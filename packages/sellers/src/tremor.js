// Tremor: honest data seller (0.002 USDC). Wraps the public USGS earthquake catalog.
const path = require('path');
const { boot, ROOT } = require('./common');
const geo = require(path.join(ROOT, 'config', 'geo.json'));
delete geo._note;

const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const countryKey = (name) => Object.keys(geo).find((k) => k.toLowerCase() === String(name).toLowerCase());

function parseQuery(q) {
  const days = q.days === undefined ? 7 : Number(q.days);
  const minMag = q.minMag === undefined ? 4.5 : Number(q.minMag);
  return { country: countryKey(q.country), days, minMag };
}

function createTremor(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const cache = new Map();
  const TTL = 10 * 60_000;          // identical questions within 10 minutes reuse the answer
  const STALE_OK = 6 * 60 * 60_000; // if the public API is slow or down, a recent answer beats a failure

  const usgs = async (url) => {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`USGS answered ${res.status}`);
        return await res.json();
      } catch (e) { last = e; }
    }
    throw last;
  };

  /** One catalog query with caching. Used by the paid route and by the start-up warm-up. */
  async function query(p) {
    const g = geo[p.country];
    const start = new Date(Date.now() - p.days * 86400000).toISOString();
    const url = `${USGS}?format=geojson&latitude=${g.lat}&longitude=${g.lon}&maxradiuskm=${g.radiusKm}&minmagnitude=${p.minMag}&starttime=${encodeURIComponent(start)}&orderby=time&limit=20`;
    const key = `${p.country}|${p.days}|${p.minMag}`;
    const hit = cache.get(key);
    let j;
    if (hit && Date.now() - hit.at < TTL) j = hit.j;
    else {
      try { j = await usgs(url); cache.set(key, { at: Date.now(), j }); } catch (e) {
        if (hit && Date.now() - hit.at < STALE_OK) j = hit.j; else throw e;
      }
    }
    const quakes = (j.features || []).map((f) => ({ magnitude: f.properties.mag, place: String(f.properties.place || '').slice(0, 120), time: new Date(f.properties.time).toISOString() }));
    return { country: p.country, window_days: p.days, quakes };
  }

  const app = boot('tremor', 4012, {
    method: 'GET', path: '/quakes', priceUnits: '2000', handlerTimeoutMs: 60000,
    description: 'Queries the public USGS earthquake catalog for a country region.',
    inputCheck: (req) => {
      const p = parseQuery(req.query);
      if (!p.country) return 'unknown country (not in the supported table)';
      if (!Number.isInteger(p.days) || p.days < 1 || p.days > 30) return 'days must be an integer from 1 to 30';
      if (!Number.isFinite(p.minMag) || p.minMag < 0 || p.minMag > 9) return 'minMag must be between 0 and 9';
      return null;
    },
    handler: (req) => query(parseQuery(req.query)),
    outputCheck: (o) => (o.quakes.every((q) => q.magnitude >= 0 && q.magnitude <= 10) ? null : 'magnitude outside 0 to 10'),
  }, opts.requiredBy ?? module);

  if (!opts.fetch && (opts.requiredBy ?? module) === require.main) {
    // Warm the cache for the three example tasks so the first live run does not wait on the public catalog.
    const warm = [['China', 7, 4.5], ['India', 7, 4.5], ['United States', 7, 4.5], ['Russia', 14, 5], ['Canada', 14, 5], ['China', 14, 5], ['United States', 14, 5], ['China', 30, 4], ['India', 30, 4]];
    (async () => { for (const [country, days, minMag] of warm) { await query({ country, days, minMag }).catch(() => undefined); } })();
  }
  return app;
}

const app = createTremor();
module.exports = { app, createTremor };
