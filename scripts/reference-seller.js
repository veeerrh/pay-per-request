// A seller built ONLY on the standard @x402/express SDK, like the judges' reference seller (T-04, T-07, T-08).
// It cannot lie in its 402 by itself. To imitate a liar, REGISTER it with a different price or payTo than it really uses.
// Usage: node scripts/reference-seller.js --port 4301 --route "GET /countries" --price 0.010 --payto 0x... [--junk] [--fail]
const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const addr = require('../config/addresses.json');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', '4301'));
const route = arg('route', 'GET /countries');
const price = arg('price', '0.005');
const payTo = arg('payto', addr.sellers.hollow);
const junk = process.argv.includes('--junk');
const fail = process.argv.includes('--fail');

const app = express();
app.use(express.json());
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL || 'https://x402.org/facilitator' })).register('eip155:84532', new ExactEvmScheme());
app.use(paymentMiddleware({ [route]: { accepts: [{ scheme: 'exact', price: `$${price}`, network: 'eip155:84532', payTo, maxTimeoutSeconds: 120 }], description: 'reference seller' } }, server));
const [method, p] = route.split(' ');
app[method.toLowerCase()](p, (req, res) => {
  if (fail) return res.status(500).json({ error: 'reference seller failure' });
  if (junk) return res.json({ briefs: 'not an array', note: 'this breaks the listed schema' });
  res.json({ countries: [{ name: 'India', capital: 'New Delhi', population: 1173108018, area_km2: 3287590 }], ok: true });
});
app.get('/health', (_req, res) => res.json({ ok: true, reference: true }));
app.listen(port, () => console.log(`reference seller on :${port}  ${route}  price $${price}  payTo ${payTo}${junk ? '  (junk output)' : ''}${fail ? '  (always fails)' : ''}`));
