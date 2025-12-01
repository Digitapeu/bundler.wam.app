import debug from 'debug'
import fs from 'fs'
import path from 'path'
import { BigNumber, BigNumberish, Signer } from 'ethers'
import { EventFragment, Interface } from '@ethersproject/abi'
import { JsonRpcProvider, Log } from '@ethersproject/providers'
import { toNumber } from '@nomicfoundation/hardhat-network-helpers/dist/src/utils'
import { defaultAbiCoder } from 'ethers/lib/utils'

import { MainnetConfig, PreVerificationGasCalculator } from '@account-abstraction/sdk'

import {
  AddressZero,
  EIP_7702_MARKER_INIT_CODE,
  IEntryPoint,
  PackedUserOperation,
  RpcError,
  UserOperation,
  UserOperationEventEvent,
  ValidationErrors,
  callGetUserOpHashWithCode,
  decodeRevertReason,
  decodeSimulateHandleOpResult,
  deepHexlify,
  erc4337RuntimeVersion,
  getAuthorizationList,
  mergeValidationDataValues,
  requireAddressAndFields,
  requireCond,
  simulationRpcParams,
  tostr,
  unpackUserOp
} from '@account-abstraction/utils'
import { BundlerConfig } from './BundlerConfig'

import { ExecutionManager } from './modules/ExecutionManager'
import { StateOverride, UserOperationByHashResponse, UserOperationReceipt } from './RpcTypes'

export const HEX_REGEX = /^0x[a-fA-F\d]*$/i

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
  verificationGasLimit: BigNumberish

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

export class MethodHandlerERC4337 {
  private lastUserOpEventBlock?: number
  private readonly logFetchBlockRange: number
  private readonly logFetchLookbackBlocks: number
  private readonly revertSelectorHints: Record<string, string>
  private readonly revertSelectorDecoders: Record<string, (data: string) => string>
  private readonly abiBaseDirs: string[]

  constructor (
    readonly execManager: ExecutionManager,
    readonly provider: JsonRpcProvider,
    readonly signer: Signer,
    readonly config: BundlerConfig,
    readonly entryPoint: IEntryPoint,
    public preVerificationGasCalculator: PreVerificationGasCalculator
  ) {
    this.logFetchBlockRange = Math.max(1, config.logFetchBlockRange ?? 500)
    this.logFetchLookbackBlocks = Math.max(this.logFetchBlockRange, config.logFetchLookbackBlocks ?? 20_000)
    this.revertSelectorHints = Object.fromEntries(
      Object.entries(config.revertSelectorHints ?? {}).map(([key, value]) => [key.toLowerCase(), value])
    )
    this.revertSelectorDecoders = {}
    this.abiBaseDirs = this.buildAbiBaseDirs(config.configDir)
    this.extendSelectorHintsFromAbis(config.revertSelectorAbiPaths ?? [])
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

  async _validateParameters (
    userOp1: Partial<UserOperation>,
    entryPointInput: string,
    requireSignature = true,
    requireGasParams = true
  ): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', ValidationErrors.InvalidFields)

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`)
    }
    // minimal sanity check: userOp exists, and all members are hex
    requireCond(userOp1 != null, 'No UserOperation param', ValidationErrors.InvalidFields)
    const userOp = deepHexlify(userOp1) as any

    const fields = ['sender', 'nonce', 'callData']
    if (requireSignature) {
      fields.push('signature')
    }
    if (requireGasParams) {
      fields.push('preVerificationGas', 'verificationGasLimit', 'callGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')
    }
    fields.forEach(key => {
      requireCond(userOp[key] != null, 'Missing userOp field: ' + key, ValidationErrors.InvalidFields)
      const value: string = userOp[key].toString()
      requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, ValidationErrors.InvalidFields)
    })
    requireAddressAndFields(userOp, 'paymaster', ['paymasterPostOpGasLimit', 'paymasterVerificationGasLimit'], ['paymasterData'])
    if (userOp1.factory !== EIP_7702_MARKER_INIT_CODE) {
      requireAddressAndFields(userOp, 'factory', ['factoryData'])
    }

    await this.checkAccountDeployment(userOp)
    await this.checkPaymaster(userOp)
    await this.checkFactory(userOp)
  }

  /**
   * eth_estimateUserOperationGas RPC api.
   * @param userOp1 input userOp (may have gas fields missing, so they can be estimated)
   * @param entryPointInput
   * @param stateOverride
   */
  async estimateUserOperationGas (
    userOp1: Partial<UserOperation>,
    entryPointInput: string,
    stateOverride?: StateOverride
  ): Promise<EstimateUserOpGasResult> {
    if (!this.config.eip7702Support && userOp1.eip7702Auth != null) {
      throw new Error('EIP-7702 tuples are not supported')
    }
    const userOp: UserOperation = {
      // default values for missing fields.
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6,
      callData: userOp1.callData ?? '0x',
      initCode: userOp1.initCode ?? '0x',
      paymasterAndData: userOp1.paymasterAndData ?? '0x',
      signature: userOp1.signature ?? '0x',
      ...userOp1
    } as any
    await this._validateParameters(userOp, entryPointInput, false, false)
    const provider = this.provider
    const mergedStateOverride = this.mergeStateOverrides(userOp, stateOverride)
    const rpcParams = simulationRpcParams('simulateHandleOp', this.entryPoint.address, userOp, [AddressZero, '0x'],
      mergedStateOverride
    )

    const ret = await provider.send('eth_call', rpcParams)
      .catch((e: any) => { throw this.wrapSimulationError('simulateHandleOp', e) })

    const returnInfo = decodeSimulateHandleOpResult(ret)

    const {
      validAfter,
      validUntil
    } = mergeValidationDataValues(returnInfo.accountValidationData, returnInfo.paymasterValidationData)
    const {
      preOpGas
    } = returnInfo

    const authorizationList = getAuthorizationList(userOp)
    // simulateHandleOp currently doesn't expose execution gas, so we still need a dedicated eth_estimateGas call.
    let callGasLimit = await this.provider.send(
      'eth_estimateGas', [
        {
          from: this.entryPoint.address,
          to: userOp.sender,
          data: userOp.callData,
          // @ts-ignore
          authorizationList: authorizationList.length === 0 ? null : authorizationList
        }
      ]
    ).then(b => toNumber(b)).catch(err => {
      throw this.wrapSimulationError('eth_estimateGas', err)
    })
    // Results from 'estimateGas' assume making a standalone transaction and paying 21'000 gas extra for it
    callGasLimit -= MainnetConfig.transactionGasStipend
    if (callGasLimit < 0) {
      callGasLimit = 0
    }

    const preVerificationGas = this.preVerificationGasCalculator.estimatePreVerificationGas(userOp, {})
    if (!Number.isFinite(Number(preVerificationGas))) {
      throw new RpcError('Unable to estimate preVerificationGas', ValidationErrors.InternalError, { step: 'preVerificationGas' })
    }
    const verificationGasLimit = BigNumber.from(preOpGas).toNumber()
    return {
      preVerificationGas,
      verificationGasLimit,
      validAfter,
      validUntil,
      callGasLimit
    }
  }

  async sendUserOperation (userOp: UserOperation, entryPointInput: string): Promise<string> {
    if (!this.config.eip7702Support && userOp.eip7702Auth != null) {
      throw new Error('EIP-7702 tuples are not supported')
    }
    await this._validateParameters(userOp, entryPointInput)

    debug(`UserOperation: Sender=${userOp.sender}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput} Paymaster=${userOp.paymaster ?? ''} ${userOp.eip7702Auth != null ? 'eip-7702 auth' : ''}`)
    await this.execManager.sendUserOperation(userOp, entryPointInput, false)
    return await callGetUserOpHashWithCode(this.entryPoint, userOp)
  }

  async _getUserOperationEvent (userOpHash: string): Promise<UserOperationEventEvent> {
    const currentBlock = await this.provider.getBlockNumber()
    const defaultStartBlock = Math.max(0, currentBlock - this.logFetchLookbackBlocks)
    const startBlock = Math.max(defaultStartBlock, (this.lastUserOpEventBlock ?? defaultStartBlock))
    const filter = this.entryPoint.filters.UserOperationEvent(userOpHash)

    let fromBlock = startBlock
    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(fromBlock + this.logFetchBlockRange - 1, currentBlock)
      let events: UserOperationEventEvent[]
      try {
        events = await this.queryFilterWithAdaptiveRange(filter, fromBlock, toBlock)
      } catch (err: any) {
        throw this.wrapLogFetchError(err, fromBlock, toBlock)
      }
      if (events.length > 0) {
        const event = events[0]
        this.lastUserOpEventBlock = event.blockNumber
        return event
      }
      fromBlock = toBlock + 1
    }
    throw new RpcError(
      `Unable to locate UserOperationEvent for hash ${userOpHash} within the last ${this.logFetchLookbackBlocks} blocks`,
      ValidationErrors.InvalidRequest,
      { userOpHash, searchedFrom: startBlock, searchedTo: currentBlock }
    )
  }

  // filter full bundle logs, and leave only logs for the given userOpHash
  // @param userOpEvent - the event of our UserOp (known to exist in the logs)
  // @param logs - full bundle logs. after each group of logs there is a single UserOperationEvent with unique hash.
  _filterLogs (userOpEvent: UserOperationEventEvent, logs: Log[]): Log[] {
    let startIndex = -1
    let endIndex = -1
    const events = Object.values(this.entryPoint.interface.events) as EventFragment[]
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const beforeExecutionTopic = this.entryPoint.interface.getEventTopic(events.find((e: EventFragment) => e.name === 'BeforeExecution')!)
    logs.forEach((log, index) => {
      if (log?.topics[0] === beforeExecutionTopic) {
        // all UserOp execution events start after the "BeforeExecution" event.
        startIndex = endIndex = index
      } else if (log?.topics[0] === userOpEvent.topics[0]) {
        // process UserOperationEvent
        if (log.topics[1] === userOpEvent.topics[1]) {
          // it's our userOpHash. save as end of logs array
          endIndex = index
        } else {
          // it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
          if (endIndex === -1) {
            startIndex = index
          }
        }
      }
    })
    if (endIndex === -1) {
      throw new Error('fatal: no UserOperationEvent in logs')
    }
    return logs.slice(startIndex + 1, endIndex)
  }

  async getUserOperationByHash (userOpHash: string): Promise<UserOperationByHashResponse | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32602)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const tx = await event.getTransaction()
    if (tx.to !== this.entryPoint.address) {
      throw new Error('unable to parse transaction')
    }
    const parsed = this.entryPoint.interface.parseTransaction(tx)
    const ops: PackedUserOperation[] = parsed?.args.ops
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

    return deepHexlify({
      userOperation: unpackUserOp(op),
      entryPoint: this.entryPoint.address,
      transactionHash: tx.hash,
      blockHash: tx.blockHash ?? '',
      blockNumber: tx.blockNumber ?? 0
    })
  }

  async getUserOperationReceipt (userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32602)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const receipt = await event.getTransactionReceipt()
    const logs = this._filterLogs(event, receipt.logs)
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

  private isBlockRangeError (err: any): boolean {
    const message = (err?.error?.message ?? err?.message ?? '').toLowerCase()
    return err?.code === -32602 || message.includes('block range') || message.includes('range limit')
  }

  private wrapLogFetchError (err: any, fromBlock: number, toBlock: number): RpcError {
    if (err instanceof RpcError) {
      return new RpcError(
        `${err.message} (while scanning blocks ${fromBlock}-${toBlock})`,
        err.code,
        {
          ...(err.data ?? {}),
          fromBlock,
          toBlock
        }
      )
    }
    const message = err?.error?.message ?? err?.message ?? 'unknown provider error'
    const code = err?.code ?? ValidationErrors.InternalError
    return new RpcError(
      `Failed to fetch UserOperationEvent logs for blocks ${fromBlock}-${toBlock}: ${message}`,
      code,
      {
        fromBlock,
        toBlock,
        cause: message
      }
    )
  }

  private async queryFilterWithAdaptiveRange (
    filter: any,
    fromBlock: number,
    toBlock: number
  ): Promise<UserOperationEventEvent[]> {
    if (fromBlock > toBlock) {
      return []
    }
    try {
      return await this.entryPoint.queryFilter(filter, fromBlock, toBlock)
    } catch (err: any) {
      if (this.isBlockRangeError(err) && fromBlock < toBlock) {
        const mid = Math.floor((fromBlock + toBlock) / 2)
        const left = await this.queryFilterWithAdaptiveRange(filter, fromBlock, mid)
        const right = await this.queryFilterWithAdaptiveRange(filter, mid + 1, toBlock)
        return left.concat(right)
      }
      throw err
    }
  }

  private mergeStateOverrides (userOp: UserOperation, override?: StateOverride): StateOverride | undefined {
    const merged: StateOverride = {}
    if (override != null) {
      Object.entries(override).forEach(([address, accountOverride]) => {
        merged[address] = {
          ...(accountOverride ?? {})
        }
      })
    }
    if (this.config.estimationForceSenderBalance != null && userOp.sender != null) {
      const senderAddress = userOp.sender
      merged[senderAddress] = {
        ...(merged[senderAddress] ?? {}),
        balance: merged[senderAddress]?.balance ?? this.config.estimationForceSenderBalance
      }
    }
    return Object.keys(merged).length === 0 ? undefined : merged
  }

  private async checkAccountDeployment (userOp: UserOperation): Promise<void> {
    const sender = userOp.sender?.toLowerCase()
    requireCond(sender != null, 'Missing sender in UserOperation', ValidationErrors.InvalidFields)
    const senderCode = await this.provider.getCode(sender)
    const hasAccountCode = senderCode != null && senderCode !== '0x'
    const hasInitCode = userOp.initCode != null && userOp.initCode !== '0x'

    if (!hasAccountCode && !hasInitCode) {
      throw new RpcError(
        'Sender account has no code on-chain and initCode was not supplied. Deploy the account or include initCode.',
        ValidationErrors.InvalidFields,
        { sender }
      )
    }

    if (hasAccountCode && hasInitCode) {
      throw new RpcError(
        'Sender account is already deployed but initCode was supplied. Remove initCode to avoid AA23.',
        ValidationErrors.InvalidFields,
        { sender }
      )
    }
  }

  private async checkPaymaster (userOp: UserOperation): Promise<void> {
    if (userOp.paymaster == null) {
      return
    }
    const paymaster = userOp.paymaster.toLowerCase()
    const code = await this.provider.getCode(paymaster)
    requireCond(code != null && code !== '0x', 'Paymaster address has no code', ValidationErrors.InvalidFields)
  }

  private async checkFactory (userOp: UserOperation): Promise<void> {
    if (userOp.factory == null || userOp.factory === EIP_7702_MARKER_INIT_CODE) {
      return
    }
    const factory = userOp.factory.toLowerCase()
    const code = await this.provider.getCode(factory)
    requireCond(code != null && code !== '0x', 'Factory address has no code deployed', ValidationErrors.InvalidFields)
  }

  private wrapSimulationError (step: string, err: any): RpcError {
    const revertSelector = typeof err?.error?.data === 'string' ? err.error.data.slice(0, 10) : undefined
    const decoded = (decodeRevertReason(err) as string | undefined) ?? err?.error?.message ?? err?.message
    const failedOp = this.decodeFailedOp(err)
    const aaCode = this.extractAACode(failedOp?.reason ?? decoded)
    const hint = this.buildHint(failedOp, aaCode)
    const messageParts = [`${step} failed`]
    if (failedOp?.opIndex != null) {
      messageParts.push(`for op ${failedOp.opIndex}`)
    }
    if (aaCode != null) {
      messageParts.push(`(${aaCode})`)
    }
    const baseReason = failedOp?.reason ?? decoded
    if (baseReason != null) {
      messageParts.push(`: ${baseReason}`)
    }
    if (failedOp?.innerSelector != null) {
      messageParts.push(`[inner revert selector ${failedOp.innerSelector}]`)
    }
    const message = messageParts.join(' ')
    return new RpcError(message, step === 'eth_estimateGas' ? ValidationErrors.UserOperationReverted : ValidationErrors.SimulateValidation, {
      step,
      aaCode,
      revertSelector,
      revertReason: failedOp?.reason ?? decoded,
      innerRevertSelector: failedOp?.innerSelector,
      innerRevertReason: failedOp?.innerReason,
      hint
    })
  }

  private buildHint (
    failedOp: { reason?: string, innerReason?: string, innerSelector?: string } | undefined,
    aaCode: string | undefined
  ): string | undefined {
    if (failedOp?.innerReason != null && failedOp.innerReason.length > 0) {
      return failedOp.innerReason
    }
    if (failedOp?.innerSelector != null) {
      const selector = failedOp.innerSelector.toLowerCase()
      const known = this.revertSelectorHints[selector]
      if (known != null) {
        return known
      }
      return `Inner revert selector ${failedOp.innerSelector}. Decode using the factory/account ABI for the exact error.`
    }
    if (aaCode != null) {
      return this.hintForAACode(aaCode)
    }
    return undefined
  }

  private decodeFailedOp (err: any): { opIndex?: number, reason?: string, innerSelector?: string, innerReason?: string } | undefined {
    const data = err?.error?.data ?? err?.data
    if (typeof data !== 'string' || !data.startsWith('0x')) {
      return undefined
    }
    // FailedOp(bytes4=0x65c8fd4d) selector + ABI encoded payload
    const FAILED_OP_SELECTOR = '0x65c8fd4d'
    if (!data.startsWith(FAILED_OP_SELECTOR)) {
      return undefined
    }
    try {
      let decoded: any
      try {
        decoded = this.entryPoint.interface.decodeErrorResult('FailedOp', data)
      } catch {
        const raw = '0x' + data.slice(10)
        decoded = defaultAbiCoder.decode(['uint256', 'string', 'bytes'], raw)
      }
      const opIndex: BigNumberish = decoded[0]
      const reason: string = decoded[1]
      const innerData: string = decoded[2]
      const innerSelector = typeof innerData === 'string' && innerData.length >= 10 ? innerData.slice(0, 10) : undefined
      let innerReason: string | undefined
      if (innerData && innerData !== '0x') {
        innerReason = this.decodeInnerRevert(innerData)
      }
      return {
        opIndex: BigNumber.from(opIndex).toNumber(),
        reason,
        innerSelector,
        innerReason
      }
    } catch {
      return undefined
    }
  }

  private decodeInnerRevert (data: string): string | undefined {
    try {
      const selector = data.slice(0, 10).toLowerCase()
      const decoder = this.revertSelectorDecoders[selector]
      if (decoder != null) {
        return decoder(data)
      }
    } catch {}
    try {
      const reason = decodeRevertReason({ error: { data } })
      if (typeof reason === 'string' && reason.length > 0) {
        return reason
      }
    } catch {}
    return undefined
  }

  private hintForAACode (code: string): string | undefined {
    const hints: Record<string, string> = {
      AA21: 'UserOperation signature validation failed',
      AA22: 'Paymaster validation failed',
      AA23: 'Account not deployed or initCode reverted',
      AA24: 'Invalid account signature',
      AA25: 'Payment validation failed',
      AA26: 'Post-op validation failed',
      AA27: 'Time-range constraints violated',
      AA28: 'Paymaster deposit too low',
      AA29: 'Unsupported signature aggregator'
    }
    return hints[code]
  }

  private extractAACode (reason?: string): string | undefined {
    if (reason == null) {
      return undefined
    }
    const match = reason.match(/(AA\d{2})/)
    return match?.[1]
  }

  private extendSelectorHintsFromAbis (pathsToAbis: string[]): void {
    pathsToAbis.forEach(abiPath => {
      try {
        const resolved = this.resolveAbiPath(abiPath)
        if (resolved == null) {
          console.warn('ABI path for revert selector hints not found:', abiPath)
          return
        }
        const content = fs.readFileSync(resolved, 'utf8')
        const abiJson = JSON.parse(content)
        const iface = new Interface(abiJson)
        iface.fragments.forEach(fragment => {
          if (fragment.type === 'error') {
            const selector = iface.getSighash(fragment).toLowerCase()
            if (this.revertSelectorHints[selector] == null) {
              this.revertSelectorHints[selector] = `Revert ${fragment.format()}`
            }
            this.revertSelectorDecoders[selector] = (data: string): string => {
              try {
                const decoded = iface.decodeErrorResult(fragment, data)
                const args = fragment.inputs?.map((input, index) => {
                  const label = input.name && input.name.length > 0 ? input.name : `arg${index}`
                  return `${label}=${decoded[index]}`
                }) ?? []
                return args.length > 0 ? `${fragment.name}(${args.join(', ')})` : `${fragment.name}()`
              } catch (err) {
                return `${fragment.name} (failed to decode args: ${(err as Error).message})`
              }
            }
          }
        })
      } catch (err) {
        console.warn('Failed to load ABI for revert selector hints:', abiPath, err?.message ?? err)
      }
    })
  }

  private resolveAbiPath (abiPath: string): string | undefined {
    if (path.isAbsolute(abiPath)) {
      return fs.existsSync(abiPath) ? abiPath : undefined
    }
    for (const base of this.abiBaseDirs) {
      const candidate = path.resolve(base, abiPath)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
    return undefined
  }

  private buildAbiBaseDirs (configDir?: string): string[] {
    const dirs = new Set<string>()
    const add = (dir: string | undefined) => {
      if (dir != null) {
        dirs.add(path.resolve(dir))
      }
    }
    add(process.cwd())
    let current = __dirname
    for (let i = 0; i < 6; i++) {
      add(current)
      current = path.resolve(current, '..')
      if (current === '/' || current === '' || current == null) {
        break
      }
    }
    add(configDir)
    return Array.from(dirs)
  }

  clientVersion (): string {
    // eslint-disable-next-line
    return 'aa-bundler/' + erc4337RuntimeVersion + (this.config.unsafe ? '/unsafe' : '')
  }
}
