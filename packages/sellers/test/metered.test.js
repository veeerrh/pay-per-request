import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { stubFacilitator, serve, signedHeader, decode402, closeAll } from './helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
afterEach(closeAll);
const brief = require('../src/brief.js');

async function up() {
  const fac = await stubFacilitator();
  process.env.FACILITATOR_URL = fac.url;
  return serve(brief.createBrief({ requiredBy: null }));
}
const country = (name) => ({ name, quakes: [{ magnitude: 5.1 }] });
const post = (countries) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ countries }) });

describe('metered pricing: Brief charges per country, never above its listed ceiling', () => {
  it('01 the quote follows the request: 6000 for one country, 10000 for two', () => {
    expect(brief.quoteUnits({ countries: [country('India')] })).toBe('6000');
    expect(brief.quoteUnits({ countries: [country('India'), country('China')] })).toBe('10000');
    expect(brief.quoteUnits(undefined)).toBe('10000'); // no usable body: the ceiling
    expect(brief.quoteUnits({ countries: [1, 2, 3, 4, 5] })).toBe('10000'); // never above the ceiling, whatever the size
    expect(brief.quoteUnits({ countries: [] })).toBe('6000');
  });

  it('02 the 402 asks exactly the metered amount for the body it was sent', async () => {
    const base = await up();
    expect(decode402(await fetch(`${base}/brief`, post([country('India')]))).accepts[0].amount).toBe('6000');
    expect(decode402(await fetch(`${base}/brief`, post([country('India'), country('China')]))).accepts[0].amount).toBe('10000');
  });

  it('03 a paid call for one country settles at 6000 and returns the paid result', async () => {
    const base = await up();
    const init = post([country('India')]);
    const header = await signedHeader(`${base}/brief`, init);
    const r = await fetch(`${base}/brief`, { ...init, headers: { ...init.headers, ...header } });
    expect(r.status).toBe(200);
    const pr = JSON.parse(Buffer.from(r.headers.get('payment-response'), 'base64').toString('utf8'));
    expect(pr.success).toBe(true);
    expect((await r.json()).briefs).toHaveLength(1);
  });

  it('04 a payment signed for one country cannot buy a two-country brief (the quote is recomputed from the paid request)', async () => {
    const base = await up();
    const cheap = await signedHeader(`${base}/brief`, post([country('India')])); // authorisation for 6000
    const init = post([country('India'), country('China')]); // the work would be worth 10000
    const r = await fetch(`${base}/brief`, { ...init, headers: { ...init.headers, ...cheap } });
    expect(r.status).toBe(402);
    expect(r.headers.get('payment-response')).toBeNull(); // nothing settled
  });
});
