import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { stubFacilitator, serve, signedHeader, decode402, closeAll } from './helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
afterEach(closeAll);
const relay = require('../src/relay.js');

const goodHire = async (country) => ({ seller: 'Tremor', paid: 2000n, txHash: `0x${'ab'.repeat(32)}`, data: { country, quakes: [{ magnitude: 5.1, place: 'x', time: new Date().toISOString() }] } });
async function up(opts = {}) {
  const fac = await stubFacilitator();
  process.env.FACILITATOR_URL = fac.url;
  return serve(relay.createRelay({ requiredBy: null, hire: goodHire, ...opts }));
}
const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const paid = async (base, body) => { const init = post(body); return fetch(`${base}/relay`, { ...init, headers: { ...init.headers, ...(await signedHeader(`${base}/relay`, init)) } }); };

describe('Relay, the chained agent', () => {
  it('01 quotes per country under a 0.010 ceiling', async () => {
    const base = await up();
    expect(decode402(await fetch(`${base}/relay`, post({ countries: [{ name: 'India' }] }))).accepts[0].amount).toBe('6000');
    expect(decode402(await fetch(`${base}/relay`, post({ countries: [{ name: 'India' }, { name: 'China' }] }))).accepts[0].amount).toBe('10000');
    expect(relay.quoteUnits({ countries: new Array(9).fill({}) })).toBe('10000');
  });

  it('02 a paid call returns the briefs and a receipt of what Relay bought and paid', async () => {
    const base = await up();
    const r = await paid(base, { countries: [{ name: 'India' }, { name: 'China' }], days: 7, minMag: 4.5 });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.briefs.map((b) => b.country)).toEqual(['India', 'China']);
    expect(j.meta.chain).toMatchObject({ agent: 'Relay', spentUnits: '4000' });
    expect(j.meta.chain.hired).toEqual([
      { seller: 'Tremor', country: 'India', paidUnits: '2000', txHash: `0x${'ab'.repeat(32)}` },
      { seller: 'Tremor', country: 'China', paidUnits: '2000', txHash: `0x${'ab'.repeat(32)}` },
    ]);
    expect(j.meta.chain.data[0].quakes).toHaveLength(1);
  });

  it('03 if the seller Relay hires fails, Relay answers an error and the buyer\'s payment is never settled', async () => {
    const base = await up({ hire: async () => { throw new Error('Tremor refused: price lie'); } });
    const r = await paid(base, { countries: [{ name: 'India' }] });
    expect(r.status).toBe(500);
    expect(r.headers.get('payment-response')).toBeNull();
  });

  it('04 Relay stops a second purchase when the first one fails', async () => {
    let calls = 0;
    const base = await up({ hire: async (c) => { calls++; if (calls === 1) throw new Error('nope'); return goodHire(c); } });
    const r = await paid(base, { countries: [{ name: 'India' }, { name: 'China' }] });
    expect(r.status).toBe(500);
    expect(calls).toBe(1);
  });

  it('05 when its working float is too low it says so BEFORE any 402, so nobody is asked to pay', async () => {
    const base = await up({ unavailable: () => 'Relay is out of working capital for the moment' });
    const r = await fetch(`${base}/relay`, post({ countries: [{ name: 'India' }] }));
    expect(r.status).toBe(503);
    expect(r.headers.get('payment-required')).toBeNull();
    expect((await r.json()).error).toBe('unavailable');
  });

  it('06 bad input is a 400 with no 402', async () => {
    const base = await up();
    for (const body of [{}, { countries: [] }, { countries: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }, { countries: [{}] }, { countries: [{ name: 'India' }], days: 31 }, { countries: [{ name: 'India' }], minMag: 12 }, { countries: [{ name: 'India' }], days: 'x' }]) {
      const r = await fetch(`${base}/relay`, post(body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.headers.get('payment-required')).toBeNull();
    }
  });

  it('07 the receipts page is read-only and has no secrets', async () => {
    const base = await up({ payTo: '0x00000000000000000000000000000000000000aa', payments: () => ({ wallet: '0x00000000000000000000000000000000000000aa', payments: [] }) });
    const r = await fetch(`${base}/payments`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toMatch(/private|key/i);
  });
});
