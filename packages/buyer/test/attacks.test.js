import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createServer } = require('../src/server.js');
const { install } = require('../src/attacks.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

async function boot(opts = {}) {
  const store = new g.Store(':memory:', 'rs');
  const signer = testSigner();
  const replaySigner = testSigner();
  const budget = new g.Budget(store, cfg);
  const atlasPayTo = world.listings.find((l) => l.id === 'atlas').payTo;
  const chain = {
    balanceOf: async () => opts.replayBalance ?? 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getReceiptStatus: async () => 'success',
    getTransfersFrom: async () => [{ txHash: '0x1', to: atlasPayTo, value: 5000n }, { txHash: '0x2', to: atlasPayTo, value: 5000n }],
  };
  const app = createServer({ store, budget, signer, chain, cfg, listings: async () => (opts.listings ?? world.listings), services: async () => [], operatorToken: 't', allowPrivate: true, extend: opts.off ? undefined : install, replaySigner, attackLimit: opts.attackLimit ?? 100 });
  return { base: await serve(app), store };
}
const fire = (base, name, body = {}) => fetch(`${base}/api/attack/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('attack panel (TC-8.1)', () => {
  it('01 price lie is refused with no money moved (T-04a)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'price-lie')).json();
    expect(j.actual).toMatchObject({ verdict: 'REFUSE', ruleId: 'M-17', status: 'refused' });
    expect(j.paid).toBe('0');
  });
  it('02 payTo lie is refused (T-04b)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'payto-lie')).json();
    expect(j.actual).toMatchObject({ verdict: 'REFUSE', ruleId: 'S-06' });
  });
  it('03 junk is paid, output rejected and flagged (T-07)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'junk')).json();
    expect(j.actual).toMatchObject({ verdict: 'ACCEPT_FLAG', status: 'rejected' });
    expect(j.paid).toBe('8000');
  });
  it('04 failure is not charged (T-06)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'failure')).json();
    expect(j.actual.status).toBe('failed');
    expect(j.paid).toBe('0');
  });
  it('05 replay: one winner among five parallel, one transfer per payment (T-05)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'replay5')).json();
    expect(j.replay).toMatchObject({ stage1: 200, winners: 1, transfers: 2, pass: true });
    expect(j.replay.stage2).not.toBe(200);
    expect(j.actual.verdict).toBe('PASS');
  }, 30000);
  it('replay with an unfunded wallet explains what to do', async () => {
    const { base } = await boot({ replayBalance: 0n });
    const r = await fire(base, 'replay5');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('replay_wallet_unfunded');
  });
  it('06 budget race returns the task to start (T-03)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'budget-race')).json();
    expect(j.startTask).toMatchObject({ budget: '12000', maxConcurrency: 5 });
  });
  it('07 invariant reports zero violations (A-20)', async () => {
    const { base } = await boot();
    const j = await (await fire(base, 'invariant', { seed: 42, runs: 20 })).json();
    expect(j.actual.verdict).toBe('PASS');
    expect(j.summary.violations).toBe(0);
  }, 60000);
  it('08 attack rows appear in the ledger tagged attack-panel', async () => {
    const { base } = await boot();
    await fire(base, 'price-lie');
    const rows = await (await fetch(`${base}/api/ledger`)).json();
    expect(rows[0].source).toBe('attack-panel');
  });
  it('09 flag off: endpoint and config report the panel as disabled', async () => {
    const { base } = await boot({ off: true });
    expect((await fire(base, 'price-lie')).status).toBe(404);
    expect((await (await fetch(`${base}/api/config`)).json()).attackPanel).toBe(false);
    const on = await boot();
    expect((await (await fetch(`${on.base}/api/config`)).json()).attackPanel).toBe(true);
  });
  it('10 rate limit returns 429', async () => {
    const { base } = await boot({ attackLimit: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fire(base, 'budget-race')).status);
    expect(codes).toEqual([200, 200, 429]);
  });
  it('11 a seller that is not registered gives a readable error', async () => {
    const { base, store } = await boot({ listings: world.listings.filter((l) => l.id !== 'overquote') });
    const r = await fire(base, 'price-lie');
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('seller_not_registered');
    expect(store.listEntries()).toHaveLength(0);
  });
  it('unknown case is a 404', async () => {
    const { base } = await boot();
    expect((await fire(base, 'nope')).status).toBe(404);
  });
});
