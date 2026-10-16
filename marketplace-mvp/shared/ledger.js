const fs = require("fs");
const path = require("path");

const JSONL_PATH = path.join(__dirname, "..", "ledger.jsonl");
const TXT_PATH = path.join(__dirname, "..", "ledger.txt");

function reset() {
  fs.writeFileSync(JSONL_PATH, "");
}

function append(entry) {
  fs.appendFileSync(JSONL_PATH, JSON.stringify(entry) + "\n");
}

function readAll() {
  if (!fs.existsSync(JSONL_PATH)) return [];
  return fs
    .readFileSync(JSONL_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function usdc(units) {
  return (Number(units) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + " USDC";
}

function renderTxt(testSummaries) {
  const entries = readAll();
  const lines = [];
  lines.push("=".repeat(100));
  lines.push("AGENT MARKETPLACE -- TRANSACTION LEDGER");
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`network: eip155:84532 (Base Sepolia)  asset: USDC (6 decimals)`);
  lines.push("=".repeat(100));
  lines.push("");

  if (testSummaries && testSummaries.length) {
    lines.push("TEST CASES EXECUTED");
    lines.push("-".repeat(100));
    for (const t of testSummaries) {
      lines.push(`[${t.result}] ${t.id} -- ${t.title}`);
      lines.push(`    expected: ${t.expected}`);
      lines.push(`    actual:   ${t.actual}`);
      lines.push("");
    }
    lines.push("");
  }

  lines.push("FULL LEDGER (every attempted call, in order)");
  lines.push("-".repeat(100));

  let totalPaid = 0n;
  let callNum = 0;

  for (const e of entries) {
    callNum++;
    totalPaid += BigInt(e.amount_paid_units || 0);
    lines.push(`#${callNum}  ${e.time}`);
    lines.push(`   test case     : ${e.test_case || "-"}`);
    lines.push(`   buyer         : ${e.buyer}`);
    lines.push(`   seller        : ${e.seller} (${e.service})`);
    lines.push(`   listed price  : ${usdc(e.listed_price_units)}`);
    lines.push(`   amount paid   : ${usdc(e.amount_paid_units)}`);
    lines.push(`   status        : ${e.status}`);
    lines.push(`   tx hash       : ${e.tx_hash || "-"}`);
    lines.push(`   latency       : ${e.latency_ms} ms`);
    if (e.notes) lines.push(`   notes         : ${e.notes}`);
    lines.push("");
  }

  lines.push("-".repeat(100));
  lines.push(`TOTAL CALLS ATTEMPTED : ${callNum}`);
  lines.push(`TOTAL AMOUNT SETTLED  : ${usdc(totalPaid.toString())}`);
  lines.push("=".repeat(100));

  fs.writeFileSync(TXT_PATH, lines.join("\n"));
  return TXT_PATH;
}

module.exports = { reset, append, readAll, renderTxt, JSONL_PATH, TXT_PATH };
