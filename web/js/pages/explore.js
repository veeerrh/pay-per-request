// Home page: the buyer console (task form, tracker, live status, budget meter, activity feed, result) and the marketplace.
import { api, MOCK, ApiError } from '../api.js';
import { app } from '../app.js';
import { openTaskEvents } from '../sse.js';
import { newTaskState, applyEvent, stageState, elapsedMs, STAGES } from '../task-state.js';
import { mountMarket } from './market.js';
import { mountResult, resultCardHtml } from './result.js';
import { $, $$, esc, icon, formatUsdc, toUnits, fmtTime, fmtElapsed, setWidth } from '../ui.js';

const MAX_BUDGET = 5_000_000n;
const FEED = {
  start: ['play', 'accent', 'Task started'], info: ['info', 'muted', 'Update'], select: ['search', 'accent', 'Service selected'],
  challenge: ['alert', 'amber', 'Payment challenge received'], settled: ['checkcircle', 'green', 'Payment settled'], refused: ['xcircle', 'red', 'Payment refused'],
  failed: ['xcircle', 'red', 'Call failed, not charged'], validated: ['check', 'green', 'Output validated'], rejected: ['alert', 'amber', 'Output rejected'],
  output: ['info', 'muted', 'Output received'], stopped: ['alert', 'amber', 'Task stopped'], blocked: ['xcircle', 'red', 'Task blocked'], completed: ['checkcircle', 'green', 'Task completed'],
};

let built = false, market, resultView, task = null, stream = null, streamState = 'closed', timer = null, examples = [], raf = 0;

const HTML = `
  <section class="card task-card" aria-labelledby="task-h">
    <div class="card-head"><h2 id="task-h">Give a task to your Buyer Agent</h2><p>The agent finds services, pays per request, validates results, and combines the output.</p></div>
    <form id="task-form" novalidate>
      <div class="examples" role="group" aria-label="Example tasks"><span class="examples-label">Try an example:</span><span id="examples"></span></div>
      <label class="label" for="task-input">Task description</label>
      <textarea id="task-input" class="textarea" rows="5" maxlength="1000" aria-describedby="task-count task-error"></textarea>
      <div class="field-meta"><span id="task-error" class="field-error" role="alert"></span><span id="task-count" class="count">0 / 1000</span></div>
      <div id="hired-tray" class="hired-tray" hidden></div>
      <details class="direct" id="direct"><summary>Direct URL mode (buy one URL with an expected price)</summary>
        <div class="form-stack">
          <div><label class="label" for="d-url">Seller URL</label><input id="d-url" class="input" placeholder="https://…"></div>
          <div class="grid-2"><div><label class="label" for="d-price">Expected price (USDC)</label><input id="d-price" class="input" inputmode="decimal" placeholder="0.001"></div>
            <div><label class="label" for="d-cat">Category</label><select id="d-cat" class="select"><option value="data">Data</option><option value="inference">Inference</option><option value="scraping">Scraping</option></select></div></div>
          <div><label class="label" for="d-payto">Expected payTo (optional)</label><input id="d-payto" class="input" placeholder="0x…"></div>
          <p id="d-error" class="field-error" role="alert"></p>
          <p class="muted">Every guard check still runs. Without a payTo, the payee cannot be compared with a listing and the ledger says so.</p>
        </div></details>
      <div class="form-row">
        <div class="field"><label class="label" for="budget-input">Budget (USDC)</label>
          <div class="input-affix"><input id="budget-input" class="input" type="text" inputmode="decimal" value="0.050" autocomplete="off" aria-describedby="budget-error"><span class="affix" aria-hidden="true">tUSDC</span></div>
          <span id="budget-error" class="field-error" role="alert"></span></div>
        <div class="field"><label class="label" for="conc-select">Max concurrency</label><select id="conc-select" class="select"><option value="1">1 call at a time</option><option value="3" selected>3 calls at once</option><option value="5">5 calls at once</option></select></div>
        <div class="field field-run"><button id="run-btn" class="btn btn-primary btn-lg" type="submit">${icon('play')}Run Task</button></div>
      </div>
      <p class="helper">${icon('shield', 'icon-sm')}<span>The budget is a <strong>hard spending cap</strong>. The agent reserves money before each payment and stops rather than exceed it. Testnet USDC only.</span></p>
    </form>
  </section>
  <section class="card status-card" aria-labelledby="status-h">
    <div class="card-head row-between"><h2 id="status-h">Task status</h2><span id="status-badge"></span></div>
    <ol class="tracker" id="tracker" aria-label="Task progress"></ol>
    <div id="status-banner" class="banner" role="status" aria-live="polite"></div>
    <dl class="stats" id="stats"></dl>
    <div class="meter" id="meter"></div>
  </section>
  <div class="split no-result" id="split">
    <section class="card result-card" id="result-card" aria-labelledby="result-h" hidden>${resultCardHtml}</section>
    <section class="card activity-card" aria-labelledby="activity-h"><div class="card-head"><h2 id="activity-h">Recent activity</h2></div><ol class="feed" id="feed"></ol></section>
  </div>
  <section class="market" id="market" aria-labelledby="market-h"></section>`;

function schedule(fn) { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); }

function renderStatus(root) {
  const t = task;
  $('#tracker', root).innerHTML = STAGES.map((name, i) => {
    const st = stageState(t, i);
    const inner = st === 'done' ? icon('check') : st === 'error' ? icon('x') : st === 'warn' ? icon('alert') : String(i + 1);
    const lab = { done: 'Done', current: 'In progress', upcoming: 'Upcoming', error: 'Blocked', warn: 'Stopped' }[st];
    return `<li class="${st}"${st === 'current' ? ' aria-current="step"' : ''}><span class="step-dot">${inner}</span><span>${name}</span><span class="step-state">${lab}</span></li>`;
  }).join('');
  const badges = { idle: ['', 'No active task'], running: ['badge-accent', 'Running'], completed: ['badge-green', 'Completed'], stopped: ['badge-amber', 'Stopped early'], blocked: ['badge-red', 'Nothing bought'] };
  const [bc, bl] = badges[t ? t.status : 'idle'] || badges.idle;
  $('#status-badge', root).innerHTML = `<span class="badge ${bc}">${bl}</span>`;

  let b;
  if (!t) b = ['', 'info', 'Ready when you are', 'Describe a task above and press Run Task. Nothing is spent until you do.'];
  else if (streamState === 'reconnecting' && t.status === 'running') b = ['warn', 'clock', 'Reconnecting to Beacon…', 'The task keeps running. Updates resume when the connection returns.'];
  else if (t.status === 'running') b = ['run', 'clock', `Working: ${STAGES[Math.max(t.stageIdx, 0)]} stage`, t.events[0]?.text || 'Starting…'];
  else if (t.status === 'completed') b = ['ok', 'checkcircle', 'Task completed', `Spent ${formatUsdc(t.spent)} of ${formatUsdc(t.budget)} test USDC. The result is shown below.`];
  else if (t.status === 'stopped') b = ['warn', 'alert', 'Task stopped early', t.notice || 'The task stopped before every step finished.'];
  else b = ['err', 'xcircle', 'Nothing was bought', t.notice];
  const banner = $('#status-banner', root);
  banner.className = `banner ${b[0]}`;
  banner.innerHTML = `${icon(b[1])}<div><strong>${esc(b[2])}</strong><span>${esc(b[3])}</span></div>`;

  const bud = BigInt(t?.budget || 0);
  const rem = bud > 0n ? bud - BigInt(t.spent || 0) - BigInt(t.reserved || 0) : 0n;
  $('#stats', root).innerHTML = [
    ['Elapsed', `<span id="stat-elapsed">${fmtElapsed(elapsedMs(t))}</span>`],
    ['Reserved', `${formatUsdc(t?.reserved || 0)} <small>USDC</small>`],
    ['Total spent', `${formatUsdc(t?.spent || 0)} <small>USDC</small>`],
    ['Services used', String(t ? t.services.length : 0)],
    ['Paid calls', String(t ? t.paidCalls : 0)],
    ['Remaining budget', t && bud > 0n ? `${formatUsdc(rem)} <small>USDC</small>` : '–'],
  ].map(([k, v]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const spent = BigInt(t?.spent || 0), res = BigInt(t?.reserved || 0);
  const pct = (x) => (bud > 0n ? Number((x * 10000n) / bud) / 100 : 0);
  $('#meter', root).innerHTML = t && bud > 0n
    ? `<div class="meter-bar" role="img" aria-label="Budget: ${formatUsdc(spent)} spent, ${formatUsdc(res)} reserved of ${formatUsdc(bud)}"><div class="meter-spent"></div><div class="meter-reserved"></div></div>
       <div class="meter-legend"><span><i class="i-spent"></i>Spent ${formatUsdc(spent)}</span><span><i class="i-reserved"></i>Reserved ${formatUsdc(res)}</span><span><i class="i-free"></i>Free ${formatUsdc(bud - spent - res)}</span><span>Cap ${formatUsdc(bud)} USDC</span></div>`
    : '';
  if (t && bud > 0n) { setWidth($('.meter-spent', root), pct(spent)); setWidth($('.meter-reserved', root), pct(res)); }
}

function renderFeed(root) {
  const feed = $('#feed', root);
  if (!task || !task.events.length) { feed.innerHTML = `<li class="empty">${icon('clock')}<p>No activity yet. Events appear here when a task runs.</p></li>`; return; }
  feed.innerHTML = task.events.slice(0, 80).map((e) => {
    const [ic, col, label] = FEED[e.kind] || FEED.info;
    return `<li><span class="ev-${col}">${icon(ic)}</span><div><div class="ev-meta"><span class="ev-label ev-${col}">${label}</span><span class="ev-time">${fmtTime(e.at)}</span></div><div class="ev-text">${esc(e.text)}</div></div></li>`;
  }).join('');
}

function renderHired(root) {
  const tray = $('#hired-tray', root);
  if (!app.hired.size) { tray.hidden = true; tray.innerHTML = ''; return; }
  tray.hidden = false;
  tray.innerHTML = `<span class="label-sm">Agents in your plan (tried first):</span>${[...app.hired].map((id) => `<span class="hired-chip">${esc(id)}<button type="button" class="icon-btn" data-unhire="${esc(id)}" aria-label="Remove ${esc(id)} from plan">${icon('x')}</button></span>`).join('')}<button type="button" class="btn btn-ghost btn-sm" data-clear-hired>Clear</button>`;
}

function renderAll(root) {
  renderStatus(root); renderFeed(root);
  const has = resultView.render();
  $('#split', root).classList.toggle('no-result', !has);
}

function attach(root, id) {
  if (stream) stream();
  task = newTaskState(id);
  streamState = 'open';
  const q = new URLSearchParams(location.search); q.set('task', id);
  history.replaceState(null, '', `?${q.toString()}${location.hash || '#explore'}`);
  resultView.reset();
  clearInterval(timer);
  timer = setInterval(() => { const el = $('#stat-elapsed', root); if (el && task) el.textContent = fmtElapsed(elapsedMs(task)); }, 250);
  stream = openTaskEvents(id, (ev) => {
    applyEvent(task, ev);
    schedule(() => renderAll(root));
    if (ev.type === 'done' || ev.type === 'blocked') finish(root);
  }, (s) => { streamState = s; schedule(() => renderStatus(root)); });
  renderAll(root);
  $('#run-btn', root).disabled = true;
  $('#run-btn', root).innerHTML = `${icon('clock')}Running…`;
}

function finish(root) {
  clearInterval(timer);
  const btn = $('#run-btn', root);
  btn.disabled = false; btn.innerHTML = `${icon('play')}Run Task`;
  app.refreshWallet();
  renderAll(root);
}

function setErr(root, inputSel, errSel, msg) {
  const el = $(errSel, root), inp = $(inputSel, root);
  el.textContent = msg || '';
  if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
}

function collect(root) {
  const direct = $('#direct', root).open && $('#d-url', root).value.trim();
  const text = $('#task-input', root).value.trim();
  const bStr = $('#budget-input', root).value.trim();
  let tErr = '', bErr = '', dErr = '', units = null;
  if (!direct) { if (!text) tErr = 'Describe a task before running.'; else if (text.length < 10) tErr = 'Add a little more detail (at least 10 characters).'; }
  if (!bStr) bErr = 'Enter a budget in USDC.';
  else if (bStr.startsWith('-')) bErr = 'Budget cannot be negative.';
  else if ((units = toUnits(bStr)) === null) bErr = 'Use a number such as 0.050.';
  else if (units <= 0n) bErr = 'Budget must be greater than 0.';
  else if (units > MAX_BUDGET) bErr = `Demo limit is ${formatUsdc(MAX_BUDGET)} USDC per task.`;
  else if (app.wallet?.usdcBalance != null && units > BigInt(app.wallet.usdcBalance)) bErr = `Budget is more than your test balance (${formatUsdc(app.wallet.usdcBalance)}). Use the Faucet.`;
  let body = null;
  if (direct) {
    const price = toUnits($('#d-price', root).value);
    const payTo = $('#d-payto', root).value.trim();
    if (!/^https?:\/\//.test(direct)) dErr = 'Enter a full URL starting with https://';
    else if (price === null || price <= 0n) dErr = 'Enter the expected price in USDC.';
    else if (price > 100000n) dErr = 'Expected price is above the 0.100 USDC cap.';
    else if (payTo && !/^0x[a-fA-F0-9]{40}$/.test(payTo)) dErr = 'payTo must be a 0x address (42 characters).';
    else if (units !== null && price > units) dErr = 'Expected price is above your budget.';
    body = { directUrl: { url: direct, expectedPrice: String(price), category: $('#d-cat', root).value, ...(payTo ? { expectedPayTo: payTo } : {}) } };
  }
  setErr(root, '#task-input', '#task-error', tErr); setErr(root, '#budget-input', '#budget-error', bErr); setErr(root, '#d-url', '#d-error', dErr);
  if (tErr) { $('#task-input', root).focus(); return null; }
  if (bErr) { $('#budget-input', root).focus(); return null; }
  if (dErr) { $('#d-url', root).focus(); return null; }
  return { ...(direct ? {} : { text }), ...(body || {}), budget: String(units), maxConcurrency: Number($('#conc-select', root).value), hired: [...app.hired] };
}

async function run(root) {
  if (task && task.status === 'running') return;
  if (MOCK) { setErr(root, null, '#task-error', 'Mock mode: tasks are disabled.'); return; }
  const body = collect(root);
  if (!body) return;
  const btn = $('#run-btn', root);
  btn.disabled = true;
  try {
    const { taskId } = await api.createTask(body);
    attach(root, taskId);
    $('#status-h', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    btn.disabled = false;
    const issue = e instanceof ApiError ? e.body?.issues?.[0] : null;
    if (issue?.path === 'budget') setErr(root, '#budget-input', '#budget-error', issue.message);
    else if (issue?.path === 'text') setErr(root, '#task-input', '#task-error', issue.message);
    else if (e.status === 429) setErr(root, null, '#task-error', 'Too many tasks right now. Wait a minute and try again.');
    else if (e.status === 409) setErr(root, null, '#task-error', `Spending is halted: ${e.body?.detail || 'the ledger failed verification'}.`);
    else setErr(root, null, '#task-error', e.message);
  }
}

function build(root) {
  root.innerHTML = HTML;
  market = mountMarket($('#market', root));
  resultView = mountResult($('#result-card', root), () => task);
  const input = $('#task-input', root);
  const count = () => { const n = input.value.length; $('#task-count', root).textContent = `${n} / 1000`; };
  input.addEventListener('input', () => { count(); setErr(root, '#task-input', '#task-error', ''); });
  $('#budget-input', root).addEventListener('input', () => setErr(root, '#budget-input', '#budget-error', ''));
  $('#task-form', root).addEventListener('submit', (e) => { e.preventDefault(); run(root); });
  root.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-example]');
    if (ex) { const t = examples[Number(ex.dataset.example)]; input.value = t.text; $('#budget-input', root).value = t.budget; $('#conc-select', root).value = String(t.maxConcurrency); count(); input.focus(); }
    const un = e.target.closest('[data-unhire]'); if (un) app.setHired(un.dataset.unhire, false);
    if (e.target.closest('[data-clear-hired]')) app.clearHired();
  });
  app.onHired(() => renderHired(root));
  api.examples().then((ex) => {
    examples = ex;
    $('#examples', root).innerHTML = ex.map((t, i) => `<button type="button" class="chip" data-example="${i}">${esc(t.name)}</button>`).join(' ');
    if (!input.value && ex[0]) { input.value = ex[0].text; $('#budget-input', root).value = ex[0].budget; count(); }
  }).catch(() => undefined);
  built = true;
}

export default {
  title: 'Explore Agents',
  subtitle: 'Give your Buyer Agent a task, or hire specialist agents for single calls.',
  async mount(root) {
    if (!built) build(root);
    market.reload();
    renderHired(root);
    const id = new URLSearchParams(location.search).get('task');
    if (id && (!task || task.id !== id)) {
      try { await api.task(id); attach(root, id); } catch { /* task no longer known */ renderAll(root); }
    } else renderAll(root);
  },
  /** Opens a task from My Tasks. */
  open(id) { const q = new URLSearchParams(location.search); q.set('task', id); history.replaceState(null, '', `?${q.toString()}#explore`); },
};
