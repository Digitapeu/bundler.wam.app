import { AccountDeployedEvent, UserOperationEventEvent } from '@account-abstraction/contracts/dist/types/EntryPoint'
import { ReputationManager } from './ReputationManager'
import { EntryPoint } from '@account-abstraction/contracts'
import Debug from 'debug'
import { SignatureAggregatorChangedEvent } from '@account-abstraction/contracts/types/EntryPoint'
import { TypedEvent } from '@account-abstraction/contracts/dist/types/common'
import { MempoolManager } from './MempoolManager'
import { getLogsChunked } from '../utils/getLogsChunked'
import { providers } from 'ethers'

const debug = Debug('aa.events')
const MAX_RANGE = 100; // Very conservative limit for strict RPC providers like Chainstack

/**
 * listen to events. trigger ReputationManager's Included
 */
export class EventsManager {
  lastBlock?: number

  constructor (
    readonly entryPoint: EntryPoint,
    readonly mempoolManager: MempoolManager,
    readonly reputationManager: ReputationManager) {
  }

  /**
   * automatically listen to all UserOperationEvent events
   */
  initEventListener (): void {
    // IMPORTANT: We cannot use ethers' built-in .on() listener because it may
    // internally call getLogs with large block ranges that exceed RPC limits.
    // Instead, we'll use a manual polling mechanism with our chunked approach.
    
    // Store the last processed block to avoid reprocessing
    let lastProcessedBlock: number | undefined
    
    // Poll for new events every few seconds
    const pollInterval = 5000 // 5 seconds
    
    const pollForEvents = async () => {
      try {
        const provider = this.entryPoint.provider as providers.JsonRpcProvider
        const currentBlock = await provider.getBlockNumber()
        
        if (lastProcessedBlock === undefined) {
          // Start from current block on first run
          lastProcessedBlock = currentBlock
          return
        }
        
        if (currentBlock <= lastProcessedBlock) {
          return // No new blocks
        }
        
        // Fetch events from last processed block to current
        const filter = {
          address: this.entryPoint.address,
          topics: this.entryPoint.filters.UserOperationEvent().topics,
          fromBlock: lastProcessedBlock + 1,
          toBlock: currentBlock
        }
        
        const logs = await getLogsChunked(provider, filter, { maxRange: MAX_RANGE })
        
        // Process each log as an event
        for (const log of logs) {
          try {
            const parsedLog = this.entryPoint.interface.parseLog(log)
            if (parsedLog.name === 'UserOperationEvent') {
              const event = {
                ...log,
                ...parsedLog,
                args: parsedLog.args,
                event: parsedLog.name,
                getTransaction: async () => provider.getTransaction(log.transactionHash),
                getTransactionReceipt: async () => provider.getTransactionReceipt(log.transactionHash),
                getBlock: async () => provider.getBlock(log.blockHash)
              } as any
              
              void this.handleEvent(event)
            }
          } catch (e) {
            // Log might be from a different event we don't care about
            debug('Could not parse log in listener', e)
          }
        }
        
        lastProcessedBlock = currentBlock
      } catch (error) {
        console.error('Error polling for events:', error)
      }
    }
    
    // Start polling
    pollForEvents() // Initial poll
    setInterval(pollForEvents, pollInterval)
  }

  /**
   * process all new events since last run
   */
  async handlePastEvents (): Promise<void> {
    if (this.lastBlock === undefined) {
      this.lastBlock = Math.max(1, await this.entryPoint.provider.getBlockNumber() - 1000)
    }
    
    // Use chunked log fetching to avoid RPC block range limits
    const provider = this.entryPoint.provider as providers.JsonRpcProvider
    const currentBlock = await provider.getBlockNumber()
    
    const filter = {
      address: this.entryPoint.address,
      fromBlock: this.lastBlock,
      toBlock: currentBlock
    }
    
    const logs = await getLogsChunked(provider, filter, { maxRange: MAX_RANGE })
    
    // Parse logs into events
    for (const log of logs) {
      try {
        const parsedLog = this.entryPoint.interface.parseLog(log)
        const event = {
          ...log,
          ...parsedLog,
          args: parsedLog.args,
          event: parsedLog.name,
          getTransaction: async () => provider.getTransaction(log.transactionHash),
          getTransactionReceipt: async () => provider.getTransactionReceipt(log.transactionHash),
          getBlock: async () => provider.getBlock(log.blockHash)
        } as any
        
        this.handleEvent(event)
      } catch (e) {
        // Log might be from a different event we don't care about
        debug('Could not parse log', e)
      }
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
    if (data != null && data.length > 42) {
      const addr = data.slice(0, 42)
      this.reputationManager.updateIncludedStatus(addr)
    }
  }
}
