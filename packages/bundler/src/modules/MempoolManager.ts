import { BigNumber, BigNumberish } from 'ethers'
import Debug from 'debug'

import {
  OperationBase,
  RpcError,
  StakeInfo,
  ValidationErrors,
  getPackedNonce,
  requireCond
} from '@account-abstraction/utils'
import {
  ValidateUserOpResult,
  ValidationResult
} from '@account-abstraction/validation-manager'

import { MempoolEntry } from './MempoolEntry'
import { ReputationManager } from './ReputationManager'

const debug = Debug('aa.mempool')

type MempoolDump = OperationBase[]

const THROTTLED_ENTITY_MEMPOOL_COUNT = 4

/**
 * P1: Optimized MempoolManager with O(1) lookups using Maps
 * Instead of linear array scans, we use:
 * - mempoolBySenderNonce: Map for O(1) lookup by sender+nonce
 * - mempoolByHash: Map for O(1) lookup by userOpHash
 */
export class MempoolManager {
  // P1: Primary storage - Map for O(1) lookups by sender+nonce
  private mempoolBySenderNonce: Map<string, MempoolEntry> = new Map()
  // P1: Secondary index - Map for O(1) lookups by hash
  private mempoolByHash: Map<string, MempoolEntry> = new Map()

  // count entities in mempool.
  private _entryCount: { [addr: string]: number | undefined } = {}

  entryCount (address: string): number | undefined {
    return this._entryCount[address.toLowerCase()]
  }

  incrementEntryCount (address?: string): void {
    address = address?.toLowerCase()
    if (address == null) {
      return
    }
    this._entryCount[address] = (this._entryCount[address] ?? 0) + 1
  }

  decrementEntryCount (address?: string): void {
    address = address?.toLowerCase()
    if (address == null || this._entryCount[address] == null) {
      return
    }
    this._entryCount[address] = (this._entryCount[address] ?? 0) - 1
    if ((this._entryCount[address] ?? 0) <= 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._entryCount[address]
    }
  }

  constructor (
    readonly reputationManager: ReputationManager,
    readonly mempoolTtlMs: number = 5 * 60 * 1000 // 5 minutes default TTL
  ) {
    // Start periodic cleanup of expired entries
    setInterval(() => this.cleanupExpired(), 30 * 1000) // Check every 30 seconds
  }

  /**
   * P1: Helper to create composite key for sender+nonce lookup
   */
  private getSenderNonceKey (sender: string, nonce: BigNumberish): string {
    return `${sender.toLowerCase()}-${BigNumber.from(nonce).toString()}`
  }

  // Remove expired UserOps from mempool
  cleanupExpired (): number {
    const before = this.mempoolBySenderNonce.size
    const expiredHashes: string[] = []

    for (const entry of this.mempoolBySenderNonce.values()) {
      if (entry.isExpired(this.mempoolTtlMs)) {
        debug('removing expired userOp', entry.userOp.sender, entry.userOpHash)
        expiredHashes.push(entry.userOpHash)
      }
    }

    for (const hash of expiredHashes) {
      this.removeUserOp(hash)
    }

    const removed = before - this.mempoolBySenderNonce.size
    if (removed > 0) {
      debug(`cleaned up ${removed} expired UserOps from mempool`)
    }
    return removed
  }

  count (): number {
    return this.mempoolBySenderNonce.size
  }

  // add userOp into the mempool, after initial validation.
  // replace existing, if any (and if new gas is higher)
  // reverts if unable to add UserOp to mempool (too many UserOps with this sender)
  addUserOp (
    skipValidation: boolean,
    userOp: OperationBase,
    userOpHash: string,
    validationResult: ValidationResult
  ): void {
    const entry = new MempoolEntry(
      userOp,
      userOpHash,
      validationResult.returnInfo.prefund ?? 0,
      (validationResult as ValidateUserOpResult).referencedContracts,
      skipValidation,
      validationResult.aggregatorInfo?.addr
    )
    const packedNonce = getPackedNonce(entry.userOp)
    const senderNonceKey = this.getSenderNonceKey(userOp.sender, packedNonce)

    // P1: O(1) lookup instead of linear scan
    const oldEntry = this.mempoolBySenderNonce.get(senderNonceKey)

    if (oldEntry != null) {
      this.checkReplaceUserOp(oldEntry, entry)
      debug('replace userOp', userOp.sender, packedNonce)

      // Remove old entry from hash index
      this.mempoolByHash.delete(oldEntry.userOpHash)

      // Update both maps
      this.mempoolBySenderNonce.set(senderNonceKey, entry)
      this.mempoolByHash.set(userOpHash, entry)

      this.updateSeenStatus(oldEntry.aggregator, oldEntry.userOp, validationResult.senderInfo, -1)
    } else {
      debug('add userOp', userOp.sender, packedNonce)
      if (!skipValidation) {
        this.checkReputation(validationResult)
        this.checkMultipleRolesViolation(userOp)
      }
      this.incrementEntryCount(userOp.sender)
      if (userOp.paymaster != null) {
        this.incrementEntryCount(userOp.paymaster)
      }
      if (userOp.factory != null) {
        this.incrementEntryCount(userOp.factory)
      }

      // P1: Add to both maps
      this.mempoolBySenderNonce.set(senderNonceKey, entry)
      this.mempoolByHash.set(userOpHash, entry)
    }

    this.updateSeenStatus(validationResult.aggregatorInfo?.addr, userOp, validationResult.senderInfo)
  }

  private updateSeenStatus (aggregator: string | undefined, userOp: OperationBase, senderInfo: StakeInfo, val = 1): void {
    try {
      this.reputationManager.checkStake('account', senderInfo)
      this.reputationManager.updateSeenStatus(userOp.sender)
    } catch (e: any) {
      if (!(e instanceof RpcError)) throw e
    }
    this.reputationManager.updateSeenStatus(aggregator, val)
    this.reputationManager.updateSeenStatus(userOp.paymaster, val)
    this.reputationManager.updateSeenStatus(userOp.factory, val)
  }

  private checkReputation (
    validationResult: ValidationResult
  ): void {
    this.checkReputationStatus('account', validationResult.senderInfo)
    this.checkReputationStatus('paymaster', validationResult.paymasterInfo)
    this.checkReputationStatus('deployer', validationResult.factoryInfo)
    this.checkReputationStatus('aggregator', validationResult.aggregatorInfo)
  }

  private checkMultipleRolesViolation (userOp: OperationBase): void {
    const knownEntities = this.getKnownEntities()
    requireCond(
      !knownEntities.includes(userOp.sender.toLowerCase()),
      `The sender address "${userOp.sender}" is used as a different entity in another UserOperation currently in mempool`,
      ValidationErrors.OpcodeValidation
    )

    const knownSenders = this.getKnownSenders()
    const paymaster = userOp.paymaster
    const factory = userOp.factory

    const isPaymasterSenderViolation = knownSenders.includes(paymaster?.toLowerCase() ?? '')
    const isFactorySenderViolation = knownSenders.includes(factory?.toLowerCase() ?? '')

    requireCond(
      !isPaymasterSenderViolation,
      `A Paymaster at ${paymaster as string} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
      ValidationErrors.OpcodeValidation
    )
    requireCond(
      !isFactorySenderViolation,
      `A Factory at ${factory as string} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
      ValidationErrors.OpcodeValidation
    )
  }

  private checkReputationStatus (
    title: 'account' | 'paymaster' | 'aggregator' | 'deployer',
    stakeInfo?: StakeInfo
  ): void {
    if (stakeInfo == null) {
      // entity missing from this userop.
      return
    }
    const maxTxMempoolAllowedEntity = this.reputationManager.calculateMaxAllowedMempoolOpsUnstaked(title, stakeInfo.addr)
    // GREP-010 A `BANNED` address is not allowed into the mempool
    this.reputationManager.checkBanned(title, stakeInfo)
    const entryCount = this.entryCount(stakeInfo.addr) ?? 0
    if (entryCount > THROTTLED_ENTITY_MEMPOOL_COUNT) {
      this.reputationManager.checkThrottled(title, stakeInfo)
    }
    if (entryCount >= maxTxMempoolAllowedEntity) {
      this.reputationManager.checkStake(title, stakeInfo)
    }
  }

  private checkReplaceUserOp (oldEntry: MempoolEntry, entry: MempoolEntry): void {
    const oldMaxPriorityFeePerGas = BigNumber.from(oldEntry.userOp.maxPriorityFeePerGas).toNumber()
    const newMaxPriorityFeePerGas = BigNumber.from(entry.userOp.maxPriorityFeePerGas).toNumber()
    const oldMaxFeePerGas = BigNumber.from(oldEntry.userOp.maxFeePerGas).toNumber()
    const newMaxFeePerGas = BigNumber.from(entry.userOp.maxFeePerGas).toNumber()
    // the error is "invalid fields", even though it is detected only after validation
    requireCond(newMaxPriorityFeePerGas >= oldMaxPriorityFeePerGas * 1.1,
      `Replacement UserOperation must have higher maxPriorityFeePerGas (old=${oldMaxPriorityFeePerGas} new=${newMaxPriorityFeePerGas}) `, ValidationErrors.InvalidFields)
    requireCond(newMaxFeePerGas >= oldMaxFeePerGas * 1.1,
      `Replacement UserOperation must have higher maxFeePerGas (old=${oldMaxFeePerGas} new=${newMaxFeePerGas}) `, ValidationErrors.InvalidFields)
  }

  getSortedForInclusion (): MempoolEntry[] {
    // P1: Convert map values to array for sorting
    const entries = Array.from(this.mempoolBySenderNonce.values())

    function cost (op: OperationBase): number {
      // TODO: need to consult basefee and maxFeePerGas
      return BigNumber.from(op.maxPriorityFeePerGas).toNumber()
    }

    entries.sort((a, b) => cost(a.userOp) - cost(b.userOp))
    return entries
  }

  /**
   * P1: O(1) lookup by sender+nonce - returns entry or undefined
   */
  _findBySenderNonce (sender: string, nonce: BigNumberish): number {
    const key = this.getSenderNonceKey(sender, nonce)
    // For backward compatibility, return -1 if not found, 0 if found
    // (callers only check for !== -1)
    return this.mempoolBySenderNonce.has(key) ? 0 : -1
  }

  /**
   * P1: O(1) lookup by sender+nonce - returns the entry directly
   */
  getBySenderNonce (sender: string, nonce: BigNumberish): MempoolEntry | undefined {
    const key = this.getSenderNonceKey(sender, nonce)
    return this.mempoolBySenderNonce.get(key)
  }

  /**
   * P1: O(1) lookup by hash - returns entry or undefined
   */
  _findByHash (hash: string): number {
    // For backward compatibility, return -1 if not found, 0 if found
    return this.mempoolByHash.has(hash) ? 0 : -1
  }

  /**
   * P1: O(1) lookup by hash - returns the entry directly
   */
  getByHash (hash: string): MempoolEntry | undefined {
    return this.mempoolByHash.get(hash)
  }

  /**
   * remove UserOp from mempool. either it is invalid, or was included in a block
   * @param userOpOrHash
   */
  removeUserOp (userOpOrHash: OperationBase | string): void {
    let entry: MempoolEntry | undefined

    if (typeof userOpOrHash === 'string') {
      // P1: O(1) lookup by hash
      entry = this.mempoolByHash.get(userOpOrHash)
    } else {
      // P1: O(1) lookup by sender+nonce
      const packedNonce = getPackedNonce(userOpOrHash)
      const key = this.getSenderNonceKey(userOpOrHash.sender, packedNonce)
      entry = this.mempoolBySenderNonce.get(key)
    }

    if (entry != null) {
      const userOp = entry.userOp
      const packedNonce = getPackedNonce(userOp)
      const senderNonceKey = this.getSenderNonceKey(userOp.sender, packedNonce)

      debug('removeUserOp', userOp.sender, packedNonce)

      // P1: Remove from both maps
      this.mempoolBySenderNonce.delete(senderNonceKey)
      this.mempoolByHash.delete(entry.userOpHash)

      this.decrementEntryCount(userOp.sender)
      this.decrementEntryCount(userOp.paymaster)
      this.decrementEntryCount(userOp.factory)
      // TODO: store and remove aggregator entity count
    }
  }

  /**
   * debug: dump mempool content
   */
  dump (): MempoolDump {
    return Array.from(this.mempoolBySenderNonce.values()).map(entry => entry.userOp)
  }

  /**
   * for debugging: clear current in-memory state
   */
  clearState (): void {
    this.mempoolBySenderNonce.clear()
    this.mempoolByHash.clear()
    this._entryCount = {}
  }

  /**
   * Returns all addresses that are currently known to be "senders" according to the current mempool.
   */
  getKnownSenders (): string[] {
    const senders: string[] = []
    for (const entry of this.mempoolBySenderNonce.values()) {
      senders.push(entry.userOp.sender.toLowerCase())
    }
    return senders
  }

  /**
   * Returns all addresses that are currently known to be any kind of entity according to the current mempool.
   * Note that "sender" addresses are not returned by this function. Use {@link getKnownSenders} instead.
   */
  getKnownEntities (): string[] {
    const res: string[] = []
    for (const entry of this.mempoolBySenderNonce.values()) {
      if (entry.userOp.paymaster != null) {
        res.push(entry.userOp.paymaster.toLowerCase())
      }
      if (entry.userOp.factory != null) {
        res.push(entry.userOp.factory.toLowerCase())
      }
    }
    return res
  }

  getMempool (): MempoolEntry[] {
    return Array.from(this.mempoolBySenderNonce.values())
  }

  // GREP-010 A `BANNED` address is not allowed into the mempool
  removeBannedAddr (addr: string): void {
    const lowerAddr = addr.toLowerCase()
    const toRemove: string[] = []

    // Collect hashes to remove
    for (const entry of this.mempoolBySenderNonce.values()) {
      const userOp = entry.userOp
      if (
        userOp.sender.toLowerCase() === lowerAddr ||
        userOp.paymaster?.toLowerCase() === lowerAddr ||
        userOp.factory?.toLowerCase() === lowerAddr
      ) {
        toRemove.push(entry.userOpHash)
      }
    }

    // Remove collected entries
    for (const hash of toRemove) {
      this.removeUserOp(hash)
    }
  }
}
