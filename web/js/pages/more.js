// My Tasks, Reputation, Wallet, Settings pages.
import { api, MOCK } from '../api.js';
import { app } from '../app.js';
import explore from './explore.js';
import { $, esc, icon, formatUsdc, fmtDateTime, dialogHead, openDialog, toast } from '../ui.js';

const err = (root, title, e, retry) => { root.innerHTML = `<section class="card"><div class="empty">${icon('alert')}<h3>${esc(title)}</h3><p>${esc(e.message)}</p><button class="btn btn-primary" type="button" data-retry>${icon('refresh')}Try again</button></div></section>`; $('[data-retry]', root).addEventListener('click', retry); };

export const tasks = {
  title: 'My Tasks',
  subtitle: 'Review what your Buyer Agent bought, from whom, and what it cost.',
  async mount(root) {
    root.innerHTML = '<section class="card"><div class="empty"><p>Loading tasks…</p></div></section>';
    try {
      const list = await api.tasks();
      const lab = { running: ['badge-accent', 'Running'], completed: ['badge-green', 'Completed'], stopped: ['badge-amber', 'Stopped early'], blocked: ['badge-red', 'Nothing bought'] };
      root.innerHTML = `<section class="card" aria-labelledby="tasks-h"><div class="card-head row-between"><div><h2 id="tasks-h">My tasks</h2><p class="muted">Every task given to your Buyer Agent since Beacon started.</p></div><a class="btn btn-primary" href="#explore">${icon('plus')}New task</a></div>
        <div class="task-list">${list.length ? list.map((t) => `<div class="task-item"><div><p>${esc(t.text)}</p><div class="meta"><span class="badge ${(lab[t.status] || lab.stopped)[0]}">${(lab[t.status] || lab.stopped)[1]}</span><span>Budget ${formatUsdc(t.budget)} USDC</span><span>Spent ${formatUsdc(t.spent)} USDC</span><span>${esc(t.paidCalls)} paid calls</span><span>${fmtDateTime(t.startedAt)}</span></div></div><button class="btn btn-secondary" type="button" data-open="${esc(t.id)}">${icon('eye')}View</button></div>`).join('') : `<div class="empty">${icon('tasks')}<h3>No tasks yet</h3><p>Give your Buyer Agent a task to see it here.</p><a class="btn btn-primary" href="#explore">Create a task</a></div>`}</div></section>`;
      root.onclick = (e) => { const b = e.target.closest('[data-open]'); if (b) { explore.open(b.dataset.open); app.goto('#explore'); } };
    } catch (e) { err(root, 'Could not load tasks', e, () => tasks.mount(root)); }
  },
};

export const reputation = {
  title: 'Reputation',
  subtitle: 'Success rate, latency and price per seller, computed from the ledger.',
  async mount(root) {
    root.innerHTML = '<section class="card"><div class="empty"><p>Loading…</p></div></section>';
    try {
      const [rep, svc] = await Promise.all([api.reputation(), api.services().catch(() => [])]);
      const name = new Map(svc.map((s) => [s.id, s]));
      const ids = new Set([...rep.map((r) => r.sellerId), ...svc.map((s) => s.id)]);
      const byId = new Map(rep.map((r) => [r.sellerId, r]));
      const rows = [...ids].map((id) => ({ id, r: byId.get(id), s: name.get(id) })).sort((a, b) => (b.r?.score ?? 0.5) - (a.r?.score ?? 0.5));
      root.innerHTML = `<section class="card" aria-labelledby="rep-h"><div class="card-head"><h2 id="rep-h">Seller reputation</h2><p class="muted">Computed from the ledger. Nobody can edit it. Success rate is clean calls divided by attempts. New sellers start on probation.</p></div>
        <div class="table-scroll"><table class="table-plain"><thead><tr><th scope="col">Seller</th><th scope="col">Category</th><th scope="col">Attempts</th><th scope="col">Success rate</th><th scope="col">Median latency</th><th scope="col">Median price</th><th scope="col">Status</th><th scope="col">Last rule</th></tr></thead><tbody>
        ${rows.map(({ id, r, s }) => `<tr><td><strong>${esc(s?.name || id)}</strong>${s?.labels?.includes('test-vendor') ? ' <span class="badge badge-amber">Test vendor</span>' : ''}</td><td>${esc(s?.category || '–')}</td><td>${r ? esc(r.attempts) : 0}</td><td>${r && r.attempts ? Math.round((r.headline ?? 0) * 100) + '%' : 'New'}</td><td>${r?.medianLatencyMs ? (r.medianLatencyMs / 1000).toFixed(2) + 's' : '–'}</td><td>${r?.medianPrice ? formatUsdc(r.medianPrice) : s ? formatUsdc(s.price) : '–'}</td><td>${statusCell(r)}</td><td>${esc(r?.lastRuleId || '–')}</td></tr>`).join('')}
        </tbody></table></div></section>`;
    } catch (e) { err(root, 'Could not load reputation', e, () => reputation.mount(root)); }
  },
};
function statusCell(r) {
  const st = r?.status || 'probation';
  const cls = { dropped: 'badge-red', active: 'badge-green', probation: '' }[st];
  return `<span class="badge ${cls}">${esc(st)}</span>${r?.suspended ? ' <span class="badge badge-red">suspended</span>' : ''}`;
}

export const wallet = {
  title: 'Wallet',
  subtitle: 'Your Base Sepolia test wallet. Test funds only, no real money.',
  async mount(root) {
    root.innerHTML = '<section class="card"><div class="empty"><p>Loading…</p></div></section>';
    try {
      const w = await api.wallet();
      app.wallet = w;
      root.innerHTML = `<div class="two-col"><section class="card" aria-labelledby="wallet-h"><div class="card-head row-between"><h2 id="wallet-h">Test wallet</h2><span class="badge badge-amber">Testnet only</span></div>
        <div class="eyebrow">Test USDC balance</div><div class="big-balance">${w.usdcBalance == null ? '–' : formatUsdc(w.usdcBalance)} <small>test USDC</small></div>
        <p class="muted mb">Testnet funds with no real value, read from Base Sepolia.</p>
        <dl class="kv"><dt>Buyer agent</dt><dd>Scout</dd><dt>Address</dt><dd><code>${esc(w.address)}</code></dd><dt>Network</dt><dd><span class="badge badge-net">Base Sepolia</span> chain id 84532</dd>
        <dt>Reserved now</dt><dd>${formatUsdc(w.reserved)} USDC</dd><dt>Session</dt><dd><code>${esc(w.sessionId)}</code></dd></dl>
        ${w.spendingHalted ? `<p class="note mt">${icon('alert', 'icon-sm')} Spending halted: ${esc(w.haltReason)}</p>` : ''}
        <div class="btn-row mt"><button type="button" class="btn btn-primary" data-action="open-faucet">${icon('droplet')}Faucet</button><button type="button" class="btn btn-secondary" data-copy-addr>${icon('copy')}Copy address</button></div></section>
        <section class="card" aria-labelledby="rules-h"><div class="card-head"><h2 id="rules-h">Funding and spending rules</h2></div><ul class="plain-list">
        <li><strong>Testnet only.</strong> Beacon refuses to run on any other network.</li>
        <li><strong>Faucet:</strong> Circle gives 20 test USDC per address, per chain, every 2 hours.</li>
        <li><strong>No gas needed:</strong> the buyer only signs payments. The facilitator pays gas.</li>
        <li><strong>Price cap:</strong> no listing may charge more than 0.100 USDC per call.</li>
        <li><strong>Keys:</strong> the private key never reaches this page. Beacon's signer holds it.</li></ul></section></div>`;
    } catch (e) { err(root, 'Could not load the wallet', e, () => wallet.mount(root)); }
  },
};

export const settings = {
  title: 'Settings',
  subtitle: 'Read-only payment guard rules and the New session control.',
  async mount(root) {
    root.innerHTML = '<section class="card"><div class="empty"><p>Loading…</p></div></section>';
    try {
      const c = await api.config();
      const r = c.rules || {};
      const h = c.hygiene;
      const rows = [['Price policy', 'Refuse anything above the listed price'], ['Max listed price', `${formatUsdc(r.perCallCeiling || 100000)} USDC per call`], ['Allowed network', 'Base Sepolia (eip155:84532)'], ['Allowed asset', 'Testnet USDC, matched by address'],
        ['Fallback limit', `${r.fallbackLimit ?? '–'} sellers per step`], ['Probation', `Fewer than ${r.probationAttempts ?? '–'} attempts`], ['Drop threshold', `Success rate under ${Math.round((r.dropThreshold ?? 0.5) * 100)}% after ${r.probationAttempts ?? 3} attempts`],
        ['Authorisation window', `${r.maxTimeoutSeconds ?? '–'} seconds at most`], ['Budget', 'Reserved before signing. Hard cap per task']];
      root.innerHTML = `<div class="two-col">
        <section class="card" aria-labelledby="guard-h"><div class="card-head"><h2 id="guard-h">Payment guard (read-only)</h2><p>Changed in one config file and a restart, never from this page.</p></div>
          <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}<dt>Rule-set hash</dt><dd><code>${esc(c.ruleSetHash)}</code></dd></dl></section>
        <section class="card" aria-labelledby="hyg-h"><div class="card-head"><h2 id="hyg-h">Key hygiene</h2><p>Latest scan of the repository, history, web bundle and logs.</p></div>
          ${h ? `<p><span class="badge ${h.ok ? 'badge-green' : 'badge-red'}">${icon(h.ok ? 'checkcircle' : 'xcircle')}${h.ok ? 'No secrets found' : 'Findings'}</span></p><dl class="kv mt"><dt>Scanned</dt><dd>${fmtDateTime(h.at)}</dd><dt>Commit</dt><dd><code>${esc(h.commit || '–')}</code></dd></dl>` : `<p><span class="badge badge-amber">${icon('clock')}No scan result yet</span></p><p class="muted mt">Run <code>npm run scan</code> to create one.</p>`}</section>
        <section class="card wide" aria-labelledby="sess-h"><div class="card-head"><h2 id="sess-h">Session</h2><p>A new session starts a fresh ledger chain with empty reputation. The old session stays stored and verifiable.</p></div>
          <button type="button" class="btn btn-secondary" data-new-session>${icon('refresh')}New session</button></section></div>`;
      $('[data-new-session]', root).addEventListener('click', newSession);
    } catch (e) { err(root, 'Could not load settings', e, () => settings.mount(root)); }
  },
};

function newSession() {
  if (MOCK) return toast('Mock mode: disabled.', 'warn');
  const dlg = openDialog(`${dialogHead('dialog-sm-title', 'Start a new session')}<form id="ns-form"><div class="dialog-body form-stack"><p class="muted">This asks for the operator token. It is kept in memory for this request only and is never stored.</p>
    <div><label class="label" for="ns-token">Operator token</label><input id="ns-token" class="input" type="password" autocomplete="off" required></div><p id="ns-error" class="field-error" role="alert"></p></div>
    <div class="dialog-foot"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button type="submit" class="btn btn-primary">Start new session</button></div></form>`, true);
  $('#ns-form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#ns-token', dlg);
    const token = input.value; input.value = '';
    try {
      const r = await api.newSession(token);
      dlg.close();
      const q = new URLSearchParams(location.search); q.delete('task'); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}#settings`);
      toast(`New session started. The previous session remains verifiable.`, 'ok');
      app.refreshWallet();
      void r;
    } catch (e2) { $('#ns-error', dlg).textContent = e2.status === 401 ? 'Not allowed. Check the operator token.' : e2.message; }
  });
}
