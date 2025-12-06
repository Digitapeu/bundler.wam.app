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
   */
  async handlePastEvents (): Promise<void> {
    const currentBlock = await this.entryPoint.provider.getBlockNumber()
    if (this.lastBlock === undefined) {
      this.lastBlock = Math.max(1, currentBlock - 1000)
    }
    
    // Query in chunks to avoid provider block range limits
    let fromBlock = this.lastBlock
    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(fromBlock + this.logFetchBlockRange - 1, currentBlock)
      try {
        const events = await this.entryPoint.queryFilter(
          { address: this.entryPoint.address },
          fromBlock,
          toBlock
        )
        for (const ev of events) {
          this.handleEvent(ev)
        }
      } catch (e) {
        // if we processed latest block, then "lastBlock" is set to one above, so the new geth 15.9 error can safely be ignored.
        if (!(e as Error).message.includes('invalid block range params')) {
          debug('queryFilter error for blocks %d-%d: %s', fromBlock, toBlock, (e as Error).message)
          throw e
        }
      }
      fromBlock = toBlock + 1
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
