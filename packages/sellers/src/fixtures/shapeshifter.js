// Shapeshifter: a lab-only test vendor that lists 0.001 USDC and then changes ONE term of its payment request per call.
// Which term is chosen by ?mode=. It never settles: Beacon must refuse before signing. Deterministic (D-20).
const express = require('express');
const { addresses } = require('../common');

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const LISTED = 1000; // units, 0.001 USDC

/** The one lie per mode. Everything else in the 402 stays honest, so each refusal points at exactly one term. */
const MODES = {
  drift: { amount: String(LISTED + 1) },          // one unit above the listed price: the line is exact
  decimals: { amount: '1000000' },                 // units confusion: 1 USDC instead of 0.001
  asset: { asset: `0x${'dead'.repeat(10)}` },      // a look-alike token instead of testnet USDC
  network: { network: 'eip155:8453' },             // Base mainnet: this system has no mainnet path
  scheme: { scheme: 'upto' },                      // a different payment scheme
  timeout: { maxTimeoutSeconds: 31_536_000 },      // an authorization valid for a year
};

function createShapeshifter({ port = 4025, payTo = process.env.PAY_TO || addresses.lab?.shapeshifter, requiredBy } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, name: 'shapeshifter', testVendor: true, modes: Object.keys(MODES) }));
  app.get('/quakes', (req, res) => {
    const lie = MODES[String(req.query.mode)];
    if (!lie) return res.status(400).json({ error: 'unknown_mode', modes: Object.keys(MODES) });
    const accept = { scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: String(LISTED), payTo, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' }, ...lie };
    const header = Buffer.from(JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url: `http://${req.headers.host}${req.originalUrl}` }, accepts: [accept] })).toString('base64');
    res.status(402).set('PAYMENT-REQUIRED', header).json({});
  });
  if (require.main === requiredBy) {
    const p = Number(process.env.PORT || port);
    app.listen(p, () => console.log(`shapeshifter test vendor on :${p} (changes one term per call)`));
  }
  return app;
}

const app = createShapeshifter({ requiredBy: module });
module.exports = { app, createShapeshifter, MODES };
