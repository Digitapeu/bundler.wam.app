import { BigNumber, BigNumberish, Signer, providers } from 'ethers'
import { Log, Provider } from '@ethersproject/providers'

import { BundlerConfig } from './BundlerConfig'
import { resolveProperties } from 'ethers/lib/utils'
import { deepHexlify, erc4337RuntimeVersion } from '@account-abstraction/utils'
import { UserOperationStruct, EntryPoint } from '@account-abstraction/contracts'
import { UserOperationEventEvent } from '@account-abstraction/contracts/dist/types/EntryPoint'
import { calcPreVerificationGas } from '@account-abstraction/sdk'
import { requireCond, RpcError, tostr } from './utils'
import { ExecutionManager } from './modules/ExecutionManager'
import { getAddr } from './modules/moduleUtils'
import { UserOperationByHashResponse, UserOperationReceipt } from './RpcTypes'
import { ExecutionErrors, UserOperation, ValidationErrors } from './modules/Types'
import { getLogsChunked } from './utils/getLogsChunked'

const HEX_REGEX = /^0x[a-fA-F\d]*$/i
const MAX_RANGE = 100; // Very conservative limit for strict RPC providers like Chainstack

/**
 * return value from estimateUserOpGas
 */
export interface EstimateUserOpGasResult {
  /**
   * the preVerification gas used by this UserOperation.
   */
  preVerificationGas: BigNumberish
  /**
   * gas used for validation of this UserOperation, including account creation
   */
  verificationGas: BigNumberish

  /**
   * (possibly future timestamp) after which this UserOperation is valid
   */
  validAfter?: BigNumberish

  /**
   * the deadline after which this UserOperation is invalid (not a gas estimation parameter, but returned by validation
   */
  validUntil?: BigNumberish
  /**
   * estimated cost of calling the account with the given callData
   */
  callGasLimit: BigNumberish
}

export class UserOpMethodHandler {
  constructor (
    readonly execManager: ExecutionManager,
    readonly provider: Provider,
    readonly signer: Signer,
    readonly config: BundlerConfig,
    readonly entryPoint: EntryPoint
  ) {
  }

  async getSupportedEntryPoints (): Promise<string[]> {
    return [this.config.entryPoint]
  }

  async selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress())
    let beneficiary = this.config.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance.lte(this.config.minBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.config.beneficiary)
    }
    return beneficiary
  }

  async _validateParameters (userOp1: UserOperationStruct, entryPointInput: string, requireSignature = true, requireGasParams = true): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', -32602)

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`)
    }
    // minimal sanity check: userOp exists, and all members are hex
    requireCond(userOp1 != null, 'No UserOperation param')
    const userOp = await resolveProperties(userOp1) as any

    const fields = ['sender', 'nonce', 'initCode', 'callData', 'paymasterAndData']
    if (requireSignature) {
      fields.push('signature')
    }
    if (requireGasParams) {
      fields.push('preVerificationGas', 'verificationGasLimit', 'callGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')
    }
    fields.forEach(key => {
      requireCond(userOp[key] != null, 'Missing userOp field: ' + key + JSON.stringify(userOp), -32602)
      const value: string = userOp[key].toString()
      requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, -32602)
    })
  }

  /**
   * eth_estimateUserOperationGas RPC api.
   * @param userOp1
   * @param entryPointInput
   */
  async estimateUserOperationGas (userOp1: UserOperationStruct, entryPointInput: string): Promise<EstimateUserOpGasResult> {
    const userOp = {
      ...await resolveProperties(userOp1),
      // default values for missing fields.
      paymasterAndData: '0x',
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6
    }

    // todo: checks the existence of parameters, but since we hexlify the inputs, it fails to validate
    await this._validateParameters(deepHexlify(userOp), entryPointInput)
    // todo: validation manager duplicate?
    const errorResult = await this.entryPoint.callStatic.simulateValidation(userOp).catch(e => e)
    if (errorResult.errorName === 'FailedOp') {
      throw new RpcError(errorResult.errorArgs.at(-1), ValidationErrors.SimulateValidation)
    }
    // todo throw valid rpc error
    if (errorResult.errorName !== 'ValidationResult') {
      throw errorResult
    }

    const { returnInfo } = errorResult.errorArgs
    let {
      preOpGas,
      validAfter,
      validUntil
    } = returnInfo

    const callGasLimit = await this.provider.estimateGas({
      from: this.entryPoint.address,
      to: userOp.sender,
      data: userOp.callData
    }).then(b => b.toNumber()).catch(err => {
      const message = err.message.match(/reason="(.*?)"/)?.at(1) ?? 'execution reverted'
      throw new RpcError(message, ExecutionErrors.UserOperationReverted)
    })
    validAfter = BigNumber.from(validAfter)
    validUntil = BigNumber.from(validUntil)
    if (validUntil === BigNumber.from(0)) {
      validUntil = undefined
    }
    if (validAfter === BigNumber.from(0)) {
      validAfter = undefined
    }
    const preVerificationGas = calcPreVerificationGas(userOp)
    const verificationGas = BigNumber.from(preOpGas).toNumber()
    return {
      preVerificationGas,
      verificationGas,
      validAfter,
      validUntil,
      callGasLimit
    }
  }

  async sendUserOperation (userOp1: UserOperationStruct, entryPointInput: string): Promise<string> {
    await this._validateParameters(userOp1, entryPointInput)

    const userOp = await resolveProperties(userOp1)

    console.log(`UserOperation: Sender=${userOp.sender}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput} Paymaster=${getAddr(
      userOp.paymasterAndData)}`)
    await this.execManager.sendUserOperation(userOp, entryPointInput)
    return await this.entryPoint.getUserOpHash(userOp)
  }

  async _getUserOperationEvent (userOpHash: string): Promise<UserOperationEventEvent> {
    // Use chunked log fetching to avoid RPC block range limits
    const provider = this.provider as providers.JsonRpcProvider
    const currentBlock = await provider.getBlockNumber()
    
    // Start from a reasonable range (e.g., last 100k blocks) and expand if needed
    let fromBlock = Math.max(0, currentBlock - 100_000)
    
    const filter = {
      address: this.entryPoint.address,
      topics: this.entryPoint.filters.UserOperationEvent(userOpHash).topics
    }
    
    // First try with recent blocks
    let logs = await getLogsChunked(provider, {
      ...filter,
      fromBlock,
      toBlock: currentBlock
    }, { maxRange: MAX_RANGE })
    
    // If not found in recent blocks, search further back
    if (logs.length === 0 && fromBlock > 0) {
      // Search from contract deployment or a reasonable historical point
      const deploymentBlock = 40321530;
      logs = await getLogsChunked(provider, {
        ...filter,
        fromBlock: deploymentBlock,
        toBlock: fromBlock - 1
      }, { maxRange: MAX_RANGE })
    }
    
    if (logs.length === 0) {
      return null as any
    }
    
    // Parse the log to get the event
    const parsedLog = this.entryPoint.interface.parseLog(logs[0])
    const event = {
      ...logs[0],
      ...parsedLog,
      args: parsedLog.args,
      getTransaction: async () => provider.getTransaction(logs[0].transactionHash),
      getTransactionReceipt: async () => provider.getTransactionReceipt(logs[0].transactionHash),
      getBlock: async () => provider.getBlock(logs[0].blockHash)
    } as any
    
    return event
  }


  /**
 * Fetch logs chunked from the RPC and return only the logs for the *executed section*
 * of the bundle that contains the given userOpHash: i.e., logs strictly after the last
 * `BeforeExecution` and up to (excluding) the matching `UserOperationEvent`.
 *
 * @param userOpEvent The known `UserOperationEvent` for this userOpHash (already located)
 * @param fromBlock   Lower bound to search (number)
 * @param toBlock     Upper bound to search (number | 'latest'), defaults to 'latest'
 */
  async _filterLogs(
    this: any,
    userOpEvent: UserOperationEventEvent,
    logs: Log[] = []
  ): Promise<Log[]> {
    // If no logs were supplied, fetch only the two relevant topics in chunks.
    if (!logs || logs.length === 0) {
      const provider = this.provider; // JsonRpcProvider / Web3Provider
      const entryPoint = this.entryPoint;
  
      // Event topics we need to reconstruct the execution slice:
      const beforeExecutionTopic = entryPoint.interface.getEventTopic(
        Object.values(entryPoint.interface.events).find((e: any) => e.name === 'BeforeExecution')!
      );
      const userOperationEventTopic = entryPoint.interface.getEventTopic(
        Object.values(entryPoint.interface.events).find((e: any) => e.name === 'UserOperationEvent')!
      );
  
      // Numeric block window around the event; widen/narrow to taste.
      const currentBlock: number = await provider.getBlockNumber();
      const fromBlock = Math.max(0, userOpEvent.blockNumber - 10_000);
      const toBlock   = Math.min(currentBlock, userOpEvent.blockNumber + 200);
  
      // topics[0] supports OR with an array → fetch only the two event signatures we need.
      const filter = {
        address: entryPoint.address,
        topics: [[beforeExecutionTopic, userOperationEventTopic]],
      };
  
      logs = await getLogsChunked(provider, filter, { maxRange: MAX_RANGE });
    }
  
    // Original slicing logic unchanged.
    let startIndex = -1;
    let endIndex = -1;
  
    const events = Object.values(this.entryPoint.interface.events);
    const beforeExecutionTopic = this.entryPoint.interface.getEventTopic(
      events.find((e: any) => e.name === 'BeforeExecution')!
    );
  
    logs.forEach((log, index) => {
      if (log?.topics[0] === beforeExecutionTopic) {
        // all UserOp execution events start after the "BeforeExecution" event.
        startIndex = endIndex = index;
      } else if (log?.topics[0] === userOpEvent.topics[0]) {
        // process UserOperationEvent
        if (log.topics[1] === userOpEvent.topics[1]) {
          // it's our userOpHash. save as end of logs array
          endIndex = index;
        } else if (endIndex === -1) {
          // different hash and end not found yet → shift start
          startIndex = index;
        }
      }
    });
  
    if (endIndex === -1) {
      throw new Error('fatal: no UserOperationEvent in logs');
    }
    return logs.slice(startIndex + 1, endIndex);
  }
  async getUserOperationByHash (userOpHash: string): Promise<UserOperationByHashResponse | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32601)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const tx = await event.getTransaction()
    if (tx.to !== this.entryPoint.address) {
      throw new Error('unable to parse transaction')
    }
    const parsed = this.entryPoint.interface.parseTransaction(tx)
    const ops: UserOperation[] = parsed?.args.ops
    if (ops == null) {
      throw new Error('failed to parse transaction')
    }
    const op = ops.find(op =>
      op.sender === event.args.sender &&
      BigNumber.from(op.nonce).eq(event.args.nonce)
    )
    if (op == null) {
      throw new Error('unable to find userOp in transaction')
    }

    const {
      sender,
      nonce,
      initCode,
      callData,
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData,
      signature
    } = op

    return deepHexlify({
      userOperation: {
        sender,
        nonce,
        initCode,
        callData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        paymasterAndData,
        signature
      },
      entryPoint: this.entryPoint.address,
      transactionHash: tx.hash,
      blockHash: tx.blockHash ?? '',
      blockNumber: tx.blockNumber ?? 0
    })
  }

  async getUserOperationReceipt (userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32601)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const receipt = await event.getTransactionReceipt()
    const logs = await this._filterLogs(event, receipt.logs)
    return deepHexlify({
      userOpHash,
      sender: event.args.sender,
      nonce: event.args.nonce,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      success: event.args.success,
      logs,
      receipt
    })
  }

  clientVersion (): string {
    // eslint-disable-next-line
    return 'aa-bundler/' + erc4337RuntimeVersion + (this.config.unsafe ? '/unsafe' : '')
  }
}
