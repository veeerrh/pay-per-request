// Shared helpers for the model-backed seller agents (Atlas, Tremor, Brief).
// Rule: a seller's model only adds words. Code owns the data and the decision, and a model failure never blocks a sale.
const path = require('path');
const { createLlm, createLlmFromEnv } = require('@di06/llm');

const DATA = path.join(__dirname, '..', '..', '..', 'data');

/**
 * The model client for one agent. Reads only that agent's own key (ATLAS_GEMINI_API_KEY and so on).
 * Tests pass requiredBy: null and get a disabled client unless they inject one.
 */
function agentLlm(agent, opts = {}) {
  if (opts.llm) return opts.llm;
  if (opts.requiredBy === null) return createLlm({});
  // A paid request must not wait for the minute window: after 3 s without budget the agent answers without the model.
  return createLlmFromEnv(process.env, { timeoutMs: 12000, maxWaitMs: 3000, usageFile: path.join(DATA, `llm-usage-${String(agent).toLowerCase()}.json`) }, agent);
}

/**
 * Runs fn at most once per key per ttl. Callers asking for the same key at the same time share one run.
 * Gives up after hardMs and returns null, so a slow model can never hold a paid request past the payment window.
 * Any error also returns null: "answer without the model's words".
 */
function memoEnrich({ ttlMs = 10 * 60_000, hardMs = 18_000, now = () => Date.now(), log = () => {} } = {}) {
  const cache = new Map();
  const inflight = new Map();
  return async function enrich(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.v;
    if (!inflight.has(key)) {
      const timer = { id: null };
      const timeout = new Promise((resolve) => { timer.id = setTimeout(() => resolve(null), hardMs); timer.id.unref?.(); });
      inflight.set(key, Promise.race([Promise.resolve().then(fn).catch((e) => { log(`model notes unavailable (${e.name || 'error'})`); return null; }), timeout])
        .then((v) => { if (v) cache.set(key, { at: now(), v }); return v; })
        .finally(() => { clearTimeout(timer.id); inflight.delete(key); }));
    }
    return inflight.get(key);
  };
}

const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

module.exports = { agentLlm, memoEnrich, clean };
