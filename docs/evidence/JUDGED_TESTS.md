# Judged-test rehearsal

Run: 2026-10-17T02:25:13.650Z against http://localhost:4100. Testnet only (Base Sepolia). Beacon 0xADb43a17Cb94d4125f45522d815060B58A71dcCb.

| Test | Result | Detail | Explorer |
| --- | --- | --- | --- |
| T-01 Happy path, then change the numbers | PASS | task1 completed, 6 paid calls verified on chain; changed numbers: completed | [tx1](https://sepolia.basescan.org/tx/0xf0a0440a62a5be7c8e62b92f75cae0e52246263923866e73db217fc8ce464b6e) [tx2](https://sepolia.basescan.org/tx/0x3401b39acd38952ce7c7e987bbe5075c3c3c3d5b507cd997af3561b730f50f9a) [tx3](https://sepolia.basescan.org/tx/0xccfdf5fcb4ebb1d24feaba624f6da685c4f2673962b7cad206741e85f4b53fd9) [tx4](https://sepolia.basescan.org/tx/0xfd395311693a893e870773e45f8c3d8a90e8ec775d018f2ca56166233743c4ef) [tx5](https://sepolia.basescan.org/tx/0x82e2c8bb73b7c74f56249c9ebc66f74516dfa735e41a2a531721a4800417597c) [tx6](https://sepolia.basescan.org/tx/0x2e1e942d97d0ca7b321f02584a50e987ff7b3e835eb8f20aa938b74bf35c0ea4) |
| T-02 Reconciliation | PASS | status matched, ledger 58000, chain 58000 |  |
| T-03 Budget 0.012 at concurrency 1 and 5 | PASS | c=1: stopped, spent 9000; c=5: stopped, spent 9000 |  |
| T-04 Price check: price lie and payTo lie | PASS | price lie: M-17, paid 0; payTo lie: S-06, paid 0 |  |
| T-05 Replay: once, again, five in parallel | PASS | replay wallet unavailable (replay_wallet_unfunded); ran the script with the Beacon wallet instead: stage 3 (5 in parallel):  200, 409, 409, 409, 409 / PASS: one response and one transfer per signed payment |  |
| T-06 Seller failure is not charged | PASS | RELEASE S-27, paid 0 |  |
| T-07 Junk output: paid, rejected, bought elsewhere | PASS | RefJunk rejected paid 3000; task completed; reputation junk count 1 | [tx1](https://sepolia.basescan.org/tx/0xf25f80609a401bd29bb858a7c1d6869f0445aa41638bf1cdd2e68568a1dcc826) |
| T-08 Standard clients in both directions | PASS | reference buyer (Beacon wallet (spare not funded)) paid our Atlas: true; our buyer paid the reference seller: completed, spent 2000 |  |
| T-09 Key hygiene | PASS | PASS  gitleaks_history; PASS  tracked_files; PASS  web_bundle; PASS  logs; PASS  npm_audit |  |
