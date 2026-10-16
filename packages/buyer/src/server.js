// Beacon's HTTP surface: serves web/ and the /api/* contract (Appendix B) on ONE origin (D-24).
// Public reads need no token (read-only dashboard, M-55). Mutations are validated and rate limited.
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const g = require('@di06/guard');
const { runTask, runDirect } = require('./runner');

const ROOT = path.join(__dirname, '..', '..', '..');
const ser = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const BUYER_NAME = 'Scout';

const TaskReq = z.object({
  text: z.string().min(10, 'Describe the task (at least 10 characters).').max(1000, 'Task text is longer than 1000 characters.').optional(),
  budget: z.string().regex(/^\d{1,12}$/, 'budget must be a digit string of USDC units'),
  maxConcurrency: z.number().int().min(1).max(5).default(3),
  hired: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(8).default([]),
  directUrl: z.object({
    url: z.string().url().max(500),
    expectedPrice: z.string().regex(/^\d{1,6}$/),
    category: z.enum(['data', 'inference', 'scraping']),
    expectedPayTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  }).optional(),
}).refine((t) => t.text || t.directUrl, { message: 'Provide a task text or a direct URL.' });

/**
 * deps: { store, budget, signer, chain, cfg, listings: () => Promise<Listing[]>, registryUrl?, operatorToken, webDir?,
 *         allowPrivate?, taskLimit?, maxTaskBudget?, log?, services?: () => Promise<any[]> }
 */
function createServer(deps) {
  const { store, budget, signer, chain, cfg } = deps;
  const maxTaskBudget = BigInt(deps.maxTaskBudget ?? 5_000_000);
  const state = { halted: false, haltReason: '', tasks: new Map(), seq: 0, balance: { at: 0, v: 0n } };
  const ruleSetHash = () => g.ruleSetHash(cfg, path.join(ROOT, 'packages', 'guard', 'dist', 'rules'));

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"] } },
  }));
  app.use(express.json({ limit: '32kb' }));

  const taskLimiter = rateLimit({ windowMs: 60_000, limit: deps.taskLimit ?? 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', detail: 'Too many tasks, wait a minute.' } });
  const light = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited' } });

  async function balance() {
    if (Date.now() - state.balance.at < 10_000) return state.balance.v;
    state.balance = { at: Date.now(), v: await chain.balanceOf(signer.address) };
    return state.balance.v;
  }

  /** Re-verify the ledger chain; a break halts spending (M-62, S-84). */
  function checkChain() {
    const c = store.verifyChain();
    state.halted = !c.ok;
    state.haltReason = c.ok ? '' : `ledger chain broken at row ${c.brokenAt}`;
    return c;
  }
  checkChain();

  // ---------- read-only endpoints ----------
  app.get('/api/health', (_req, res) => res.json({ ok: true, sessionId: store.sessionId, spendingHalted: state.halted }));
  app.get('/api/examples', (_req, res) => res.json(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tasks.json'), 'utf8'))));
  app.get('/api/config', (_req, res) => {
    let hygiene = null;
    try { hygiene = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hygiene.json'), 'utf8')); } catch { /* not generated yet */ }
    res.json({ rules: cfg, ruleSetHash: ruleSetHash(), network: g.NETWORK, usdc: g.USDC_ADDRESS, hygiene, buyer: BUYER_NAME });
  });

  const reputation = () => g.computeReputation(store.listEntries(), cfg, Date.now());

  app.get('/api/services', async (req, res) => {
    try {
      const list = deps.services ? await deps.services(req.query) : [];
      const rep = reputation();
      res.json(ser(list.map((s) => {
        const r = rep.get(s.id) ?? g.newSellerReputation(s.id, cfg);
        return { ...s, reputation: { attempts: r.attempts, clean: r.clean, headline: r.headline, score: r.score, medianLatencyMs: r.medianLatencyMs, medianPrice: r.medianPrice, status: r.status, suspended: r.suspended, lastRuleId: r.lastRuleId } };
      })));
    } catch (e) { res.status(502).json({ error: 'registry_unreachable', detail: e.message }); }
  });

  app.post('/api/services', light, async (req, res) => {
    if (!deps.registryUrl) return res.status(501).json({ error: 'no_registry' });
    try {
      const r = await fetch(`${deps.registryUrl}/services`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(15000) });
      res.status(r.status).json(await r.json());
    } catch (e) { res.status(502).json({ error: 'registry_unreachable', detail: e.message }); }
  });

  app.get('/api/wallet', async (_req, res) => {
    let bal = null;
    try { bal = await balance(); } catch { /* chain unreachable: report null, never a guess */ }
    const reserved = store.db.prepare("SELECT amount FROM reservations r JOIN tasks t ON t.task_id=r.task_id WHERE t.session_id=? AND r.state='reserved'").all(store.sessionId).reduce((s, r) => s + BigInt(r.amount), 0n);
    res.json(ser({ address: signer.address, usdcBalance: bal, reserved, sessionId: store.sessionId, spendingHalted: state.halted, haltReason: state.haltReason, network: g.NETWORK }));
  });

  const entries = () => store.listEntries().map((e) => ({ ...e, buyer: BUYER_NAME, buyerAddress: signer.address, source: e.source ?? 'task' }));
  app.get('/api/ledger', (req, res) => {
    let rows = entries();
    if (req.query.status) rows = rows.filter((e) => e.status === String(req.query.status));
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    res.json(ser(rows.slice(-limit)));
  });
  app.get('/api/ledger/verify', (_req, res) => res.json(ser(checkChain())));
  app.get('/api/reputation', (_req, res) => res.json(ser([...reputation().values()])));

  app.post('/api/reconcile', light, async (_req, res) => {
    const start = store.sessionStartBlock();
    if (start === null) return res.json({ ok: false, status: 'unverified', error: 'this session has no start block', ledgerTotal: '0', chainTotal: '0', differences: [] });
    const r = await g.reconcile({ store, chain, buyerAddress: signer.address, fromBlock: BigInt(start), retry: { times: 4, delayMs: 3000 } });
    res.json(ser({ ...r, rows: undefined, differences: r.differences }));
  });

  // ---------- tasks ----------
  const snapshot = (t) => ({
    id: t.id, text: t.text, budget: t.budget, maxConcurrency: t.maxConcurrency, hired: t.hired, kind: t.kind, status: t.status, stage: t.stage,
    startedAt: t.startedAt, endedAt: t.endedAt, spent: t.spent, reserved: t.reserved, paidCalls: t.paidCalls, services: t.services, result: t.result, notice: t.notice,
  });
  function apply(t, ev) {
    if (ev.type === 'stage') t.stage = ev.stage;
    else if (ev.type === 'metrics') Object.assign(t, { spent: ev.spent, reserved: ev.reserved, paidCalls: ev.paidCalls, services: ev.services });
    else if (ev.type === 'blocked') { t.status = 'blocked'; t.notice = ev.notice; t.endedAt = ev.at; }
    else if (ev.type === 'done') { t.status = ev.status; t.notice = ev.notice; t.result = ev.result; t.endedAt = ev.at; }
  }
  function emit(t, ev) {
    const e = { ...ev, id: t.events.length + 1 };
    t.events.push(e);
    if (t.events.length > 500) t.events.shift();
    apply(t, e);
    for (const sub of t.subs) sub.write(`id: ${e.id}\ndata: ${JSON.stringify(ser(e))}\n\n`);
    if (t.status !== 'running') { for (const sub of t.subs) sub.end(); t.subs.clear(); }
  }

  app.post('/api/tasks', taskLimiter, async (req, res) => {
    const p = TaskReq.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_task', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const body = p.data;
    const b = BigInt(body.budget);
    if (b <= 0n) return res.status(400).json({ error: 'invalid_task', issues: [{ path: 'budget', message: 'Budget must be greater than 0.' }] });
    if (b > maxTaskBudget) return res.status(400).json({ error: 'invalid_task', issues: [{ path: 'budget', message: `Demo limit is ${g.formatUsdc(maxTaskBudget)} USDC per task.` }] });
    if (state.halted) return res.status(409).json({ error: 'spending_halted', detail: state.haltReason });
    if ([...state.tasks.values()].filter((t) => t.status === 'running').length >= 2) return res.status(429).json({ error: 'busy', detail: 'Two tasks are already running. Wait for one to finish.' });
    if (body.hired.length) {
      const known = new Set((await deps.listings()).map((l) => l.id));
      const bad = body.hired.filter((h) => !known.has(h));
      if (bad.length) return res.status(400).json({ error: 'invalid_task', issues: [{ path: 'hired', message: `Unknown agent id(s): ${bad.join(', ')}` }] });
    }
    if (body.directUrl && !deps.allowPrivate && !body.directUrl.url.startsWith('https://')) return res.status(400).json({ error: 'invalid_task', issues: [{ path: 'directUrl.url', message: 'The URL must use https.' }] });
    if (body.directUrl && BigInt(body.directUrl.expectedPrice) > g.MAX_PRICE) return res.status(400).json({ error: 'invalid_task', issues: [{ path: 'directUrl.expectedPrice', message: 'Expected price is above the 0.10 USDC cap.' }] });

    const id = `t${++state.seq}_${crypto.randomBytes(3).toString('hex')}`;
    const t = {
      id, text: body.text ?? `Direct purchase from ${body.directUrl.url}`, budget: body.budget, maxConcurrency: body.maxConcurrency, hired: body.hired, kind: body.directUrl ? 'direct' : 'task',
      status: 'running', stage: null, startedAt: new Date().toISOString(), endedAt: null, spent: '0', reserved: '0', paidCalls: 0, services: [], result: null, notice: '', events: [], subs: new Set(),
    };
    state.tasks.set(id, t);
    res.status(202).json({ taskId: id });
    const ctx = { store, budget, signer, cfg, chain, log: deps.log, listings: deps.listings, allowPrivate: deps.allowPrivate };
    const em = (ev) => emit(t, ev);
    (body.directUrl
      ? runDirect(ctx, { taskId: id, budget: b, directUrl: { ...body.directUrl, expectedPrice: BigInt(body.directUrl.expectedPrice) } }, em)
      : runTask(ctx, { taskId: id, text: body.text, budget: b, maxConcurrency: body.maxConcurrency, hired: body.hired }, em)
    ).catch((e) => {
      deps.log?.('error', 'task crashed', { error: e.message });
      emit(t, { type: 'done', status: 'stopped', notice: 'The task stopped unexpectedly. Anything already signed is tracked in the ledger.', result: null, at: new Date().toISOString() });
    }).finally(() => { checkChain(); if (t.status === 'running') { t.status = 'stopped'; for (const s of t.subs) s.end(); } });
  });

  app.get('/api/tasks', (_req, res) => res.json([...state.tasks.values()].map(snapshot).reverse()));
  app.get('/api/tasks/:id', (req, res) => {
    const t = state.tasks.get(req.params.id);
    return t ? res.json(snapshot(t)) : res.status(404).json({ error: 'not_found' });
  });

  app.get('/api/tasks/:id/events', (req, res) => {
    const t = state.tasks.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const last = Number(req.get('last-event-id') || req.query.lastEventId || 0);
    for (const e of t.events.filter((x) => x.id > last)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(ser(e))}\n\n`);
    if (t.status !== 'running') return res.end();
    t.subs.add(res);
    const hb = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); t.subs.delete(res); }); // a closed tab never stops the task
  });

  // ---------- operator action ----------
  app.post('/api/session/new', light, async (req, res) => {
    const given = Buffer.from(String(req.get('x-operator-token') || ''));
    const want = Buffer.from(String(deps.operatorToken || ''));
    if (!deps.operatorToken || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'unauthorized' });
    try { await g.recoverPending({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds }); } catch { /* best effort */ }
    const block = Number(await chain.blockNumber());
    const sessionId = store.newSession(block);
    checkChain();
    res.json({ sessionId, startBlock: block, note: 'The previous session stays stored and verifiable.' });
  });

  // ---------- extra routes (attack panel in 8.1) ----------
  if (deps.extend) deps.extend(app, { state, store, budget, signer, chain, cfg, emit, snapshot, listings: deps.listings, checkChain });

  // ---------- static dashboard ----------
  const webDir = deps.webDir ?? path.join(ROOT, 'web');
  app.use(express.static(webDir, { dotfiles: 'ignore', index: 'index.html' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((_req, res) => res.status(404).type('text').send('Not found'));
  app.use((err, _req, res, _next) => {
    deps.log?.('error', 'unhandled', { error: err.message });
    res.status(err.status === 400 || err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.status === 400 || err.type === 'entity.parse.failed' ? 'bad_request' : 'internal_error' });
  });

  app.state = state;
  return app;
}

/** Registry listings as typed seller listings (typed fields only, M-12). Held listings are not used (M-05). */
function registryListings(registryUrl) {
  return async () => {
    const r = await fetch(`${registryUrl}/services`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`registry answered ${r.status}`);
    return (await r.json()).filter((s) => ['active', 'flagged'].includes(s.status)).map((s) => ({
      id: s.id, name: s.name, category: s.category, price: BigInt(s.price), payTo: s.payTo, endpoint: s.endpoint, method: s.method, listingHash: s.listingHash, outputSchema: s.outputSchema, labels: s.labels,
    }));
  };
}

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  g.assertTestnet({ NETWORK: process.env.NETWORK || 'eip155:84532', CHAIN_ID: process.env.CHAIN_ID || '84532', USDC_ADDRESS: process.env.USDC_ADDRESS || g.USDC_ADDRESS });
  if (process.env.DEMO_MODE === 'true' && process.env.ALLOW_PRIVATE_ENDPOINTS === 'true') { console.error('REFUSING TO START: ALLOW_PRIVATE_ENDPOINTS must be false in demo mode'); process.exit(1); }

  // Operator token: created once, stored in .env (never committed), printed once.
  let operatorToken = process.env.OPERATOR_TOKEN;
  if (!operatorToken) {
    operatorToken = crypto.randomBytes(24).toString('hex');
    fs.appendFileSync(path.join(ROOT, '.env'), `\nOPERATOR_TOKEN=${operatorToken}\n`);
    console.log(`OPERATOR_TOKEN created and saved to .env (needed for "New session"): ${operatorToken}`);
  }

  const cfg = g.loadConfig(path.join(ROOT, 'config', 'rules.config.json'));
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const store = new g.Store(path.join(ROOT, 'data', 'buyer.db'), g.ruleSetHash(cfg, path.join(ROOT, 'packages', 'guard', 'dist', 'rules')));
  const chain = g.createChainReader(process.env.RPC_URL);
  const signer = g.createSigner();
  const log = g.createLogger();
  let cached = { at: 0, v: 0n };
  const budget = new g.Budget(store, cfg, () => cached.v);
  const refresh = async () => { cached = { at: Date.now(), v: await chain.balanceOf(signer.address) }; };
  await refresh().catch(() => undefined);
  setInterval(() => refresh().catch(() => undefined), 15000).unref();
  if (store.sessionStartBlock() === null) store.setSessionStartBlock(Number(await chain.blockNumber()));

  const start = await g.startGuard({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds, log });
  if (start.recovered.length) log('info', 'recovered pending purchases', start.recovered);
  g.startRecoveryLoop({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds, log });

  const registryUrl = (process.env.REGISTRY_URL || 'http://localhost:4000').replace(/\/$/, '');
  const listings = registryListings(registryUrl);
  const services = async (q) => { const u = new URL(`${registryUrl}/services`); for (const k of ['category', 'maxPrice', 'q']) if (q && q[k]) u.searchParams.set(k, String(q[k])); const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`registry answered ${r.status}`); return r.json(); };
  const extend = process.env.ENABLE_ATTACK_PANEL === 'true' ? (() => { try { return require('./attacks').install; } catch { return undefined; } })() : undefined;

  const app = createServer({ store, budget, signer, chain, cfg, listings, services, registryUrl, operatorToken, log, allowPrivate: process.env.ALLOW_PRIVATE_ENDPOINTS === 'true', maxTaskBudget: process.env.MAX_TASK_BUDGET, extend });
  if (start.spendingHalted) { app.state.halted = true; app.state.haltReason = start.reason; }
  const port = Number(process.env.PORT || 4100);
  app.listen(port, () => console.log(`Beacon on :${port} (buyer ${signer.address}, session ${store.sessionId})`));
}

if (require.main === module) main().catch((e) => { console.error('Beacon failed to start:', e.message); process.exit(1); });

module.exports = { createServer, registryListings };
