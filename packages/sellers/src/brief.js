// Brief: honest inference seller (0.010 USDC). Deterministic rule-based readiness scorer, no model call (design 10.2).
const { boot } = require('./common');

function readiness(quakes) {
  const max = quakes.reduce((m, q) => Math.max(m, q.magnitude), 0);
  if (max >= 6 || quakes.length >= 10) return 'high';
  if (max >= 5 || quakes.length >= 3) return 'medium';
  return 'low';
}
const ACTION = {
  low: 'No unusual activity. Keep standard supply levels.',
  medium: 'Moderate activity. Pre-position medical and shelter stock near the affected region.',
  high: 'Strong or frequent activity. Stage supplies and response teams before morning.',
};

function brief(c) {
  const r = readiness(c.quakes);
  const max = c.quakes.reduce((m, q) => Math.max(m, q.magnitude), 0);
  return { country: c.name, readiness: r, brief: `${c.quakes.length} event(s) in the window${c.quakes.length ? `, strongest M${max}` : ''}. ${ACTION[r]}` };
}

function createBrief(opts = {}) {
  return boot('brief', 4013, {
    method: 'POST', path: '/brief', priceUnits: '10000',
    description: 'Writes a short readiness brief for up to 2 countries from data you already bought.',
    inputCheck: (req) => {
      const list = req.body?.countries;
      if (!Array.isArray(list) || list.length < 1) return 'countries must be a non-empty array';
      if (list.length > 2) return 'at most 2 countries per call';
      for (const c of list) {
        if (typeof c?.name !== 'string' || !c.name || c.name.length > 80) return 'each country needs a name';
        if (!Array.isArray(c.quakes) || c.quakes.length > 50) return 'each country needs a quakes array (max 50)';
        if (!c.quakes.every((q) => typeof q.magnitude === 'number' && q.magnitude >= 0 && q.magnitude <= 10)) return 'quake magnitude must be between 0 and 10';
      }
      return null;
    },
    handler: async (req) => ({ briefs: req.body.countries.map(brief) }),
    outputCheck: (o) => (o.briefs.every((b) => ['low', 'medium', 'high'].includes(b.readiness)) ? null : 'bad readiness'),
  }, opts.requiredBy ?? module);
}

const app = createBrief();
module.exports = { app, createBrief, readiness };
