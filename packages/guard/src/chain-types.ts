/** What guard.pay() and recovery need from the chain. Implemented with viem in chain.ts (2.5), mocked in tests. */
export interface ChainReader {
  /** USDC EIP-3009 authorizationState(authorizer, nonce): true if the authorization was already used or cancelled. */
  authorizationState(authorizer: string, nonce: string): Promise<boolean>;
}
