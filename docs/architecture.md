# Architecture: where a payment is checked, signed, verified and settled

Governing rule: **the model decides what to buy, plain code decides whether money moves.** The planner never imports the signer.

```mermaid
flowchart LR
  subgraph Outer["Outer ring: the marketplace (untrusted)"]
    UI["Dashboard (web/)\nconsole, marketplace, ledger"]
    REG["Registry :4000\nlistings, advisory probe"]
    S1["Atlas / Tremor / Brief\n(honest sellers)"]
    S2["Overquote / Redirect / Hollow / Offline\n(test vendors)"]
  end
  subgraph Mid["Middle ring: the security layer (our work)"]
    PL["Planner (rule based)\nproposes a plan"]
    SEL["Selector + reputation\nmeasured behaviour only"]
    GP["guard.pay()  ① CHECK\n402 vs listing snapshot, budget reserved,\nintent written BEFORE signing"]
    SG["signer module  ② SIGN\nonly code that touches the key"]
    VAL["Validator\nschema + sanity + quarantine"]
    LED["Hash-chained ledger\n+ reconciliation"]
  end
  subgraph Core["Core: the transaction system (given)"]
    FAC["x402 facilitator  ③ VERIFY then ④ SETTLE"]
    CH["USDC on Base Sepolia\nEIP-3009 transferWithAuthorization"]
  end
  UI -->|task, budget, concurrency| PL --> SEL --> GP
  SEL -.reads.-> REG
  GP -->|unpaid request| S1
  GP -->|unpaid request| S2
  S1 -->|402 PAYMENT-REQUIRED| GP
  GP -->|approved terms only| SG
  SG -->|PAYMENT-SIGNATURE| S1
  S1 -->|verify, claim nonce, work, validate own output, settle| FAC --> CH
  S1 -->|200 + PAYMENT-RESPONSE| GP --> VAL --> LED
  LED -->|compare to USDC transfers out of the buyer wallet| CH
```

## The four moments

| Moment | Where it happens | What it guarantees |
| --- | --- | --- |
| ① Checked | `guard.pay()` and the rule engine, before anything is signed | Price, token, network, scheme, payTo and timeout all equal the listing snapshot. A refusal creates no signature |
| ② Signed | `signer.ts`, the single module that reads a private key | Only terms that passed ① are signed, once per request id, after the budget is reserved |
| ③ Verified | Seller middleware asks the facilitator to verify, then claims the nonce atomically | One authorisation unlocks one response (replays get an error and no free work) |
| ④ Settled | Seller settles only after its handler succeeded and its own output passed its own schema | No service, no charge. The facilitator submits the transfer and pays gas |

After the response: the validator checks schema and content, the ledger writes a hash-chained row, and reconciliation compares paid rows with on-chain transfers to the last unit.

## Processes and ports

Gateway 8080 (one public door) routes to Beacon 4100 (dashboard, buyer API, signer), Registry 4000, and seven sellers 4011 to 4024. Only Beacon receives a private key. Sellers hold a receiving address only.
