import { BigNumber, BigNumberish } from 'ethers'
import { OperationBase, ReferencedCodeHashes, UserOperation } from '@account-abstraction/utils'

export class MempoolEntry {
  userOpMaxGas: BigNumber
  readonly createdAt: number // Timestamp for TTL tracking

  constructor (
    readonly userOp: OperationBase,
    readonly userOpHash: string,
    readonly prefund: BigNumberish,
    readonly referencedContracts: ReferencedCodeHashes,
    readonly skipValidation: boolean,
    readonly aggregator?: string
  ) {
    this.userOpMaxGas = BigNumber
      .from((this.userOp as UserOperation).preVerificationGas ?? 0)
      .add(this.userOp.callGasLimit)
      .add(this.userOp.verificationGasLimit)
      .add(this.userOp.paymasterVerificationGasLimit ?? 0)
      .add(this.userOp.paymasterPostOpGasLimit ?? 0)
    this.createdAt = Date.now()
  }

  // Check if this entry has expired (default 5 minutes)
  isExpired (ttlMs: number = 5 * 60 * 1000): boolean {
    return Date.now() - this.createdAt > ttlMs
  }
}
