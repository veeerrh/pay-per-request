// Marketplace: browse, filter, details, hire, register. Filtering happens client side on /api/services.
// There is deliberately NO network filter or selector anywhere (D-26): everything here is Base Sepolia testnet.
import { api, MOCK } from '../api.js';
import { app } from '../app.js';
import { $, $$, esc, icon, formatUsdc, toUnits, CAT_ICON, CAT_LABEL, codePanel, dialogHead, openDialog, copyText, toast } from '../ui.js';

const state = { list: [], status: 'loading', error: '', f: { q: '', cat: 'All', maxPrice: 100000, sort: 'recommended' } };

function repOf(s) { return s.reputation || { attempts: 0, headline: null, score: 0.5, medianLatencyMs: null, status: 'probation' }; }

function visible() {
  const f = state.f, q = f.q.trim().toLowerCase();
  const rows = state.list.filter((s) => (f.cat === 'All' || s.category === f.cat.toLowerCase()) && BigInt(s.price) <= BigInt(f.maxPrice) && (!q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)));
  const proven = (s) => repOf(s).attempts >= 3;
  const cmp = {
    recommended: (a, b) => (proven(b) - proven(a)) || (repOf(b).score - repOf(a).score) || (Number(BigInt(a.price) - BigInt(b.price))) || a.name.localeCompare(b.name),
    price: (a, b) => Number(BigInt(a.price) - BigInt(b.price)) || a.name.localeCompare(b.name),
    success: (a, b) => ((repOf(b).headline ?? -1) - (repOf(a).headline ?? -1)) || Number(BigInt(a.price) - BigInt(b.price)),
  }[f.sort];
  return rows.sort(cmp);
}

function chips(s) {
  const r = repOf(s), out = [];
  if (s.inputSchema && s.outputSchema) out.push(`<span class="badge badge-green">${icon('check')}Schema listed</span>`);
  if (s.probe?.matches === true) out.push(`<span class="badge badge-green">${icon('check')}Probe matched</span>`);
  if (s.probe?.matches === false) out.push(`<span class="badge badge-red">${icon('alert')}Probe mismatch</span>`);
  if (s.labels?.includes('test-vendor')) out.push(`<span class="badge badge-amber">${icon('alert')}Test vendor</span>`);
  if (r.status === 'dropped') out.push(`<span class="badge badge-red">Dropped</span>`);
  else if (r.status === 'probation') out.push(`<span class="badge">Probation</span>`);
  else out.push(`<span class="badge badge-green">Active</span>`);
  if (r.suspended) out.push(`<span class="badge badge-red">Suspended</span>`);
  return out.join('');
}

function card(s) {
  const r = repOf(s), hired = app.hired.has(s.id);
  const rate = r.attempts ? `${Math.round((r.headline ?? 0) * 100)}%` : 'New';
  return `<article class="agent-card${hired ? ' hired' : ''}" aria-labelledby="ag-${esc(s.id)}">
    <div class="agent-cover"><span class="cover-icon">${icon(CAT_ICON[s.category] || 'cpu')}</span></div>
    <div class="agent-body">
      <div class="badges"><span class="badge">${esc(CAT_LABEL[s.category] || s.category)}</span></div>
      <h3 id="ag-${esc(s.id)}">${esc(s.name)}</h3>
      <p class="desc">${esc(s.description)}</p>
      <div class="badges">${chips(s)}</div>
      <div class="agent-net">${icon('globe', 'icon-sm')}Base Sepolia (testnet)</div>
      <dl class="metrics">
        <div><dt>Success</dt><dd>${rate}</dd></div>
        <div><dt>Median</dt><dd>${r.medianLatencyMs ? (r.medianLatencyMs / 1000).toFixed(2) + 's' : '–'}</dd></div>
        <div><dt>Calls</dt><dd>${r.attempts}</dd></div>
      </dl>
    </div>
    <div class="agent-foot">
      <div class="price"><small>Per call</small><strong>${formatUsdc(s.price)}</strong> <span>USDC</span></div>
      <div class="foot-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-view="${esc(s.id)}">View Details</button>
        <button type="button" class="btn ${hired ? 'btn-secondary' : 'btn-primary'} btn-sm" data-hire="${esc(s.id)}" aria-pressed="${hired}">${hired ? icon('check') + 'Hired' : 'Hire Agent'}</button>
      </div>
    </div></article>`;
}

function renderGrid(root) {
  const grid = $('#agent-grid', root), count = $('#market-count', root);
  if (state.status === 'loading') { count.textContent = 'Loading agents…'; grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton" aria-hidden="true"></div>').join(''); return; }
  if (state.status === 'error') { count.textContent = ''; grid.innerHTML = `<div class="card empty wide">${icon('alert')}<h3>Could not load agents</h3><p>${esc(state.error)}. Nothing was charged.</p><button class="btn btn-primary" type="button" data-retry>${icon('refresh')}Try again</button></div>`; return; }
  const rows = visible();
  count.textContent = `Showing ${rows.length} of ${state.list.length} agents`;
  grid.innerHTML = rows.length ? rows.map(card).join('') : `<div class="card empty wide">${icon('search')}<h3>No agents match</h3><p>Try a different search, raise the max price, or clear the filters.</p><button class="btn btn-secondary" type="button" data-clear>Clear filters</button></div>`;
}

async function load(root) {
  state.status = 'loading'; renderGrid(root);
  try { state.list = await api.services(); state.status = 'ready'; } catch (e) { state.status = 'error'; state.error = e.message; }
  renderGrid(root);
}

function details(id) {
  const s = state.list.find((x) => x.id === id);
  if (!s) return;
  const r = repOf(s), hired = app.hired.has(s.id);
  const dlg = openDialog(`${dialogHead('dialog-title', esc(s.name), `<div class="badges mt"><span class="badge">${esc(CAT_LABEL[s.category])}</span><span class="badge badge-net">Base Sepolia</span>${s.labels?.includes('test-vendor') ? '<span class="badge badge-amber">Test vendor</span>' : ''}</div>`)}
    <div class="dialog-body">
      <p>${esc(s.description)}</p>
      <div class="dsec mt"><h3>Reputation (computed from the ledger)</h3>
        <div class="metric-row">
          <div class="stat"><dt>Listed price</dt><dd>${formatUsdc(s.price)} <small>USDC / call</small></dd></div>
          <div class="stat"><dt>Success rate</dt><dd>${r.attempts ? Math.round((r.headline ?? 0) * 100) + '%' : 'New'}</dd></div>
          <div class="stat"><dt>Median latency</dt><dd>${r.medianLatencyMs ? (r.medianLatencyMs / 1000).toFixed(2) + 's' : '–'}</dd></div>
        </div>
        <p class="muted mt">${r.attempts} attempt(s) in this session. Status: <strong>${esc(r.status)}</strong>${r.lastRuleId ? `. Last rule that counted against it: ${esc(r.lastRuleId)}` : ''}. Ranking uses measured behaviour only, never seller text.</p>
      </div>
      <div class="dsec"><h3>Listing</h3><dl class="kv">
        <dt>Network</dt><dd>Base Sepolia (eip155:84532)</dd>
        <dt>payTo</dt><dd><code>${esc(s.payTo)}</code> <button type="button" class="icon-btn" data-copy="${esc(s.payTo)}" aria-label="Copy payTo">${icon('copy')}</button></dd>
        <dt>Endpoint</dt><dd><code>${esc(s.endpoint)}</code></dd>
        <dt>Listing</dt><dd>version ${esc(s.version)}, hash <code>${esc(s.listingHash)}</code></dd>
        <dt>Registry probe</dt><dd>${s.probe ? (s.probe.matches === true ? 'The 402 matched this listing.' : s.probe.matches === false ? `<span class="bad">Mismatch: ${esc(s.probe.reason)}</span>` : esc(s.probe.reason || 'not checked')) : 'not checked'}</dd>
      </dl></div>
      <div class="dgrid">
        <div class="dsec"><h3>Input schema</h3>${codePanel(s.inputSchema, 'modal-code')}</div>
        <div class="dsec"><h3>Output schema</h3>${codePanel(s.outputSchema, 'modal-code')}</div>
      </div>
    </div>
    <div class="dialog-foot"><button type="button" class="btn btn-secondary" data-close>Close</button><button type="button" class="btn btn-primary" data-hire-dialog="${esc(s.id)}">${hired ? 'Remove from plan' : 'Hire Agent'}</button></div>`);
  dlg.querySelector('[data-hire-dialog]').addEventListener('click', () => { toggleHire(s.id); dlg.close(); });
  dlg.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
  dlg.querySelectorAll('[data-copy-json]').forEach((b) => b.addEventListener('click', () => copyText(b.parentElement.querySelector('code').textContent, 'JSON copied.')));
}

function toggleHire(id) {
  const on = !app.hired.has(id);
  app.setHired(id, on);
  const s = state.list.find((x) => x.id === id);
  if (on) { toast(`${s?.name || id} added to your task plan.`, 'ok'); $('#task-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

function registerDialog(root) {
  const dlg = openDialog(`${dialogHead('dialog-title', 'Register a seller')}
    <form id="reg-form" novalidate><div class="dialog-body form-stack">
      <p class="muted">Anyone can list a seller. Listings are validated, the endpoint is checked, and the registry probes the 402 (advisory). Beacon still re-checks every 402 before it pays.</p>
      <div class="grid-2"><div><label class="label" for="r-name">Name</label><input id="r-name" class="input" maxlength="80" required></div>
        <div><label class="label" for="r-cat">Category</label><select id="r-cat" class="select"><option value="data">Data</option><option value="inference">Inference</option><option value="scraping">Scraping</option></select></div></div>
      <div class="grid-2"><div><label class="label" for="r-url">Endpoint URL</label><input id="r-url" class="input" type="url" placeholder="https://…" required></div>
        <div><label class="label" for="r-method">Method</label><select id="r-method" class="select"><option>GET</option><option>POST</option></select></div></div>
      <div class="grid-2"><div><label class="label" for="r-price">Price per call (USDC, max 0.100)</label><input id="r-price" class="input" inputmode="decimal" placeholder="0.005" required></div>
        <div><label class="label" for="r-payto">payTo address</label><input id="r-payto" class="input" placeholder="0x…" required></div></div>
      <div><label class="label" for="r-desc">Description</label><input id="r-desc" class="input" maxlength="500"></div>
      <div class="grid-2"><div><label class="label" for="r-in">Input JSON Schema</label><textarea id="r-in" class="textarea" rows="4">{"type":"object"}</textarea></div>
        <div><label class="label" for="r-out">Output JSON Schema</label><textarea id="r-out" class="textarea" rows="4">{"type":"object"}</textarea></div></div>
      <div><label class="label" for="r-probe">Example query for the probe (optional, for example country=India)</label><input id="r-probe" class="input" maxlength="200"></div>
      <p id="r-error" class="field-error" role="alert"></p><div id="r-result" role="status"></div>
    </div><div class="dialog-foot"><button type="button" class="btn btn-secondary" data-close>Close</button><button type="submit" class="btn btn-primary">Register</button></div></form>`);
  const form = $('#reg-form', dlg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#r-error', dlg), out = $('#r-result', dlg);
    err.textContent = ''; out.innerHTML = '';
    const v = (id) => $(`#${id}`, dlg).value.trim();
    const price = toUnits(v('r-price'));
    const parse = (id, label) => { try { return JSON.parse(v(id)); } catch { err.textContent = `${label} must be valid JSON.`; return null; } };
    if (!v('r-name')) return (err.textContent = 'Enter a name.');
    if (!/^https?:\/\//.test(v('r-url'))) return (err.textContent = 'Enter a full URL starting with https://');
    if (price === null || price <= 0n || price > 100000n) return (err.textContent = 'Price must be between 0.001 and 0.100 USDC.');
    if (!/^0x[a-fA-F0-9]{40}$/.test(v('r-payto'))) return (err.textContent = 'payTo must be a 0x address (42 characters).');
    const inSchema = parse('r-in', 'The input schema'); if (!inSchema) return;
    const outSchema = parse('r-out', 'The output schema'); if (!outSchema) return;
    if (MOCK) return (err.textContent = 'Mock mode: registration is disabled.');
    const btn = $('button[type="submit"]', dlg); btn.disabled = true;
    try {
      const r = await api.registerService({
        name: v('r-name'), category: v('r-cat'), endpoint: v('r-url'), method: v('r-method'), price: price.toString(), network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: v('r-payto'), inputSchema: inSchema, outputSchema: outSchema, description: v('r-desc'),
        ...(v('r-probe') ? { probeQuery: v('r-probe') } : {}),
      });
      const p = r.probe;
      out.innerHTML = `<div class="banner ${r.status === 'flagged' ? 'err' : 'ok'}">${icon(r.status === 'flagged' ? 'alert' : 'checkcircle')}<div><strong>${r.status === 'flagged' ? 'Listed, but flagged' : 'Listed'} (version ${esc(r.version)})</strong><span>${p ? (p.matches === true ? 'The probe matched the listing.' : p.matches === false ? `Probe mismatch: ${esc(p.reason)}` : esc(p.reason)) : ''}</span></div></div>`;
      load(root);
    } catch (e2) { err.textContent = e2.message; } finally { btn.disabled = false; }
  });
}

export function mountMarket(root) {
  root.innerHTML = `
    <div class="section-head"><h2 id="market-h">Explore Agents</h2><p class="muted">Agents provide data, inference, and scraping services. Pay only for the calls you make.</p></div>
    <div class="toolbar" role="search" aria-label="Filter agents">
      <div class="search"><svg class="icon" aria-hidden="true"><use href="#i-search"/></svg><label class="sr-only" for="search-input">Search agents or services</label><input id="search-input" class="input" type="search" placeholder="Search agents or services…" autocomplete="off"></div>
      <div class="seg" id="cat-filter" role="group" aria-label="Category">${['All', 'Data', 'Inference', 'Scraping'].map((c) => `<button type="button" data-cat="${c}" aria-pressed="${c === 'All'}">${c}</button>`).join('')}</div>
      <div class="filters">
        <div class="field field-range"><label class="label-sm" for="price-range">Max price: <output id="price-out" for="price-range">0.100</output> USDC</label><input id="price-range" type="range" min="1000" max="100000" step="1000" value="100000"></div>
        <div class="field"><label class="label-sm" for="sort-select">Sort by</label><select id="sort-select" class="select select-sm"><option value="recommended">Recommended</option><option value="price">Lowest price</option><option value="success">Best success rate</option></select></div>
        <button type="button" class="btn btn-secondary btn-sm" data-register>${icon('plus')}Register seller</button>
      </div>
    </div>
    <p class="result-count" id="market-count" aria-live="polite"></p>
    <div id="agent-grid" class="agent-grid"></div>`;

  $('#search-input', root).addEventListener('input', (e) => { state.f.q = e.target.value; renderGrid(root); });
  $('#cat-filter', root).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.f.cat = b.dataset.cat; $$('#cat-filter button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); renderGrid(root); });
  $('#price-range', root).addEventListener('input', (e) => { state.f.maxPrice = Number(e.target.value); $('#price-out', root).textContent = formatUsdc(state.f.maxPrice); renderGrid(root); });
  $('#sort-select', root).addEventListener('change', (e) => { state.f.sort = e.target.value; renderGrid(root); });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-view]')) details(t.closest('[data-view]').dataset.view);
    else if (t.closest('[data-hire]')) toggleHire(t.closest('[data-hire]').dataset.hire);
    else if (t.closest('[data-retry]')) load(root);
    else if (t.closest('[data-register]')) registerDialog(root);
    else if (t.closest('[data-clear]')) {
      state.f = { q: '', cat: 'All', maxPrice: 100000, sort: 'recommended' };
      $('#search-input', root).value = ''; $('#price-range', root).value = 100000; $('#price-out', root).textContent = '0.100'; $('#sort-select', root).value = 'recommended';
      $$('#cat-filter button', root).forEach((x) => x.setAttribute('aria-pressed', x.dataset.cat === 'All'));
      renderGrid(root);
    }
  });
  app.onHired(() => renderGrid(root));
  return { reload: () => load(root) };
}
