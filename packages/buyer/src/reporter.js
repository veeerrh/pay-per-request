// Beacon's reporter: a templated receipt of what was bought, from whom, why and at what cost (P-03).
// Text here comes from typed fields only; any model prose is added by Beacon's summary, not by this receipt.
const fmt = (u) => (BigInt(u) / 1000000n).toString() + '.' + (BigInt(u) % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(3, '0');

const SOURCES = {
  scraping: 'Public scraping sandbox country list (robots.txt checked)',
  data: 'Public USGS earthquake catalog',
  inference: 'Readiness brief: level from fixed rules, wording from a model and checked against the data',
};
const ORDER = { low: 1, medium: 2, high: 3 };

function buildResult({ params, countries, quakeByCountry, briefs, attempts, entries, complete, notice }) {
  const byReq = new Map(entries.map((e) => [e.id, e]));
  const breakdown = attempts.map((a) => {
    const e = byReq.get(a.result.requestId) || {};
    return {
      callNo: e.callNo ?? null, sellerId: a.sellerId, seller: a.sellerName, category: e.category ?? null, why: a.why,
      listed: e.listed ?? '0', paid: String(a.result.paid), outcome: a.result.status, ruleId: a.result.ruleId, reason: a.result.reason,
    };
  });
  const accepted = attempts.filter((a) => a.result.status === 'paid');
  const contributors = [...new Map(accepted.map((a) => [a.sellerId, { id: a.sellerId, name: a.sellerName, category: byReq.get(a.result.requestId)?.category ?? null }])).values()];
  const cats = new Set(contributors.map((c) => c.category));

  const levels = briefs.map((b) => b.readiness);
  const level = levels.length && complete ? levels.reduce((m, l) => (ORDER[l] > ORDER[m] ? l : m), 'low') : 'incomplete';
  const evidence = [];
  if (countries.length) evidence.push(`Countries analysed (${params.by === 'area' ? 'largest by area' : 'most populous'}): ${countries.join(', ')}.`);
  for (const c of countries) {
    const q = quakeByCountry.get(c);
    if (q) evidence.push(`${c}: ${q.quakes.length} earthquake(s) of magnitude ${params.minMag} or more in the last ${params.days} days${q.quakes.length ? `, strongest M${Math.max(...q.quakes.map((x) => x.magnitude))}` : ''}.`);
  }
  for (const b of briefs) evidence.push(`${b.country}: readiness ${b.readiness}. ${b.brief}`);

  const title = complete ? `Readiness: ${level} overall` : 'Partial result. The readiness brief is incomplete.';
  const summary = complete
    ? briefs.map((b) => `${b.country} ${b.readiness}`).join(', ') + '.'
    : notice || 'Not every step could be completed within the budget and the eligible sellers.';
  return {
    complete, assessment: { level, title, summary },
    evidence, sources: [...cats].filter(Boolean).map((c) => SOURCES[c]),
    uncertainty: 'Earthquake data comes from a public catalog and country regions are approximated by a centre point and radius. Readiness levels are a simple rule on event count and strongest magnitude. This is decision support, not a forecast, and needs expert review before action.',
    contributors, breakdown,
    rawOutputs: [],
  };
}

/** Plain-text receipt for the CLI and the final report. */
function formatReceipt(breakdown, totals) {
  const rows = breakdown.map((b) => `#${String(b.callNo ?? '?').padEnd(3)} ${b.seller.padEnd(10)} ${b.category ? b.category.padEnd(9) : ''.padEnd(9)} ${b.outcome.padEnd(9)} listed ${fmt(b.listed).padStart(6)}  paid ${fmt(b.paid).padStart(6)}  ${b.ruleId.padEnd(6)} ${b.reason.slice(0, 80)}`);
  return [...rows, '', `spent ${fmt(totals.spent)} of ${fmt(totals.budget)} USDC (testnet), ${fmt(totals.remaining)} remaining`].join('\n');
}

module.exports = { buildResult, formatReceipt, fmt };
