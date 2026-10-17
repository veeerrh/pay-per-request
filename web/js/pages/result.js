// Result panel: Final Result, Service Breakdown, Raw Outputs (Appendix B result shape).
import { esc, icon, formatUsdc, statusBadge, codePanel, CAT_ICON, wireTabs, bulletsHtml, $, $$ } from '../ui.js';

export function mountResult(card, getTask) {
  let tab = 'final';
  const render = () => {
    const t = getTask();
    const has = !!(t && t.result);
    card.hidden = !has;
    if (!has) return has;
    const r = t.result;
    $('[data-result-badge]', card).innerHTML = r.complete ? `<span class="badge badge-green">${icon('checkcircle')}Completed</span>` : `<span class="badge badge-amber">${icon('alert')}Partial</span>`;
    $$('[role="tab"]', card).forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; if (on) $('[role="tabpanel"]', card).setAttribute('aria-labelledby', b.id); });
    const panel = $('[role="tabpanel"]', card);
    if (tab === 'final') {
      const a = r.assessment || {};
      const rep = r.beaconSummary?.text ? `<div class="result-section beacon-report"><div class="eyebrow">Summary${r.beaconSummary.source === 'model' ? ' · AI-written' : ' · rule-based'}</div>${bulletsHtml(r.beaconSummary.text)}</div>` : '';
      panel.innerHTML = `${rep}
        <div class="result-hero l-${esc(a.level)}">${icon(a.level === 'low' ? 'checkcircle' : 'alert')}<div><div class="eyebrow">Overall assessment</div><h3>${esc(a.title)}</h3><p class="muted">${esc(a.summary)}</p></div></div>
        <div class="result-section"><h3>Key evidence</h3>${r.evidence?.length ? `<ul class="bullets">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="muted">No validated evidence was collected.</p>'}</div>
        <div class="result-section"><h3>Sources used</h3>${r.sources?.length ? `<ul class="bullets">${r.sources.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</div>
        <div class="result-section"><h3>Important uncertainty</h3><p class="note">${icon('alert', 'icon-sm')} ${esc(r.uncertainty)}</p></div>
        <div class="result-section"><h3>Agents that contributed</h3><div class="chips">${(r.contributors || []).map((c) => `<span class="badge">${icon(CAT_ICON[c.category] || 'cpu')}${esc(c.name)}</span>`).join('') || '<span class="muted">None.</span>'}</div></div>`;
    } else if (tab === 'breakdown') {
      panel.innerHTML = `<div class="table-scroll"><table class="table-plain"><thead><tr><th scope="col">#</th><th scope="col">Agent</th><th scope="col">Why it was selected</th><th scope="col">Listed</th><th scope="col">Paid</th><th scope="col">Outcome</th></tr></thead><tbody>${(r.breakdown || []).map((b) => `<tr><td>${esc(b.callNo)}</td><td><strong>${esc(b.seller)}</strong><br><span class="muted">${esc(b.category)}</span></td><td>${esc(b.why)}</td><td>${formatUsdc(b.listed)}</td><td>${formatUsdc(b.paid)}</td><td>${statusBadge(b.outcome)}<div class="reason">${esc(b.ruleId)}: ${esc(b.reason)}</div></td></tr>`).join('')}</tbody></table></div><p class="muted mt">Amounts are test USDC on Base Sepolia.</p>`;
    } else {
      panel.innerHTML = `<p class="muted mb">Structured outputs as returned by each paid call. Rejected output is kept for inspection and was <strong>not used</strong>.</p>${codePanel({ task: t.id, calls: t.outputs })}`;
    }
    return has;
  };
  wireTabs($('[role="tablist"]', card), (k) => { tab = k; render(); });
  return { render, reset() { tab = 'final'; } };
}

export const resultCardHtml = `
  <div class="card-head row-between"><h2 id="result-h">Task result</h2><span data-result-badge></span></div>
  <div class="tabs" role="tablist" aria-label="Result views">
    <button role="tab" type="button" id="rt-final" aria-controls="result-panel" aria-selected="true" data-tab="final">Final Result</button>
    <button role="tab" type="button" id="rt-breakdown" aria-controls="result-panel" aria-selected="false" tabindex="-1" data-tab="breakdown">Service Breakdown</button>
    <button role="tab" type="button" id="rt-raw" aria-controls="result-panel" aria-selected="false" tabindex="-1" data-tab="raw">Raw Outputs</button>
  </div>
  <div id="result-panel" role="tabpanel" tabindex="0" aria-labelledby="rt-final"></div>`;
