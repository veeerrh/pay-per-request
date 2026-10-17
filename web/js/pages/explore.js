// Explore Agents: a centered task box, then (once a task is running) the live workspace with Beacon's chat, the agents it hired,
// the result and the activity feed. The agent market sits below. All numbers and text come from the backend; the UI never
// decides whether a payment happened, it only shows what the events and results say.
import { api, MOCK, ApiError } from '../api.js';
import { app } from '../app.js';
import { openTaskEvents } from '../sse.js';
import { newTaskState, applyEvent, stageState, elapsedMs, STAGES } from '../task-state.js';
import { mountMarket } from './market.js';
import { mountResult, resultCardHtml } from './result.js';
import { mountBeaconChat } from './beacon-chat.js';
import { thumb } from '../thumbs.js';
import { $, $$, esc, icon, formatUsdc, toUnits, fmtTime, fmtElapsed, setWidth, CAT_ICON, CAT_LABEL } from '../ui.js';

const MAX_BUDGET = 5_000_000n;
const FEED = {
  start: ['play', 'accent', 'Task started'], info: ['info', 'muted', 'Update'], select: ['search', 'accent', 'Service selected'],
  challenge: ['alert', 'amber', 'Payment challenge received'], settled: ['checkcircle', 'green', 'Payment settled'], refused: ['xcircle', 'red', 'Payment refused'],
  failed: ['xcircle', 'red', 'Call failed, not charged'], validated: ['check', 'green', 'Output validated'], rejected: ['alert', 'amber', 'Output rejected'],
  output: ['info', 'muted', 'Output received'], stopped: ['alert', 'amber', 'Task stopped'], blocked: ['xcircle', 'red', 'Task blocked'], completed: ['checkcircle', 'green', 'Task completed'],
};
const BADGES = { idle: ['', 'No active task'], running: ['badge-accent', 'Running'], completed: ['badge-green', 'Completed'], stopped: ['badge-amber', 'Stopped early'], blocked: ['badge-red', 'Nothing bought'] };

let built = false, market, resultView, chat, task = null, taskText = '', stream = null, streamState = 'closed', timer = null, examples = [], raf = 0, services = [], submitting = false, kickTimer = 0;

const HTML = `
  <div class="xp" id="xp" data-state="idle">
    <div class="xp-hero"><h2 class="xp-title">Explore Agents</h2><p class="xp-sub">Give your Buyer Agent a task, or hire specialist agents for single calls.</p></div>
    <div class="xp-taskline" id="xp-taskline" hidden><div><span class="eyebrow">Your task</span><p class="xp-tasktext" id="xp-tasktext"></p></div><span id="xp-taskstatus"></span></div>

    <form id="task-form" class="xp-composer" novalidate aria-label="New task">
      <label class="sr-only" for="task-input">Task description</label>
      <div class="xp-box">
        <textarea id="task-input" rows="1" maxlength="1000" placeholder="Give your Buyer Agent a task…" aria-describedby="task-error"></textarea>
        <button id="run-btn" class="xp-send" type="submit" aria-label="Send task">${icon('send')}</button>
      </div>
      <div class="xp-meta"><span id="task-error" class="field-error" role="alert"></span><span id="task-count" class="count"></span></div>
      <details class="xp-options" id="xp-options" open><summary>Budget and options</summary>
        <div class="xp-options-body">
          <div class="form-row">
            <div class="field"><label class="label" for="budget-input">Budget (USDC)</label>
              <div class="input-affix"><input id="budget-input" class="input" type="text" inputmode="decimal" value="0.050" autocomplete="off" aria-describedby="budget-error"><span class="affix" aria-hidden="true">tUSDC</span></div>
              <span id="budget-error" class="field-error" role="alert"></span></div>
            <div class="field"><label class="label" for="conc-select">Max concurrency</label><select id="conc-select" class="select"><option value="1">1 call at a time</option><option value="3" selected>3 calls at once</option><option value="5">5 calls at once</option></select></div>
          </div>
          <p class="helper">${icon('shield', 'icon-sm')}<span>The budget is a <strong>hard spending cap</strong>. The agent reserves money before each payment and stops rather than exceed it. Testnet USDC only.</span></p>
          <div id="hired-tray" class="hired-tray" hidden></div>
        </div>
      </details>
      <div class="examples" role="group" aria-label="Example tasks"><span id="examples"></span></div>
    </form>

    <div class="xp-main" id="xp-main" hidden>
      <aside class="xp-chat" id="chat-mount" aria-label="Beacon chat"></aside>
      <section class="xp-agents" id="agent-cards" aria-labelledby="agents-h" hidden></section>
      <section class="card result-card" id="result-card" aria-labelledby="result-h" hidden>${resultCardHtml}</section>
      <section class="card activity-card" aria-labelledby="activity-h"><div class="card-head"><h2 id="activity-h">Recent activity</h2></div><ol class="feed" id="feed"></ol></section>
      <section class="market" id="market" aria-labelledby="market-h"></section>
    </div>

    <aside class="xp-rail" id="xp-rail" hidden aria-label="Task status">
      <section class="card status-card" aria-labelledby="status-h">
        <div class="card-head row-between"><h2 id="status-h">Task status</h2><span id="status-badge"></span></div>
        <ol class="tracker" id="tracker" aria-label="Task progress"></ol>
        <div id="status-banner" class="banner" role="status" aria-live="polite"></div>
        <dl class="stats" id="stats"></dl>
        <div class="meter" id="meter"></div>
      </section>
    </aside>
  </div>`;

function schedule(fn) { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); }
const badgeHtml = (t) => { const [c, l] = BADGES[t ? t.status : 'idle'] || BADGES.idle; return `<span class="badge ${c}">${l}</span>`; };

function renderStatus(root) {
  const t = task;
  $('#tracker', root).innerHTML = STAGES.map((name, i) => {
    const st = stageState(t, i);
    const inner = st === 'done' ? icon('check') : st === 'error' ? icon('x') : st === 'warn' ? icon('alert') : String(i + 1);
    const lab = { done: 'Done', current: 'In progress', upcoming: 'Upcoming', error: 'Blocked', warn: 'Stopped' }[st];
    return `<li class="${st}"${st === 'current' ? ' aria-current="step"' : ''}><span class="step-dot">${inner}</span><span>${name}</span><span class="step-state">${lab}</span></li>`;
  }).join('');
  $('#status-badge', root).innerHTML = badgeHtml(t);
  $('#xp-taskstatus', root).innerHTML = badgeHtml(t);

  let b;
  if (!t) b = ['', 'info', 'Ready when you are', 'Describe a task above and press send. Nothing is spent until you do.'];
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

/** The agents Beacon hired for this task: why it chose them, what they delivered and what they added. Real data only. */
function renderAgents(root) {
  const box = $('#agent-cards', root);
  const t = task;
  const seen = new Map();
  if (t) {
    for (const c of t.choices) seen.set(c.sellerId, { id: c.sellerId, name: c.seller, category: c.category, reason: c.reason });
    for (const o of t.outputs) if (!seen.has(o.agent)) { const s = services.find((x) => x.id === o.agent); seen.set(o.agent, { id: o.agent, name: s?.name || o.agent, category: s?.category || '', reason: '' }); }
  }
  if (!seen.size) { box.hidden = true; box.innerHTML = ''; return; }
  const order = ['scraping', 'data', 'inference'];
  const cards = [...seen.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  box.hidden = false;
  box.innerHTML = `<h2 id="agents-h" class="xp-h">Agents on this task</h2><div class="xp-agent-grid">${cards.map((c) => {
    const svc = services.find((s) => s.id === c.id);
    const outs = t.outputs.filter((o) => o.agent === c.id);
    const ok = outs.filter((o) => o.status === 'accepted').at(-1);
    const bad = outs.some((o) => o.status === 'rejected');
    const state = ok ? ['Delivered', 'badge-green'] : bad ? ['Rejected', 'badge-amber'] : t.status === 'running' ? ['Working', 'badge-accent'] : ['No answer', ''];
    const metaNotes = ok?.output?.meta?.notes;
    const tag = metaNotes === 'model' ? '<span class="badge badge-ai">AI-written</span>' : metaNotes === 'none' || metaNotes === 'rules' ? '<span class="badge">Rule-based</span>' : '';
    const notes = t.notes.filter((n) => n.agent === c.name);
    const rep = svc?.reputation;
    return `<article class="xp-agent">
      <div class="xp-agent-thumb">${thumb(c.name, c.category)}</div>
      <div class="xp-agent-head"><div><h3>${esc(c.name)}</h3><span class="muted">${esc(CAT_LABEL[c.category] || c.category)}</span></div><span class="badge ${state[1]}">${state[0]}</span></div>
      <dl class="xp-agent-facts"><div><dt>Price</dt><dd>${svc ? `${formatUsdc(svc.price)} USDC` : '–'}</dd></div><div><dt>Reputation</dt><dd>${rep ? Number(rep.score).toFixed(2) : '–'}</dd></div></dl>
      ${c.reason ? `<p class="xp-why"><strong>Why Beacon chose it</strong>${esc(c.reason)}</p>` : ''}
      ${notes.length ? `<div class="xp-notes"><strong>What it added</strong><ul>${notes.slice(0, 6).map((n) => `<li>${esc(n.text)}</li>`).join('')}</ul></div>` : ''}
      ${tag ? `<div class="badges">${tag}</div>` : ''}
    </article>`;
  }).join('')}</div>`;
}

function renderHired(root) {
  const tray = $('#hired-tray', root);
  if (!app.hired.size) { tray.hidden = true; tray.innerHTML = ''; return; }
  tray.hidden = false;
  tray.innerHTML = `<span class="label-sm">Agents in your plan (tried first):</span>${[...app.hired].map((id) => `<span class="hired-chip">${esc(id)}<button type="button" class="icon-btn" data-unhire="${esc(id)}" aria-label="Remove ${esc(id)} from plan">${icon('x')}</button></span>`).join('')}<button type="button" class="btn btn-ghost btn-sm" data-clear-hired>Clear</button>`;
}

function renderAll(root) {
  renderStatus(root); renderFeed(root); renderAgents(root);
  resultView.render();
  const active = !!task;
  $('#xp', root).dataset.state = active ? 'active' : 'idle';
  $('#xp-main', root).hidden = !active;
  $('#xp-rail', root).hidden = !active;
  $('#xp-taskline', root).hidden = !active;
  $('#xp-tasktext', root).textContent = taskText || (task ? 'Task in progress' : '');
}

function attach(root, id) {
  if (stream) stream();
  task = newTaskState(id);
  streamState = 'open';
  const q = new URLSearchParams(location.search); q.set('task', id);
  history.replaceState(null, '', `?${q.toString()}${location.hash || '#explore'}`);
  resultView.reset();
  $('#xp-options', root).open = false; // once the agent is working the options step aside
  chat.setTask(id);
  refreshServices(root);
  clearInterval(timer);
  timer = setInterval(() => { const el = $('#stat-elapsed', root); if (el && task) el.textContent = fmtElapsed(elapsedMs(task)); }, 250);
  stream = openTaskEvents(id, (ev) => {
    applyEvent(task, ev);
    schedule(() => renderAll(root));
    if (ev.type === 'chat') { clearTimeout(kickTimer); kickTimer = setTimeout(() => chat.kick(), 300); }
    if (ev.type === 'done' || ev.type === 'blocked') finish(root);
  }, (s) => { streamState = s; schedule(() => renderStatus(root)); });
  renderAll(root);
  const btn = $('#run-btn', root);
  btn.disabled = true; btn.setAttribute('aria-label', 'Task running'); btn.innerHTML = icon('clock');
}

function finish(root) {
  clearInterval(timer);
  const btn = $('#run-btn', root);
  btn.disabled = false; btn.setAttribute('aria-label', 'Send task'); btn.innerHTML = icon('send');
  app.refreshWallet();
  refreshServices(root);
  chat.kick();
  renderAll(root);
}

function refreshServices(root) { api.services().then((l) => { services = l; if (task) schedule(() => renderAgents(root)); }).catch(() => undefined); }

function setErr(root, inputSel, errSel, msg) {
  const el = $(errSel, root), inp = $(inputSel, root);
  el.textContent = msg || '';
  if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
}

function collect(root) {
  const text = $('#task-input', root).value.trim();
  const bStr = $('#budget-input', root).value.trim();
  let tErr = '', bErr = '', units = null;
  if (!text) tErr = 'Describe a task before sending.'; else if (text.length < 10) tErr = 'Add a little more detail (at least 10 characters).';
  if (!bStr) bErr = 'Enter a budget in USDC.';
  else if (bStr.startsWith('-')) bErr = 'Budget cannot be negative.';
  else if ((units = toUnits(bStr)) === null) bErr = 'Use a number such as 0.050.';
  else if (units <= 0n) bErr = 'Budget must be greater than 0.';
  else if (units > MAX_BUDGET) bErr = `Demo limit is ${formatUsdc(MAX_BUDGET)} USDC per task.`;
  else if (app.wallet?.usdcBalance != null && units > BigInt(app.wallet.usdcBalance)) bErr = `Budget is more than your test balance (${formatUsdc(app.wallet.usdcBalance)}). Use the Faucet.`;
  setErr(root, '#task-input', '#task-error', tErr); setErr(root, '#budget-input', '#budget-error', bErr);
  const opts = $('#xp-options', root);
  if (tErr) { $('#task-input', root).focus(); return null; }
  if (bErr) { opts.open = true; $('#budget-input', root).focus(); return null; }
  return { text, budget: String(units), maxConcurrency: Number($('#conc-select', root).value), hired: [...app.hired] };
}

async function run(root) {
  if (submitting || (task && task.status === 'running')) return; // one submission at a time, however many times send is pressed
  if (MOCK) { setErr(root, null, '#task-error', 'Mock mode: tasks are disabled.'); return; }
  const body = collect(root);
  if (!body) return;
  submitting = true;
  const btn = $('#run-btn', root);
  btn.disabled = true;
  try {
    const { taskId } = await api.createTask(body);
    taskText = body.text;
    const input = $('#task-input', root);
    input.value = ''; autosize(input); $('#task-count', root).textContent = '';
    $('#xp-options', root).open = false;
    attach(root, taskId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    btn.disabled = false;
    const issue = e instanceof ApiError ? e.body?.issues?.[0] : null;
    if (issue?.path === 'budget') { $('#xp-options', root).open = true; setErr(root, '#budget-input', '#budget-error', issue.message); }
    else if (issue?.path === 'text') setErr(root, '#task-input', '#task-error', issue.message);
    else if (e.status === 429) setErr(root, null, '#task-error', 'You have reached the temporary task limit (6 per minute). Please wait a minute and try again.');
    else if (e.status === 409) setErr(root, null, '#task-error', `Spending is halted: ${e.body?.detail || 'the ledger failed verification'}.`);
    else setErr(root, null, '#task-error', e.message);
  } finally { submitting = false; }
}

function autosize(el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }

function build(root) {
  root.innerHTML = HTML;
  market = mountMarket($('#market', root));
  resultView = mountResult($('#result-card', root), () => task);
  chat = mountBeaconChat($('#chat-mount', root), { getTaskId: () => task?.id || null, isRunning: () => !!task && task.status === 'running' });
  api.config().then((c) => chat.setModel(c)).catch(() => undefined);
  const input = $('#task-input', root);
  const count = () => { const n = input.value.length; $('#task-count', root).textContent = n > 800 ? `${n} / 1000` : ''; };
  input.addEventListener('input', () => { count(); autosize(input); setErr(root, '#task-input', '#task-error', ''); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); run(root); } });
  $('#budget-input', root).addEventListener('input', () => setErr(root, '#budget-input', '#budget-error', ''));
  $('#task-form', root).addEventListener('submit', (e) => { e.preventDefault(); run(root); });
  root.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-example]');
    if (ex) { const t = examples[Number(ex.dataset.example)]; input.value = t.text; $('#budget-input', root).value = t.budget; $('#conc-select', root).value = String(t.maxConcurrency); count(); autosize(input); input.focus(); }
    const un = e.target.closest('[data-unhire]'); if (un) app.setHired(un.dataset.unhire, false);
    if (e.target.closest('[data-clear-hired]')) app.clearHired();
  });
  app.onHired(() => renderHired(root));
  api.examples().then((ex) => {
    examples = ex;
    $('#examples', root).innerHTML = ex.map((t, i) => `<button type="button" class="chip" data-example="${i}">${esc(t.name)}</button>`).join(' ');
    if (ex[0]) $('#budget-input', root).value = ex[0].budget;
  }).catch(() => undefined);
  built = true;
}

/** Back to the empty landing page: detaches from any task (a running task keeps running on the server). */
function resetView() {
  const root = document.getElementById('page-explore');
  if (!built || !root) return;
  if (stream) { stream(); stream = null; }
  clearInterval(timer); clearTimeout(kickTimer);
  task = null; taskText = ''; streamState = 'closed'; submitting = false;
  chat.setTask(null);
  resultView.reset();
  const btn = $('#run-btn', root);
  btn.disabled = false; btn.setAttribute('aria-label', 'Send task'); btn.innerHTML = icon('send');
  $('#xp-options', root).open = true;
  const input = $('#task-input', root); input.value = ''; autosize(input);
  $('#task-count', root).textContent = '';
  setErr(root, '#task-input', '#task-error', ''); setErr(root, '#budget-input', '#budget-error', '');
  renderAll(root);
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
      try { const s = await api.task(id); taskText = s.text || taskText; attach(root, id); } catch { /* task no longer known */ renderAll(root); }
    } else renderAll(root);
  },
  reset: resetView,
  /** Opens a task from My Tasks. */
  open(id) { const q = new URLSearchParams(location.search); q.set('task', id); history.replaceState(null, '', `?${q.toString()}${location.hash}`); }, // the caller then switches the hash, which routes here
};
