// Attack panel page: fire the hostile cases against the live system and see the verdict, the money effect and the ledger row.
import { api } from '../api.js';
import { app } from '../app.js';
import explore from './explore.js';
import { $, esc, icon, formatUsdc, explorerUrl, shortHash, toast } from '../ui.js';

const TITLES = {
  'price-lie': 'Price lie', 'payto-lie': 'payTo lie', junk: 'Junk output', failure: 'Seller failure', replay5: 'Replay five times in parallel', 'budget-race': 'Budget race', invariant: 'Invariant test',
};
const WHAT = {
  'price-lie': 'Buys once from Overquote, whose 402 asks ten times its listed price.',
  'payto-lie': 'Buys once from Redirect, whose 402 names a different payee address.',
  junk: 'Buys once from Hollow, which takes payment and returns output that breaks its own schema.',
  failure: 'Buys once from Offline, which always fails after the payment is verified.',
  replay5: 'Signs one payment with the replay wallet and sends it once, again, then five times in parallel against Atlas.',
  'budget-race': 'Starts task 3 with a 0.012 USDC cap at concurrency 5. Watch the budget meter on the Explore page.',
  invariant: 'Hundreds of seeded random parallel purchases against one budget, checked after every step.',
};

function resultHtml(r) {
  const a = r.actual || {};
  const ok = ['REFUSE', 'ACCEPT_FLAG', 'RELEASE', 'PASS', 'READY'].includes(a.verdict);
  const url = explorerUrl(r.txHash);
  return `<div class="attack-result"><div class="badges"><span class="badge ${ok ? 'badge-green' : 'badge-red'}">${icon(ok ? 'checkcircle' : 'xcircle')}${esc(a.verdict)}</span><span class="badge">${esc(a.ruleId || '')}</span>${a.status ? `<span class="badge">${esc(a.status)}</span>` : ''}</div>
    <p class="mt">${esc(a.reason)}</p>
    <dl class="kv mt"><dt>Money moved</dt><dd>${formatUsdc(r.paid)} test USDC</dd>${url ? `<dt>Transaction</dt><dd><a href="${url}" target="_blank" rel="noopener noreferrer">${esc(shortHash(r.txHash))}</a></dd>` : ''}${r.callNo ? `<dt>Ledger row</dt><dd><a href="#ledger">Call #${esc(r.callNo)}</a></dd>` : ''}<dt>Took</dt><dd>${esc(r.durationMs)} ms</dd></dl></div>`;
}

export default {
  title: 'Attack Panel',
  subtitle: 'Fire the hostile cases against the live system and see the verdict.',
  async mount(root) {
    root.innerHTML = '<section class="card"><div class="empty"><p>Loading…</p></div></section>';
    let cases;
    try { cases = await api.attacks(); } catch (e) {
      root.innerHTML = `<section class="card"><div class="empty">${icon('alert')}<h3>Attack panel is not available</h3><p>${esc(e.status === 404 ? 'Set ENABLE_ATTACK_PANEL=true on the Beacon server.' : e.message)}</p></div></section>`;
      return;
    }
    root.innerHTML = `<div class="banner-top">${icon('alert')}<span>Every case goes through the <strong>same payment guard</strong> as a normal task. Each one is a real call on Base Sepolia with test USDC, and appears in the Ledger tagged <code>attack-panel</code>.</span></div>
      <div class="attack-grid">${cases.map((c) => `<section class="card attack-card" aria-labelledby="at-${esc(c.id)}"><h2 id="at-${esc(c.id)}">${esc(TITLES[c.id] || c.id)}</h2><p class="muted">${esc(WHAT[c.id] || '')}</p>
        <dl class="kv"><dt>Proves</dt><dd>${esc(c.proves)}</dd><dt>Expected</dt><dd>${esc(c.expected)}</dd><dt>Cost</dt><dd>${esc(c.cost)}</dd></dl>
        <div><button type="button" class="btn btn-primary" data-fire="${esc(c.id)}">${icon('bolt')}Fire</button></div><div data-out="${esc(c.id)}" role="status" aria-live="polite"></div></section>`).join('')}</div>`;
    root.onclick = async (e) => {
      const b = e.target.closest('[data-fire]');
      if (!b) return;
      const id = b.dataset.fire, out = $(`[data-out="${id}"]`, root);
      b.disabled = true; out.innerHTML = `<p class="muted">${icon('clock', 'icon-sm')} Running…</p>`;
      try {
        const r = await api.attack(id);
        out.innerHTML = resultHtml(r);
        if (r.startTask) {
          const { taskId } = await api.createTask(r.startTask);
          explore.open(taskId); app.goto('#explore'); toast('Budget race started. Watch the meter.', 'ok');
        }
        app.refreshWallet();
      } catch (e2) { out.innerHTML = `<div class="banner err">${icon('xcircle')}<div><strong>${esc(e2.body?.error || 'Failed')}</strong><span>${esc(e2.message)}</span></div></div>`; }
      b.disabled = false;
    };
  },
};
