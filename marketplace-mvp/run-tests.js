const { guardedCall, replaySend, toUnits } = require("./buyer/guardedClient");
const ledger = require("./shared/ledger");

const results = [];

function record(id, title, expected, pass, actual) {
  results.push({ id, title, expected, actual, result: pass ? "PASS" : "FAIL" });
  console.log(`\n[${pass ? "PASS" : "FAIL"}] ${id} -- ${title}`);
  console.log(`   expected: ${expected}`);
  console.log(`   actual:   ${actual}`);
}

async function main() {
  ledger.reset();

  // ---- TC1-3: happy path, one per category ----
  const budgetAmple = { remaining: toUnits("1.0").toString() };

  {
    const r = await guardedCall("scraper", { testCase: "TC1 happy-path-scraper", budgetState: budgetAmple });
    record(
      "TC1",
      "Happy path -- scraping seller",
      "200, paid, tx hash present, valid output",
      r.ok && r.entry.status === "paid" && !!r.entry.tx_hash,
      `status=${r.entry.status} tx=${r.entry.tx_hash}`,
    );
  }

  {
    const r = await guardedCall("fx-rates", { testCase: "TC2 happy-path-fx-rates", budgetState: budgetAmple });
    record(
      "TC2",
      "Happy path -- data (fx-rates) seller",
      "200, paid, tx hash present, valid output",
      r.ok && r.entry.status === "paid" && !!r.entry.tx_hash,
      `status=${r.entry.status} tx=${r.entry.tx_hash}`,
    );
  }

  {
    const r = await guardedCall("summarizer", { testCase: "TC3 happy-path-summarizer", budgetState: budgetAmple });
    record(
      "TC3",
      "Happy path -- inference (summarizer) seller",
      "200, paid, tx hash present, valid output",
      r.ok && r.entry.status === "paid" && !!r.entry.tx_hash,
      `status=${r.entry.status} tx=${r.entry.tx_hash}`,
    );
  }

  // ---- TC4: price-check refusal ----
  {
    const r = await guardedCall("fx-rates-rogue", { testCase: "TC4 price-check-refusal", budgetState: budgetAmple });
    record(
      "TC4",
      "Rogue seller asks 10x listed price -- buyer must refuse and pay nothing",
      "refused, amount_paid=0",
      !r.ok && r.reason === "price_check_failed" && r.entry.amount_paid_units === "0",
      `reason=${r.reason} amount_paid_units=${r.entry.amount_paid_units}`,
    );
  }

  // ---- TC5: replay protection (sequential) ----
  {
    const attempts = await replaySend("scraper", { testCase: "TC5 replay-sequential", parallel: false, copies: 2 });
    const successes = attempts.filter((a) => a.httpStatus === 200).length;
    record(
      "TC5",
      "Same signed payment sent twice, sequentially -- exactly one must succeed",
      "exactly 1 of 2 attempts settles",
      successes === 1,
      `${successes} of ${attempts.length} attempts settled (statuses: ${attempts.map((a) => a.httpStatus).join(", ")})`,
    );
  }

  // ---- TC6: replay protection (parallel) ----
  {
    const attempts = await replaySend("fx-rates", { testCase: "TC6 replay-parallel", parallel: true, copies: 3 });
    const successes = attempts.filter((a) => a.httpStatus === 200).length;
    record(
      "TC6",
      "Same signed payment sent 3x in parallel -- exactly one must succeed",
      "exactly 1 of 3 attempts settles",
      successes === 1,
      `${successes} of ${attempts.length} attempts settled (statuses: ${attempts.map((a) => a.httpStatus).join(", ")})`,
    );
  }

  // ---- TC7: seller failure -- no charge ----
  {
    const r = await guardedCall("summarizer-fail", { testCase: "TC7 seller-failure-no-charge", budgetState: budgetAmple });
    record(
      "TC7",
      "Seller handler throws before responding -- payment must not settle",
      "failed, amount_paid=0",
      !r.ok && r.reason === "settlement_failed" && r.entry.amount_paid_units === "0",
      `reason=${r.reason} amount_paid_units=${r.entry.amount_paid_units}`,
    );
  }

  // ---- TC8: bad output -- paid but rejected ----
  {
    const r = await guardedCall("fx-rates-malformed", { testCase: "TC8 bad-output-rejected", budgetState: budgetAmple });
    record(
      "TC8",
      "Seller settles normally but returns output missing a required field",
      "paid_output_rejected, amount_paid>0, data not used",
      !r.ok && r.reason === "bad_output" && BigInt(r.entry.amount_paid_units) > 0n,
      `reason=${r.reason} status=${r.entry.status} amount_paid_units=${r.entry.amount_paid_units}`,
    );
  }

  // ---- TC9: budget cap stops a call before it would overspend ----
  {
    const tinyBudget = { remaining: toUnits("0.0015").toString() }; // enough for fx-rates (0.001) but not scraper (0.002)
    const r1 = await guardedCall("fx-rates", { testCase: "TC9 budget-cap", budgetState: tinyBudget });
    const r2 = await guardedCall("scraper", { testCase: "TC9 budget-cap", budgetState: tinyBudget });
    record(
      "TC9",
      "Tiny budget (0.0015) covers 1st call (0.001) but not 2nd (0.002)",
      "call 1 paid, call 2 refused for budget, total spend never exceeds budget",
      r1.ok && !r2.ok && r2.reason === "budget_exceeded",
      `call1=${r1.entry.status} call2=${r2.entry.status}(${r2.reason}) remaining=${tinyBudget.remaining}`,
    );
  }

  const txtPath = ledger.renderTxt(results);

  const passed = results.filter((r) => r.result === "PASS").length;
  console.log("\n" + "=".repeat(70));
  console.log(`SUMMARY: ${passed}/${results.length} test cases passed`);
  console.log(`Ledger written to: ${txtPath}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("test run crashed:", err);
  process.exit(1);
});
