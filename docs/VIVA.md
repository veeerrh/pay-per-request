# Viva sheet: one-sentence answers (and where each is proven)

| Question | Answer | Proven by |
| --- | --- | --- |
| What happens if the buyer crashes after signing? | An intent row is written before signing. On restart we read each unfinished intent, check the USDC authorisation state on chain, and mark it paid or not charged. We saw this live when a slow facilitator settled after the request timed out | `recover.ts`, `docs/evidence/m3.3-reconcile.txt` |
| Why can the planner never hold the key? | The model decides what to buy and plain code decides whether money moves, so a prompt injection can change the plan but cannot move money past the guard. Only `signer.ts` reads a key | `guard/test/pay.test.ts` (key isolation), planner test |
| What if the facilitator lies or is down? | The seller never grants a resource without a confirmed settle, and we reconcile every paid row against real USDC transfers. A facilitator outage ends the call with a stated reason | `sellers/test/kit.test.js`, `reconcile.ts` |
| How do you stop fake sellers topping the ranking? | Scores are shrunk toward a neutral prior, new sellers start on probation, one payTo can back only a few listings, registration is rate limited, and ranking ignores seller text | `reputation.ts`, `registry` tests |
| How do you stop a retry paying twice? | One live authorisation per request id, and no new signature until the old nonce is known unused on chain | `recover.ts`, `pay.ts` |
| Why is the budget safe under parallel calls? | The reservation is one synchronous atomic step before signing, a `finally` always releases, and a seeded random test with tens of thousands of parallel calls shows zero violations | `budget.ts`, `npm run invariant` |
| How does one payment unlock only one answer? | The seller inserts the authorisation nonce into a unique-key table before doing any work, so the second insert fails (we saw 1 winner and 4 refusals live) | `claims.ts`, `docs/evidence/m3.2-replay.txt` |
| How do you know the ledger matches the chain? | Reconciliation compares paid ledger rows with USDC transfers out of Beacon's wallet to the last unit and never reports OK when the chain could not be read | `reconcile.ts`, evidence files |
| Why do refused calls appear in the ledger? | Required by the brief and useful: every attempt, including refusals, is a hash-chained row with the rule that decided it | Ledger page, decision log |
| What does the system not protect against? | A compromised facilitator wallet or chain, a fully compromised machine holding Beacon's key, and seller content quality beyond schema and sanity checks | README known limits |
