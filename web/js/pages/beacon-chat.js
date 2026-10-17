// Beacon's chat panel. One persistent panel: the feed comes from GET /api/tasks/:id/chat (the backend is the source of truth),
// questions go to POST /api/chat. The chat explains and summarises; it can never start a purchase (that is POST /api/tasks only).
import { api, MOCK, ApiError } from '../api.js';
import { $, $$, esc, icon, fmtTime, bulletsHtml } from '../ui.js';

const MAX = 500;
const CHIPS = ['Why did you pick these agents?', 'What did it cost?', 'What went wrong?', 'Show the results'];
const KIND = {
  plan: 'Plan', choice: 'Choice', select: 'Selecting', agent: 'Agent', paid: 'Paid', rejected: 'Rejected', refused: 'Refused', failed: 'Failed', pending: 'Pending',
  blocked: 'Blocked', summary: 'Summary', question: 'You', answer: 'Beacon', notice: 'Notice', alert: 'Alert', incident: 'Report', info: 'Update',
};

export function mountBeaconChat(root, { getTaskId, isRunning }) {
  root.innerHTML = `
    <section class="bc" aria-labelledby="bc-h">
      <header class="bc-head">
        <span class="bc-avatar" aria-hidden="true">B</span>
        <div class="bc-titles"><h2 id="bc-h">Beacon</h2><p>Your buyer agent</p></div>
        <span class="bc-model" id="bc-model" hidden></span>
      </header>
      <div class="bc-feed" id="bc-feed" role="log" aria-live="polite" aria-label="Beacon conversation" tabindex="0"></div>
      <div class="bc-chips" id="bc-chips" role="group" aria-label="Suggested questions">${CHIPS.map((c) => `<button type="button" class="chip" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <form class="bc-form" id="bc-form" novalidate>
        <label class="sr-only" for="bc-input">Message to Beacon</label>
        <textarea id="bc-input" rows="1" maxlength="${MAX}" placeholder="Ask Beacon anything..." autocomplete="off"></textarea>
        <button type="submit" class="bc-send" id="bc-send" aria-label="Send message" disabled>${icon('send')}</button>
      </form>
      <p class="bc-note" id="bc-note" role="status" aria-live="polite"></p>
    </section>`;

  const feed = $('#bc-feed', root), input = $('#bc-input', root), send = $('#bc-send', root), note = $('#bc-note', root);
  let messages = [], local = [], busy = false, timer = null, taskId = null, lastSig = '';

  const setNote = (text, kind = '') => { note.textContent = text; note.dataset.kind = kind; };
  const sync = () => { send.disabled = busy || !input.value.trim(); };
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };

  function bubble(m) {
    const kind = m.kind || (m.role === 'user' ? 'question' : 'answer');
    const user = m.role === 'user';
    return `<div class="bc-msg bc-k-${esc(kind)} ${user ? 'bc-user' : 'bc-beacon'}${m.severity ? ` bc-s-${esc(m.severity)}` : ''}">
      <div class="bc-meta"><span class="bc-kind">${esc(KIND[kind] || kind)}</span>${m.at ? `<time>${esc(fmtTime(m.at))}</time>` : ''}</div>
      <div class="bc-text">${kind === 'summary' ? bulletsHtml(m.text) : esc(m.text)}</div></div>`;
  }

  function render(force = false) {
    const list = taskId ? messages : local;
    const sig = `${taskId}|${list.length}|${list.at(-1)?.text?.length ?? 0}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.innerHTML = list.length
      ? list.map(bubble).join('')
      : `<div class="bc-empty">${icon('info')}<p>${taskId ? 'Beacon has not said anything yet.' : 'Run a task and Beacon will narrate each step here: which agents it picks, why, what it pays and what came back. You can ask follow-up questions at any time.'}</p></div>`;
    if (nearBottom || force) feed.scrollTop = feed.scrollHeight; // only follow the conversation when the reader is at the bottom
  }

  async function refresh() {
    if (!taskId || MOCK) return;
    try {
      const j = await api.taskChat(taskId);
      messages = j.messages || [];
      render();
    } catch { /* keep what is shown; the next tick retries */ }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (taskId && isRunning()) timer = setInterval(() => { refresh(); if (!isRunning()) { clearInterval(timer); timer = null; refresh(); } }, 2000);
  }

  async function ask(text) {
    const message = text.trim();
    if (!message || busy) return;
    if (message.length > MAX) { setNote(`Keep it under ${MAX} characters.`, 'err'); return; }
    busy = true; sync(); setNote('');
    const id = getTaskId();
    try {
      if (MOCK) throw new ApiError(0, null, 'Mock mode: chat is disabled.');
      const r = await api.chat({ message, ...(id ? { taskId: id } : {}) });
      input.value = ''; grow();
      if (id) { taskId = id; await refresh(); } else { local.push({ role: 'user', kind: 'question', text: message, at: new Date().toISOString() }, { role: 'beacon', kind: 'answer', text: r.reply, at: new Date().toISOString() }); render(true); }
      if (r.source === 'rules') setNote('Answered with rule-based logic.', '');
    } catch (e) {
      if (e.status === 429) setNote('You have reached the temporary message limit (12 per minute). Please wait a minute and try again.', 'err');
      else if (e.status === 404) setNote('That task is no longer available.', 'err');
      else if (e.status === 400) setNote(e.body?.issues?.[0]?.message || 'That message could not be sent.', 'err');
      else setNote(e.message || 'The message could not be sent.', 'err');
    } finally { busy = false; sync(); }
  }

  input.addEventListener('input', () => { sync(); grow(); setNote(input.value.length > MAX - 50 ? `${MAX - input.value.length} characters left` : ''); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
  $('#bc-form', root).addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  $('#bc-chips', root).addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) ask(b.dataset.q); });

  return {
    /** Point the panel at a task (or none). Keeps the conversation of that task and refreshes it. */
    setTask(id) { if (id !== taskId) { taskId = id; messages = []; lastSig = ''; render(true); } schedule(); refresh(); },
    /** Called when the task stream says something happened (a chat event, or the task finished). */
    kick() { refresh(); schedule(); },
    setModel(cfg) {
      const el = $('#bc-model', root);
      if (!cfg || !cfg.llm) { el.hidden = true; return; }
      el.hidden = false;
      el.className = `bc-model ${cfg.llm.enabled ? 'on' : 'off'}`;
      el.textContent = cfg.llm.enabled ? 'AI' : 'Rule-based';
      el.title = cfg.llm.enabled ? 'Beacon uses a model for planning, choosing and explaining. Payments are always decided by code.' : 'No model is configured, so Beacon uses its rule-based logic.';
    },
    destroy() { clearInterval(timer); },
  };
}
