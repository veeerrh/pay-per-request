// Beacon's planner. Rule based (design D-18). It proposes a plan; plain code decides whether money moves.
// This module must never import the signer (M-37): it only parses text and builds a typed plan.
class PlanError extends Error {
  constructor(message) { super(message); this.name = 'PlanError'; }
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

/** Pulls the numbers out of the task text and validates them. Defaults: 3 countries, population, M4.5, 7 days. */
function parseTask(text) {
  if (typeof text !== 'string' || text.trim().length < 10) throw new PlanError('Describe the task in a sentence (at least 10 characters).');
  if (text.length > 1000) throw new PlanError('Task text is longer than 1000 characters.');
  const t = text.toLowerCase();
  const nMatch = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:most\s+populous|largest|biggest|top)\b/) || t.match(/\btop\s+(\d+|one|two|three|four|five)\b/);
  const n = nMatch ? num(nMatch[1]) : 3;
  const by = /\bby area\b|\blargest\b|\bbiggest\b/.test(t) && !/\bmost populous\b/.test(t) ? 'area' : 'population';
  const mag = t.match(/magnitude\s+(?:of\s+)?(\d+(?:\.\d+)?)/);
  const days = t.match(/(?:last|past)\s+(\d+)\s+days?/);
  const p = { n, by, minMag: mag ? Number(mag[1]) : 4.5, days: days ? Number(days[1]) : 7 };
  if (!Number.isInteger(p.n) || p.n < 1 || p.n > 5) throw new PlanError('The number of countries must be between 1 and 5.');
  if (!Number.isInteger(p.days) || p.days < 1 || p.days > 30) throw new PlanError('The time window must be between 1 and 30 days.');
  if (!Number.isFinite(p.minMag) || p.minMag < 0 || p.minMag > 9) throw new PlanError('The minimum magnitude must be between 0 and 9.');
  return p;
}

/** scrape -> data (one call per country) -> inference (batches of at most 2 countries, S-45). */
function buildPlan(p) {
  return {
    params: p,
    steps: [
      { id: 'scrape', category: 'scraping', calls: 1, label: `Find the ${p.n} ${p.by === 'area' ? 'largest' : 'most populous'} countries` },
      { id: 'quakes', category: 'data', calls: p.n, label: `Fetch M${p.minMag}+ earthquakes for the last ${p.days} days, one call per country` },
      { id: 'briefs', category: 'inference', calls: Math.ceil(p.n / 2), label: 'Write a readiness brief per country (2 countries per call)' },
    ],
  };
}

/** Cheapest possible cost using listed prices. An optimistic lower bound; the runtime cap enforces the rest (M-20). */
function estimateMin(plan, listings) {
  const cheapest = (cat) => listings.filter((l) => l.category === cat).reduce((m, l) => (m === null || l.price < m ? l.price : m), null);
  let total = 0n;
  for (const s of plan.steps) {
    const c = cheapest(s.category);
    if (c === null) return null;
    total += c * BigInt(s.calls);
  }
  return total;
}

module.exports = { parseTask, buildPlan, estimateMin, PlanError };
