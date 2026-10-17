# Five-minute demo script

Open in separate tabs before you start: the dashboard, the ledger page, BaseScan, the attack panel. Start from a **New session** (Settings, operator token). Keep the recorded backup video one click away. Cut from the bottom if you run over.

| Time | Show | Say | Proves |
| --- | --- | --- | --- |
| 0:00 to 0:30 | `docs/architecture.md` diagram | "Three rings. The chain moves the money, our security layer decides whether it may move, the marketplace is untrusted. A payment is checked, signed, verified, then settled." | P-24 |
| 0:30 to 1:30 | **Happy path.** Pick example task 1, change a number (for example 2 countries), run it. When paid rows appear, click one hash and show the amount going from the buyer to that seller's address on BaseScan | "Every paid call has its own transaction." | T-01 |
| 1:30 to 2:00 | Ledger page: the **Matches chain** badge, then **Re-run** | "Ledger total equals the USDC that left the wallet, to the last unit. The chain badge shows the ledger is intact." | T-02, A-02, A-19 |
| 2:00 to 3:15 | **Live fraud** on a fresh session, task 1. Watch the feed: Overquote refused (asked ten times its price), Offline failed and not charged, Redirect refused (wrong payee), Hollow paid then output rejected and discarded, then the honest sellers finish. Open the refusal detail to show the rule and reason | "Each refusal names the rule that fired." | T-04, T-06, T-07, A-01 |
| 3:15 to 4:00 | **Attack panel:** fire the replay (one answer, one transfer). Then run the budget race: 0.012 USDC at concurrency 5 and point at the meter | "Spent plus reserved never passes the cap." | T-05, T-03, A-06 |
| 4:00 to 4:30 | **Reputation page.** Run task 1 again: the fraud agents are skipped | "Reputation is computed from the ledger. Nobody can edit it." | P-11, M-44 to M-50 |
| 4:30 to 5:00 | Settings: the green key-hygiene badge and the rule-set hash. Mention the reference buyer paying our seller and ours paying theirs | "Standard x402 on both sides. No key in the repo, history, web bundle or logs." | T-08, T-09 |

Extra credit, 30 seconds each (only if time allows)

- **Approval:** set "Ask me before any call above" to 0.008, run task 1, and when Beacon pauses on Brief show that nothing is signed, then click Approve.
- **Metered pricing:** open the Ledger after a run: Brief's rows show listed 0.010 but asked and paid 0.006 for the single-country call.
- **Agent chain:** tick "Agent chain" and run: Beacon pays Atlas and Relay; Relay's card shows the Tremor purchases it made with its own wallet, with transaction links.

Practical notes

- Facilitator settlement time varies from 2 seconds to a minute. Keep talking while it loads. A slow call shows as pending and is recovered from the chain.
- Before going live: fund Beacon, the spare and the replay wallets (faucet allows one request per address every 2 hours), start the tunnel, run `npm run start:public`, run `npm run health -- --once`, run task 1 once, then press New session.
