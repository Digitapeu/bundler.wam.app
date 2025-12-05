import { BigNumber, BigNumberish } from 'ethers'
import {
  AddressZero,
  getUserOpMaxCost,
  IEntryPoint,
  OperationBase,
  requireCond,
  UserOperation,
  ValidationErrors
} from '@account-abstraction/utils'
import { MempoolManager } from './MempoolManager'
import { IBundleManager } from './IBundleManager'

/**
 * manage paymaster deposits, to make sure a paymaster has enough gas for all its pending transaction in the mempool
 * [EREP-010]
 */
interface DepositManagerOptions {
  headroomBps: number
  maxPendingOps: number
}

const DEFAULT_OPTIONS: DepositManagerOptions = {
  headroomBps: 12_000,
  maxPendingOps: 20
}

export class DepositManager {
  private deposits: Record<string, BigNumber> = {}

  constructor (
    readonly entryPoint: IEntryPoint,
    readonly mempool: MempoolManager,
    readonly bundleManager: IBundleManager,
    private readonly options: DepositManagerOptions = DEFAULT_OPTIONS) {
    this.entryPoint.on(this.entryPoint.filters.Deposited(), (...args) => {
      const account = args[0] as string | undefined
      const totalDeposit = args[1] as BigNumber | undefined
      if (account != null && totalDeposit != null) {
        this.setCachedDeposit(account, totalDeposit)
      }
    })
    this.entryPoint.on(this.entryPoint.filters.Withdrawn(), async (...args) => {
      const account = args[0] as string | undefined
      if (account != null) {
        await this.refreshDepositFromChain(account)
      }
    })
  }

  async checkPaymasterDeposit (userOp: OperationBase, currentPrefund?: BigNumberish): Promise<void> {
    const paymaster = this.normalizeAddress(userOp.paymaster)
    if (paymaster == null || paymaster === AddressZero) {
      return
    }
    const prefund = this.normalizePrefund(currentPrefund, userOp)
    let deposit = await this.getCachedDeposit(paymaster)
    const required = this.getRequiredDeposit(paymaster, prefund)
    if (deposit.lt(required)) {
      deposit = await this.refreshDepositFromChain(paymaster)
    }

    // [EREP-010] paymaster is required to have balance for all its pending transactions.
    // on-chain AA31 checks the deposit for the current userop.
    // but submitting all these UserOps it will eventually abort on this error,
    // so it's fine to return the same code.
    requireCond(deposit.gte(required), 'paymaster deposit too low for all mempool UserOps', ValidationErrors.PaymasterDepositTooLow)
  }

  /**
   * clear deposits after some known change on-chain
   */
  clearCache (): void {
    this.deposits = {}
  }

  async getCachedDeposit (addr: string): Promise<BigNumber> {
    const normalized = this.normalizeAddress(addr)
    if (normalized == null) {
      return BigNumber.from(0)
    }
    let deposit = this.deposits[normalized]
    if (deposit == null) {
      deposit = await this.refreshDepositFromChain(normalized)
    }
    return deposit
  }

  private async refreshDepositFromChain (addr: string): Promise<BigNumber> {
    const normalized = this.normalizeAddress(addr)
    if (normalized == null) {
      return BigNumber.from(0)
    }
    // Use entryPoint.balanceOf directly - bundleManager.getPaymasterBalance has wrong implementation in RIP7560 mode
    const fresh = await this.entryPoint.balanceOf(normalized)
    this.deposits[normalized] = fresh
    return fresh
  }

  private setCachedDeposit (addr: string, amount: BigNumber): void {
    const normalized = this.normalizeAddress(addr)
    if (normalized != null) {
      this.deposits[normalized] = amount
    }
  }

  private getRequiredDeposit (paymaster: string, currentPrefund: BigNumber): BigNumber {
    let required = currentPrefund
    let tracked = 1
    const maxTracked = Math.max(this.options.maxPendingOps, 1)
    for (const entry of this.mempool.getMempool()) {
      const entryPaymaster = this.normalizeAddress(entry.userOp.paymaster)
      if (entryPaymaster === paymaster) {
        required = required.add(entry.prefund)
        tracked++
        if (tracked >= maxTracked) {
          break
        }
      }
    }
    return this.applyHeadroom(required)
  }

  private normalizeAddress (addr?: string): string | undefined {
    if (addr == null || addr === '0x') {
      return undefined
    }
    return addr.toLowerCase()
  }

  private normalizePrefund (prefund: BigNumberish | undefined, userOp: OperationBase): BigNumber {
    if (prefund != null) {
      return BigNumber.from(prefund)
    }
    return BigNumber.from(getUserOpMaxCost(userOp as UserOperation))
  }

  private applyHeadroom (value: BigNumber): BigNumber {
    const headroomBps = Math.max(this.options.headroomBps, 0)
    if (headroomBps === 0) {
      return value
    }
    return value.mul(headroomBps).div(10_000)
  }
}
