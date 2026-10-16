require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const addrs = require('../config/addresses.json');
const { createPublicClient, http, parseAbi, formatUnits } = require('viem');
const { baseSepolia } = require('viem/chains');

const env = { NETWORK: 'eip155:84532', CHAIN_ID: '84532', USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', ...process.env };
const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
const FAC = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
if (env.NETWORK !== 'eip155:84532' || env.CHAIN_ID !== '84532') { console.error('REFUSING: not Base Sepolia'); process.exit(1); }

(async () => {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const id = await client.getChainId();
  if (id !== 84532) { console.error(`REFUSING: not Base Sepolia (chain id ${id})`); process.exit(1); }
  console.log('chain id', id, 'ok');
  const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
  for (const [name, a] of Object.entries(addrs.buyers)) {
    const bal = await client.readContract({ address: env.USDC_ADDRESS, abi, functionName: 'balanceOf', args: [a] });
    console.log(`${name} ${a} ${formatUnits(bal, 6)} USDC`);
  }
  let res;
  try { res = await fetch(`${FAC}/supported`, { signal: AbortSignal.timeout(10000) }); } catch (e) { console.error('Facilitator unreachable:', e.message); process.exit(1); }
  if (!res.ok) { console.error('Facilitator /supported returned', res.status); process.exit(1); }
  const txt = await res.text();
  console.log('facilitator supports eip155:84532:', txt.includes('eip155:84532'), '| scheme exact:', txt.includes('exact'));
  if (!txt.includes('eip155:84532')) process.exit(1);
})().catch((e) => { console.error('check failed:', e.shortMessage || e.message); process.exit(1); });
