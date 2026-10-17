# Judged-test rehearsal

Run: 2026-10-17T00:37:16.500Z against http://localhost:4100. Testnet only (Base Sepolia). Beacon 0xADb43a17Cb94d4125f45522d815060B58A71dcCb.

| Test | Result | Detail | Explorer |
| --- | --- | --- | --- |
| T-01 Happy path, then change the numbers | PASS | task1 completed, 6 paid calls verified on chain; changed numbers: completed | [tx1](https://sepolia.basescan.org/tx/0xa8f4983c676e1a316d42fc35e9e1dd74405714c6b41bb92d34796ca133cd3e51) [tx2](https://sepolia.basescan.org/tx/0xbb2fc3f689d15a159627ed6396a2ba1ca75526cbf13d1e6fdfd9ca7408c6e40c) [tx3](https://sepolia.basescan.org/tx/0xa5c9beed3c5fbd818b6c539432f0f452bd74dafc61b7edaa438b46d5ff1ba018) [tx4](https://sepolia.basescan.org/tx/0x0849ab8cf02c2a58f38674f15f56f9b999c9c73b2046764624ea7bc0757f9958) [tx5](https://sepolia.basescan.org/tx/0x9118bd70984e09186a25403808f248802d4b9494c59e07bf0939f073aa421aa4) [tx6](https://sepolia.basescan.org/tx/0x0c70dd92be2c8ddd267ec970bff6588bc2b26b5f5181d99655b52f4a8313b72b) |
| T-02 Reconciliation | PASS | status matched, ledger 58000, chain 58000 |  |
| T-03 Budget 0.012 at concurrency 1 and 5 | PASS | c=1: stopped, spent 9000; c=5: stopped, spent 9000 |  |
| T-04 Price check: price lie and payTo lie | PASS | price lie: M-17, paid 0; payTo lie: S-06, paid 0 |  |
| T-05 Replay: once, again, five in parallel | PASS | replay wallet unavailable (replay_wallet_unfunded); ran the script with the Beacon wallet instead: stage 3 (5 in parallel):  200, 402, 402, 402, 402 / PASS: one response and one transfer per signed payment |  |
| T-06 Seller failure is not charged | PASS | RELEASE S-27, paid 0 |  |
| T-07 Junk output: paid, rejected, bought elsewhere | PASS | RefJunk rejected paid 3000; task completed; reputation junk count 1 | [tx1](https://sepolia.basescan.org/tx/0x01cb23cd0d1bffc77f9b622ab2696bd2d5d0c23a8b6686929581600717227b4c) |
| T-08 Standard clients in both directions | PASS | reference buyer (Beacon wallet (spare not funded)) paid our Atlas: true; our buyer paid the reference seller: completed, spent 2000 |  |
| T-09 Key hygiene | PASS | PASS  gitleaks_history; PASS  tracked_files; PASS  web_bundle; PASS  logs; PASS  npm_audit |  |
