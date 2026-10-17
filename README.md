# AgentMarket: a pay-per-call agent economy on Base Sepolia

[![ci](https://github.com/veeerrh/pay-per-request/actions/workflows/ci.yml/badge.svg)](https://github.com/veeerrh/pay-per-request/actions/workflows/ci.yml)

AI agents hire other AI agents and pay **per request in testnet USDC** over **x402 v2** on **Base Sepolia**. A buyer agent (**Beacon**, shown as "Scout" in the UI) takes a plain-language task and a hard budget, finds sellers in an open registry, pays each one per call, checks everything it receives, and explains what it bought, from whom, why and at what cost.

> **Testnet only.** Every balance and payment here uses test USDC on Base Sepolia (chain id 84532). The code refuses to start on any other network. There is no mainnet path.

The interesting part is the **security layer** around the payment: the buyer refuses lying sellers before it signs anything, can never overspend even in parallel, pays only for answers that pass validation, and keeps a tamper-evident ledger that reconciles with the chain to the last unit.

## Run it (one command)

Prerequisites: Node 22 or newer, Git. Testnet wallets funded at <https://faucet.circle.com> (Base Sepolia, USDC, 20 per address every 2 hours).

```bash
git clone https://github.com/veeerrh/pay-per-request.git
cd pay-per-request
npm ci
npm run build
node scripts/gen-wallets.js      # creates fresh wallets in .env (never printed) and public addresses in config/addresses.json
node scripts/chain-check.js      # shows the addresses and balances; fund Beacon (and the spare and replay wallets) at the faucet
npm run start                    # registry, 7 sellers, Beacon, gateway; seeds the registry
```

Open <http://localhost:4100> (or everything through one door at <http://localhost:8080>). To serve judges, see `docs/PUBLIC_URLS.md` (`npm run tunnel`, then `npm run start:public`).

## The three example tasks (each needs scraping, data and inference)

| # | Task | Budget | Honest cost |
| --- | --- | --- | --- |
| 1 | The 3 most populous countries, earthquakes of magnitude 4.5 or more in the last 7 days, a readiness brief for each | 0.050 | 31,000 units |
| 2 | The 4 largest countries by area, magnitude 5.0 or more in the last 14 days, a brief for each | 0.060 | 33,000 units |
| 3 | The 2 most populous countries, magnitude 4.0 or more in the last 30 days, a brief for each | 0.030 | 19,000 units |

Judges can change the numbers inside the task text, the budget and `max_concurrency` (1, 3 or 5) in the console. Run from the terminal with `npm run task -- --id 1 --budget 0.050 --concurrency 3`.

## What it does (and where to look)

| Layer | What | Where |
| --- | --- | --- |
| Rule engine | Pure functions that decide whether the buyer may sign: price, token, network, scheme, payTo, timeout, caps | `packages/guard/src/rules`, `engine.ts` |
| `guard.pay()` | The single choke point: request, check, reserve budget, write intent, sign, send, validate, record | `packages/guard/src/pay.ts` |
| Budget | Reserve before signing, atomic, released in a `finally`; proven by a seeded random invariant test | `budget.ts`, `invariant.ts` |
| Ledger | Append-only, hash-chained SQLite ledger with session epochs and rule-set hashes | `store/store.ts` |
| Reconciliation | Paid rows versus USDC transfers out of the buyer wallet, to the last unit | `reconcile.ts` |
| Recovery | A crash or timeout after signing is resolved from the chain, never lost | `recover.ts` |
| Seller kit | Verify, claim nonce, work, validate own output, then settle; one authorisation unlocks one response | `packages/sellers/src/kit.js` |
| Agents | Model-backed agents (Gemini, one key each): buyer Beacon plans, chooses sellers and chats; sellers Atlas, Tremor, Brief add notes, a digest and the brief wording. Scripted test vendors Overquote, Redirect, Hollow, Offline for the fraud lab | `packages/sellers`, `packages/buyer`, `packages/llm` |
| Model rule | A model writes words and proposes picks; code owns the data, the readiness level and every payment decision, and checks that numbers in model text come from the data. Every agent falls back to a rule-based path with no key | `packages/llm`, `agent-kit.js`, `beacon.js` |
| Registry | Open, validated, SSRF-safe, rate limited, advisory probe | `packages/registry` |
| Dashboard | Console, marketplace, ledger, reputation, attack panel, wallet, settings | `web/` |

Architecture diagram and the four payment moments (checked, signed, verified, settled): `docs/architecture.md`.

## Test it

```bash
npm test                         # all tests (guard, sellers, registry, buyer, gateway, scans)
npm run invariant -- --seed 42 --runs 300   # budget never exceeded under parallel random calls
npm run scan                     # gitleaks over the full history, tracked files, web bundle, logs, npm audit
node scripts/judged-tests.js     # rehearses the nine judged tests against the running stack
```

Evidence from live runs (BaseScan links, reconcile output) is in `docs/evidence/`.

## Security model in brief

- **Code decides whether money moves; the model only proposes.** The planner never imports the signer.
- **Refuse before you sign.** Every 402 is compared with a listing snapshot taken at task start. A refusal creates no signature.
- **Subtract first, then sign.** The budget is reserved atomically before a signature exists.
- **No service, no charge.** Sellers settle only after their own output passes their own schema.
- **Evidence over trust.** Every attempt, including refusals, is a hash-chained ledger row. Reputation is computed from the ledger and cannot be edited.
- **Keys.** Only `signer.ts` reads a private key. Sellers hold receiving addresses only. Logs are redacted and scanned. No key is in the repository, history, web bundle or logs (`npm run scan`).

## Known limits (be honest)

- Not protected: a compromised facilitator wallet or chain, a fully compromised machine holding Beacon's key, and the quality of seller content beyond schema and sanity checks.
- The public x402.org facilitator's settlement time varies from about 2 seconds to over a minute. The buyer holds such calls as pending and recovers them from the chain instead of guessing.
- Signed listings and the human-approval gate are not built. Stretch goals (agent chain, Bazaar listing) are not built.
- Earthquake regions are approximated by a centre point and radius per country. Brief's readiness level comes from fixed thresholds on event count and strongest magnitude; the model only writes the wording.
- Model text is checked for invented numbers, not for every kind of wrong statement. Free-tier Gemini limits apply, and prompts on the free tier may be used by Google to improve its products, so only test data goes in.
