import { providers } from 'ethers';
import { Log } from '@ethersproject/providers';

const DEFAULT_MAX_RANGE = 2000; // tune to your RPC cap

export async function getLogsChunked(
  provider: providers.JsonRpcProvider,
  base: providers.Filter,
  opts?: { maxRange?: number }
): Promise<Log[]> {
  const maxRange = opts?.maxRange ?? DEFAULT_MAX_RANGE;

  // Force numeric bounds (fixes your TS error)
  let from = Number(base.fromBlock ?? 0);
  const to = Number(
    base.toBlock ?? (await provider.getBlockNumber())
  );

  const acc: Log[] = [];
  while (from <= to) {
    const end = Math.min(from + maxRange - 1, to);
    const f: providers.Filter = {
      ...base,
      fromBlock: from,
      toBlock: end,
    };
    const chunk = await provider.getLogs(f);
    acc.push(...chunk);
    from = end + 1;
  }
  return acc;
}