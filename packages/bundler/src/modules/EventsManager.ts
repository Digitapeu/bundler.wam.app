import { ReputationManager } from './ReputationManager'
import Debug from 'debug'
import { MempoolManager } from './MempoolManager'
import { TypedEvent } from '../types/common'
import {
  AccountDeployedEvent, IEntryPoint,
  SignatureAggregatorChangedEvent,
  UserOperationEventEvent
} from '@account-abstraction/utils'

const debug = Debug('aa.events')

/**
 * listen to events. trigger ReputationManager's Included
 */
export class EventsManager {
  lastBlock?: number
  private readonly logFetchBlockRange: number

  constructor (
    readonly entryPoint: IEntryPoint,
    readonly mempoolManager: MempoolManager,
    readonly reputationManager: ReputationManager,
    logFetchBlockRange: number = 100
  ) {
    this.logFetchBlockRange = Math.max(1, logFetchBlockRange)
  }

  /**
   * automatically listen to all UserOperationEvent events
   */
  initEventListener (): void {
    this.entryPoint.on(this.entryPoint.filters.UserOperationEvent(), (...args) => {
      const ev = args.slice(-1)[0]
      void this.handleEvent(ev as any)
    })
  }

  /**
   * process all new events since last run
   * P4: Parallel chunk fetching for faster event sync
   */
  async handlePastEvents (): Promise<void> {
    const currentBlock = await this.entryPoint.provider.getBlockNumber()
    if (this.lastBlock === undefined) {
      this.lastBlock = Math.max(1, currentBlock - 1000)
    }

    // P4: Build list of chunk ranges to fetch in parallel
    const chunks: Array<{ fromBlock: number, toBlock: number }> = []
    let fromBlock = this.lastBlock
    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(fromBlock + this.logFetchBlockRange - 1, currentBlock)
      chunks.push({ fromBlock, toBlock })
      fromBlock = toBlock + 1
    }

    if (chunks.length === 0) {
      return
    }

    // P4: Fetch all chunks in parallel (limit concurrency to avoid overwhelming RPC)
    const MAX_CONCURRENT = 5
    const allEvents: Array<UserOperationEventEvent | AccountDeployedEvent | SignatureAggregatorChangedEvent> = []

    for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
      const batch = chunks.slice(i, i + MAX_CONCURRENT)
      const results = await Promise.all(
        batch.map(async ({ fromBlock, toBlock }) => {
          try {
            return await this.entryPoint.queryFilter(
              { address: this.entryPoint.address },
              fromBlock,
              toBlock
            )
          } catch (e) {
            if (!(e as Error).message.includes('invalid block range params')) {
              debug('queryFilter error for blocks %d-%d: %s', fromBlock, toBlock, (e as Error).message)
            }
            return []
          }
        })
      )
      // Flatten results
      for (const events of results) {
        allEvents.push(...events)
      }
    }

    // Sort by block number to process in order
    allEvents.sort((a, b) => a.blockNumber - b.blockNumber)

    // Process all events
    for (const ev of allEvents) {
      this.handleEvent(ev)
    }
  }

  handleEvent (ev: UserOperationEventEvent | AccountDeployedEvent | SignatureAggregatorChangedEvent): void {
    switch (ev.event) {
      case 'UserOperationEvent':
        this.handleUserOperationEvent(ev as any)
        break
      case 'AccountDeployed':
        this.handleAccountDeployedEvent(ev as any)
        break
      case 'SignatureAggregatorForUserOperations':
        this.handleAggregatorChangedEvent(ev as any)
        break
    }
    this.lastBlock = ev.blockNumber + 1
  }

  handleAggregatorChangedEvent (ev: SignatureAggregatorChangedEvent): void {
    debug('handle ', ev.event, ev.args.aggregator)
    this.eventAggregator = ev.args.aggregator
    this.eventAggregatorTxHash = ev.transactionHash
  }

  eventAggregator: string | null = null
  eventAggregatorTxHash: string | null = null

  // aggregator event is sent once per events bundle for all UserOperationEvents in this bundle.
  // it is not sent at all if the transaction is handleOps
  getEventAggregator (ev: TypedEvent): string | null {
    if (ev.transactionHash !== this.eventAggregatorTxHash) {
      this.eventAggregator = null
      this.eventAggregatorTxHash = ev.transactionHash
    }
    return this.eventAggregator
  }

  // AccountDeployed event is sent before each UserOperationEvent that deploys a contract.
  handleAccountDeployedEvent (ev: AccountDeployedEvent): void {
    this._includedAddress(ev.args.factory)
  }

  handleUserOperationEvent (ev: UserOperationEventEvent): void {
    const hash = ev.args.userOpHash
    this.mempoolManager.removeUserOp(hash)
    this._includedAddress(ev.args.sender)
    this._includedAddress(ev.args.paymaster)
    this._includedAddress(this.getEventAggregator(ev))
  }

  _includedAddress (data: string | null): void {
    if (data != null && data.length >= 42) {
      const addr = data.slice(0, 42)
      this.reputationManager.updateIncludedStatus(addr)
    }
  }
}
