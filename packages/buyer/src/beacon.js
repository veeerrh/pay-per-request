// Beacon, the buying agent. Four jobs: understand the task (plan), pick which sub-agent to hire (choose),
// explain what happened (summarize) and answer questions in the chat (answer).
//
// A model may write words and propose a pick. It never signs, never approves a payment and never adds a seller:
//  - plan: the numbers it proposes pass the same bounds as the rules (validateParams)
//  - choose: the pick must be one of the candidates the safety rules already approved, else the top ranked one is used
//  - summarize and answer: built from recorded facts; a number in the prose that is not in the facts replaces the prose
// This module must not import the signer or the guard (M-37). Without a model every job has a rule-based path.
const { z, quote, numbersGrounded, LlmUnavailable, LlmInvalid, LlmBudget } = require('@di06/llm');
const { parseTask, validateParams, PlanError } = require('./planner');
const { fmt } = require('./reporter');

const ROLE = 'You are Beacon, a buying agent in a marketplace where AI agents hire other AI agents and pay per request in test USDC on a test network. '
  + 'You cannot spend money, sign anything or start a purchase yourself: code does that after its own safety checks. '
  + 'Never invent facts, prices, addresses or results. Use plain, calm language.';

const PlanOut = z.object({
  supported: z.boolean(),
  reason: z.string().max(240).default(''),
  n: z.number().default(3),
  by: z.string().default('population'),
  minMag: z.number().default(4.5),
  days: z.number().default(7),
  understanding: z.string().max(300).default(''),
});
const ChooseOut = z.object({ id: z.string().max(60), reason: z.string().max(400) });

const PLAN_SYSTEM = `${ROLE}
Your job now: read the user's task and extract parameters for one supported job type: an earthquake readiness report for the N largest countries.
Parameters: n (how many countries, default 3), by ("population" for most populous, "area" for largest by area; default "population"), minMag (minimum earthquake magnitude, default 4.5), days (look-back window in days, default 7).
If the task is not about earthquake readiness for countries, set supported to false and say in "reason" what you can do instead, in one sentence.
Copy numbers the user wrote exactly, even if they look too large; code checks the limits. "understanding" is one plain sentence restating the task.`;

const CHOOSE_SYSTEM = `${ROLE}
Your job now: choose which seller to hire for one step of a task. Every candidate has already passed the safety rules and fits the budget.
Prefer, in this order: proven sellers, then a higher score, then a lower price, then lower latency. Pick another candidate only if the facts give a clear reason.
Return the chosen "id" exactly as given and a "reason" of at most two short sentences that uses only the facts provided.`;

const SUMMARY_SYSTEM = `${ROLE}
Your job now: write a brief final report as at most 5 bullet points (never more), each on its own line starting with "- " and at most 16 words, no heading and no intro. Merge related facts into one bullet (for example one bullet for all hired agents). Give money in USDC only, never in raw units. Cover: what was asked, which agents you hired and why, what they returned, what it cost against the budget, and anything that went wrong or is uncertain.
Use only the facts provided. Do not add numbers that are not in the facts.
Briefly mention what the hired agents added in their own words (agentNotes), attributing each to its agent.
Write plain text only: no markdown, no asterisks, no headings. Short paragraphs or lines starting with a dash are fine.`;

const LAB_SYSTEM = `${ROLE}
Your job now: write the closing incident report of a security exercise (the Fraud Lab) in at most 170 words.
Say what each suspect agent tried, how the system stopped it or limited the damage, what it cost, and what the system cannot do.
Use only the facts provided and write every number as digits exactly as given (for example 0.013 USDC, never in words). Cover every suspect, the replay result and the ledger and reconciliation check. Do not add numbers that are not in the facts. Be honest: a payment that already settled on chain cannot be recovered; the system only caps and flags it.
Plain text only: no markdown, no asterisks, no headings.`;

const ANSWER_SYSTEM = `${ROLE}
Your job now: answer the user's question about the current task using only the facts provided. If the facts do not contain the answer, say you do not know.
If the user asks you to buy, pay or change something, explain that a new purchase starts only when they submit a task. Keep answers under 120 words. Plain text only: no markdown or asterisks.`;

/** Typed, safe facts about a candidate. Seller-written text (descriptions, labels) is deliberately absent (M-12). */
/** Why a model step fell back to rules: our own request budget is full, or the model could not answer. */
const why = (e) => (e instanceof LlmBudget ? 'budget' : 'unavailable');

const candidateFacts = (c) => ({
  id: c.id, name: c.name, rank: c.rank, price: fmt(c.price), proven: !!c.rep?.proven,
  score: Number((c.rep?.score ?? 0.5).toFixed(2)), attempts: c.rep?.attempts ?? 0, medianLatencyMs: c.rep?.medianLatencyMs ?? null,
});

function createBeacon({ llm, log } = {}) {
  const useModel = !!llm?.enabled;
  const warn = (msg, e) => log?.('warn', msg, { error: e?.message });

  /** Task text to validated parameters. { params, understanding, source } or throws PlanError. */
  async function plan(text) {
    if (typeof text !== 'string' || text.trim().length < 10) throw new PlanError('Describe the task in a sentence (at least 10 characters).');
    if (text.length > 1000) throw new PlanError('Task text is longer than 1000 characters.');
    const fallback = () => {
      const params = parseTask(text);
      return { params, understanding: `${params.n} ${params.by === 'area' ? 'largest' : 'most populous'} countries, earthquakes of magnitude ${params.minMag}+ in the last ${params.days} days`, source: 'rules' };
    };
    if (!useModel) return fallback();
    try {
      const out = await llm.generateJson({ name: 'plan', system: PLAN_SYSTEM, user: quote('user task', text), schema: PlanOut, maxOutputTokens: 300 });
      if (!out.supported) throw new PlanError(out.reason || 'I can only plan earthquake readiness reports for the largest countries.');
      const params = validateParams({ n: out.n, by: out.by, minMag: out.minMag, days: out.days });
      return { params, understanding: out.understanding || `${params.n} countries, magnitude ${params.minMag}+, last ${params.days} days`, source: 'model' };
    } catch (e) {
      if (e instanceof PlanError) throw e;
      if (!(e instanceof LlmUnavailable || e instanceof LlmInvalid)) throw e;
      warn('plan: model unavailable, using rules', e);
      return { ...fallback(), fallback: why(e) };
    }
  }

  /**
   * candidates: eligible candidates in rank order (from the selector). Returns { id, reason, source }.
   * The id is always one of the candidates.
   */
  async function choose({ category, label, candidates, taskText }) {
    const top = candidates[0];
    const templated = (c) => (c.why ? `${c.why}.` : `${c.name} is ranked #${c.rank} of ${candidates.length}: ${c.rep?.proven ? 'proven' : 'unproven'}, score ${(c.rep?.score ?? 0.5).toFixed(2)}, ${fmt(c.price)} USDC.`);
    if (candidates.length === 1) return { id: top.id, reason: `${top.name} is the only eligible ${category} agent right now.`, source: 'rules' };
    if (!useModel) return { id: top.id, reason: templated(top), source: 'rules' };
    const facts = candidates.map(candidateFacts);
    try {
      const out = await llm.generateJson({
        name: 'choose', system: CHOOSE_SYSTEM, maxOutputTokens: 250, schema: ChooseOut,
        user: `Step: ${category} (${label}).\n${quote('task', taskText)}\n${quote('candidates', facts)}`,
      });
      const picked = candidates.find((c) => c.id === out.id);
      if (!picked) { warn('choose: model picked an id outside the candidate set, using top ranked'); return { id: top.id, reason: templated(top), source: 'rules' }; }
      const grounded = numbersGrounded(out.reason, JSON.stringify(facts));
      return { id: picked.id, reason: grounded ? `${out.reason.trim()} (${templated(picked)})` : templated(picked), source: grounded ? 'model' : 'rules' };
    } catch (e) {
      if (!(e instanceof LlmUnavailable || e instanceof LlmInvalid)) throw e;
      warn('choose: model unavailable, using top ranked', e);
      return { id: top.id, reason: templated(top), source: 'rules', fallback: why(e) };
    }
  }

  /** Deterministic report from facts. Used without a model and when the model's prose cannot be trusted. */
  function templatedSummary(f) {
    const lines = [];
    lines.push(`- Task: ${f.task}`);
    if (f.choices.length) lines.push(`- Hired: ${f.choices.map((c) => `${c.seller} (${c.category})`).join(', ')}.`);
    for (const c of f.choices.slice(0, 3)) lines.push(`- Why ${c.seller}: ${c.reason}`);
    const paid = f.purchases.filter((p) => p.paid !== '0');
    lines.push(`- Cost: ${fmt(f.spent)} of ${fmt(f.budget)} USDC across ${paid.length} paid call${paid.length === 1 ? '' : 's'}.`);
    const bad = f.purchases.filter((p) => !['paid'].includes(p.status));
    if (bad.length) lines.push(`- Problems: ${bad.map((p) => `${p.seller} ${p.status}${p.reason ? ` (${p.reason})` : ''}`).join('; ')}.`);
    if (f.findings.length) lines.push(`- Result: ${f.findings.slice(0, 3).join(' ')}`);
    if (f.agentNotes?.length) lines.push(`- What the agents added: ${f.agentNotes.slice(0, 3).map((n) => `${n.agent} - ${n.text}`).join(' | ')}`);
    lines.push(f.status === 'completed' ? '- The task completed.' : `- The task ended as ${f.status}.${f.notice ? ` ${f.notice}` : ''}`);
    return lines.join('\n');
  }

  async function summarize(f) {
    const fallback = { text: templatedSummary(f), source: 'rules' };
    if (!useModel) return fallback;
    try {
      const text = await llm.generateText({ name: 'summary', system: SUMMARY_SYSTEM, user: quote('facts', f), maxOutputTokens: 450 });
      if (!numbersGrounded(text, JSON.stringify(f))) { warn('summary: ungrounded numbers, using the template'); return fallback; }
      return { text, source: 'model' };
    } catch (e) {
      if (!(e instanceof LlmUnavailable || e instanceof LlmInvalid)) throw e;
      warn('summary: model unavailable, using the template', e);
      return { ...fallback, fallback: why(e) };
    }
  }

  /** The closing report of a Fraud Lab run. Template without a model; the model's version is used only when its numbers are grounded. */
  function templatedLabReport(f) {
    const s = f.scoreboard;
    const lines = [`Fraud Lab report. I tried ${s.suspectsTried} suspect agents (${s.attacks} attacks) one at a time through the real payment path.`];
    const blockedNames = f.steps.filter((x) => x.outcome === 'blocked' && x.suspect !== 'Replay').map((x) => `${x.suspect}${x.ruleId ? ` (${x.ruleId})` : ''}`);
    if (blockedNames.length) lines.push(`Refused before I signed anything: ${blockedNames.join('; ')}. Nothing was paid. A buyer with no checks would have signed requests with a face value of ${f.exposureUsdc} USDC.`);
    if (s.failedNotCharged) lines.push(`Failed without charging me: ${s.failedNotCharged}. The reserved budget was released.`);
    if (s.paidThenRejected) lines.push(`Took a payment and returned junk: ${s.paidThenRejected}. I paid ${s.junkPaidUsdc} USDC, discarded the answer, flagged the seller and excluded it. That loss is capped at one call and cannot be recovered.`);
    if (s.controlPaid) lines.push(`Control: the honest agent was paid and validated, so legitimate buying still works.`);
    if (f.replay) lines.push(`Replay: ${f.replay.blocked ? 'blocked' : 'NEEDS ATTENTION'}. ${f.replay.winners} of the five simultaneous requests got through, and there were ${f.replay.transfers ?? 'an unverified number of'} transfers on chain for 2 signed payments.`);
    lines.push(`Spent on purchases: ${s.spentUsdc} USDC. Ledger chain verified: ${f.verification.chainOk ? 'yes' : 'NO'}. Reconciliation: ${f.verification.reconcile.status}${f.verification.reconcile.ledgerTotalUsdc ? ` (ledger ${f.verification.reconcile.ledgerTotalUsdc} USDC, chain ${f.verification.reconcile.chainTotalUsdc} USDC)` : ''}.`);
    lines.push('Not covered: a stolen private key, a compromised facilitator, and wrong but plausible content.');
    return lines.join('\n');
  }

  async function labReport(f) {
    const fallback = { text: templatedLabReport(f), source: 'rules' };
    if (!useModel) return fallback;
    try {
      const text = await llm.generateText({ name: 'lab-report', system: LAB_SYSTEM, user: quote('lab facts', f), maxOutputTokens: 450 });
      if (!numbersGrounded(text, JSON.stringify(f)) || !text.includes(f.scoreboard.spentUsdc)) { warn('lab report: ungrounded or incomplete, using the template'); return fallback; }
      return { text, source: 'model' };
    } catch (e) {
      if (!(e instanceof LlmUnavailable || e instanceof LlmInvalid)) throw e;
      warn('lab report: model unavailable, using the template', e);
      return { ...fallback, fallback: why(e) };
    }
  }

  /** Rule-based answers: enough to be useful with no model. */
  function ruleAnswer(question, f) {
    const q = question.toLowerCase();
    if (!f) return 'There is no task yet. Submit one and I will explain every step as it happens.';
    const money = `${fmt(f.spent)} of ${fmt(f.budget)} USDC`;
    if (/\b(previous|earlier|before|last task|first task|other task)\b/.test(q)) {
      return f.earlierTasks?.length ? f.earlierTasks.map((x) => `${x.id}: "${x.task}" ended as ${x.status}, spent ${x.spentUsdc} of ${x.budgetUsdc} USDC.`).join('\n') : 'There is no earlier task in this session.';
    }
    if (/\b(why|reason|chose|choose|chosen|select|picked?|hire[d]?)\b/.test(q)) {
      return f.choices.length ? f.choices.map((c) => `${c.seller} for ${c.category}: ${c.reason}`).join('\n') : 'I have not chosen any agent yet.';
    }
    if (/\b(cost|spent|spend|paid|pay|price|budget|money|usdc|left|remaining)\b/.test(q)) {
      const rows = f.purchases.filter((p) => p.paid !== '0').map((p) => `${p.seller}: ${fmt(p.paid)} USDC (${p.status})`);
      return `Spent ${money}.${rows.length ? `\n${rows.join('\n')}` : ' Nothing has been paid yet.'}`;
    }
    if (/\b(fraud|refus|reject|fail|problem|error|wrong|attack|lie|junk)\b/.test(q)) {
      const bad = f.purchases.filter((p) => p.status !== 'paid');
      return bad.length ? bad.map((p) => `${p.seller}: ${p.status}${p.ruleId && p.ruleId !== 'none' ? ` (rule ${p.ruleId})` : ''}${p.reason ? `. ${p.reason}` : ''}`).join('\n') : 'Nothing has gone wrong so far.';
    }
    if (/\b(notes?|digest|said|says?|actions?|recommend\w*|commentary|what did (atlas|tremor|brief))\b/.test(q)) {
      return f.agentNotes?.length ? f.agentNotes.map((n) => `${n.agent}: ${n.text}`).join('\n') : 'The agents have not added any notes yet.';
    }
    if (/\b(result|output|found|find|finding|findings|return|returned|got|quake|earthquake|brief|readiness|answer|data|countries|country)\b/.test(q)) {
      return f.findings.length ? f.findings.join('\n') : 'No results are available yet.';
    }
    return `Task "${f.task}" is ${f.status}${f.stage ? ` (stage: ${f.stage})` : ''}. Spent ${money} on ${f.purchases.filter((p) => p.paid !== '0').length} paid call(s). `
      + 'You can ask why I picked an agent, what it cost, what came back, or what went wrong.';
  }

  /** question: string; facts: the task facts or null; history: [{ role, text }]. Returns { text, source }. */
  async function answer({ question, facts, history = [] }) {
    const fallback = { text: ruleAnswer(question, facts), source: 'rules' };
    if (!useModel || !facts) return fallback;
    try {
      const text = await llm.generateText({
        name: 'answer', system: ANSWER_SYSTEM, maxOutputTokens: 350,
        user: `${quote('facts', facts)}\n${quote('recent chat', history.slice(-6))}\n${quote('user question', question)}`,
      });
      if (!numbersGrounded(text, JSON.stringify(facts) + question)) { warn('answer: ungrounded numbers, using rules'); return fallback; }
      return { text, source: 'model' };
    } catch (e) {
      if (!(e instanceof LlmUnavailable || e instanceof LlmInvalid)) throw e;
      warn('answer: model unavailable, using rules', e);
      return { ...fallback, fallback: why(e) };
    }
  }

  return { plan, choose, summarize, answer, labReport, templatedLabReport, templatedSummary, ruleAnswer, usesModel: useModel, usage: () => (useModel && llm.usage ? llm.usage() : null) };
}

/**
 * Facts about a task for the summary and the chat, from what the task recorded (ledger rows, choices, result).
 * Amounts appear both as units and as USDC text so a model can copy them instead of converting.
 */
function factsFromTask(t, earlier = []) {
  if (!t) return null;
  const clip = (s, n) => String(s ?? '').slice(0, n);
  return {
    earlierTasks: earlier.slice(-3).map((x) => ({ id: x.id, task: clip(x.text, 120), status: x.status, budgetUsdc: fmt(x.budget), spentUsdc: fmt(x.spent) })),
    task: clip(t.text, 300), status: t.status, stage: t.stage || null, notice: clip(t.notice, 300),
    budget: String(t.budget), budgetUsdc: fmt(t.budget), spent: String(t.spent), spentUsdc: fmt(t.spent),
    remainingUsdc: fmt(BigInt(t.budget) - BigInt(t.spent)), paidCalls: t.paidCalls,
    params: t.params || null,
    choices: (t.choices || []).map((c) => ({ category: c.category, seller: c.name, reason: clip(c.reason, 400) })),
    purchases: (t.ledger || []).map((e) => ({
      callNo: e.callNo ?? null, seller: clip(e.seller || e.sellerId, 40), category: e.category ?? null, listed: String(e.listed ?? '0'), paid: String(e.paid ?? '0'),
      paidUsdc: fmt(e.paid ?? '0'), status: e.status, ruleId: e.ruleId ?? null, reason: clip(e.reason, 200),
    })),
    findings: (t.result?.evidence || []).slice(0, 12).map((s) => clip(s, 300)),
    agentNotes: (t.agentNotes || []).slice(0, 20).map((n) => ({ agent: clip(n.agent, 40), category: n.category, text: clip(n.text, 300) })),
  };
}

/** Facts about a Fraud Lab run for the closing report. Amounts appear as USDC text so a model can copy them. */
function factsFromLab({ results, totals, verification, replay, cfg }) {
  const clip = (s, n) => String(s ?? '').slice(0, n);
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const sum = (rows, k) => rows.reduce((a, r) => a + BigInt(r[k] || 0), 0n);
  const attacks = results.filter((r) => r.id !== 'control');
  const blocked = attacks.filter((r) => r.outcome === 'blocked' && r.id !== 'replay');
  const rejected = results.filter((r) => r.outcome === 'rejected');
  const rec = verification?.reconcile ?? { status: 'unverified' };
  return {
    steps: results.map((r) => ({ suspect: clip(r.suspect, 60), outcome: r.outcome, ruleId: r.ruleId ?? null, reason: clip(r.reason, 160), paidUsdc: fmt(r.paid || 0), wouldHavePaidUsdc: r.wouldHavePaid ? fmt(r.wouldHavePaid) : null })),
    scoreboard: {
      suspectsTried: new Set(results.map((r) => r.id)).size - (results.some((r) => r.id === 'control') ? 1 : 0),
      attacks: attacks.length,
      blockedBeforeSigning: blocked.length,
      paidThenRejected: rejected.length,
      failedNotCharged: count('failed'),
      controlPaid: results.some((r) => r.id === 'control' && r.outcome === 'paid'),
      junkPaidUsdc: fmt(sum(rejected, 'paid')),
      spentUsdc: fmt(totals.spent),
      probationCapUsdc: fmt(cfg?.probationSpendCap ?? 0),
    },
    exposureUsdc: fmt(sum(blocked, 'wouldHavePaid')),
    replay: replay ? { blocked: !!replay.pass, winners: replay.winners, transfers: replay.transfers ?? null, usedBeaconWallet: !!replay.usedBeaconWallet } : null,
    verification: {
      chainOk: !!verification?.chainOk,
      reconcile: { status: rec.status, ledgerTotalUsdc: rec.ledgerTotal !== undefined ? fmt(rec.ledgerTotal) : null, chainTotalUsdc: rec.chainTotal !== undefined ? fmt(rec.chainTotal) : null },
    },
  };
}

module.exports = { createBeacon, factsFromTask, factsFromLab };
