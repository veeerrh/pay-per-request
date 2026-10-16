export const BASE_SEPOLIA_NETWORK = 'eip155:84532';
export const BASE_SEPOLIA_CHAIN_ID = '84532';
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Refuses to run on anything except Base Sepolia and its USDC (M-40, S-56). */
export function assertTestnet(env: Record<string, string | undefined>): void {
  if (env.NETWORK !== BASE_SEPOLIA_NETWORK) throw new Error(`REFUSING: NETWORK must be ${BASE_SEPOLIA_NETWORK}`);
  if (env.CHAIN_ID !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`REFUSING: CHAIN_ID must be ${BASE_SEPOLIA_CHAIN_ID}`);
  if ((env.USDC_ADDRESS || '').toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) throw new Error('REFUSING: USDC_ADDRESS is not the Base Sepolia USDC');
}
