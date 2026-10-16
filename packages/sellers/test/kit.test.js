import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const require = createRequire(import.meta.url);
const { createSellerApp } = require('../src/kit.js');
const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');

const PAYTO = '0xc4A183e8fA3d4093ec16D580182ae7056C878643';
const closers = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = (server) => () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

/** Stand-in facilitator: counts verify and settle calls. mode: ok | settleFails */
async function stubFacilitator(mode = 'ok') {
  const count = { verify: 0, settle: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/supported') return send({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: { 'eip155:*': [] } });
      const j = body ? JSON.parse(body) : {};
      const payer = j.paymentPayload?.payload?.authorization?.from;
      if (req.url === '/verify') { count.verify++; return send({ isValid: true, payer }); }
      if (req.url === '/settle') {
        count.settle++;
        if (mode === 'settleFails') return send({ success: false, errorReason: 'invalid_transaction_state', transaction: '', network: 'eip155:84532', payer });
        return send({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer });
      }
      send({}, 404);
    });
  });
  const port = await listen(server);
  closers.push(stop(server));
  return { url: `http://127.0.0.1:${port}`, count, stop: stop(server) };
}

async function startSeller(fac, over = {}) {
  const calls = { handler: 0 };
  const app = createSellerApp({
    name: 'test', method: 'GET', path: '/echo', priceUnits: '1000', payTo: PAYTO, facilitatorUrl: fac.url,
    claimsDb: over.claimsDb || ':memory:',
    inputCheck: (req) => (typeof req.query.msg === 'string' ? null : 'msg required'),
    handler: async (req) => { calls.handler++; if (req.query.fail === '1') throw new Error('boom'); if (req.query.junk === '1') return { junk: 1 }; return { echo: req.query.msg }; },
    outputCheck: (o) => (typeof o.echo === 'string' ? null : 'bad'),
  });
  const server = http.createServer(app);
  const port = await listen(server);
  closers.push(stop(server));
  return { base: `http://127.0.0.1:${port}`, calls, app, stop: stop(server) };
}

/** A real x402 v2 PAYMENT-SIGNATURE header, signed with a throwaway key (no funds needed against the stub). */
async function signedHeader(url) {
  const r = await fetch(url);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const http402 = new x402HTTPClient(client);
  return http402.encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
}

describe('seller kit (TC-3.1, TC-3.2)', () => {
  it('3.1-02 unpaid request gets a correct 402', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const r = await fetch(`${s.base}/echo?msg=hi`);
    expect(r.status).toBe(402);
    const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:84532', amount: '1000', payTo: PAYTO });
    expect(s.calls.handler).toBe(0);
  });
  it('3.1-01b bad input is a 400 and never a 402 (M-69)', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const r = await fetch(`${s.base}/echo`);
    expect(r.status).toBe(400);
    expect(r.headers.get('payment-required')).toBeNull();
  });
  it('paid call succeeds and settles once', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    const r = await fetch(`${s.base}/echo?msg=hi`, { headers: h });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ echo: 'hi' });
    expect(r.headers.get('payment-response')).toBeTruthy();
    expect(f.count.settle).toBe(1);
  });
  it('3.1-04 handler throws: 500, no settle, claim released (T-06)', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=x&fail=1`);
    const r = await fetch(`${s.base}/echo?msg=x&fail=1`, { headers: h });
    expect(r.status).toBe(500);
    expect(r.headers.get('payment-response')).toBeNull();
    expect(f.count.settle).toBe(0);
    const ok = await fetch(`${s.base}/echo?msg=x`, { headers: h }); // same authorisation can be used for a good request
    expect(ok.status).toBe(200);
  });
  it('3.1-05 own output invalid: 502, not settled (M-29)', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=x&junk=1`);
    const r = await fetch(`${s.base}/echo?msg=x&junk=1`, { headers: h });
    expect(r.status).toBe(502);
    expect(f.count.settle).toBe(0);
  });
  it('3.1-06 facilitator down: resource not granted', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    await f.stop();
    const r = await fetch(`${s.base}/echo?msg=hi`, { headers: h });
    expect(r.status).not.toBe(200);
    expect(r.headers.get('payment-response')).toBeNull();
    expect(s.calls.handler).toBe(0);
  });
  it('3.1-07 settle fails: resource not granted', async () => {
    const f = await stubFacilitator('settleFails'); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    const r = await fetch(`${s.base}/echo?msg=hi`, { headers: h });
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain('"echo"');
  });
  it('3.2-01 sequential replay: first 200, second 409, handler ran once', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    expect((await fetch(`${s.base}/echo?msg=hi`, { headers: h })).status).toBe(200);
    expect((await fetch(`${s.base}/echo?msg=hi`, { headers: h })).status).toBe(409);
    expect(s.calls.handler).toBe(1);
    expect(f.count.settle).toBe(1);
  });
  it('3.2-02 five parallel replays: exactly one winner', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    const rs = await Promise.all(Array.from({ length: 5 }, () => fetch(`${s.base}/echo?msg=hi`, { headers: h })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    expect(s.calls.handler).toBe(1);
    expect(f.count.settle).toBe(1);
  });
  it('3.2-04 claims persist across a seller restart', async () => {
    const f = await stubFacilitator();
    const db = join(mkdtempSync(join(tmpdir(), 'claims-')), 'c.db');
    const a = await startSeller(f, { claimsDb: db });
    const h = await signedHeader(`${a.base}/echo?msg=hi`);
    expect((await fetch(`${a.base}/echo?msg=hi`, { headers: h })).status).toBe(200);
    a.app.claims.close();
    await a.stop();
    const b = await startSeller(f, { claimsDb: db });
    expect((await fetch(`${b.base}/echo?msg=hi`, { headers: h })).status).toBe(409);
    expect(b.calls.handler).toBe(0);
  });
  it('3.2-06 no free work: handler counter stays 1 under replay', async () => {
    const f = await stubFacilitator(); const s = await startSeller(f);
    const h = await signedHeader(`${s.base}/echo?msg=hi`);
    for (let i = 0; i < 4; i++) await fetch(`${s.base}/echo?msg=hi`, { headers: h });
    expect(s.calls.handler).toBe(1);
  });
});
