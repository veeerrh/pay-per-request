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
   - Message kinds to style differently: `plan`, `choice` (why this agent was hired), `select`, `paid`, `rejected`, `refused`, `failed`, `pending`, `blocked`, `summary`, `question`, `answer`.
   - Input box: `POST /api/chat` with `{ message, taskId? }`, up to 500 characters. Reply is `{ reply, source }`, where `source` is `model` or `rules`. The chat can explain but never buys anything.
   - Suggested chips: "Why did you pick these agents?", "What did it cost?", "What went wrong?", "Show the results".
2. **Task box**: text, budget, concurrency (1/3/5). `POST /api/tasks` (budget is a digit string of units).
3. **Agent cards** for Atlas, Tremor, Brief, each showing: price, reputation score, status, and the **last output** with its model-written part:
   - Atlas: `countries[].note`, `summary`, `meta`
   - Tremor: `stats` (count, strongest, hoursSinceLatest), `digest`
   - Brief: `briefs[].brief`, `briefs[].actions[]`, `basis`
   - Show a small "AI-written" tag when `meta.notes` is `model`, and "rule-based" when it is `none` or `rules`.
4. **"Why this agent" line** on each hired agent: from the `choice` event or `result.choices[]` (`category`, `seller`, `reason`, `source`).
5. **Result card**: use `result.beaconSummary.text` as the headline report, then `result.evidence[]`, then the cost breakdown. Keep the budget meter (spent + reserved never above the cap).
6. **Model status badge** in the header: from `GET /api/config` `llm.enabled`. Optional tooltip with `llm.usage` per model (`day/rpd`, `minute/rpm`).
7. **Keep:** wallet, ledger (with Basescan tx links), reputation, hash-chain verify, reconcile, "New session" (operator token).

### Live updates (important)
- Use SSE `GET /api/tasks/:id/events` first. If it fails or stalls for about 10 seconds, switch to polling `GET /api/tasks/:id/poll?after=<lastEventId>` every 2 s. Stop when `status` is not `running`.
- Events have a rising integer `id`. New types: `plan` (`params`, `source`), `choice`, `chat`. Existing: `stage`, `metrics`, `activity`, `ledger`, `output`, `blocked`, `done` (`done` is last while running).
- Chat Q&A can add events after `done`, so keep polling the chat endpoint, not the events one, for answers.

### Fraud Lab (separate tab)
- `GET /api/attack` lists the cases; `POST /api/attack/:case` runs one. Cases: `price-lie` (Overquote), `payto-lie` (Redirect), `junk` (Hollow), `failure` (Offline), `replay5`, `budget-race`, `invariant`.
- Each result shows: expected outcome, actual verdict, rule id (for example `M-17`, `S-06`), amount paid (usually 0), tx link if any, and the ledger row it created.
- Label clearly: "Scripted agents, no LLM. Every payment goes through the real Beacon guard."
- Enabled when `GET /api/config` `attackPanel` is true. Attack calls are limited to 10 per minute.

## 3. Limits and edge cases to design for
- **Chat limit:** 12 messages per minute; **tasks:** 6 per minute; show a friendly message on HTTP 429.
- **Model can be out of quota:** replies still work (`source: "rules"`). Do not treat that as an error.
- **A task can stop or be blocked** (budget too low, no eligible seller, unsupported request). Show the `notice`; Beacon also says it in the chat.
- **Refused attempts have no tx hash.** Paid, rejected junk does.
- Operator-only actions (`POST /api/session/new`) need the `x-operator-token` header. Do not put the token in the frontend bundle.

## 4. Reference
- API contract (older endpoints): Appendix B of `docs/DI-06_Build_Playbook.md`; architecture: `docs/architecture.md`; test evidence: `docs/evidence/JUDGED_TESTS.md`.
- Live task chat feed example (kinds in order): `plan` → `choice` → `paid` ×N → `summary`.
