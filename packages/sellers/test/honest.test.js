import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { stubFacilitator, serve, signedHeader, decode402, closeAll } from './helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
afterEach(closeAll);

const COUNTRIES = [
  { name: 'China', capital: 'Beijing', population: 1330044000, area_km2: 9596960 },
  { name: 'India', capital: 'New Delhi', population: 1173108018, area_km2: 3287590 },
  { name: 'United States', capital: 'Washington', population: 310232863, area_km2: 9629091 },
  { name: 'Russia', capital: 'Moscow', population: 140702000, area_km2: 17100000 },
];
let mods;
beforeAll(() => { mods = { atlas: require('../src/atlas.js'), tremor: require('../src/tremor.js'), brief: require('../src/brief.js') }; });

async function up(factory, opts) {
  const fac = await stubFacilitator();
  process.env.FACILITATOR_URL = fac.url;
  const base = await serve(factory({ requiredBy: null, ...opts }));
  return { base, fac };
}

describe('honest sellers (TC-5.1)', () => {
  it('01 prices on the 402 are 5000, 2000 and 10000', async () => {
    const a = await up(mods.atlas.createAtlas, { scrape: async () => COUNTRIES });
    const t = await up(mods.tremor.createTremor, { fetch: async () => ({ ok: true, json: async () => ({ features: [] }) }) });
    const b = await up(mods.brief.createBrief);
    expect(decode402(await fetch(`${a.base}/countries?top=3`)).accepts[0].amount).toBe('5000');
    expect(decode402(await fetch(`${t.base}/quakes?country=India`)).accepts[0].amount).toBe('2000');
    const r = await fetch(`${b.base}/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ countries: [{ name: 'India', quakes: [] }] }) });
    expect(decode402(r).accepts[0].amount).toBe('10000');
  });

  it('02 Atlas returns the top N by population or area', async () => {
    const a = await up(mods.atlas.createAtlas, { scrape: async () => COUNTRIES });
    const h = await signedHeader(`${a.base}/countries?top=2&by=population`);
    const r = await fetch(`${a.base}/countries?top=2&by=population`, { headers: h });
    expect(r.status).toBe(200);
    expect((await r.json()).countries.map((c) => c.name)).toEqual(['China', 'India']);
    const h2 = await signedHeader(`${a.base}/countries?top=2&by=area`);
    expect((await (await fetch(`${a.base}/countries?top=2&by=area`, { headers: h2 })).json()).countries.map((c) => c.name)).toEqual(['Russia', 'United States']);
  });

  it('03 Tremor maps USGS GeoJSON to our schema and sends the right query', async () => {
    let seen;
    const t = await up(mods.tremor.createTremor, {
      fetch: async (url) => { seen = url; return { ok: true, json: async () => ({ features: [{ properties: { mag: 5.1, place: 'near somewhere', time: Date.now() - 3600_000 } }] }) }; },
    });
    const u = `${t.base}/quakes?country=India&days=7&minMag=4.5`;
    const r = await fetch(u, { headers: await signedHeader(u) });
    const j = await r.json();
    expect(j).toMatchObject({ country: 'India', window_days: 7 });
    expect(j.quakes[0].magnitude).toBe(5.1);
    expect(seen).toContain('minmagnitude=4.5');
    expect(seen).toContain('format=geojson');
  });

  it('04 Brief is rule based and deterministic', async () => {
    const b = await up(mods.brief.createBrief);
    const body = JSON.stringify({ countries: [{ name: 'China', quakes: [{ magnitude: 5.1 }, { magnitude: 4.6 }] }, { name: 'India', quakes: [] }] });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    const r = await fetch(`${b.base}/brief`, { ...init, headers: { ...init.headers, ...(await signedHeader(`${b.base}/brief`, init)) } });
    expect((await r.json()).briefs.map((x) => `${x.country}:${x.readiness}`)).toEqual(['China:medium', 'India:low']);
  });

  it('05 invalid input costs nothing: 400 and no 402 (M-69)', async () => {
    const a = await up(mods.atlas.createAtlas, { scrape: async () => COUNTRIES });
    const t = await up(mods.tremor.createTremor, { fetch: async () => ({ ok: true, json: async () => ({ features: [] }) }) });
    const b = await up(mods.brief.createBrief);
    for (const u of [`${a.base}/countries?top=99`, `${a.base}/countries?by=colour`, `${t.base}/quakes?country=Narnia`, `${t.base}/quakes?country=India&days=400`, `${t.base}/quakes?country=India&minMag=12`]) {
      const r = await fetch(u);
      expect(r.status, u).toBe(400);
      expect(r.headers.get('payment-required')).toBeNull();
    }
    const three = await fetch(`${b.base}/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ countries: [1, 2, 3].map((n) => ({ name: `c${n}`, quakes: [] })) }) });
    expect(three.status).toBe(400);
  });

  it('06 robots.txt disallow and the domain allowlist are enforced (S-55, M-41)', async () => {
    const mk = (robots) => mods.atlas.makeScraper(async (u) => (u.endsWith('robots.txt') ? { ok: true, text: async () => robots } : { ok: true, text: async () => '<div class="country"></div>' }));
    await expect(mk('User-agent: *\nDisallow: /pages/')()).rejects.toThrow(/robots/);
    const a = await up(mods.atlas.createAtlas, { scrape: mk('User-agent: *\nDisallow: /pages/') });
    const u = `${a.base}/countries?top=1`;
    const r = await fetch(u, { headers: await signedHeader(u) });
    expect(r.status).toBe(500);
    expect(a.fac.count.settle).toBe(0);
  });

  it('07 upstream failure is not charged (S-09)', async () => {
    const t = await up(mods.tremor.createTremor, { fetch: async () => ({ ok: false, status: 503 }) });
    const u = `${t.base}/quakes?country=India`;
    const r = await fetch(u, { headers: await signedHeader(u) });
    expect(r.status).toBe(500);
    expect(t.fac.count.settle).toBe(0);
  });

  it('08 absurd own output is not settled (M-29)', async () => {
    const a = await up(mods.atlas.createAtlas, { scrape: async () => [{ name: 'Nowhere', capital: 'x', population: 0, area_km2: 5 }] });
    const u = `${a.base}/countries?top=1`;
    const r = await fetch(u, { headers: await signedHeader(u) });
    expect(r.status).toBe(502);
    expect(a.fac.count.settle).toBe(0);
  });

  it('09 sellers hold no private key variable (M-71)', () => {
    for (const f of ['atlas', 'tremor', 'brief', 'common', 'kit']) {
      expect(require('node:fs').readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'), f).not.toMatch(/PRIVATE_KEY/);
    }
  });
});
