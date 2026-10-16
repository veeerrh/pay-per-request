import { describe, it, expect } from 'vitest';
import { assertTestnet, BASE_SEPOLIA_USDC } from '../src/netguard';
const ok = { NETWORK: 'eip155:84532', CHAIN_ID: '84532', USDC_ADDRESS: BASE_SEPOLIA_USDC };
describe('assertTestnet', () => {
  it('accepts Base Sepolia', () => expect(() => assertTestnet(ok)).not.toThrow());
  it('refuses mainnet', () => expect(() => assertTestnet({ ...ok, NETWORK: 'eip155:8453', CHAIN_ID: '8453' })).toThrow());
  it('refuses a different asset', () => expect(() => assertTestnet({ ...ok, USDC_ADDRESS: '0x0000000000000000000000000000000000000001' })).toThrow());
});
