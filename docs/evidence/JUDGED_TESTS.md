# Judged-test rehearsal

Run: 2026-10-17T00:08:49.648Z against http://localhost:4100. Testnet only (Base Sepolia). Beacon 0xADb43a17Cb94d4125f45522d815060B58A71dcCb.

| Test | Result | Detail | Explorer |
| --- | --- | --- | --- |
| T-01 Happy path, then change the numbers | FAIL | task1 stopped, 0 paid calls verified on chain; changed numbers: completed |  |
| T-02 Reconciliation | PASS | status matched, ledger 27000, chain 27000 |  |
| T-03 Budget 0.012 at concurrency 1 and 5 | PASS | c=1: stopped, spent 9000; c=5: stopped, spent 9000 |  |
| T-04 Price check: price lie and payTo lie | PASS | price lie: M-17, paid 0; payTo lie: S-06, paid 0 |  |
| T-05 Replay: once, again, five in parallel | PASS | replay wallet unavailable (replay_wallet_unfunded); ran the script with the Beacon wallet instead: stage 3 (5 in parallel):  200, 402, 402, 402, 402 / PASS: one response and one transfer per signed payment |  |
| T-06 Seller failure is not charged | PASS | RELEASE S-27, paid 0 |  |
| T-07 Junk output: paid, rejected, bought elsewhere | FAIL | RefJunk not used paid undefined; task stopped; reputation junk count undefined |  |
| T-08 Standard clients in both directions | PASS | reference buyer (Beacon wallet (spare not funded)) paid our Atlas: true; our buyer paid the reference seller: completed, spent 2000 |  |
| T-09 Key hygiene | FAIL | PASS  gitleaks_history; PASS  tracked_files; PASS  web_bundle; PASS  logs; FAIL  npm_audit   / To address all issues (including breaking changes), run: /   npm audit fix --force |  |
