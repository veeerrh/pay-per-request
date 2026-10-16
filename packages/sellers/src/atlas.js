// Atlas: honest scraping seller (0.005 USDC). Checks robots.txt and a domain allowlist before fetching (M-41, P-18).
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { boot } = require('./common');

const SOURCE = 'https://www.scrapethissite.com/pages/simple/';
const ALLOWED_HOSTS = new Set(['www.scrapethissite.com', 'scrapethissite.com']);
const UA = 'AgentMarket-Atlas/1.0 (hackathon demo)';
const CACHE_MS = 10 * 60 * 1000;

function makeScraper(fetchImpl = fetch, now = () => Date.now()) {
  let cache = null;
  return async function countries() {
    if (cache && now() - cache.at < CACHE_MS) return cache.list;
    const url = new URL(SOURCE);
    if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error('domain is not on the allowlist');
    const robotsTxt = await fetchImpl(`${url.origin}/robots.txt`, { headers: { 'user-agent': UA } }).then((r) => (r.ok ? r.text() : ''));
    const robots = robotsParser(`${url.origin}/robots.txt`, robotsTxt);
    if (robots.isAllowed(SOURCE, UA) === false) throw new Error('robots.txt disallows this page');
    const res = await fetchImpl(SOURCE, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`source answered ${res.status}`);
    const $ = cheerio.load(await res.text());
    const list = [];
    $('.country').each((_i, el) => {
      const g = (c) => $(el).find(c).text().trim();
      list.push({ name: g('.country-name'), capital: g('.country-capital'), population: parseInt(g('.country-population'), 10), area_km2: parseFloat(g('.country-area')) });
    });
    if (!list.length) throw new Error('page had no countries');
    cache = { at: now(), list };
    return list;
  };
}

function createAtlas(opts = {}) {
  const scrape = opts.scrape || makeScraper();
  return boot('atlas', 4011, {
    method: 'GET', path: '/countries', priceUnits: '5000',
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
      const list = [...(await scrape())].sort((a, b) => b[by] - a[by]).slice(0, top);
      return { countries: list };
    },
    // Own output check before settling (M-29): never charge for absurd content.
    outputCheck: (o) => {
      if (!Array.isArray(o.countries) || o.countries.length === 0) return 'no countries';
      return o.countries.every((c) => c.name && c.population > 0 && c.area_km2 > 0) ? null : 'country with zero population or area';
    },
  }, opts.requiredBy ?? module);
}

const app = createAtlas();
module.exports = { app, createAtlas, makeScraper };
