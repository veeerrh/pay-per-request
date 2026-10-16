// Replay harness (A-16, T-05). Signs ONE payment, sends it once, again, then signs another and sends it 5 times in parallel.
// Expected: exactly one 200 per signed payment, the rest refused, exactly one on-chain transfer per signed payment.
// Usage: node scripts/replay.js <sellerUrl> [WALLET_ENV_NAME=REPLAY_PRIVATE_KEY]
// The replay wallet is separate from Beacon on purpose (M-68, S-93).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, parseAbi } = require('viem');
const { baseSepolia } = require('viem/chains');

const url = process.argv[2];
const envName = process.argv[3] || 'REPLAY_PRIVATE_KEY';
if (!url || !process.env[envName]) { console.error(`usage: replay.js <url> [ENV_NAME]; ${envName} must be set`); process.exit(1); }
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const account = privateKeyToAccount(process.env[envName]);
const chain = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || 'https://sepolia.base.org') });
const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
const http402 = new x402HTTPClient(client);

async function sign() {
  const r = await fetch(url);
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  return { headers: http402.encodePaymentSignatureHeader(await client.createPaymentPayload(pr)), payTo: pr.accepts[0].payTo };
}

async function transfersSince(fromBlock, payTo) {
  const head = await chain.getBlockNumber();
  let n = 0; const hashes = new Set();
  for (let from = fromBlock; from <= head; from += 200n) {
    const to = from + 199n > head ? head : from + 199n;
    const logs = await chain.getLogs({ address: USDC, event: abi[0], args: { from: account.address, to: payTo }, fromBlock: from, toBlock: to });
    logs.forEach((l) => hashes.add(l.transactionHash));
  }
  return [...hashes];
}

(async () => {
  console.log('replay wallet', account.address, '->', url);
  const startBlock = await chain.getBlockNumber();
  const a = await sign();
  const send = (h) => fetch(url, { headers: h }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 80) }));

  const first = await send(a.headers);
  const second = await send(a.headers);
  console.log('stage 1 (once):          ', first.status, first.body);
  console.log('stage 2 (same header):   ', second.status, second.body);

  const b = await sign();
  const par = await Promise.all(Array.from({ length: 5 }, () => send(b.headers)));
  console.log('stage 3 (5 in parallel): ', par.map((p) => p.status).join(', '));

  await new Promise((r) => setTimeout(r, 4000));
  const txs = await transfersSince(startBlock, a.payTo);
  const ok200 = [first, ...par].filter((p) => p.status === 200).length;
  console.log('on-chain transfers from replay wallet:', txs.length, txs);
  const pass = first.status === 200 && second.status !== 200 && par.filter((p) => p.status === 200).length === 1 && txs.length === 2;
  console.log(pass ? 'PASS: one response and one transfer per signed payment' : `FAIL (200s: ${ok200}, transfers: ${txs.length})`);
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('replay failed:', e.message); process.exitCode = 1; });
