# Bundler Optimization Plan

> **Date**: December 2024  
> **Target**: EIP-4337 Bundler on Cronos  
> **Goal**: 100x performance improvement + fix DB sync issues

---

## Legend

- 🔴 **P0** - Critical / Do immediately
- 🟠 **P1** - High impact / Do this week  
- 🟡 **P2** - Medium impact / Do when possible
- ⚪ **P3** - Nice to have / Future

---

## Phase 0: Fix DB Sync (Blocking Issue)

| ID | Priority | Issue | File(s) | Change | Impact |
|----|----------|-------|---------|--------|--------|
| F1 | 🔴 P0 | No startup event sync | `runBundler.ts:219` | Add `await eventsManager.handlePastEvents()` after `initEventListener()` | Fixes missing receipts after restart |
| F2 | 🔴 P0 | Fire-and-forget events | `BundleManager.ts:187` | Option to await confirmation before returning | Fixes race with DB syncer |
| F3 | 🔴 P0 | Chainstack block limits | Config | Set `logFetchBlockRange: 50` | Prevents silent query failures |
| F4 | 🔴 P0 | Missing lookback config | Config | Add `logFetchLookbackBlocks: 1000` | Ensures full search range |

---

## Phase 1: Critical Performance

| ID | Priority | Bottleneck | File(s) | Change | Impact | Notes |
|----|----------|------------|---------|--------|--------|-------|
| P1 | 🔴 P0 | O(n) mempool lookups | `MempoolManager.ts` | Replace array with `Map<string, MempoolEntry>` using `${sender}-${nonce}` key | **10-50x** lookup speed | Linear scan on every add/remove |
| P2 | 🔴 P0 | Re-validation too aggressive | `BundleManager.ts:396` | Extend `isRecentlyValidated(2000)` → `isRecentlyValidated(30000)` | **2-5x** bundle creation | 2s is too short for Cronos 6s blocks |
| P3 | 🟠 P1 | Code hash fetched every time | `ValidationManager.ts:470` | Add LRU cache for `getCodeHashes()` with 60s TTL | **2-3x** validation | Same contracts validated repeatedly |
| P4 | 🟠 P1 | Sequential event log chunks | `EventsManager.ts:49-69` | Parallel chunk fetching with `Promise.all()` | **5-10x** event sync | Currently awaits each chunk |
| P5 | 🟠 P1 | Sequential receipt log chunks | `MethodHandlerERC4337.ts:253-271` | Same parallel pattern | **5-10x** receipt lookup | Same issue |

---

## Phase 2: Significant Performance

| ID | Priority | Bottleneck | File(s) | Change | Impact | Notes |
|----|----------|------------|---------|--------|--------|-------|
| P6 | 🟠 P1 | Batch RPC still useful | `BundlerServer.ts:131-135` | Parallel processing for **non-sendUserOperation** methods | **5-20x** for batch queries | `sendUserOperation` is mutex-bound anyway |
| P7 | 🟠 P1 | Sequential deposit checks | `DepositManager.ts:140-149` | Batch paymaster deposit checks via multicall | **2-3x** deposit validation | Iterates mempool for each check |
| P8 | 🟠 P1 | Full sort every bundle | `MempoolManager.ts:211-220` | Use heap/priority queue or insertion sort | **O(n log n) → O(log n)** per op | Sorts entire mempool each bundle |
| P9 | 🟡 P2 | UserOp hash computed twice | `ExecutionManager.ts` + `BundleManager.ts` | Cache hash in `MempoolEntry` | Minor | Already cached, ensure reuse |
| P10 | 🟡 P2 | Sync ABI file reads | `MethodHandlerERC4337.ts:616` | Async read on startup, cache in memory | Startup time | Blocking I/O |

---

## Phase 3: Bug Fixes & Stability

| ID | Priority | Bug | File(s) | Fix | Risk |
|----|----------|-----|---------|-----|------|
| B1 | 🟠 P1 | Dual mutex race condition | `ExecutionManager.ts` + `BundleManager.ts` | Coordinate or unify mutexes | State corruption under load |
| B2 | 🟠 P1 | Memory leak in deposit cache | `DepositManager.ts:83-91` | Proper cache eviction with max size | Memory growth over time |
| B3 | 🟡 P2 | Cleanup race with bundling | `MempoolManager.ts:65-78` | Mutex protection for cleanup | Can remove mid-bundle |
| B4 | 🟡 P2 | Silent failures in fire-and-forget | Multiple | Add error tracking/metrics | Hard to debug issues |
| B5 | 🟡 P2 | AA25 nonce error assumed success | `BundleManager.ts:409-414` | Verify tx actually succeeded on-chain | False positive removals |
| B6 | 🟡 P2 | `lastUserOpEventBlock` skips | `MethodHandlerERC4337.ts:268` | Reset on gaps or use separate per-query search | Missed events |

---

## Phase 4: Architecture (Scale)

| ID | Priority | Improvement | File(s) | Change | When Needed |
|----|----------|-------------|---------|--------|-------------|
| A1 | 🟡 P2 | Worker threads | `runBundler.ts` | Use Node.js `cluster` module | >100 UserOps/min |
| A2 | 🟡 P2 | Batch RPC calls | `ValidationManager.ts` | Use multicall for stake/deposit/code queries | High RPC costs |
| A3 | ⚪ P3 | External mempool | New module | Redis-backed mempool | Horizontal scaling |
| A4 | ⚪ P3 | Connection pooling | Provider setup | Pool RPC connections | High concurrency |
| A5 | ⚪ P3 | Metrics/monitoring | New module | Prometheus metrics for latency, queue depth | Production ops |

---

## Design Decision Summary

These patterns exist for good reasons and have limited optimization potential:

| Pattern | Why It Exists | Can We Optimize? |
|---------|---------------|------------------|
| **Sequential batch processing** | Mutex serializes mempool writes anyway | ✅ Yes for non-write methods (getReceipt, estimate) |
| **Double validation** | ERC-4337 spec requirement - state can change | ✅ Yes, extend cache window (2s → 30s for Cronos) |
| **Mutex on sendUserOperation** | State consistency for paymaster/entity accounting | ❌ No, required for correctness |
| **Fire-and-forget confirmation** | Speed - return hash immediately | ✅ Optional: add config flag to wait |

---

## Expected Impact by Phase

| Phase | Effort | Throughput Gain | Latency Reduction |
|-------|--------|-----------------|-------------------|
| Phase 0 | 1 day | N/A (fixes) | Fixes broken receipts |
| Phase 1 | 2-3 days | **10-50x** | **50-80%** |
| Phase 2 | 3-5 days | **2-5x** additional | **20-40%** additional |
| Phase 3 | 2-3 days | Stability | Prevents degradation |
| Phase 4 | 1-2 weeks | Horizontal scale | Minimal per-request |

---

## Recommended Execution Order

```
Week 1:
├── Day 1-2: Phase 0 (DB sync fixes)
│   ├── F1: Startup event sync
│   ├── F2: Optional confirmation wait
│   └── F3-F4: Config fixes
│
├── Day 3-5: Phase 1 Critical
│   ├── P1: Map-based mempool
│   ├── P2: Extend validation cache
│   └── P3: Code hash LRU cache

Week 2:
├── Day 1-3: Phase 1 + 2
│   ├── P4-P5: Parallel log fetching
│   ├── P6: Parallel batch for reads
│   └── P7: Batch deposit checks
│
├── Day 4-5: Phase 3 Bugs
│   ├── B1: Mutex coordination
│   └── B2: Cache eviction

Week 3+:
└── Phase 4 as needed based on load
```

---

## Config Recommendations

```json
{
  "network": "$JSON_RPC_URL",
  "port": "3000",
  "chainId": 25,
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "senderCreator": "0x449ED7C3e6Fee6a97311d4b55475DF59C44AdD33",
  "beneficiary": "$BENEFICIARY",
  "gasFactor": "1.1",
  "minBalance": "0.1",
  "minStake": "0.5",
  "minUnstakeDelay": 0,
  "maxBundleGas": 5000000,
  "autoBundleInterval": 3,
  "autoBundleMempoolSize": 1,
  "paymasterMaxPendingOps": 50,
  "logFetchBlockRange": 50,
  "logFetchLookbackBlocks": 1000,
  "rip7560": false,
  "eip7702Support": true
}
```

---

## Changelog

| Date | Change | Status |
|------|--------|--------|
| 2024-12-31 | Initial plan created | ✅ |
| 2024-12-31 | F1: Startup event sync implemented | ✅ |
| 2024-12-31 | F2: waitForConfirmation config option added | ✅ |
| 2024-12-31 | P1: Map-based mempool with O(1) lookups | ✅ |
| 2024-12-31 | P2: Validation cache extended to 30s | ✅ |
| 2024-12-31 | P3: LRU cache for code hashes (60s TTL) | ✅ |
| 2024-12-31 | P4: Parallel event log fetching (5 concurrent) | ✅ |
| 2024-12-31 | P5: Receipt log fetching - SKIPPED (early return is better) | ⏭️ |
| 2024-12-31 | P6: Parallel batch RPC for read methods | ✅ |
| 2024-12-31 | B1: Mutex coordination - REVIEWED (design is correct) | ✅ |
| 2024-12-31 | B2: Deposit cache LRU with max size (500 entries) | ✅ |
| 2024-12-31 | P7: Batch deposit checks - SKIPPED (low impact) | ⏭️ |
| 2024-12-31 | P8: Priority queue - SKIPPED (O(n log n) optimal for bulk) | ⏭️ |

## Files Modified

- `packages/bundler/src/runBundler.ts` - F1: Added startup event sync
- `packages/bundler/src/BundlerConfig.ts` - F2: Added waitForConfirmation option
- `packages/bundler/src/modules/BundleManager.ts` - F2: Implemented confirmation wait, P2: Extended revalidation window
- `packages/bundler/src/modules/initServer.ts` - F2: Pass config to BundleManager
- `packages/bundler/src/modules/MempoolManager.ts` - P1: Complete refactor to use Maps
- `packages/bundler/src/modules/MempoolEntry.ts` - P2: Extended validation grace period
- `packages/bundler/src/modules/EventsManager.ts` - P4: Parallel chunk fetching
- `packages/bundler/src/BundlerServer.ts` - P6: Parallel batch processing for reads
- `packages/validation-manager/src/ValidationManager.ts` - P3: LRU cache for code hashes
- `packages/bundler/src/modules/DepositManager.ts` - B2: LRU cache with max size limit

