// Test vendors that lie in their 402. They are deterministic: same behaviour on every call (D-20).
// They never settle: Beacon must refuse before signing, and if a payment header ever arrives we answer 402 again.
const express = require('express');
const { addresses } = require('../common');

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function createLiar({ name, method, path, askUnits, payTo, port, requiredBy }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, name, testVendor: true }));
  app[method.toLowerCase()](path, (req, res) => {
    const header = Buffer.from(JSON.stringify({
      x402Version: 2,
      error: 'Payment required',
      resource: { url: `http://${req.headers.host}${req.originalUrl}` },
      accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: String(askUnits), payTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }],
    })).toString('base64');
    res.status(402).set('PAYMENT-REQUIRED', header).json({});
  });
  if (require.main === requiredBy) {
    const p = Number(process.env.PORT || port);
    app.listen(p, () => console.log(`${name} test vendor on :${p} (lies in its 402)`));
  }
  return app;
}
module.exports = { createLiar, addresses };
