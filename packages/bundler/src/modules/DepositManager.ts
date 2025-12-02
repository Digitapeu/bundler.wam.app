import { BigNumber } from 'ethers'
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
export class DepositManager {
  private deposits: Record<string, BigNumber> = {}

  constructor (
    readonly entryPoint: IEntryPoint,
    readonly mempool: MempoolManager,
    readonly bundleManager: IBundleManager) {
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

  async checkPaymasterDeposit (userOp: OperationBase): Promise<void> {
    const paymaster = this.normalizeAddress(userOp.paymaster)
    if (paymaster == null || paymaster === AddressZero) {
      return
    }
    let deposit = await this.getCachedDeposit(paymaster)
    const required = this.getRequiredDeposit(paymaster, userOp)
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

  private getRequiredDeposit (paymaster: string, currentOp: OperationBase): BigNumber {
    let required = BigNumber.from(getUserOpMaxCost(currentOp as UserOperation))
    for (const entry of this.mempool.getMempool()) {
      const entryPaymaster = this.normalizeAddress(entry.userOp.paymaster)
      if (entryPaymaster === paymaster) {
        required = required.add(BigNumber.from(getUserOpMaxCost(entry.userOp as UserOperation)))
      }
    }
    return required
  }

  private normalizeAddress (addr?: string): string | undefined {
    if (addr == null || addr === '0x') {
      return undefined
    }
    return addr.toLowerCase()
  }
}
