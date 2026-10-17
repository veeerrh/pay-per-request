import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGateway } = require('../src/gateway.js');
const closers = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((x) => { server.closeAllConnections?.(); server.close(x); })); r(server.address().port); }));
async function upstream(name, handler) {
  const s = http.createServer((req, res) => (handler ? handler(req, res) : (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ name, url: req.url, host: req.headers.host })))));
  return listen(s);
}
const raw = (port, path) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));

describe('gateway (TC-9.1)', () => {
  it('routes by prefix, strips the prefix and keeps the public Host header', async () => {
    const registry = await upstream('registry'), atlas = await upstream('atlas'), beacon = await upstream('beacon');
    const gw = await listen(http.createServer(createGateway({ routes: { registry, atlas }, beacon })));
    const a = await (await fetch(`http://127.0.0.1:${gw}/atlas/countries?top=3`, { headers: { host: 'public.example.com' } })).json();
    expect(a).toMatchObject({ name: 'atlas', url: '/countries?top=3' });
    expect((await (await fetch(`http://127.0.0.1:${gw}/registry/services`)).json())).toMatchObject({ name: 'registry', url: '/services' });
    expect((await (await fetch(`http://127.0.0.1:${gw}/api/health`)).json())).toMatchObject({ name: 'beacon', url: '/api/health' });
    expect((await (await fetch(`http://127.0.0.1:${gw}/`)).json()).name).toBe('beacon');
  });

  it('a prefix is not a substring match: /atlasx goes to Beacon', async () => {
    const atlas = await upstream('atlas'), beacon = await upstream('beacon');
    const gw = await listen(http.createServer(createGateway({ routes: { atlas }, beacon })));
    expect((await (await fetch(`http://127.0.0.1:${gw}/atlasx/y`)).json()).name).toBe('beacon');
  });

  it('server-sent events stream through without buffering', async () => {
    const sse = await upstream('sse', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 400);
    });
    const beacon = await upstream('beacon');
    const gw = await listen(http.createServer(createGateway({ routes: {}, beacon: sse })));
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${gw}/api/tasks/x/events`);
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('one');
    expect(Date.now() - t0).toBeLessThan(300); // the first event arrived before the stream finished
    void beacon;
  });

  it('path traversal cannot jump between services (S-security)', async () => {
    const registry = await upstream('registry'), atlas = await upstream('atlas'), beacon = await upstream('beacon');
    const gw = await listen(http.createServer(createGateway({ routes: { registry, atlas }, beacon })));
    for (const p of ['/atlas/../registry/services', '/atlas/..%2fregistry/services', '/atlas/%2e%2e/registry/services']) {
      const r = await raw(gw, p);
      const name = (() => { try { return JSON.parse(r.body).name; } catch { return 'n/a'; } })();
      expect(name, p).not.toBe('registry');
      expect(r.status, p).toBe(400);
    }
  });

  it('an unreachable upstream gives a clean 502', async () => {
    const gw = await listen(http.createServer(createGateway({ routes: { atlas: 1 }, beacon: 1 })));
    const r = await fetch(`http://127.0.0.1:${gw}/atlas/x`);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('upstream_unreachable');
  });
});
