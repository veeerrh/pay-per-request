// Interoperability buyer built ONLY on the standard @x402/fetch wrapper (T-08). No custom headers or fields.
// Usage: node scripts/reference-buyer.js <url> [walletEnvName=SPARE_BUYER_PRIVATE_KEY]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');

const url = process.argv[2];
const envName = process.argv[3] || 'SPARE_BUYER_PRIVATE_KEY';
if (!url || !process.env[envName]) { console.error(`usage: reference-buyer.js <url> [ENV_NAME]; ${envName} must be set in .env`); process.exit(1); }
const account = privateKeyToAccount(process.env[envName]);
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:84532', client: new ExactEvmScheme(account) }] });

(async () => {
  console.log('buyer', account.address, '->', url);
  const res = await pay(url, { method: 'GET' });
  console.log('status', res.status);
  console.log('body', (await res.text()).slice(0, 300));
  const h = res.headers.get('PAYMENT-RESPONSE');
  console.log('settlement', h ? decodePaymentResponseHeader(h) : 'none (not settled)');
})().catch((e) => { console.error('reference buyer failed:', e.message); process.exitCode = 1; });
