import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { stubFacilitator, serve, signedHeader, decode402, closeAll } from './helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
afterEach(closeAll);
const addresses = require('../../../config/addresses.json');
const { SERVICES, buildEnv } = require('../../../scripts/lib/services.js');
let m;
beforeAll(() => {
  m = {
    overquote: require('../src/fixtures/overquote.js'), redirect: require('../src/fixtures/redirect.js'),
    hollow: require('../src/fixtures/hollow.js'), offline: require('../src/fixtures/offline.js'),
  };
});

describe('test vendors (TC-5.2)', () => {
  it('01 Overquote asks 20000 against a listed 2000', async () => {
    const base = await serve(m.overquote.app);
    const pr = decode402(await fetch(`${base}/countries?top=3`));
    expect(pr.accepts[0].amount).toBe('20000');
    expect(require('../../../config/listings/overquote.json').price).toBe('2000');
  });
  it('02 Redirect names a decoy payTo, not its listed address', async () => {
    const base = await serve(m.redirect.app);
    const pr = decode402(await fetch(`${base}/quakes?country=India`));
    expect(pr.accepts[0].payTo).toBe(addresses.sellers['redirect-decoy']);
    expect(pr.accepts[0].payTo).not.toBe(addresses.sellers.redirect);
  });
  it('liars never settle: a payment header just gets another 402', async () => {
    const base = await serve(m.overquote.app);
    const r = await fetch(`${base}/countries?top=3`, { headers: { 'payment-signature': 'x' } });
    expect(r.status).toBe(402);
  });
  it('03 Hollow settles, then returns junk that breaks the listed schema (T-07)', async () => {
    const fac = await stubFacilitator();
    process.env.FACILITATOR_URL = fac.url;
    const base = await serve(m.hollow.createHollow({ requiredBy: null }));
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    const h = await signedHeader(`${base}/brief`, init);
    const r = await fetch(`${base}/brief`, { ...init, headers: { ...init.headers, ...h } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ summary: 12345, confidence: 'very high' });
    expect(fac.count.settle).toBe(1);
  });
  it('04 Offline fails after verify and never settles (S-09)', async () => {
    const fac = await stubFacilitator();
    process.env.FACILITATOR_URL = fac.url;
    const base = await serve(m.offline.createOffline({ requiredBy: null }));
    const h = await signedHeader(`${base}/countries?top=1`);
    const r = await fetch(`${base}/countries?top=1`, { headers: h });
    expect(r.status).toBe(500);
    expect(fac.count.settle).toBe(0);
  });
  it('05 deterministic: five identical calls behave identically (D-20)', async () => {
    const base = await serve(m.overquote.app);
    const bodies = [];
    for (let i = 0; i < 5; i++) bodies.push(decode402(await fetch(`${base}/countries?top=3`)).accepts[0].amount);
    expect(new Set(bodies).size).toBe(1);
  });
  it('06 each fixture is cheaper than its honest peer (D-19)', () => {
    const p = (n) => BigInt(require(`../../../config/listings/${n}.json`).price);
    expect(p('overquote')).toBeLessThan(p('atlas'));
    expect(p('offline')).toBeLessThan(p('atlas'));
    expect(p('redirect')).toBeLessThan(p('tremor'));
    expect(p('hollow')).toBeLessThan(p('brief'));
    expect([p('overquote'), p('redirect'), p('hollow'), p('offline')]).toEqual([2000n, 1000n, 8000n, 4000n]);
  });
  it('09 child processes get an env allowlist and no private key (M-71)', () => {
    const parent = { PATH: '/bin', BEACON_PRIVATE_KEY: '0x' + 'a'.repeat(64), REPLAY_PRIVATE_KEY: '0x' + 'b'.repeat(64), OPERATOR_TOKEN: 'secret', RPC_URL: 'https://sepolia.base.org' };
    for (const s of SERVICES.filter((x) => !['beacon'].includes(x.name))) {
      const env = buildEnv(s, parent);
      expect(Object.keys(env).filter((k) => /PRIVATE|TOKEN|SECRET/i.test(k)), s.name).toEqual([]);
      expect(env.PORT).toBe(String(s.port));
    }
    expect(buildEnv(SERVICES.find((x) => x.name === 'beacon'), parent).BEACON_PRIVATE_KEY).toBeDefined();
  });
  it('every fixture and honest seller has its own receiving address', () => {
    const vals = Object.values(addresses.sellers);
    expect(new Set(vals).size).toBe(vals.length);
  });
});
