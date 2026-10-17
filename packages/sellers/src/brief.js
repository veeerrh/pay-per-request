// Brief: honest inference agent. Metered: 0.002 base plus 0.004 per country, so one country costs 0.006 and two cost 0.010 (the listed ceiling). Code decides the readiness level from the quake data with fixed thresholds.
// A model (Gemini, BRIEF_GEMINI_API_KEY) writes the brief and up to three actions for a planner. It cannot change the level,
// and code drops any text that carries a number the data does not. Without the model Brief answers with its template.
const crypto = require('crypto');
const { quote, numbersGrounded, z } = require('@di06/llm');
const { boot } = require('./common');
const { agentLlm, memoEnrich, clean } = require('./agent-kit');

/** Metered quote in USDC units, from the number of countries in the request. The listed price (10000) is the ceiling. */
const METER = { base: 2000, perCountry: 4000 };
const quoteUnits = (body) => { const n = Array.isArray(body?.countries) ? body.countries.length : 2; return String(METER.base + METER.perCountry * Math.min(Math.max(n, 1), 2)); };

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
const THRESHOLDS = { medium: 'strongest M5 or 3 events', high: 'strongest M6 or 10 events' };

const strongest = (quakes) => quakes.reduce((m, q) => Math.max(m, q.magnitude), 0);

/** The rule-based brief. Always available, and the base that the model's wording replaces. */
function brief(c) {
  const r = readiness(c.quakes);
  const max = strongest(c.quakes);
  return { country: c.name, readiness: r, brief: `${c.quakes.length} event(s) in the window${c.quakes.length ? `, strongest M${max}` : ''}. ${ACTION[r]}` };
}

const BriefOut = z.object({
  briefs: z.array(z.object({
    country: z.string().max(80),
    brief: z.string().max(480),
    actions: z.array(z.string().max(160)).max(3).default([]),
  })).max(2),
});
const BRIEF_SYSTEM = `You are Brief, an inference agent that writes short disaster-readiness briefs for logistics planners.
For each country you receive numbers that code computed from earthquake data and a readiness level that code decided (low, medium or high).
Write "brief": two or three sentences saying what this activity means for readiness at that level. Use only the numbers provided.
Write "actions": up to three short, practical steps that match the level (low is routine, medium is pre-positioning, high is staging).
Never change the level. Do not predict future earthquakes. Do not mention places, damage, casualties or any figure that is not provided.
Return the countries in the same order with the same names.`;

/**
 * The brief-writing logic, shared by Brief and by Relay (the chained agent): code decides the readiness level, a model (if its key is set)
 * writes the wording, and any text with an ungrounded number is dropped. prefix is the env prefix of the model key (BRIEF_ or RELAY_).
 */
function createBriefWriter(prefix, opts = {}) {
  const llm = agentLlm(prefix, opts);
  const enrich = memoEnrich({ log: (m) => console.warn(`${prefix.toLowerCase()}: ${m}`) });

  /** Model wording for each country, or null. Each entry is checked on its own; a bad one falls back to the template. */
  async function write(countries, base) {
    const facts = {
      thresholds: THRESHOLDS,
      countries: countries.map((c, i) => ({ name: c.name, readiness: base[i].readiness, events: c.quakes.length, strongestMagnitude: c.quakes.length ? strongest(c.quakes) : null, magnitudes: c.quakes.map((q) => q.magnitude).slice(0, 20) })),
    };
    const out = await llm.generateJson({ name: 'brief-write', system: BRIEF_SYSTEM, schema: BriefOut, maxOutputTokens: 700, user: `${quote('country data', facts)}
Write the briefs now.` });
    if (out.briefs.length !== countries.length || out.briefs.some((b, i) => b.country !== countries[i].name)) return null;
    const factsText = JSON.stringify(facts);
    const entries = out.briefs.map((b) => {
      const text = clean(b.brief);
      if (!text || !numbersGrounded(text, factsText)) return null;
      const actions = b.actions.map(clean).filter((a) => a && numbersGrounded(a, factsText));
      return { brief: text, actions };
    });
    return entries.some(Boolean) ? entries : null;
  }

  /** countries: [{ name, quakes: [{ magnitude }] }]. Returns the seller response body. */
  async function compose(countries) {
    const base = countries.map(brief);
    const key = crypto.createHash('sha1').update(JSON.stringify(countries.map((c) => [c.name, c.quakes.map((q) => q.magnitude)]))).digest('hex');
    const extra = llm.enabled ? await enrich(key, () => write(countries, base)) : null;
    const briefs = base.map((b, i) => (extra?.[i]
      ? { ...b, brief: extra[i].brief, ...(extra[i].actions.length ? { actions: extra[i].actions } : {}), basis: { events: countries[i].quakes.length, strongest: countries[i].quakes.length ? strongest(countries[i].quakes) : null } }
      : b));
    return { briefs, meta: { notes: extra ? 'model' : 'rules' } };
  }
  return { llm, compose };
}

function createBrief(opts = {}) {
  const writer = createBriefWriter('BRIEF', opts);

  return boot('brief', 4013, {
    method: 'POST', path: '/brief', priceUnits: '10000', priceFn: quoteUnits, handlerTimeoutMs: 40000,
    discovery: { bodyType: 'json', input: { countries: [{ name: 'India' }] }, inputSchema: { properties: { countries: { type: 'array', minItems: 1, maxItems: 2 } }, required: ['countries'] }, output: { example: { briefs: [] } } },
    description: 'Writes a short readiness brief for up to 2 countries from data you already bought. The level comes from fixed rules; a model writes the wording.',
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
    handler: async (req) => writer.compose(req.body.countries),
    outputCheck: (o) => (o.briefs.every((b) => ['low', 'medium', 'high'].includes(b.readiness)) ? null : 'bad readiness'),
  }, opts.requiredBy ?? module);
}

const app = createBrief();
module.exports = { app, createBrief, createBriefWriter, readiness, quoteUnits, METER, ACTION };
