import { providers } from 'ethers';
import { Log } from '@ethersproject/providers';

// Chainstack has very strict limits, potentially as low as 100 blocks
// See: https://docs.chainstack.com/docs/limits#evm-range-limits
const DEFAULT_MAX_RANGE = 100; // Ultra-conservative for Chainstack

export async function getLogsChunked(
  provider: providers.JsonRpcProvider,
  base: providers.Filter,
  opts?: { maxRange?: number }
): Promise<Log[]> {
  const maxRange = opts?.maxRange ?? DEFAULT_MAX_RANGE;

  // Force numeric bounds
  let from = Number(base.fromBlock ?? 0);
  const to = Number(
    base.toBlock ?? (await provider.getBlockNumber())
  );

  const acc: Log[] = [];
  while (from <= to) {
    // Calculate the end block for this chunk
    const end = Math.min(from + maxRange - 1, to);
    
    // Double-check we're not exceeding the range
    const actualRange = end - from + 1;
    if (actualRange > maxRange) {
      console.error(`Warning: Block range ${actualRange} exceeds max ${maxRange}`);
    }
    
    const f: providers.Filter = {
      ...base,
      fromBlock: from,
      toBlock: end,
    };
    
    try {
      const chunk = await provider.getLogs(f);
      acc.push(...chunk);
    } catch (error: any) {
      // If we still hit a limit, try with an even smaller range
      if (error?.code === -32602 && maxRange > 10) {
        console.warn(`Block range limit hit with ${actualRange} blocks, retrying with smaller chunks...`);
        // Recursively call with half the range
        const smallerChunks = await getLogsChunked(provider, {
          ...base,
          fromBlock: from,
          toBlock: end
        }, { maxRange: Math.floor(maxRange / 2) });
        acc.push(...smallerChunks);
      } else {
        throw error;
      }
    }
    
    from = end + 1;
  }
  return acc;
}