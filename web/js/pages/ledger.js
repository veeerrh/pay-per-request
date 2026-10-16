// Ledger page: every attempted call, filters, detail view with the decision log, CSV export, reconciliation and chain badges.
import { api } from '../api.js';
import { app } from '../app.js';
import { $, esc, icon, formatUsdc, fmtTime, fmtDateTime, shortHash, explorerUrl, statusBadge, STATUS, dialogHead, openDialog, wireTabs, toast } from '../ui.js';

const s = { rows: [], tab: 'all', shown: 200, verify: null, rec: null, recBusy: false, loaded: false, error: '' };
let root;

const TABS = [['all', 'All'], ['paid', 'Paid'], ['refused', 'Refused'], ['failed', 'Failed'], ['rejected', 'Paid, output rejected'], ['pending', 'Pending']];
const counts = () => { const c = { all: s.rows.length, paid: 0, refused: 0, failed: 0, rejected: 0, pending: 0 }; s.rows.forEach((e) => { if (c[e.status] !== undefined) c[e.status]++; }); return c; };
const visibleRows = () => [...(s.tab === 'all' ? s.rows : s.rows.filter((e) => e.status === s.tab))].sort((a, b) => b.callNo - a.callNo);

function hashCell(e) {
  const url = explorerUrl(e.txHash);
  if (url) return `<div class="cell-stack"><a class="hash-link" href="${url}" target="_blank" rel="noopener noreferrer">${esc(shortHash(e.txHash))}<span class="sr-only"> (opens the Base Sepolia block explorer)</span> ${icon('external', 'icon-sm')}</a><span class="badge badge-net">Base Sepolia testnet</span><span class="badge ${e.txConfirmed ? 'badge-green' : 'badge-amber'}">${e.txConfirmed ? 'Confirmed' : 'Pending confirmation'}</span></div>`;
  if (e.source === 'mock' && BigInt(e.paid || 0) > 0n) return `<span class="badge badge-demo">Demo data</span>`;
  return '<span class="hash-none">–</span>';
}

function row(e) {
  return `<tr>
    <td class="num">#${esc(e.callNo)}</td><td>${fmtTime(e.time)}</td><td>${esc(e.buyer)}</td>
    <td class="cell-seller"><strong>${esc(e.seller)}</strong>${e.source && e.source !== 'task' ? `<span>${esc(e.source)}</span>` : ''}</td>
    <td>${esc(e.category)}</td>
    <td class="num">${formatUsdc(e.listed)}</td><td class="num">${formatUsdc(e.asked)}</td><td class="num ${BigInt(e.paid || 0) ? '' : 'paid-zero'}">${formatUsdc(e.paid)}</td>
    <td>${statusBadge(e.status)}${e.reason ? `<div class="reason">${esc(e.ruleId)}: ${esc(e.reason)}</div>` : ''}</td>
    <td class="num">${esc(e.latencyMs)} ms</td><td>${hashCell(e)}</td>
    <td><button type="button" class="btn btn-secondary btn-sm" data-detail="${esc(e.id)}" aria-label="Details for call ${esc(e.callNo)}">${icon('eye')}Details</button></td></tr>`;
}

function recBadge() {
  const r = s.rec;
  if (s.recBusy) return `<span class="badge badge-amber">${icon('clock')}Checking the chain…</span>`;
  if (!r) return `<span class="badge badge-amber">${icon('clock')}Not checked yet</span>`;
  if (r.status === 'matched') return `<span class="badge badge-green">${icon('checkcircle')}Matches chain</span>`;
  if (r.status === 'unverified') return `<span class="badge badge-amber">${icon('alert')}Not verified</span>`;
  return `<span class="badge badge-red">${icon('xcircle')}Differences found</span>`;
}
function recText() {
  const r = s.rec;
  if (!r) return 'Press Re-run to compare the ledger with USDC transfers out of the buyer wallet.';
  if (r.status === 'unverified') return esc(r.error || 'The chain could not be read, so this is NOT a pass.');
  const d = (r.differences || []).map((x) => `${x.status.replace('_', ' ')} ${formatUsdc(Math.max(Number(x.ledgerAmount), Number(x.chainAmount)))}`).join('; ');
  return `Ledger ${formatUsdc(r.ledgerTotal)} · chain ${formatUsdc(r.chainTotal)} USDC${d ? `. Differences: ${esc(d)}` : '. Equal to the last unit.'}`;
}

function render() {
  const c = counts();
  const paid = s.rows.reduce((t, e) => t + BigInt(e.paid || 0), 0n);
  const v = s.verify;
  root.innerHTML = `
    <div class="summary-grid" aria-label="Ledger summary">
      <div class="sum-card"><div class="k">Total paid</div><div class="v">${formatUsdc(paid)} <small>test USDC</small></div><div class="s">${c.paid + c.rejected} payments settled</div></div>
      <div class="sum-card"><div class="k">Successful calls</div><div class="v">${c.paid}</div><div class="s">Paid and output accepted</div></div>
      <div class="sum-card"><div class="k">Refused / failed</div><div class="v">${c.refused + c.failed}</div><div class="s">${c.refused} refused · ${c.failed} failed · ${c.rejected} paid, output rejected${c.pending ? ` · ${c.pending} pending` : ''}</div></div>
      <div class="sum-card"><div class="k">Reconciliation</div><div class="v">${recBadge()}</div><div class="s">${recText()}</div><div class="mt"><button type="button" class="btn btn-secondary btn-sm" data-rerun ${s.recBusy ? 'disabled' : ''}>${icon('refresh')}Re-run</button></div></div>
    </div>
    <section class="card" aria-labelledby="ledger-h">
      <div class="card-head row-between wrap"><div><h2 id="ledger-h">Transaction ledger</h2><p class="muted">Every attempted call, including refusals and failures. Amounts are <strong>test USDC</strong> on Base Sepolia.</p></div>
        <button class="btn btn-secondary" type="button" data-export>${icon('download')}Export CSV</button></div>
      <div class="status-strip">
        ${v ? (v.ok ? `<span class="badge badge-green">${icon('checkcircle')}Ledger intact, ${esc(v.rows)} rows</span><span class="muted">head <code>${esc(shortHash('0x' + v.headHash))}</code></span>` : `<span class="badge badge-red">${icon('xcircle')}Ledger broken at row ${esc(v.brokenAt)}</span><span class="muted">New spending is halted.</span>`) : ''}
        <span class="muted">Session ${esc(app.wallet?.sessionId?.slice(0, 10) || '')}. Earlier sessions stay stored and verifiable.</span>
      </div>
      <div class="tabs" role="tablist" aria-label="Ledger status filter" id="ledger-tabs">${TABS.filter(([k]) => k !== 'pending' || c.pending).map(([k, l]) => `<button role="tab" type="button" id="lt-${k}" data-tab="${k}" aria-selected="${s.tab === k}" aria-controls="ledger-panel" tabindex="${s.tab === k ? 0 : -1}">${l}<span class="tab-count">${c[k]}</span></button>`).join('')}</div>
      <div id="ledger-panel" role="tabpanel" tabindex="0" aria-labelledby="lt-${s.tab}">${body()}</div>
    </section>`;
  wireTabs($('#ledger-tabs', root), (k) => { s.tab = k; s.shown = 200; render(); $(`#lt-${k}`, root)?.focus(); });
}

function body() {
  if (!s.loaded) return `<div class="empty">${icon('clock')}<p>Loading the ledger…</p></div>`;
  if (s.error) return `<div class="empty">${icon('alert')}<h3>Could not load the ledger</h3><p>${esc(s.error)}</p><button class="btn btn-primary" type="button" data-reload>${icon('refresh')}Try again</button></div>`;
  const rows = visibleRows();
  if (!rows.length) return `<div class="empty">${icon('ledger')}<h3>No calls in this view</h3><p>${s.rows.length ? 'No ledger rows match this filter.' : 'Run a task to see every attempted call here.'}</p></div>`;
  const shown = rows.slice(0, s.shown);
  return `<div class="table-wrap"><table class="ledger"><caption class="sr-only">Ledger of attempted calls, amounts in testnet USDC</caption><thead><tr>
    <th scope="col" class="num">Call</th><th scope="col">Time</th><th scope="col">Buyer</th><th scope="col">Seller / service</th><th scope="col">Category</th>
    <th scope="col" class="num">Listed</th><th scope="col" class="num">Requested</th><th scope="col" class="num">Paid</th><th scope="col">Status</th>
    <th scope="col" class="num">Latency</th><th scope="col">Transaction hash</th><th scope="col">Details</th></tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>
    ${rows.length > shown.length ? `<div class="mt"><button type="button" class="btn btn-secondary" data-more>Show more (${rows.length - shown.length} older)</button></div>` : ''}`;
}

function detail(id) {
  const e = s.rows.find((x) => x.id === id);
  if (!e) return;
  const x = e.terms?.expected, y = e.terms?.actual;
  const fields = [['Scheme', 'scheme'], ['Network', 'network'], ['Asset', 'asset'], ['Pay to', 'payTo'], ['Amount (USDC)', 'amount']];
  const trs = fields.map(([lab, k]) => {
    const ev = k === 'amount' ? formatUsdc(x?.[k]) : x?.[k], av = y ? (k === 'amount' ? formatUsdc(y[k]) : y[k]) : 'n/a';
    const ok = y && String(x?.[k]).toLowerCase() === String(y[k]).toLowerCase();
    return `<tr><th scope="row">${lab}</th><td>${esc(ev)}</td><td>${esc(av)}</td><td class="${ok ? 'good' : 'bad'}">${ok ? 'Match' : 'Mismatch'}</td></tr>`;
  }).join('');
  const sch = { passed: ['badge-green', 'Passed'], failed: ['badge-red', 'Failed'], not_run: ['', 'Not run'] }[e.schema?.state] || ['', 'Not run'];
  const url = explorerUrl(e.txHash);
  openDialog(`${dialogHead('dialog-title', `Call #${esc(e.callNo)}: ${esc(e.seller)}`, `<div class="badges mt">${statusBadge(e.status)}<span class="badge badge-net">Base Sepolia testnet</span>${e.source === 'mock' ? '<span class="badge badge-demo">Demo data</span>' : ''}${e.payToUnverified ? '<span class="badge badge-amber">payTo unverified</span>' : ''}</div>`)}
    <div class="dialog-body">
      ${e.reason ? `<p class="note mb"><strong>${esc(STATUS[e.status]?.label || e.status)}.</strong> ${esc(e.reason)}</p>` : ''}
      <div class="dsec"><h3>Prices</h3><div class="metric-row">
        <div class="stat"><dt>Advertised price</dt><dd>${formatUsdc(e.listed)} <small>USDC</small></dd></div>
        <div class="stat"><dt>402 asked price</dt><dd>${formatUsdc(e.asked)} <small>USDC</small></dd></div>
        <div class="stat"><dt>Amount paid</dt><dd>${formatUsdc(e.paid)} <small>USDC</small></dd></div></div></div>
      <div class="dsec"><h3>Payment terms: expected (listing) vs actual (402)</h3><div class="table-scroll"><table class="table-plain"><thead><tr><th scope="col">Field</th><th scope="col">Expected</th><th scope="col">Actual</th><th scope="col">Result</th></tr></thead><tbody>${trs}</tbody></table></div></div>
      <div class="dgrid">
        <div class="dsec"><h3>Schema validation</h3><p><span class="badge ${sch[0]}">${sch[1]}</span></p><p class="muted mt">${esc(e.schema?.detail || 'No paid response was validated.')}</p></div>
        <div class="dsec"><h3>Response</h3><dl class="kv"><dt>Latency</dt><dd>${esc(e.latencyMs)} ms</dd><dt>Time</dt><dd>${fmtDateTime(e.time)}</dd><dt>Category</dt><dd>${esc(e.category)}</dd><dt>Why selected</dt><dd>${esc(e.why || 'n/a')}</dd></dl></div>
      </div>
      <div class="dsec"><h3>Settlement receipt</h3>${url
        ? `<dl class="kv"><dt>Transaction</dt><dd><a href="${url}" target="_blank" rel="noopener noreferrer">${esc(e.txHash)}</a></dd><dt>Status</dt><dd>${e.txConfirmed ? 'Confirmed on chain (receipt found)' : 'Reported by the seller, not yet confirmed on chain'}</dd></dl>`
        : `<p class="muted">${BigInt(e.paid || 0) > 0n ? 'No verified receipt is available for this row.' : 'No receipt. Nothing was settled for this call.'}</p>`}</div>
      <div class="dsec"><h3>Decision log</h3><dl class="kv"><dt>Rule that decided it</dt><dd><code>${esc(e.ruleId)}</code></dd><dt>Reason</dt><dd>${esc(e.reason || 'All checks passed.')}</dd><dt>Rule-set hash</dt><dd><code>${esc(e.ruleSetHash)}</code></dd><dt>Listing snapshot</dt><dd><code>${esc(e.listingHash)}</code></dd><dt>Row hash</dt><dd><code>${esc(e.hash || 'n/a')}</code></dd><dt>Previous row hash</dt><dd><code>${esc(e.prevHash || 'n/a')}</code></dd></dl></div>
    </div><div class="dialog-foot"><button type="button" class="btn btn-secondary" data-close>Close</button></div>`);
}

/** Cells starting with = + - @ are prefixed so spreadsheets never run them as formulas. */
function exportCsv() {
  const rows = visibleRows().sort((a, b) => a.callNo - b.callNo);
  if (!rows.length) return toast('No visible rows to export.', 'warn');
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
  const head = ['call_no', 'time_iso', 'buyer', 'seller', 'category', 'listed_usdc', 'requested_usdc', 'paid_usdc', 'status', 'latency_ms', 'tx_hash', 'network', 'rule', 'reason', 'source'];
  const lines = [head.join(',')].concat(rows.map((e) => [e.callNo, e.time, e.buyer, e.seller, e.category, formatUsdc(e.listed), formatUsdc(e.asked), formatUsdc(e.paid), STATUS[e.status]?.label || e.status, e.latencyMs, explorerUrl(e.txHash) ? e.txHash : '', 'Base Sepolia (testnet)', e.ruleId, e.reason, e.source].map(cell).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `agentmarket-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${rows.length} row${rows.length > 1 ? 's' : ''}.`, 'ok');
}

async function rerun() {
  s.recBusy = true; render();
  try { s.rec = await api.reconcile(); } catch (e) { s.rec = { status: 'unverified', error: e.message }; }
  s.recBusy = false; render();
}

async function load() {
  s.loaded = false; s.error = ''; render();
  try {
    const [rows, v] = await Promise.all([api.ledger(), api.verify()]);
    s.rows = rows; s.verify = v; s.loaded = true;
    app.setHalted(!v.ok, v.ok ? '' : `The ledger hash chain failed verification at row ${v.brokenAt}.`);
  } catch (e) { s.error = e.message; s.loaded = true; }
  render();
}

export default {
  title: 'Ledger',
  subtitle: 'Every attempted call, including refusals and failures, in testnet USDC.',
  mount(el) {
    if (!root) {
      root = el;
      root.addEventListener('click', (e) => {
        const t = e.target;
        if (t.closest('[data-detail]')) detail(t.closest('[data-detail]').dataset.detail);
        else if (t.closest('[data-export]')) exportCsv();
        else if (t.closest('[data-rerun]')) rerun();
        else if (t.closest('[data-more]')) { s.shown += 200; render(); }
        else if (t.closest('[data-reload]')) load();
      });
    }
    return load().then(() => { if (!s.rec && !s.error) rerun(); });
  },
};
