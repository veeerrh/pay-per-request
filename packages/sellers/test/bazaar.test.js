import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { stubFacilitator, serve, decode402, closeAll } from './helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
afterEach(closeAll);

describe('Bazaar discovery metadata on the 402', () => {
  it('01 Tremor (GET) and Relay (POST) advertise what they take and return, and the price is unchanged', async () => {
    const fac = await stubFacilitator();
    process.env.FACILITATOR_URL = fac.url;
    const tremor = await serve(require('../src/tremor.js').createTremor({ requiredBy: null }));
    const t = decode402(await fetch(`${tremor}/quakes?country=India&days=7&minMag=4.5`));
    expect(t.accepts[0].amount).toBe('2000');
    expect(t.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'GET' });
    expect(t.extensions.bazaar.info.input.queryParams.country).toBe('India');
    const relay = await serve(require('../src/relay.js').createRelay({ requiredBy: null, hire: async () => ({}) }));
    const r = decode402(await fetch(`${relay}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ countries: [{ name: 'India' }] }) }));
    expect(r.accepts[0].amount).toBe('6000');
    expect(r.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' });
  });
});
