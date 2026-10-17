// Fraud Lab: Beacon tries each scripted suspect agent one at a time and reports what went wrong and why it did not hire them.
// One run is a task: it reuses the task event stream (SSE with polling fallback), Beacon's chat feed and the ledger. The UI only
// shows what the backend events and the final result say; it never decides whether a payment happened.
import { api, MOCK, ApiError } from '../api.js';
import { app } from '../app.js';
import { openTaskEvents } from '../sse.js';
import { newTaskState, applyEvent } from '../task-state.js';
import { mountBeaconChat } from './beacon-chat.js';
import { thumb } from '../thumbs.js';
import { $, $$, esc, icon, formatUsdc, toUnits, explorerUrl, shortHash, bulletsHtml } from '../ui.js';

const OUTCOME = {
  blocked: ['badge-green', 'checkcircle', 'Blocked'],
  failed: ['badge-green', 'checkcircle', 'Failed, not charged'],
  rejected: ['badge-amber', 'alert', 'Paid, then rejected'],
  paid: ['badge-green', 'checkcircle', 'Paid and validated'],
  pending: ['badge-amber', 'clock', 'Settling'],
  attention: ['badge-red', 'xcircle', 'Needs attention'],
  error: ['badge-red', 'xcircle', 'Could not run'],
};
const FIELD = { price: 'Price (USDC)', payTo: 'Pay to', token: 'Token', network: 'Network', scheme: 'Scheme' };
const LAYERS = { 'Before signing': 'badge-accent', 'After paying': 'badge-amber', Liveness: '', 'Seller side': 'badge-accent', Control: 'badge-green' };
const SIGNED = { blocked: 'No. Refused before signing', failed: 'Signed, never settled', rejected: 'Yes', paid: 'Yes', pending: 'Yes, settling', attention: 'Yes', error: 'No' };

let built = false, roster = [], chat, task = null, stream = null, streamState = 'closed', raf = 0, submitting = false, chosen = new Set(), timer = null;

const HTML = `
  <div class="lab" id="lab" data-state="idle">
    <header class="lab-hero">
      <div><h2 class="lab-title">Fraud Lab</h2><p class="lab-sub">Beacon tries each scripted fraud agent one at a time, the way it buys in a normal task, and explains in the chat what went wrong and why it did not hire them.</p></div>
      <span class="badge badge-accent">Scripted agents · no LLM</span>
    </header>
    <p class="banner-top lab-note">${icon('shield')}<span>Every payment goes through the <strong>real Beacon guard</strong> with test USDC on Base Sepolia. Nothing here is faked: refusals, the one real loss and the on-chain proof come from the same system as a normal task.</span></p>

    <section class="lab-setup card" id="lab-setup" aria-labelledby="lab-setup-h">
      <div class="card-head row-between"><div><h2 id="lab-setup-h">Choose your suspects</h2><p class="muted">All of them run by default, in this order. Untick any to skip it.</p></div>
        <div class="lab-actions">
          <div class="field lab-budget"><label class="label" for="lab-budget">Run budget (USDC)</label><div class="input-affix"><input id="lab-budget" class="input" inputmode="decimal" value="0.050" autocomplete="off"><span class="affix" aria-hidden="true">tUSDC</span></div></div>
          <button type="button" class="btn btn-primary" id="lab-run">${icon('bolt')}Run Fraud Lab</button>
        </div></div>
      <p id="lab-error" class="field-error" role="alert"></p>
      <div class="lab-roster" id="lab-roster"></div>
    </section>

    <div class="lab-run" id="lab-run-area" hidden>
      <div class="lab-main">
        <section class="card lab-progress" aria-label="Run progress">
          <div class="row-between"><div><span class="eyebrow">Fraud Lab run</span><h2 id="lab-prog-title">Starting…</h2></div><div class="lab-prog-actions"><span id="lab-badge"></span><button type="button" class="btn btn-secondary btn-sm" id="lab-again" hidden>${icon('refresh')}New run</button></div></div>
          <div class="lab-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="lab-bar"><span id="lab-bar-fill"></span></div>
        </section>
        <ol class="lab-timeline" id="lab-timeline" aria-label="Suspects"></ol>
        <section class="card lab-final" id="lab-final" hidden aria-labelledby="lab-final-h"></section>
      </div>
      <aside class="lab-side" aria-label="Beacon chat and run stats">
        <div id="lab-chat"></div>
        <section class="card lab-stats" aria-labelledby="lab-stats-h"><h2 id="lab-stats-h" class="sr-only">Run stats</h2><dl class="stats" id="lab-stats"></dl></section>
      </aside>
    </div>
  </div>`;

const units = (v) => { try { return BigInt(v || 0); } catch { return 0n; } };

/** Steps for the timeline: live events first, the final result when the run was restored without its event history. */
function steps() {
  const live = [...task.lab.values()];
  if (live.length) return live.sort((a, b) => (a.index || 0) - (b.index || 0));
  const fin = task.result?.kind === 'lab' ? task.result.steps || [] : [];
  return fin.map((r, i) => ({ ...r, index: i + 1, total: fin.length, status: 'done', paidUsdc: formatUsdc(r.paid || 0), wouldHavePaidUsdc: r.wouldHavePaid ? formatUsdc(r.wouldHavePaid) : null }));
}

function diffHtml(diffs) {
  if (!diffs?.length) return '';
  return `<div class="lab-diff" role="table" aria-label="What the agent claimed against what it asked for">
    <div class="lab-diff-head" role="row"><span role="columnheader">Term</span><span role="columnheader">It listed</span><span role="columnheader">It asked for</span></div>
    ${diffs.map((d) => `<div class="lab-diff-row" role="row"><span role="cell">${esc(FIELD[d.field] || d.field)}</span><span role="cell"><code>${esc(d.listed)}</code></span><span role="cell" class="lie"><code>${esc(d.actual)}</code></span></div>`).join('')}</div>`;
}

function lanesHtml(lanes, transfers) {
  if (!lanes?.length) return '';
  return `<div class="lab-lanes"><span class="label-sm">Five requests with the same signed payment, sent at once</span>
    <div class="lab-lane-grid">${lanes.map((l) => `<div class="lab-lane ${l.status === 200 ? 'ok' : 'stop'}"><strong>#${esc(l.n)}</strong><span class="code">${l.status ? esc(l.status) : 'none'}</span><small>${esc(l.layer)}</small></div>`).join('')}</div>
    ${transfers != null ? `<p class="muted">On chain: ${esc(transfers)} transfers for 2 signed payments. The extra requests got nothing and cost nothing.</p>` : ''}</div>`;
}

function stepHtml(s) {
  const running = s.status === 'running';
  const o = OUTCOME[s.outcome] || ['', 'clock', s.outcome || 'Done'];
  const outcomeLabel = s.id === 'replay' && s.outcome === 'blocked' ? 'Replays blocked' : s.id === 'control' && s.outcome === 'paid' ? 'Paid and validated' : o[2];
  const url = explorerUrl(s.txHash);
  const naive = s.wouldHavePaidUsdc ? `<div><dt>A buyer with no checks would have paid</dt><dd class="lie-text">${esc(s.wouldHavePaidUsdc)} USDC <small>(computed)</small></dd></div>` : '';
  const rep = s.reputation ? `<div><dt>Reputation score</dt><dd>${esc(s.reputation.before)} <span class="arrow" aria-label="to">→</span> <strong>${esc(s.reputation.after)}</strong></dd></div>` : '';
  const body = running
    ? `<p class="lab-tactic">${esc(s.tactic || '')}</p><p class="muted lab-trying"><span class="spinner" aria-hidden="true"></span>Beacon is trying to buy from it now…</p>`
    : `<p class="lab-tactic">${esc(s.tactic || s.reason || '')}</p>
       ${diffHtml(s.diffs)}
       ${s.id === 'replay' ? lanesHtml(s.lanes, s.transfers) : ''}
       <div class="lab-verdict">${s.ruleId ? `<span class="badge">${icon('shield', 'icon-sm')}Rule ${esc(s.ruleId)}</span>` : ''}<span class="lab-reason">${esc(s.reason || '')}</span></div>
       <dl class="lab-facts">
         <div><dt>Signed a payment?</dt><dd>${esc(s.id === 'replay' ? 'Yes, two payments, each used once' : SIGNED[s.outcome] || '–')}</dd></div>
         <div><dt>Money moved</dt><dd>${esc(s.paidUsdc ?? '0.000')} USDC</dd></div>
         ${naive}${rep}
         ${url ? `<div><dt>Transaction</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(shortHash(s.txHash))} ${icon('external', 'icon-sm')}</a></dd></div>` : ''}
       </dl>`;
  return `<li class="lab-step lab-o-${esc(running ? 'running' : s.outcome)}" data-key="${esc(s.key)}">
    <div class="lab-step-thumb">${thumb(s.agentId || s.id, '')}</div>
    <div class="lab-step-body">
      <div class="lab-step-head"><div><span class="eyebrow">Suspect ${esc(s.index)} of ${esc(s.total)} · ${esc(s.layer || '')}</span><h3>${esc(s.title || s.agentId)}<span class="muted"> · ${esc(s.suspect || '')}</span></h3></div>
        ${running ? '<span class="badge badge-accent">Trying now</span>' : `<span class="badge ${o[0]}">${icon(o[1])}${esc(outcomeLabel)}</span>`}</div>
      ${body}
    </div></li>`;
}

function finalHtml() {
  const r = task.result;
  if (!r || r.kind !== 'lab') return '';
  const sb = r.scoreboard || {}, v = r.verification || {}, rc = v.reconcile || {};
  const exposure = steps().reduce((sum, s) => sum + units(s.wouldHavePaid), 0n);
  const tiles = [
    ['Blocked before signing', sb.blockedBeforeSigning ?? 0, 'good'],
    ['Paid, then rejected', sb.paidThenRejected ?? 0, sb.paidThenRejected ? 'warn' : ''],
    ['Failed, not charged', sb.failedNotCharged ?? 0, 'good'],
    ['Lost to junk (USDC)', sb.junkPaidUsdc ?? '0.000', sb.junkPaidUsdc && sb.junkPaidUsdc !== '0.000' ? 'warn' : ''],
    ['Total spent (USDC)', sb.spentUsdc ?? '0.000', ''],
    ...(exposure > 0n ? [['A buyer with no checks would have paid (USDC)', formatUsdc(exposure), 'bad']] : []),
  ];
  const matched = rc.status === 'matched';
  return `<div class="card-head"><h2 id="lab-final-h">Beacon's report</h2></div>
    ${r.beaconSummary?.text ? `<div class="beacon-report">${bulletsHtml(r.beaconSummary.text)}<small class="muted">${r.beaconSummary.source === 'model' ? 'Written by the model from the recorded facts' : 'Rule-based report from the recorded facts'}</small></div>` : ''}
    <div class="lab-score">${tiles.map(([k, val, tone]) => `<div class="lab-tile ${tone}"><dd>${esc(val)}</dd><dt>${esc(k)}</dt></div>`).join('')}</div>
    <div class="lab-proof"><h3>Proof</h3><ul class="bullets brief">
      <li>${v.chainOk ? `${icon('checkcircle', 'icon-sm')} The hash-chained ledger verifies.` : `${icon('xcircle', 'icon-sm')} The ledger failed verification.`}</li>
      <li>${matched ? icon('checkcircle', 'icon-sm') : icon('alert', 'icon-sm')} Reconciliation against Base Sepolia: <strong>${esc(rc.status || 'unverified')}</strong>${rc.ledgerTotal != null ? `. Ledger ${esc(formatUsdc(rc.ledgerTotal))} USDC, chain ${esc(formatUsdc(rc.chainTotal))} USDC` : ''}${rc.excludedReplayTransfers ? ` (${esc(rc.excludedReplayTransfers)} replay-test transfer${rc.excludedReplayTransfers > 1 ? 's' : ''} recorded as tests)` : ''}.</li>
      <li><a href="#ledger">Open the Ledger</a> to see every row tagged Fraud Lab.</li></ul></div>
    <p class="muted lab-honest">${icon('info', 'icon-sm')} Honest limit: a payment that already settled on chain cannot be taken back. The Ghost's payment is the one real loss in a full run; the system caps it at one call and keeps the junk out of the result.</p>`;
}

function renderStats(root) {
  const t = task;
  const bud = units(t.budget), spent = units(t.spent), res = units(t.reserved);
  $('#lab-stats', root).innerHTML = [
    ['Run budget', `${formatUsdc(bud)} <small>USDC</small>`],
    ['Spent', `${formatUsdc(spent)} <small>USDC</small>`],
    ['Reserved', `${formatUsdc(res)} <small>USDC</small>`],
    ['Suspects tried', `${steps().filter((s) => s.status === 'done').length} / ${steps()[0]?.total ?? '–'}`],
  ].map(([k, v]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function render(root) {
  const lab = $('#lab', root);
  const active = !!task;
  lab.dataset.state = active ? 'active' : 'idle';
  $('#lab-setup', root).hidden = active;
  $('#lab-run-area', root).hidden = !active;
  if (!active) return;
  const list = steps();
  const total = list[0]?.total || 0;
  const done = list.filter((s) => s.status === 'done').length;
  const running = task.status === 'running';
  const badge = { running: ['badge-accent', 'Running'], completed: ['badge-green', 'Completed'], stopped: ['badge-amber', 'Stopped early'], blocked: ['badge-red', 'Did not start'] }[task.status] || ['', task.status];
  $('#lab-badge', root).innerHTML = `<span class="badge ${badge[0]}">${badge[1]}</span>`;
  $('#lab-prog-title', root).textContent = task.status === 'blocked' ? 'The run could not start' : total ? (running ? `Suspect ${Math.min(done + 1, total)} of ${total}` : `${done} of ${total} suspects tried`) : 'Preparing the run…';
  $('#lab-bar-fill', root).style.width = `${total ? Math.round((done / total) * 100) : 4}%`;
  $('#lab-again', root).hidden = running;
  $('#lab-timeline', root).innerHTML = list.map(stepHtml).join('')
    + (task.status === 'blocked' || (task.status === 'stopped' && !list.length) ? `<li class="card lab-blocked">${icon('alert')}<div><strong>Nothing was tried</strong><p>${esc(task.notice || 'The run stopped before it started.')}</p></div></li>` : '');
  const fin = $('#lab-final', root);
  const html = running ? '' : finalHtml();
  fin.hidden = !html;
  if (html && fin.dataset.done !== task.id) { fin.innerHTML = html; fin.dataset.done = task.id; }
  renderStats(root);
}

const schedule = (root) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => render(root)); };

function attach(root, id) {
  if (stream) stream();
  task = newTaskState(id);
  streamState = 'open';
  $('#lab-final', root).dataset.done = '';
  chat.setTask(id);
  stream = openTaskEvents(id, (ev) => {
    applyEvent(task, ev);
    schedule(root);
    if (ev.type === 'chat') { clearTimeout(timer); timer = setTimeout(() => chat.kick(), 300); }
    if (ev.type === 'done' || ev.type === 'blocked') { app.refreshWallet(); chat.kick(); }
  }, (s) => { streamState = s; });
  render(root);
}

function selection(root) {
  return $$('[data-suspect]', root).filter((c) => c.checked).map((c) => c.dataset.suspect);
}

function rosterHtml() {
  return roster.map((a, i) => `<label class="lab-card${chosen.has(a.id) ? ' on' : ''}" data-card="${esc(a.id)}">
    <div class="lab-card-thumb">${thumb(a.id, '')}<span class="lab-order">${i + 1}</span></div>
    <div class="lab-card-body">
      <div class="lab-card-top"><span class="badge ${LAYERS[a.layer] || ''}">${esc(a.layer)}</span><input type="checkbox" data-suspect="${esc(a.id)}" ${chosen.has(a.id) ? 'checked' : ''} aria-label="Include ${esc(a.title)}"></div>
      <h3>${esc(a.title)}</h3><span class="muted">${esc(a.suspect)}${a.honest ? ' · honest control' : ''}</span>
      <p class="lab-card-tactic">${esc(a.tactic)}</p>
      ${a.subs?.length ? `<ul class="lab-subs">${a.subs.map((s) => `<li>${esc(s.label)}</li>`).join('')}</ul>` : ''}
      <dl class="kv lab-card-kv"><dt>Expected</dt><dd>${esc(a.expected)}</dd><dt>Rules</dt><dd>${a.rules?.length ? a.rules.map((r) => `<code>${esc(r)}</code>`).join(' ') : 'none, it should pass'}</dd><dt>Cost</dt><dd>${esc(a.cost)}</dd></dl>
    </div></label>`).join('');
}

async function run(root) {
  if (submitting || (task && task.status === 'running')) return;
  const err = $('#lab-error', root);
  err.textContent = '';
  if (MOCK) { err.textContent = 'Mock mode: the Fraud Lab is disabled.'; return; }
  const picked = selection(root);
  if (!picked.length) { err.textContent = 'Choose at least one suspect.'; return; }
  const b = toUnits($('#lab-budget', root).value.trim());
  if (b === null || b < 10000n || b > 100000n) { err.textContent = 'Budget must be between 0.010 and 0.100 USDC.'; return; }
  submitting = true;
  const btn = $('#lab-run', root); btn.disabled = true;
  try {
    const { taskId } = await api.labRun({ ...(picked.length === roster.length ? {} : { cases: picked }), budget: String(b) });
    attach(root, taskId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    const issue = e instanceof ApiError ? e.body?.issues?.[0] : null;
    err.textContent = issue?.message || (e.status === 409 ? (e.body?.error === 'lab_running' ? 'A Fraud Lab run is already in progress.' : `Spending is halted: ${e.body?.detail || 'the ledger failed verification'}.`)
      : e.status === 429 ? 'Too many runs at the moment. Wait a minute and try again.' : e.message);
  } finally { submitting = false; btn.disabled = false; }
}

function reset(root) {
  if (stream) { stream(); stream = null; }
  task = null;
  chat.setTask(null);
  render(root);
}

function build(root) {
  root.innerHTML = HTML;
  chat = mountBeaconChat($('#lab-chat', root), { getTaskId: () => task?.id || null, isRunning: () => !!task && task.status === 'running' });
  api.config().then((c) => chat.setModel(c)).catch(() => undefined);
  $('#lab-run', root).addEventListener('click', () => run(root));
  $('#lab-again', root).addEventListener('click', () => reset(root));
  root.addEventListener('change', (e) => {
    const c = e.target.closest('[data-suspect]');
    if (!c) return;
    if (c.checked) chosen.add(c.dataset.suspect); else chosen.delete(c.dataset.suspect);
    c.closest('.lab-card').classList.toggle('on', c.checked);
    $('#lab-error', root).textContent = '';
  });
  built = true;
}

export default {
  title: 'Fraud Lab',
  subtitle: 'Scripted fraud agents against the real payment guard. Beacon explains each one.',
  async mount(root) {
    if (!built) build(root);
    try {
      const j = await api.lab();
      roster = j.agents || [];
      if (!chosen.size) chosen = new Set(j.order || roster.map((a) => a.id));
      if (j.defaultBudget && !task) $('#lab-budget', root).value = formatUsdc(j.defaultBudget);
      $('#lab-roster', root).innerHTML = rosterHtml();
      $('#lab-error', root).textContent = '';
    } catch (e) {
      $('#lab-roster', root).innerHTML = `<div class="empty wide">${icon('alert')}<h3>The Fraud Lab is not available</h3><p>${esc(e.status === 404 ? 'Set ENABLE_ATTACK_PANEL=true on the Beacon server.' : e.message)}</p></div>`;
      $('#lab-run', root).disabled = true;
    }
    render(root);
  },
};
