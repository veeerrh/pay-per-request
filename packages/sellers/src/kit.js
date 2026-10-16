// Seller kit: one paid route that never works for free and never charges for failure.
// Order (design 6.5, X-10): validate input -> 402 -> facilitator verify -> claim nonce -> work -> validate
// our own output -> facilitator settle. The standard @x402/express middleware verifies first, buffers the
// handler response, and settles ONLY if the handler answered below 400, so a failure never settles.
// Spike result (Milestone 3.1): the middleware already defers settlement, so we wrap it instead of rewriting it.
const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ClaimStore, formatUsdc, assertTestnet, createLogger } = require('@di06/guard');

const NETWORK = 'eip155:84532';
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`handler timed out after ${ms} ms`)), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

function nonceFromHeader(h) {
  try {
    const j = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    const a = j?.payload?.authorization;
    return a?.nonce ? { nonce: String(a.nonce), payer: String(a.from || '') } : null;
  } catch { return null; }
}

/**
 * opts: { name, method, path, priceUnits (string), payTo, description, claimsDb, facilitatorUrl,
 *         inputCheck(req)->string|null, handler(req)->object, outputCheck(output)->string|null, handlerTimeoutMs }
 */
function createSellerApp(opts) {
  assertTestnet({ NETWORK, CHAIN_ID: '84532', USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
  const log = createLogger((l) => console.log(`[${opts.name}] ${l}`));
  const claims = new ClaimStore(opts.claimsDb || ':memory:');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, name: opts.name, payTo: opts.payTo, network: NETWORK }));

  const method = (opts.method || 'GET').toUpperCase();
  const routeKey = `${method} ${opts.path}`;

  // 1. Input is validated BEFORE any 402, so a bad request is never asked for money (M-69).
  app.use(opts.path, (req, res, next) => {
    if (req.method !== method) return next();
    const err = opts.inputCheck ? opts.inputCheck(req) : null;
    if (err) return res.status(400).json({ error: 'invalid_input', detail: err });
    next();
  });

  // 2. Standard x402 v2 middleware: 402 challenge, verify, buffer, settle only on a successful handler.
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl || 'https://x402.org/facilitator' });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  const routes = {
    [routeKey]: {
      accepts: [{ scheme: 'exact', price: `$${formatUsdc(BigInt(opts.priceUnits))}`, network: NETWORK, payTo: opts.payTo, maxTimeoutSeconds: opts.maxTimeoutSeconds || 120 }],
      description: opts.description || opts.name,
    },
  };
  app.use(paymentMiddleware(routes, resourceServer));

  // 3. Claim the nonce before any work (X-08). A second claim never runs the handler.
  const claim = (req, res, next) => {
    const sig = req.get('payment-signature');
    const n = sig && nonceFromHeader(sig);
    if (!n) return res.status(402).json({ error: 'payment_authorization_unreadable' });
    if (!claims.claim(n.nonce, n.payer)) {
      log('warn', 'replay refused', { nonce: n.nonce.slice(0, 10) });
      return res.status(409).json({ error: 'authorization_already_used' });
    }
    // If anything below fails the middleware does not settle, so give the claim back (M-30).
    res.on('finish', () => { if (res.statusCode >= 400) claims.release(n.nonce); });
    next();
  };

  // 4-5. Work, then validate our own output; invalid output answers 502 and is therefore never settled (M-29).
  const work = async (req, res) => {
    let output;
    try {
      output = await withTimeout(opts.handler(req), opts.handlerTimeoutMs || 15000);
    } catch (e) {
      log('error', 'handler failed', { error: e.message });
      return res.status(500).json({ error: 'service_failed' });
    }
    const bad = opts.outputCheck ? opts.outputCheck(output) : null;
    if (bad) {
      log('error', 'own output failed validation', { detail: bad });
      return res.status(502).json({ error: 'output_failed_validation' });
    }
    res.json(output);
  };
  app[method.toLowerCase()](opts.path, claim, work);

  app.use((err, _req, res, _next) => {
    log('error', 'unhandled', { error: err.message });
    res.status(500).json({ error: 'internal_error' });
  });
  app.claims = claims;
  return app;
}

module.exports = { createSellerApp, nonceFromHeader };
