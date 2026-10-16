/** What guard.pay() and recovery need from the chain. Implemented with viem in chain.ts, mocked in tests. */
export interface ChainReader {
  /** USDC EIP-3009 authorizationState(authorizer, nonce): true if the authorization was already used or cancelled. */
  authorizationState(authorizer: string, nonce: string): Promise<boolean>;
  /** Finds the transaction that used an authorization (AuthorizationUsed event), scanning back `lookbackBlocks`. */
  findAuthorizationUse?(authorizer: string, nonce: string, lookbackBlocks?: number): Promise<{ txHash: string } | null>;
}
