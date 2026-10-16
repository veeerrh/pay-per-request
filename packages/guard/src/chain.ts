import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import type { ChainReader } from './chain-types';
import { USDC_ADDRESS } from './money';

// Verified against the live Base Sepolia USDC contract: authorizationState(address,bytes32) and
// event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce).
export const USDC_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** Max blocks per eth_getLogs call. 200 fits the public Base Sepolia RPC; raise it with LOG_RANGE if you use a provider key. */
export const LOG_RANGE = BigInt(process.env.LOG_RANGE || 200);

export function createPublicChainClient(rpcUrl = 'https://sepolia.base.org'): PublicClient {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) }) as PublicClient;
}

export interface ChainTransfer { txHash: string; to: string; value: bigint; blockNumber: bigint }
export type ReceiptStatus = 'success' | 'reverted' | 'missing';

/** Everything reconciliation needs, on top of the recovery reads. */
export interface ReconcileChain extends ChainReader {
  blockNumber(): Promise<bigint>;
  /** USDC Transfer logs with from = `from`, starting at `fromBlock`. Throws if the chain cannot be read. */
  getTransfersFrom(from: string, fromBlock: bigint): Promise<ChainTransfer[]>;
  getReceiptStatus(txHash: string): Promise<ReceiptStatus>;
  balanceOf(address: string): Promise<bigint>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries with exponential backoff and jitter (429s, timeouts). Throws after the last attempt. */
export async function withBackoff<T>(fn: () => Promise<T>, tries = 4, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(baseMs * 2 ** i + Math.floor(Math.random() * 150));
    }
  }
  throw last;
}

export function createChainReader(rpcUrl?: string): ReconcileChain & { client: PublicClient } {
  const client = createPublicChainClient(rpcUrl);
  const usdc = USDC_ADDRESS as `0x${string}`;
  return {
    client,
    blockNumber: () => client.getBlockNumber(),
    authorizationState: (authorizer, nonce) =>
      client.readContract({ address: usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [authorizer as `0x${string}`, nonce as `0x${string}`] }),
    balanceOf: (a) => client.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [a as `0x${string}`] }),
    // The public RPC limits eth_getLogs to a 200 block range (found in a live check), so scan backwards in
    // chunks and stop at the first hit. Base Sepolia makes a block about every 2 seconds.
    async findAuthorizationUse(authorizer, nonce, lookbackBlocks = 1800) {
      const head = await client.getBlockNumber();
      const floor = head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n;
      for (let to = head; to >= floor; to -= LOG_RANGE) {
        const from = to - LOG_RANGE + 1n > floor ? to - LOG_RANGE + 1n : floor;
        const logs = await withBackoff(() =>
          client.getLogs({ address: usdc, event: USDC_ABI[2], args: { authorizer: authorizer as `0x${string}`, nonce: nonce as `0x${string}` }, fromBlock: from, toBlock: to }),
        );
        if (logs.length) return { txHash: logs[0].transactionHash as string };
        if (from === floor) break;
      }
      return null;
    },
    async getTransfersFrom(from, fromBlock) {
      const head = await client.getBlockNumber();
      const out: ChainTransfer[] = [];
      for (let start = fromBlock; start <= head; start += LOG_RANGE) {
        const end = start + LOG_RANGE - 1n > head ? head : start + LOG_RANGE - 1n;
        const logs = await withBackoff(() => client.getLogs({ address: usdc, event: USDC_ABI[3], args: { from: from as `0x${string}` }, fromBlock: start, toBlock: end }));
        for (const l of logs) out.push({ txHash: (l.transactionHash as string).toLowerCase(), to: l.args.to as string, value: l.args.value as bigint, blockNumber: l.blockNumber as bigint });
      }
      return out;
    },
    async getReceiptStatus(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch (e) {
        if (/not.?found|could not be found/i.test((e as Error).message)) return 'missing';
        throw e;
      }
    },
  };
}
