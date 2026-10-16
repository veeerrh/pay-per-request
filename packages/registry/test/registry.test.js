import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../src/server.js');
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYTO = '0xc4A183e8fA3d4093ec16D580182ae7056C878643';
const closers = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

const publicLookup = async () => [{ address: '93.184.216.34' }];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
/** A fetch stand-in for the probe: answers 402 asking `amount` and naming `payTo`. */
const probeFetch = (amount = '5000', payTo = PAYTO, status = 402) => async () => new Response('{}', {
  status, headers: { 'payment-required': b64({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: USDC, amount, payTo, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }] }) },
});

async function start(opts = {}) {
  const app = createRegistry({ lookup: publicLookup, fetch: probeFetch(), ...opts });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const listing = (over = {}) => ({
  name: 'Atlas', category: 'scraping', endpoint: 'https://sellers.example.com/atlas/countries', method: 'GET', price: '5000', network: 'eip155:84532',
  asset: USDC, payTo: PAYTO, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, description: 'ok', ...over,
});
const post = (base, body, headers = {}) => fetch(`${base}/services`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('registry (TC-6.1)', () => {
  it('01 valid registration is listed and probed', async () => {
    const base = await start();
    const r = await post(base, listing());
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ id: 'atlas', version: 1, status: 'active', probe: { matches: true } });
    const list = await (await fetch(`${base}/services`)).json();
    expect(list.map((x) => x.id)).toEqual(['atlas']);
    expect(list[0].price).toBe('5000');
  });

  it('02 validation failures name the field', async () => {
    const base = await start();
    const bad = [{ price: '100001' }, { network: 'eip155:8453' }, { asset: 'USDC' }, { endpoint: 'http://sellers.example.com/x' }, { payTo: '0x123' }, { outputSchema: { type: 5 } }, { category: 'other' }, { name: '' }];
    for (const o of bad) {
      const r = await post(base, listing(o));
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect((await r.json()).error).toMatch(/invalid/);
    }
    expect((await post(base, { nonsense: true })).status).toBe(400);
  });

  it('03 SSRF: private, loopback, link-local and rebinding hosts are refused (S-53)', async () => {
    const base = await start();
    for (const ep of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'https://[::1]/x']) {
      const r = await post(base, listing({ endpoint: ep, name: 'Bad' }));
      expect(r.status, ep).toBe(400);
    }
    const rebinding = await start({ lookup: async () => [{ address: '127.0.0.1' }] });
    expect((await post(rebinding, listing({ name: 'Rebind' }))).status).toBe(400);
  });

  it('04 a judge liar seller is listed but flagged with the reason (S-88, T-04)', async () => {
    const base = await start({ fetch: probeFetch('10000') });
    const r = await post(base, listing({ name: 'Liar', price: '1000' }));
    const j = await r.json();
    expect(r.status).toBe(201);
    expect(j.status).toBe('flagged');
    expect(j.probe.matches).toBe(false);
    expect(j.probe.reason).toContain('10000');
    expect((await (await fetch(`${base}/services`)).json())).toHaveLength(1);
  });

  it('05 rate limit returns 429 (S-50)', async () => {
    const base = await start({ rateLimit: 3, maxPerPayTo: 99 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(base, listing({ name: `S${i}`, payTo: `0x${String(i + 1).padStart(40, '1')}` }))).status);
    expect(codes.slice(0, 3).every((c) => c === 201)).toBe(true);
    expect(codes[3]).toBe(429);
  });

  it('06 at most 3 listings per payTo (M-04)', async () => {
    const base = await start();
    for (let i = 0; i < 3; i++) expect((await post(base, listing({ name: `N${i}` }))).status).toBe(201);
    expect((await post(base, listing({ name: 'N3' }))).status).toBe(429);
  });

  it('07 a price change makes a new version, held until the probe confirms it (M-05)', async () => {
    const base = await start({ fetch: probeFetch('5000') });
    await post(base, listing());
    const unreachable = await start({ fetch: async () => { throw new Error('down'); } });
    await post(unreachable, listing());
    const changed = await post(unreachable, listing({ price: '6000' }));
    expect((await changed.json())).toMatchObject({ version: 2, status: 'held' });
    const detail = await (await fetch(`${unreachable}/services/atlas`)).json();
    expect(detail.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('08 filters by category, max price and text', async () => {
    const base = await start({ maxPerPayTo: 99, fetch: probeFetch('2000') });
    await post(base, listing({ name: 'Cheap Data', category: 'data', price: '2000' }));
    await post(base, listing({ name: 'Pricey Brief', category: 'inference', price: '10000' }));
    const get = async (q) => (await (await fetch(`${base}/services?${q}`)).json()).map((x) => x.id);
    expect(await get('category=data')).toEqual(['cheap-data']);
    expect(await get('maxPrice=3000')).toEqual(['cheap-data']);
    expect(await get('q=brief')).toEqual(['pricey-brief']);
    expect((await fetch(`${base}/services?maxPrice=abc`)).status).toBe(400);
  });

  it('09 markup in names and descriptions is neutralised on the HTML page (S-75)', async () => {
    const base = await start();
    await post(base, listing({ name: '<script>alert(1)</script>Evil', description: '<img src=x onerror=alert(1)> hi' }));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    const r = await fetch(`${base}/`);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('10 refuses to start with private endpoints allowed in demo mode (D-29)', () => {
    expect(() => createRegistry({ demoMode: true, allowPrivate: true })).toThrow(/REFUSING/);
  });

  it('11 re-posting the same listing is idempotent', async () => {
    const base = await start();
    await post(base, listing());
    const again = await post(base, listing());
    expect(again.status).toBe(200);
    expect((await again.json())).toMatchObject({ unchanged: true, version: 1 });
  });

  it('name hijack with a different payTo is refused', async () => {
    const base = await start();
    await post(base, listing());
    const r = await post(base, listing({ payTo: '0x000000000000000000000000000000000000dEaD' }));
    expect(r.status).toBe(409);
  });

  it('local development allows http localhost only when explicitly enabled', async () => {
    const dev = await start({ allowPrivate: true });
    expect((await post(dev, listing({ endpoint: 'http://localhost:4011/countries' }))).status).toBe(201);
    const strict = await start();
    expect((await post(strict, listing({ endpoint: 'http://localhost:4011/countries' }))).status).toBe(400);
  });
});
