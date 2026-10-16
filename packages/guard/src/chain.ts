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

export function createChainReader(rpcUrl?: string): ChainReader & { client: PublicClient } {
  const client = createPublicChainClient(rpcUrl);
  return {
    client,
    authorizationState: (authorizer, nonce) =>
      client.readContract({ address: USDC_ADDRESS as `0x${string}`, abi: USDC_ABI, functionName: 'authorizationState', args: [authorizer as `0x${string}`, nonce as `0x${string}`] }),
    // The public RPC limits eth_getLogs to a 200 block range (found in a live check), so scan backwards in
    // chunks and stop at the first hit. Base Sepolia makes a block about every 2 seconds.
    async findAuthorizationUse(authorizer, nonce, lookbackBlocks = 1800) {
      const head = await client.getBlockNumber();
      const floor = head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n;
      for (let to = head; to >= floor; to -= LOG_RANGE) {
        const from = to - LOG_RANGE + 1n > floor ? to - LOG_RANGE + 1n : floor;
        const logs = await client.getLogs({
          address: USDC_ADDRESS as `0x${string}`, event: USDC_ABI[2], args: { authorizer: authorizer as `0x${string}`, nonce: nonce as `0x${string}` },
          fromBlock: from, toBlock: to,
        });
        if (logs.length) return { txHash: logs[0].transactionHash as string };
        if (from === floor) break;
      }
      return null;
    },
  };
}
