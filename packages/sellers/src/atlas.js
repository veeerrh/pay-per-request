// Atlas: honest scraping agent (0.005 USDC). Checks robots.txt and a domain allowlist before fetching (M-41, P-18).
// Code scrapes, cleans, ranks and owns every figure. A model (Gemini) reads the ranked rows and adds a short data note per
// country and a one-line summary. If the model is slow, down or wrong, Atlas still answers with the plain rows.
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { createLlm, createLlmFromEnv, quote, numbersGrounded, z } = require('@di06/llm');
const { boot } = require('./common');

const SOURCE = 'https://www.scrapethissite.com/pages/simple/';
const ALLOWED_HOSTS = new Set(['www.scrapethissite.com', 'scrapethissite.com']);
const UA = 'AgentMarket-Atlas/1.0 (hackathon demo)';
const CACHE_MS = 10 * 60 * 1000;

const fs = require('fs');
const path = require('path');
const STALE_OK_MS = 24 * 60 * 60 * 1000; // a day-old country list is still a fine answer if the site is slow or down

/**
 * Fetches and parses the sandbox page. Robust on purpose: the public sandbox can take 20 seconds, so the page is cached
 * in memory and on disk, and a stale copy is served if a refresh fails. robots.txt is checked on every real fetch (M-41).
 */
function makeScraper(fetchImpl = fetch, now = () => Date.now(), opts = {}) {
  let cache = null;
  const file = opts.cacheFile || null;
  if (file) { try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no disk cache yet */ } }
  const refresh = async () => {
    const url = new URL(SOURCE);
    if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error('domain is not on the allowlist');
    const robotsTxt = await fetchImpl(`${url.origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.text() : ''));
    const robots = robotsParser(`${url.origin}/robots.txt`, robotsTxt);
    if (robots.isAllowed(SOURCE, UA) === false) throw new Error('robots.txt disallows this page');
    const res = await fetchImpl(SOURCE, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`source answered ${res.status}`);
    const $ = cheerio.load(await res.text());
    const list = [];
    $('.country').each((_i, el) => {
      const g = (c) => $(el).find(c).text().trim();
      list.push({ name: g('.country-name'), capital: g('.country-capital'), population: parseInt(g('.country-population'), 10), area_km2: parseFloat(g('.country-area')) });
    });
    if (!list.length) throw new Error('page had no countries');
    cache = { at: now(), list };
    if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* cache is best effort */ } }
    return list;
  };
  let inflight = null;
  return async function countries() {
    if (cache && now() - cache.at < CACHE_MS) return cache.list;
    inflight ||= refresh().finally(() => { inflight = null; });
    try { return await inflight; } catch (e) {
      // robots.txt refusals are never bypassed by a stale copy: only network trouble is.
      if (/robots|allowlist/.test(e.message)) throw e;
      if (cache && now() - cache.at < STALE_OK_MS) return cache.list;
      throw e;
    }
  };
}

const NotesOut = z.object({
  countries: z.array(z.object({ name: z.string().max(80), note: z.string().max(160) })).max(10),
  summary: z.string().max(240),
});

const ATLAS_SYSTEM = `You are Atlas, a data-collection agent that scrapes public web pages for other agents.
You receive rows that code already scraped, cleaned and ranked. You do not change, re-rank or add rows.
For each row write one short note (under 25 words) about what is notable in the row itself: its rank position in this table, a missing field, or an unusually small or large value. Do not repeat the population and area numbers, the data already carries them. Use only the values in the row.
Then write one summary sentence about the table: how many rows were scraped, what the ranking is based on and which countries were returned.
Return the same country names in the same order.`;

const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The model's part of Atlas. Returns { notes: Map(name -> note), summary } or null.
 * Code checks the answer: same countries in the same order, and every number in the prose must come from the rows.
 * null means "answer with the plain rows"; it never blocks or changes a paid answer.
 */
function createAnnotator({ llm, now = () => Date.now(), log = () => {} }) {
  const TTL = 10 * 60_000;
  const cache = new Map();
  const inflight = new Map();
  const HARD_LIMIT_MS = 18_000; // well inside the payment window

  async function run(rows, ctx) {
    const facts = { rankedBy: ctx.by, rowsScraped: ctx.rowsScraped, rows };
    const out = await llm.generateJson({
      name: 'atlas-notes', system: ATLAS_SYSTEM, schema: NotesOut, maxOutputTokens: 600,
      user: `${quote('scraped rows', facts)}
Write the notes now.`,
    });
    if (out.countries.length !== rows.length || out.countries.some((c, i) => c.name !== rows[i].name)) { log('atlas: model changed the countries, notes dropped'); return null; }
    const factsText = JSON.stringify(facts);
    const notes = new Map();
    for (const c of out.countries) {
      const note = clean(c.note);
      if (note && numbersGrounded(note, factsText)) notes.set(c.name, note);
    }
    const summary = numbersGrounded(out.summary, factsText) ? clean(out.summary) : `Top ${rows.length} of ${ctx.rowsScraped} scraped rows, ranked by ${ctx.by}.`;
    return { notes, summary };
  }

  return async function annotate(rows, ctx) {
    if (!llm?.enabled) return null;
    const key = `${ctx.by}|${ctx.rowsScraped}|${JSON.stringify(rows.map((r) => [r.name, r.population, r.area_km2]))}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL) return hit.v;
    if (!inflight.has(key)) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), HARD_LIMIT_MS).unref?.());
      inflight.set(key, Promise.race([run(rows, ctx).catch((e) => { log(`atlas: notes unavailable (${e.name})`); return null; }), timeout])
        .then((v) => { if (v) cache.set(key, { at: now(), v }); return v; })
        .finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  };
}

function createAtlas(opts = {}) {
  const llm = opts.llm || (opts.requiredBy === null ? createLlm({}) : createLlmFromEnv(process.env, { timeoutMs: 12000, maxWaitMs: 3000, usageFile: path.join(__dirname, '..', '..', '..', 'data', 'llm-usage-atlas.json') }, 'ATLAS'));
  const annotate = createAnnotator({ llm, log: (m) => console.warn(m) });
  const scrape = opts.scrape || makeScraper(fetch, () => Date.now(), { cacheFile: path.join(__dirname, '..', '..', '..', 'data', 'atlas-cache.json') });
  if (!opts.scrape && (opts.requiredBy ?? module) === require.main) scrape().catch(() => undefined); // warm the cache at start
  return boot('atlas', 4011, {
    method: 'GET', path: '/countries', priceUnits: '5000', handlerTimeoutMs: 50000,
    description: 'Fetches the country list from a public scraping sandbox and returns the top N by population or area.',
    inputCheck: (req) => {
      const top = req.query.top === undefined ? 3 : Number(req.query.top);
      if (!Number.isInteger(top) || top < 1 || top > 10) return 'top must be an integer from 1 to 10';
      if (req.query.by !== undefined && !['population', 'area'].includes(req.query.by)) return 'by must be population or area';
      return null;
    },
    handler: async (req) => {
      const top = req.query.top === undefined ? 3 : Number(req.query.top);
      const by = req.query.by === 'area' ? 'area_km2' : 'population';
      const all = await scrape();
      // Countries only: uninhabited territories such as Antarctica (population 0) are not countries and would fail our own output check.
      const list = all.filter((c) => c.population > 0 && c.area_km2 > 0).sort((a, b) => b[by] - a[by]).slice(0, top);
      const extra = await annotate(list, { by: by === 'area_km2' ? 'area' : 'population', rowsScraped: all.length });
      const countries = extra ? list.map((c) => (extra.notes.has(c.name) ? { ...c, note: extra.notes.get(c.name) } : c)) : list;
      return { countries, ...(extra ? { summary: extra.summary } : {}), meta: { source: SOURCE, rowsScraped: all.length, rankedBy: by === 'area_km2' ? 'area' : 'population', notes: extra ? 'model' : 'none' } };
    },
    // Own output check before settling (M-29): never charge for absurd content.
    outputCheck: (o) => {
      if (!Array.isArray(o.countries) || o.countries.length === 0) return 'no countries';
      return o.countries.every((c) => c.name && c.population > 0 && c.area_km2 > 0) ? null : 'country with zero population or area';
    },
  }, opts.requiredBy ?? module);
}

const app = createAtlas();
module.exports = { app, createAtlas, makeScraper, createAnnotator };
