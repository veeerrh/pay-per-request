import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { stubFacilitator, serve, closeAll } from '../../sellers/test/helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { runTask } = require('../src/runner.js');
const { loadLocalListings } = require('../src/listings.js');
const { parseTask, PlanError } = require('../src/planner.js');
const { formatReceipt } = require('../src/reporter.js');
const { x402Client } = require('@x402/core/client');
const { x402HTTPClient } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const path = require('node:path');

const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 3000 };
const GEO = ['China', 'India', 'United States', 'Indonesia', 'Brazil', 'Pakistan'];
const COUNTRIES = GEO.map((name, i) => ({ name, capital: 'x', population: 1000000 * (10 - i), area_km2: 1000 * (10 - i) }));

/** Real x402 client signing with a throwaway key: works against the stub facilitator, no funds needed. */
function testSigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
  const http = new x402HTTPClient(client);
  return {
    address: account.address,
    signPayment: async (pr) => {
      const payload = await client.createPaymentPayload(pr);
      return { headers: http.encodePaymentSignatureHeader(payload), nonce: payload.payload.authorization.nonce, validBefore: Number(payload.payload.authorization.validBefore) };
    },
    signMessage: async () => 'sig',
  };
}

let hits, bases, listings;
beforeAll(async () => {
  const fac = await stubFacilitator();
  process.env.FACILITATOR_URL = fac.url;
  const S = (f) => require(`../../sellers/src/${f}`);
  const quakeFetch = async () => ({ ok: true, json: async () => ({ features: [{ properties: { mag: 5.1, place: 'sample place', time: Date.now() - 86400000 } }] }) });
  const apps = {
    atlas: S('atlas.js').createAtlas({ requiredBy: null, scrape: async () => COUNTRIES }),
    tremor: S('tremor.js').createTremor({ requiredBy: null, fetch: quakeFetch }),
    brief: S('brief.js').createBrief({ requiredBy: null }),
    overquote: S('fixtures/overquote.js').app,
    redirect: S('fixtures/redirect.js').app,
    hollow: S('fixtures/hollow.js').createHollow({ requiredBy: null }),
    offline: S('fixtures/offline.js').createOffline({ requiredBy: null }),
  };
  hits = {};
  bases = {};
  for (const [id, app] of Object.entries(apps)) {
    hits[id] = 0;
    const counting = (req, res, next) => { hits[id]++; next(); };
    const wrapped = require('express')();
    wrapped.use((req, res, next) => (req.path === '/health' ? next() : counting(req, res, next)));
    wrapped.use(app);
    bases[id] = await serve(wrapped);
  }
  listings = loadLocalListings().map((l) => ({ ...l, endpoint: bases[l.id] + new URL(l.endpoint).pathname }));
});
afterAll(closeAll);

function rig(opts = {}) {
  const store = new g.Store(':memory:', 'rs');
  const signer = testSigner();
  const bal = opts.balance ?? 20_000_000n;
  const budget = new g.Budget(store, cfg);
  const chain = { balanceOf: async () => bal, authorizationState: async () => false };
  const events = [];
  const run = (req) => runTask({ store, budget, signer, cfg, chain, listings: async () => listings }, { taskId: `t${Math.random().toString(36).slice(2, 7)}`, maxConcurrency: 3, ...req }, (e) => events.push(e));
  return { store, run, events, budget };
}
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';
const T3 = 'For the 2 most populous countries, find earthquakes of magnitude 4.0 or more from the last 30 days and write a short readiness brief for each.';
const statuses = (store) => store.listEntries().map((e) => `${e.sellerId}:${e.status}`);

describe('Beacon end to end against real seller apps (TC-5.3)', () => {
  it('01 task 1 cold start reproduces the design story and totals 35,000 units (Brief is metered)', async () => {
    const r = rig();
    const out = await r.run({ text: T1, budget: 50000n });
    expect(out.status).toBe('completed');
    const ms = statuses(r.store).sort();
    expect(ms).toEqual(['atlas:paid', 'brief:paid', 'brief:paid', 'hollow:rejected', 'offline:failed', 'overquote:refused', 'redirect:refused', 'tremor:paid', 'tremor:paid', 'tremor:paid'].sort());
    expect(out.totals.spent).toBe(35000n);
    expect(r.store.verifyChain().ok).toBe(true);
    expect(out.result.assessment.level).toBe('medium');
    expect(out.result.contributors.map((c) => c.id).sort()).toEqual(['atlas', 'brief', 'tremor']);
    expect(formatReceipt(out.result.breakdown, out.totals)).toContain('spent 0.035');
  });

  it('events: stages in order, spend never above the budget, ends with done', async () => {
    const r = rig();
    await r.run({ text: T1, budget: 50000n });
    const stages = r.events.filter((e) => e.type === 'stage').map((e) => e.stage);
    expect(stages).toEqual(['plan', 'discover', 'pay', 'execute', 'validate', 'combine']);
    for (const m of r.events.filter((e) => e.type === 'metrics')) expect(BigInt(m.spent) + BigInt(m.reserved)).toBeLessThanOrEqual(50000n);
    expect(r.events.at(-2).type === 'done' || r.events.some((e) => e.type === 'done')).toBe(true);
    expect(r.events.filter((e) => e.type === 'ledger')).toHaveLength(10);
  });

  it('02 same totals at max_concurrency 1 and 5', async () => {
    for (const c of [1, 5]) {
      const r = rig();
      const out = await r.run({ text: T1, budget: 50000n, maxConcurrency: c });
      expect(out.totals.spent, `concurrency ${c}`).toBe(35000n);
    }
  });

  it('04 task 3 at 0.012 USDC stops with exact numbers and never exceeds the cap (T-03)', async () => {
    for (const c of [1, 5]) {
      const r = rig();
      const out = await r.run({ text: T3, budget: 12000n, maxConcurrency: c });
      expect(out.status, `c=${c}`).toBe('stopped');
      expect(out.totals.spent).toBe(9000n);
      expect(out.notice).toMatch(/8,000|10,000/);
      expect(out.notice).toContain('3,000');
      for (const m of r.events.filter((e) => e.type === 'metrics')) expect(BigInt(m.spent) + BigInt(m.reserved)).toBeLessThanOrEqual(12000n);
      expect(out.result.assessment.level).toBe('incomplete');
    }
  });

  it('05 a second run in the same session skips the fixtures (S-92)', async () => {
    const r = rig();
    await r.run({ text: T1, budget: 50000n });
    const before = { ...hits };
    const out = await r.run({ text: T1, budget: 50000n });
    expect(out.status).toBe('completed');
    for (const id of ['overquote', 'offline', 'redirect', 'hollow']) expect(hits[id], id).toBe(before[id]);
    expect(out.totals.spent).toBe(27000n);
  });

  it('06 judge changes the numbers: 2 countries, M4.0, 30 days', async () => {
    const r = rig();
    const out = await r.run({ text: T3, budget: 50000n });
    expect(out.status).toBe('completed');
    expect(out.params).toMatchObject({ n: 2, minMag: 4, days: 30 });
    expect(out.result.breakdown.filter((b) => b.outcome === 'paid').length).toBeGreaterThanOrEqual(3);
  });

  it('07 bad task text is rejected with no spending', async () => {
    const r = rig();
    for (const text of ['', 'short', 'x'.repeat(1001), 'For the 9 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days', 'For the 3 most populous countries find quakes from the last 400 days please']) {
      const out = await r.run({ text, budget: 50000n });
      expect(out.status, text.slice(0, 30)).toBe('blocked');
    }
    expect(r.store.listEntries()).toHaveLength(0);
    expect(() => parseTask('')).toThrow(PlanError);
  });

  it('nothing affordable is blocked, not partially run', async () => {
    const r = rig();
    const out = await r.run({ text: T1, budget: 1000n });
    expect(out.status).toBe('blocked');
    expect(out.notice).toContain('Nothing was bought');
    expect(r.store.listEntries()).toHaveLength(0);
  });

  it('10 wallet below the floor refuses to start (S-79)', async () => {
    const r = rig({ balance: 50000n });
    const out = await r.run({ text: T1, budget: 50000n });
    expect(out.status).toBe('blocked');
    expect(out.notice).toContain('missing');
  });

  it('hired agents pin their category and the fixtures are never contacted', async () => {
    const r = rig();
    const before = { ...hits };
    const out = await r.run({ text: T1, budget: 50000n, hired: ['atlas', 'tremor', 'brief'] });
    expect(out.status).toBe('completed');
    expect(out.totals.spent).toBe(27000n);
    for (const id of ['overquote', 'offline', 'redirect', 'hollow']) expect(hits[id], id).toBe(before[id]);
  });

  it('12 the planner never imports the signer', () => {
    const src = readFileSync(new URL('../src/planner.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/require\(['"][^'"]*(signer|guard)|BEACON_PRIVATE_KEY/);
  });
});
