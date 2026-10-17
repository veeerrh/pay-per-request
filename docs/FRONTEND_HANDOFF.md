# Frontend handoff: what changed in the backend and what the UI needs

Short version: the agents now use Gemini, Beacon has a chat, the fraud demo is separate, and the live view needs a polling fallback. Everything is testnet (Base Sepolia). **No network selector anywhere.** Amounts are units with 6 decimals (`5000` = 0.005 USDC).

## 1. What changed in the backend

| Area | Change |
| --- | --- |
| **Beacon (buyer)** | Now an LLM agent. It reads the task text, picks one seller per step, narrates everything in a chat feed, writes a final summary and answers questions. Shown to users as "Scout" today; rename if you like. |
| **Atlas** | Scrapes the country list in code, then Gemini adds a short `note` per country and a `summary`. |
| **Tremor** | Gets USGS quakes in code, then Gemini adds a one-sentence `digest`. Also returns `stats`. |
| **Brief** | Readiness level (`low/medium/high`) is still set by code. Gemini writes the `brief` text and up to 3 `actions`. |
| **Safety rule** | A model writes words and proposes picks. Code decides the data, the level and every payment. Numbers in model text are checked against the data. If Gemini is down or out of quota, every agent still answers rule-based. |
| **Quota** | Each agent has its own Gemini key and a request budget. Usage is shown in `GET /api/config` under `llm.usage`. |
| **Fraud agents** | Overquote, Redirect, Hollow, Offline stay scripted (no LLM). They belong in a separate **Fraud Lab** tab, not in the live earthquake demo. |
| **Polling** | `GET /api/tasks/:id/poll?after=N` is new, because the free Cloudflare tunnel may not pass SSE. |

## 2. UI changes needed

**Tabs:** `Live Market` (LLM agents, real task) and `Fraud Lab` (scripted attacks through Beacon's guard).

### Live Market
1. **Beacon chat panel** (new, main element).
   - On load and while a task runs, show the feed: `GET /api/tasks/:id/chat` returns `messages[]` with `role` (`beacon` or `user`), `kind`, `text`, `at`.
   - Message kinds to style differently: `plan`, `choice` (why this agent was hired), `select`, `agent` (what a hired agent added in its own words, text starts with "Atlas adds: …"), `paid`, `rejected`, `refused`, `failed`, `pending`, `blocked`, `notice` (Beacon says it is using its rule-based path because Gemini's free budget is full or the model is down; show it as a small info banner, once per task), `summary`, `question`, `answer`.
   - Input box: `POST /api/chat` with `{ message, taskId? }`, up to 500 characters. Without `taskId` the chat follows the running task, else the newest one. Always pass `taskId` when the user has selected an older task. Beacon can also answer questions about the 3 tasks before it ("how did the previous task go?"). Reply is `{ reply, source }`, where `source` is `model` or `rules`. The chat can explain but never buys anything.
   - Suggested chips: "Why did you pick these agents?", "What did it cost?", "What went wrong?", "Show the results".
2. **Task box**: text, budget, concurrency (1/3/5). `POST /api/tasks` (budget is a digit string of units).
3. **Agent cards** for Atlas, Tremor, Brief, each showing: price, reputation score, status, and the **last output** with its model-written part:
   - Atlas: `countries[].note`, `summary`, `meta`
   - Tremor: `stats` (count, strongest, hoursSinceLatest), `digest`
   - Brief: `briefs[].brief`, `briefs[].actions[]`, `basis`
   - Show a small "AI-written" tag when `meta.notes` is `model`, and "rule-based" when it is `none` or `rules`.
4. **"What each agent added"**: `result.agentNotes[]` (`agent`, `category`, `text`) and live `note` events. Show each note under its agent card (Atlas: country notes and summary; Tremor: one digest per country; Brief: actions per country). The same lines appear in the chat as `agent` messages.
5. **"Why this agent" line** on each hired agent: from the `choice` event or `result.choices[]` (`category`, `seller`, `reason`, `source`).
6. **Result card**: use `result.beaconSummary.text` as the headline report, then `result.evidence[]`, then the cost breakdown. Keep the budget meter (spent + reserved never above the cap).
7. **Task history survives a Beacon restart.** `GET /api/tasks` returns the last 30 tasks with their chat (`/api/tasks/:id/chat`). A task that was running at restart comes back as `stopped` with a notice. The event stream and `poll` history are not restored, so load the chat from the chat endpoint, not from replaying events. Direct-URL purchases now also get chat narration and a summary.
8. **Model status badge** in the header: from `GET /api/config` `llm.enabled`. Optional tooltip with `llm.usage` per model (`day/rpd`, `minute/rpm`).
9. **Keep:** wallet, ledger (with Basescan tx links), reputation, hash-chain verify, reconcile, "New session" (operator token).

### Live updates (important)
- Use SSE `GET /api/tasks/:id/events` first. If it fails or stalls for about 10 seconds, switch to polling `GET /api/tasks/:id/poll?after=<lastEventId>` every 2 s. Stop when `status` is not `running`.
- Events have a rising integer `id`. New types: `plan` (`params`, `source`), `choice`, `note`, `chat`. Existing: `stage`, `metrics`, `activity`, `ledger`, `output`, `blocked`, `done` (`done` is last while running).
- Chat Q&A can add events after `done`, so keep polling the chat endpoint, not the events one, for answers.

### Fraud Lab (separate tab)
Beacon tries each scripted suspect one at a time and explains in its chat what went wrong and why it did not hire the agent. It is one run, shown like a task: same chat, events, polling and history.

- `GET /api/lab` returns `agents[]` for the cards: `id, title, suspect, tactic, layer` (Before signing / After paying / Liveness / Seller side / Control), `rules[], expected, cost`, and for Shapeshifter `subs[]` (six one-term lies). Order: Bait-and-Switch (Overquote), Redirector, Shapeshifter, Ghost (Hollow), Vanishing agent (Offline), Control (honest Atlas), Replay attacker.
- `POST /api/lab/run` with optional `{ cases: [ids], budget: "50000" }` returns `{ taskId }`. Then use the normal task routes: `GET /api/tasks/:id/events` (or `/poll`), `/api/tasks/:id/chat`, `GET /api/tasks/:id`. One lab run at a time (409 `lab_running`).
- **Events:** `lab_step` (`key, index, total, agentId, title, suspect, sub, layer, status: running|done`; on `done` also `outcome` = `blocked | failed | rejected | paid | pending | attention`, `ruleId, reason, paidUsdc, wouldHavePaidUsdc, diffs[]` (claim vs reality: `field, listed, actual`), `reputation {before, after}`, `txHash`, and for the replay `lanes[]` = the five parallel requests with `status` and the `layer` that decided it). Also `ledger`, `metrics`, `chat`, then `done` with `result {kind: 'lab', steps[], scoreboard, verification, beaconSummary}`.
- **Chat kinds for the lab:** `plan`, `select` ("Suspect 3 of 12…"), `alert` (what went wrong and how it was stopped, with `severity` = `blocked | warn`), `paid` (control), `notice` (skipped suspects, unfunded replay wallet, model fallback), `info` (proof check) and a closing `incident` report. Show `blocked` alerts in red, `warn` in amber, `ok` in green.
- **Suggested layout:** a vertical timeline of suspects. Each shows the claim-vs-reality diff (highlight the lie), the rule that fired, "signed? paid? tx?", reputation before to after, and "a buyer with no checks would have paid X" (computed, label it). The replay shows five parallel lanes. A scoreboard at the end: `scoreboard` (blockedBeforeSigning, paidThenRejected, failedNotCharged, junkPaidUsdc, spentUsdc) plus `verification` (ledger chain OK, reconcile matched). The Beacon chat sits beside it and streams the same story in words.
- Label clearly: "Scripted agents, no LLM. Every payment goes through the real Beacon guard." The closing report may be model-written; `beaconSummary.source` says `model` or `rules`.
- Honest limits are part of the demo: a paid-then-junk seller is capped and flagged, not refunded. The Ghost's 0.008 USDC is the one real loss in a full run.
- The older single-case endpoints (`GET /api/attack`, `POST /api/attack/:case`) still exist; the lab replaces them for the page. Enabled when `GET /api/config` `attackPanel` is true.

## 3. Limits and edge cases to design for
- **Chat limit:** 12 messages per minute; **tasks:** 6 per minute; show a friendly message on HTTP 429.
- **Model can be out of quota:** replies still work (`source: "rules"`). Do not treat that as an error.
- **A task can stop or be blocked** (budget too low, no eligible seller, unsupported request). Show the `notice`; Beacon also says it in the chat.
- **Refused attempts have no tx hash.** Paid, rejected junk does.
- Operator-only actions (`POST /api/session/new`) need the `x-operator-token` header. Do not put the token in the frontend bundle.

## 4. Reference
- API contract (older endpoints): Appendix B of `docs/DI-06_Build_Playbook.md`; architecture: `docs/architecture.md`; test evidence: `docs/evidence/JUDGED_TESTS.md`.
- Live task chat feed example (kinds in order): `plan` → `choice` → `agent` / `paid` ×N → `summary`.
