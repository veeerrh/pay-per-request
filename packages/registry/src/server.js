// Registry: a directory and record keeper only. Data and money never pass through it (design 2, 11).
// Open registration (no auth, D-13), validated with the shared contract, SSRF-safe, rate limited, probe is advisory (M-03).
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const g = require('@di06/guard');

const ROOT = path.join(__dirname, '..', '..', '..');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings(
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, listing_hash TEXT NOT NULL, listing_json TEXT NOT NULL,
  pay_to TEXT NOT NULL, probe_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS listing_versions(
  id TEXT NOT NULL, version INTEGER NOT NULL, listing_hash TEXT NOT NULL, listing_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version));
`;

function createRegistry(opts = {}) {
  const allowPrivate = !!opts.allowPrivate;
  if (opts.demoMode && allowPrivate) throw new Error('REFUSING TO START: ALLOW_PRIVATE_ENDPOINTS must be false in demo mode (D-29)');
  const maxPerPayTo = opts.maxPerPayTo ?? 3;
  const db = new Database(opts.dbPath || ':memory:');
  db.exec(SCHEMA);
  const fetchImpl = opts.fetch || fetch;
  const lookup = opts.lookup;

  const RegSchema = g.Listing.extend({
    endpoint: allowPrivate ? z.string().url() : g.Listing.shape.endpoint,
    probeQuery: z.string().max(200).optional(),
    probeBody: z.record(z.string(), z.unknown()).optional(),
  });

  const hashOf = (l) => crypto.createHash('sha256').update(g.stableStringify(l)).digest('hex').slice(0, 16);

  /** Advisory probe (M-03): one unpaid request, compare the 402 with the listing. Never blocks registration. */
  async function probe(l) {
    try {
      await g.assertPublicEndpoint(l.endpoint, { allowPrivate, lookup }); // re-check at probe time (DNS rebinding)
      const url = l.endpoint + (l.probeQuery ? `${l.endpoint.includes('?') ? '&' : '?'}${l.probeQuery}` : '');
      const res = await g.limitedFetch(fetchImpl, url, { method: l.method, body: l.probeBody ? JSON.stringify(l.probeBody) : undefined, headers: l.probeBody ? { 'content-type': 'application/json' } : {} }, { timeoutMs: 8000, maxBytes: 65536 });
      const at = new Date().toISOString();
      if (res.status !== 402) return { matches: null, reason: `seller answered ${res.status} to the example request, so its 402 could not be checked`, at };
      const header = res.headers.get('payment-required');
      if (!header) return { matches: null, reason: '402 without a PAYMENT-REQUIRED header', at };
      const accepts = g.decodePaymentRequired(header).accepts;
      const ok = accepts.some((a) => a.network === g.NETWORK && a.asset.toLowerCase() === g.USDC_ADDRESS.toLowerCase() && a.amount === BigInt(l.price) && a.payTo.toLowerCase() === l.payTo.toLowerCase());
      if (ok) return { matches: true, reason: null, at };
      const a = accepts[0];
      const why = [];
      if (a.amount !== BigInt(l.price)) why.push(`asks ${a.amount} units against a listed ${l.price}`);
      if (a.payTo.toLowerCase() !== l.payTo.toLowerCase()) why.push(`names payTo ${a.payTo}, not the listed ${l.payTo}`);
      if (a.network !== g.NETWORK) why.push(`names network ${a.network}`);
      if (a.asset.toLowerCase() !== g.USDC_ADDRESS.toLowerCase()) why.push(`names asset ${a.asset}`);
      return { matches: false, reason: why.join('; ') || 'terms differ from the listing', at };
    } catch (e) {
      return { matches: null, reason: `probe failed: ${e.message}`, at: new Date().toISOString() };
    }
  }

  const present = (row) => {
    const l = JSON.parse(row.listing_json);
    return {
      id: row.id, name: l.name, category: l.category, description: l.description, endpoint: l.endpoint, method: l.method, price: l.price,
      network: l.network, asset: l.asset, payTo: l.payTo, inputSchema: l.inputSchema, outputSchema: l.outputSchema, labels: l.labels || [],
      listingHash: row.listing_hash, version: row.version, status: row.status, probe: row.probe_json ? JSON.parse(row.probe_json) : null,
      updatedAt: row.updated_at,
    };
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], styleSrc: ["'self'"], frameAncestors: ["'none'"] } } }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, listings: db.prepare('SELECT COUNT(*) AS n FROM listings').get().n }));

  app.get('/services', (req, res) => {
    let rows = db.prepare('SELECT * FROM listings ORDER BY id').all().map(present);
    if (req.query.category) rows = rows.filter((r) => r.category === String(req.query.category));
    if (req.query.maxPrice !== undefined) {
      if (!/^\d{1,9}$/.test(String(req.query.maxPrice))) return res.status(400).json({ error: 'maxPrice must be a digit string of units' });
      rows = rows.filter((r) => BigInt(r.price) <= BigInt(req.query.maxPrice));
    }
    if (req.query.q) { const q = String(req.query.q).toLowerCase().slice(0, 100); rows = rows.filter((r) => `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(q)); }
    res.json(rows);
  });

  app.get('/services/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const versions = db.prepare('SELECT version, listing_hash AS listingHash, created_at AS createdAt FROM listing_versions WHERE id=? ORDER BY version').all(req.params.id);
    res.json({ ...present(row), versions });
  });

  const limiter = rateLimit({
    windowMs: opts.rateWindowMs ?? 3_600_000, limit: opts.rateLimit ?? 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'rate_limited', detail: 'too many registrations from this address, try again later' },
  });

  app.post('/services', limiter, async (req, res) => {
    const parsed = RegSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_listing', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const { probeQuery, probeBody, ...core } = parsed.data;
    const listing = { ...core, name: g.sanitizeListingText(core.name, 80), description: g.sanitizeListingText(core.description, 500), probeQuery, probeBody };
    try { await g.assertPublicEndpoint(listing.endpoint, { allowPrivate, lookup }); } catch (e) { return res.status(400).json({ error: 'invalid_endpoint', detail: e.message }); }
    const id = slug(listing.name);
    if (!id) return res.status(400).json({ error: 'invalid_listing', issues: [{ path: 'name', message: 'name must contain letters or digits' }] });

    const existing = db.prepare('SELECT * FROM listings WHERE id=?').get(id);
    if (existing && existing.pay_to.toLowerCase() !== listing.payTo.toLowerCase()) return res.status(409).json({ error: 'name_taken', detail: 'a listing with this name belongs to a different payTo address' });
    if (!existing) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM listings WHERE lower(pay_to)=?').get(listing.payTo.toLowerCase()).n;
      if (n >= maxPerPayTo) return res.status(429).json({ error: 'payto_limit', detail: `at most ${maxPerPayTo} listings per payTo address` });
    }
    const stored = JSON.stringify(listing);
    const h = hashOf({ ...listing, probeQuery: undefined, probeBody: undefined });
    if (existing && existing.listing_hash === h) return res.status(200).json({ id, version: existing.version, status: existing.status, probe: JSON.parse(existing.probe_json || 'null'), unchanged: true });

    const now = new Date().toISOString();
    const priceChanged = existing && JSON.parse(existing.listing_json).price !== listing.price;
    const result = await probe(listing);
    // A price change stays held until a probe confirms the new terms (M-05).
    const status = result.matches === false ? 'flagged' : priceChanged && result.matches !== true ? 'held' : 'active';
    const version = existing ? existing.version + 1 : 1;
    db.transaction(() => {
      db.prepare('INSERT INTO listing_versions(id, version, listing_hash, listing_json, created_at) VALUES (?,?,?,?,?)').run(id, version, h, stored, now);
      if (existing) db.prepare('UPDATE listings SET version=?, status=?, listing_hash=?, listing_json=?, probe_json=?, updated_at=? WHERE id=?').run(version, status, h, stored, JSON.stringify(result), now, id);
      else db.prepare('INSERT INTO listings(id, version, status, listing_hash, listing_json, pay_to, probe_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, version, status, h, stored, listing.payTo, JSON.stringify(result), now, now);
    })();
    res.status(existing ? 200 : 201).json({ id, version, status, probe: result });
  });

  // Minimal server-rendered page for anyone who opens the registry URL directly. All text is escaped; no script runs (M-55).
  app.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM listings ORDER BY id').all().map(present);
    const tr = rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.category)}</td><td>${esc(r.price)} units</td><td>${esc(r.status)}</td><td>${esc(r.payTo)}</td><td>${esc(r.description)}</td></tr>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>AgentMarket registry</title><h1>AgentMarket registry</h1><p>Testnet only (Base Sepolia). Prices are in USDC units (6 decimals). JSON: <a href="/services">/services</a></p><table border="1" cellpadding="6"><tr><th>Name</th><th>Category</th><th>Price</th><th>Status</th><th>payTo</th><th>Description</th></tr>${tr}</table>`);
  });

  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.status === 400 ? 'bad_request' : 'internal_error' }));
  app.db = db;
  return app;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const app = createRegistry({
    dbPath: path.join(ROOT, 'data', 'registry.db'), allowPrivate: process.env.ALLOW_PRIVATE_ENDPOINTS === 'true', demoMode: process.env.DEMO_MODE === 'true',
  });
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`registry on :${port}${process.env.ALLOW_PRIVATE_ENDPOINTS === 'true' ? ' (DEV: private endpoints allowed)' : ''}`));
}

module.exports = { createRegistry, slug };
