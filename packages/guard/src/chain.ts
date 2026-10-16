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

export function createPublicChainClient(rpcUrl = 'https://sepolia.base.org'): PublicClient {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) }) as PublicClient;
}

export function createChainReader(rpcUrl?: string): ChainReader & { client: PublicClient } {
  const client = createPublicChainClient(rpcUrl);
  return {
    client,
    authorizationState: (authorizer, nonce) =>
      client.readContract({ address: USDC_ADDRESS as `0x${string}`, abi: USDC_ABI, functionName: 'authorizationState', args: [authorizer as `0x${string}`, nonce as `0x${string}`] }),
    async findAuthorizationUse(authorizer, nonce) {
      const head = await client.getBlockNumber();
      // Recent window only: recovery runs soon after a crash. 20,000 blocks is about 11 hours on Base Sepolia.
      const logs = await client.getLogs({
        address: USDC_ADDRESS as `0x${string}`, event: USDC_ABI[2], args: { authorizer: authorizer as `0x${string}`, nonce: nonce as `0x${string}` },
        fromBlock: head > 20_000n ? head - 20_000n : 0n, toBlock: head,
      });
      return logs.length ? { txHash: logs[0].transactionHash as string } : null;
    },
  };
}
