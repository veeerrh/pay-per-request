// Small helpers shared by every page. No inline styles or scripts are ever produced (CSP).
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapes server text before it goes into markup (M-55, S-75). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const UNITS = 1000000n;
/** Units (digit string or bigint) to "0.005". Money is never a float. */
export function formatUsdc(u) {
  let v;
  try { v = BigInt(u ?? 0); } catch { return '–'; }
  const neg = v < 0n;
  if (neg) v = -v;
  let f = (v % UNITS).toString().padStart(6, '0');
  while (f.length > 3 && f.endsWith('0')) f = f.slice(0, -1);
  return `${neg ? '-' : ''}${v / UNITS}.${f}`;
}
/** "0.050" to units (bigint) or null when invalid. */
export function toUnits(str) {
  const s = String(str ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return BigInt(w) * UNITS + BigInt((f + '000000').slice(0, 6));
}
export const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleTimeString([], { hour12: false }); };
export const fmtDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString([], { hour12: false }); };
export const fmtElapsed = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const shortHash = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '–');
export const TX_RE = /^0x[0-9a-fA-F]{64}$/;
/** Explorer links are built only from a real transaction hash returned by the backend (P-04, M-36). */
export const explorerUrl = (h) => (typeof h === 'string' && TX_RE.test(h) ? `https://sepolia.basescan.org/tx/${h}` : null);

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind ? 't-' + kind : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

export async function copyText(text, msg = 'Copied to clipboard.') {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.className = 'sr-only';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { toast('Copy failed. Select the text and copy it manually.', 'err'); ta.remove(); return; }
    ta.remove();
  }
  toast(msg, 'ok');
}

export const dialogHead = (id, title, extra = '') =>
  `<div class="dialog-head"><div><h2 id="${id}">${title}</h2>${extra}</div><button type="button" class="icon-btn" data-close aria-label="Close dialog">${icon('x')}</button></div>`;

/** Opens one of the two shared <dialog> elements. Esc, focus trap and focus return come from the platform. */
export function openDialog(html, small = false) {
  const dlg = $(small ? '#dialog-sm' : '#dialog');
  dlg.innerHTML = html;
  dlg.setAttribute('aria-labelledby', small ? 'dialog-sm-title' : 'dialog-title');
  if (!dlg.open) dlg.showModal();
  return dlg;
}
export function wireDialogs() {
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  }
}

export function wireTabs(list, onSelect) {
  list.addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) onSelect(b.dataset.tab); });
  list.addEventListener('keydown', (e) => {
    const tabs = $$('[role="tab"]', list);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n === null) return;
    e.preventDefault();
    const key = tabs[n].dataset.tab;
    onSelect(key);
    list.querySelector(`[data-tab="${key}"]`)?.focus();
  });
}

/** JSON as coloured, escaped markup. */
export function jsonHtml(obj) {
  const src = JSON.stringify(obj, null, 2) ?? 'null';
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? (m[2] ? 'tk-key' : 'tk-str') : m[3] ? 'tk-lit' : 'tk-num';
    out += `<span class="${cls}">${esc(m[1] ? m[1] : m[0])}</span>${m[2] ? esc(m[2]) : ''}`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}
export const codePanel = (obj, extra = '') => `<div class="code-panel ${extra}"><button type="button" class="btn btn-secondary btn-sm copy-btn" data-copy-json>${icon('copy')}Copy</button><pre tabindex="0"><code>${jsonHtml(obj)}</code></pre></div>`;

export const CAT_ICON = { data: 'database', inference: 'cpu', scraping: 'globe' };
export const CAT_LABEL = { data: 'Data', inference: 'Inference', scraping: 'Scraping' };

export const STATUS = {
  paid: { label: 'Paid', cls: 'badge-green', ic: 'checkcircle' },
  refused: { label: 'Refused', cls: 'badge-red', ic: 'shield' },
  failed: { label: 'Failed, not charged', cls: 'badge-red', ic: 'xcircle' },
  rejected: { label: 'Paid, output rejected', cls: 'badge-amber', ic: 'alert' },
  pending: { label: 'Pending', cls: 'badge-amber', ic: 'clock' },
};
export const statusBadge = (s) => { const m = STATUS[s] || STATUS.pending; return `<span class="badge ${m.cls}">${icon(m.ic)}${m.label}</span>`; };

/** Sets an element width from JS (allowed by CSP, unlike a style attribute in markup). */
export const setWidth = (el, pct) => { if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`; };

/** Turns a short report into bullet points: lines starting with "- " are used as they are, other prose is split into sentences. */
export function bulletsHtml(text, max = 6) {
  const raw = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let items = raw.map((l) => l.replace(/^[-*\u2022]\s+/, ''));
  if (raw.length <= 1 && !/^[-*\u2022]\s/.test(raw[0] || '')) items = String(text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<ul class="bullets brief">${items.slice(0, max).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}
