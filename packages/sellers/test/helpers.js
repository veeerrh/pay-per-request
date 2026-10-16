import http from 'node:http';
import { createRequire } from 'node:module';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const require = createRequire(import.meta.url);
const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');

export const closers = [];
export const closeAll = () => Promise.all(closers.splice(0).map((c) => c()));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = (server) => () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

/** Stand-in facilitator that counts verify and settle calls. */
export async function stubFacilitator() {
  const count = { verify: 0, settle: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/supported') return send({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: { 'eip155:*': [] } });
      const payer = (body ? JSON.parse(body) : {}).paymentPayload?.payload?.authorization?.from;
      if (req.url === '/verify') { count.verify++; return send({ isValid: true, payer }); }
      if (req.url === '/settle') { count.settle++; return send({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer }); }
      res.writeHead(404); res.end();
    });
  });
  const port = await listen(server);
  closers.push(stop(server));
  return { url: `http://127.0.0.1:${port}`, count };
}

export async function serve(app) {
  const server = http.createServer(app);
  const port = await listen(server);
  closers.push(stop(server));
  return `http://127.0.0.1:${port}`;
}

/** A real x402 v2 payment header signed with a throwaway key (valid against the stub facilitator). */
export async function signedHeader(url, init = {}) {
  const r = await fetch(url, init);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  return new x402HTTPClient(client).encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
}

export const decode402 = (r) => JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
