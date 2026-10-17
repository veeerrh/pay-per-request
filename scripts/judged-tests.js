// Rehearses the nine judged tests (T-01..T-09) against a running stack and writes docs/evidence/JUDGED_TESTS.md.
// Usage: node scripts/judged-tests.js [--only T-03,T-04] [--beacon http://localhost:4100]
// Needs: npm run start (registry + sellers) and Beacon running. Spends a few cents of test USDC.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const g = require('../packages/guard/dist');

const ROOT = path.join(__dirname, '..');
const addr = require('../config/addresses.json');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BEACON = arg('beacon', 'http://localhost:4100').replace(/\/$/, '');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const TOKEN = process.env.OPERATOR_TOKEN;
const chain = g.createChainReader(process.env.RPC_URL);
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';
const T3 = 'For the 2 most populous countries, find earthquakes of magnitude 4.0 or more from the last 30 days and write a short readiness brief for each.';
const results = [];
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (id) => !ONLY.length || ONLY.includes(id);
const randAddr = () => privateKeyToAccount(generatePrivateKey()).address; // key discarded: a receive-only address
const scanLink = (h) => `https://sepolia.basescan.org/tx/${h}`;

async function api(method, p, body, headers = {}) {
  const r = await fetch(BEACON + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
}
async function newSession() {
  const r = await api('POST', '/api/session/new', {}, { 'x-operator-token': TOKEN });
  if (r.status !== 200) throw new Error(`could not start a new session (${r.status}): is OPERATOR_TOKEN in .env?`);
}
async function runTask(body, maxMs = 420000) {
  const c = await api('POST', '/api/tasks', body);
  if (c.status !== 202) throw new Error(`task rejected (${c.status}): ${JSON.stringify(c.body)}`);
  const id = c.body.taskId;
  const t0 = Date.now();
  for (;;) {
    const s = (await api('GET', `/api/tasks/${id}`)).body;
    if (s.status !== 'running') return s;
    if (Date.now() - t0 > maxMs) throw new Error('task timed out');
    await sleep(2000);
  }
}
const ledgerFor = async (taskId) => (await api('GET', '/api/ledger')).body.filter((e) => e.taskId === taskId);

/** Confirms on chain that a transaction moved `amount` USDC units from the buyer to `to`. */
async function verifyTransfer(hash, from, to, amount) {
  const r = await chain.client.getTransactionReceipt({ hash });
  const logs = await chain.client.getLogs({ address: g.USDC_ADDRESS, event: g.USDC_ABI[3], fromBlock: r.blockNumber, toBlock: r.blockNumber });
  return logs.some((l) => l.transactionHash === hash && l.args.from.toLowerCase() === from.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase() && l.args.value === BigInt(amount));
}

function startRef(port, route, price, payTo, flags = []) {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'reference-seller.js'), '--port', String(port), '--route', route, '--price', price, '--payto', payTo, ...flags], { cwd: ROOT, stdio: 'ignore' });
  children.push(p);
  return p;
}
async function register(l) {
  const r = await api('POST', '/api/services', l);
  if (![200, 201].includes(r.status)) throw new Error(`register failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}
const listingBase = (over) => ({ network: 'eip155:84532', asset: g.USDC_ADDRESS, method: 'GET', inputSchema: { type: 'object' }, labels: [], ...over });
const countriesOut = require('../config/listings/atlas.json').outputSchema;
const briefOut = require('../config/listings/brief.json').outputSchema;

async function test(id, name, fn) {
  if (!want(id)) return;
  process.stdout.write(`${id} ${name} ... `);
  try { const r = await fn(); results.push({ id, name, pass: !!r.pass, detail: r.detail, links: r.links || [] }); console.log(r.pass ? 'PASS' : 'FAIL', r.detail); } catch (e) { results.push({ id, name, pass: false, detail: `error: ${e.message}`, links: [] }); console.log('FAIL error:', e.message); }
}

async function main() {
  const health = await api('GET', '/api/health');
  if (health.status !== 200) throw new Error('Beacon is not reachable. Start it first.');
  const beaconAddr = (await api('GET', '/api/wallet')).body.address;

  await test('T-01', 'Happy path, then change the numbers', async () => {
    await newSession();
    const s = await runTask({ text: T1, budget: '50000', maxConcurrency: 3 });
    const rows = (await ledgerFor(s.id)).filter((e) => e.status === 'paid');
    const payTos = new Map((await api('GET', '/api/services')).body.map((x) => [x.id, x.payTo]));
    const links = [], bad = [];
    for (const e of rows) {
      const payTo = payTos.get(e.sellerId) || addr.sellers[e.sellerId];
      const ok = e.txHash && await verifyTransfer(e.txHash, beaconAddr, payTo, e.paid);
      if (e.txHash) links.push(scanLink(e.txHash));
      if (!ok) bad.push(e.sellerId);
    }
    const s2 = await runTask({ text: T3, budget: '30000', maxConcurrency: 3 });
    const pass = s.status === 'completed' && rows.length >= 3 && !bad.length && s2.status === 'completed';
    return { pass, detail: `task1 ${s.status}, ${rows.length} paid calls verified on chain${bad.length ? ' (MISMATCH ' + bad.join(',') + ')' : ''}; changed numbers: ${s2.status}`, links };
  });

  await test('T-02', 'Reconciliation', async () => {
    const r = (await api('POST', '/api/reconcile', {})).body;
    return { pass: r.ok === true && r.ledgerTotal === r.chainTotal, detail: `status ${r.status}, ledger ${r.ledgerTotal}, chain ${r.chainTotal}` };
  });

  await test('T-03', 'Budget 0.012 at concurrency 1 and 5', async () => {
    const out = [];
    for (const c of [1, 5]) {
      await newSession();
      const s = await runTask({ text: T3, budget: '12000', maxConcurrency: c });
      out.push({ c, status: s.status, spent: BigInt(s.spent), notice: s.notice });
    }
    const pass = out.every((o) => o.status === 'stopped' && o.spent <= 12000n && o.notice);
    return { pass, detail: out.map((o) => `c=${o.c}: ${o.status}, spent ${o.spent}`).join('; ') };
  });

  await test('T-04', 'Price check: price lie and payTo lie', async () => {
    const a = randAddr(), b = randAddr(), decoy = randAddr();
    startRef(4301, 'GET /countries', '0.010', a);   // really asks 10,000 units
    startRef(4302, 'GET /countries', '0.001', decoy); // really pays to the decoy
    await sleep(3000);
    await register(listingBase({ name: 'RefLiarPrice', category: 'scraping', endpoint: 'http://localhost:4301/countries', price: '1000', payTo: a, outputSchema: countriesOut, description: 'listed at 0.001, 402 asks 0.010', probeQuery: 'top=1' }));
    await register(listingBase({ name: 'RefLiarPayTo', category: 'scraping', endpoint: 'http://localhost:4302/countries', price: '1000', payTo: b, outputSchema: countriesOut, description: 'listed payTo differs from the 402', probeQuery: 'top=1' }));
    const r1 = await runTask({ budget: '50000', directUrl: { url: 'http://localhost:4301/countries?top=1', expectedPrice: '1000', category: 'scraping', expectedPayTo: a } });
    const r2 = await runTask({ budget: '50000', directUrl: { url: 'http://localhost:4302/countries?top=1', expectedPrice: '1000', category: 'scraping', expectedPayTo: b } });
    const pass = r1.status === 'stopped' && r1.spent === '0' && r1.result.breakdown[0].ruleId === 'M-17' && r2.status === 'stopped' && r2.spent === '0' && r2.result.breakdown[0].ruleId === 'S-06';
    return { pass, detail: `price lie: ${r1.result.breakdown[0].ruleId}, paid ${r1.spent}; payTo lie: ${r2.result.breakdown[0].ruleId}, paid ${r2.spent}` };
  });

  await test('T-05', 'Replay: once, again, five in parallel', async () => {
    const atk = await api('POST', '/api/attack/replay5', {});
    if (atk.status === 200) return { pass: atk.body.actual.verdict === 'PASS', detail: atk.body.actual.reason };
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'http://localhost:4011/countries?top=1', 'BEACON_PRIVATE_KEY'], { cwd: ROOT, encoding: 'utf8' });
    const out = res.stdout + res.stderr;
    return { pass: res.status === 0 && /PASS/.test(out), detail: `replay wallet unavailable (${atk.body?.error}); ran the script with the Beacon wallet instead: ${(out.match(/stage 3.*|PASS.*|FAIL.*/g) || []).join(' | ')}` };
  });

  await test('T-06', 'Seller failure is not charged', async () => {
    const r = await api('POST', '/api/attack/failure', {});
    return { pass: r.status === 200 && r.body.actual.status === 'failed' && r.body.paid === '0', detail: r.body.actual ? `${r.body.actual.verdict} ${r.body.actual.ruleId}, paid ${r.body.paid}` : JSON.stringify(r.body) };
  });

  await test('T-07', 'Junk output: paid, rejected, bought elsewhere', async () => {
    const junkAddr = randAddr();
    startRef(4305, 'POST /brief', '0.003', junkAddr, ['--junk']);
    await sleep(3000);
    await register(listingBase({ name: 'RefJunk', category: 'inference', method: 'POST', endpoint: 'http://localhost:4305/brief', price: '3000', payTo: junkAddr, outputSchema: briefOut, description: 'returns 200 with schema-breaking output', probeBody: { countries: [{ name: 'India', quakes: [] }] } }));
    await newSession();
    const s = await runTask({ text: T1, budget: '60000', maxConcurrency: 3 });
    const rows = await ledgerFor(s.id);
    const junk = rows.find((e) => e.sellerId === 'refjunk');
    const rep = (await api('GET', '/api/reputation')).body.find((r) => r.sellerId === 'refjunk');
    const pass = !!junk && junk.status === 'rejected' && BigInt(junk.paid) > 0n && s.status === 'completed' && rep && rep.junk >= 1;
    return { pass, detail: `RefJunk ${junk ? junk.status : 'not used'} paid ${junk?.paid}; task ${s.status}; reputation junk count ${rep?.junk}`, links: junk?.txHash ? [scanLink(junk.txHash)] : [] };
  });

  await test('T-08', 'Standard clients in both directions', async () => {
    const a = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reference-buyer.js'), 'http://localhost:4011/countries?top=1', 'SPARE_BUYER_PRIVATE_KEY'], { cwd: ROOT, encoding: 'utf8' });
    let aOut = a.stdout + a.stderr, wallet = 'spare wallet';
    if (!/status 200/.test(aOut)) {
      const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reference-buyer.js'), 'http://localhost:4011/countries?top=1', 'BEACON_PRIVATE_KEY'], { cwd: ROOT, encoding: 'utf8' });
      aOut = b.stdout + b.stderr; wallet = 'Beacon wallet (spare not funded)';
    }
    const okA = /status 200/.test(aOut) && /success: true/.test(aOut);
    const payTo = randAddr();
    startRef(4304, 'GET /countries', '0.002', payTo);
    await sleep(3000);
    const s = await runTask({ budget: '20000', directUrl: { url: 'http://localhost:4304/countries?top=1', expectedPrice: '2000', category: 'scraping', expectedPayTo: payTo } });
    return { pass: okA && s.status === 'completed' && s.spent === '2000', detail: `reference buyer (${wallet}) paid our Atlas: ${okA}; our buyer paid the reference seller: ${s.status}, spent ${s.spent}` };
  });

  await test('T-09', 'Key hygiene', async () => {
    const r = spawnSync('npm', ['run', 'scan'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
    const lines = (r.stdout.match(/^(PASS|FAIL).*/gm) || []);
    return { pass: r.status === 0, detail: lines.join('; ') };
  });

  children.forEach((c) => { try { c.kill(); } catch { /* gone */ } });
  const md = [`# Judged-test rehearsal\n`, `Run: ${new Date().toISOString()} against ${BEACON}. Testnet only (Base Sepolia). Beacon ${beaconAddr}.\n`, '| Test | Result | Detail | Explorer |', '| --- | --- | --- | --- |']
    .concat(results.map((r) => `| ${r.id} ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.links.map((l, i) => `[tx${i + 1}](${l})`).join(' ')} |`)).join('\n') + '\n';
  if (!ONLY.length) { fs.mkdirSync(path.join(ROOT, 'docs', 'evidence'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'docs', 'evidence', 'JUDGED_TESTS.md'), md); }
  console.log('\n' + md);
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}
main().catch((e) => { console.error(e.message); children.forEach((c) => { try { c.kill(); } catch { /* gone */ } }); process.exit(1); });
