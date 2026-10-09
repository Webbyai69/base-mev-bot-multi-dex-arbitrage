/**
 * Forward-looking gas budget guard (src/executor.ts gasBudgetGuard): a single send is refused when its
 * worst-case gas (full gas limit × this max fee) would push the day past MAX_DAILY_GAS_USD — so one high
 * bid can't blow the whole cap in a single transaction and drain the wallet. Raising the cap lets it bid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gasBudgetGuard } from "../dist/executor.js";

const ETH = 3300;
const gw = (x) => BigInt(Math.round(x * 1e9)); // gwei -> wei

test("a 25-gwei bid on a 260k-gas trade does NOT fit a $1/day cap (≈$21 worst case)", () => {
  const g = gasBudgetGuard(260_000, gw(25.04), ETH, 0, 1);
  assert.ok(g.worstCaseUsd > 20 && g.worstCaseUsd < 23, `worstCase ${g.worstCaseUsd}`);
  assert.equal(g.fits, false);
});

test("a base-fee liquidation (900k gas, ~0.045 gwei) fits a $1/day cap (cents)", () => {
  const g = gasBudgetGuard(900_000, gw(0.045), ETH, 0, 1);
  assert.ok(g.worstCaseUsd < 0.25, `worstCase ${g.worstCaseUsd}`);
  assert.equal(g.fits, true);
});

test("the guard tracks the day's remaining budget", () => {
  // ~1.05 gwei over 260k gas ≈ $0.90 worst case.
  const mfpg = gw(1.049);
  assert.equal(gasBudgetGuard(260_000, mfpg, ETH, 0, 1).fits, true, "fits with a fresh $1 budget");
  assert.equal(gasBudgetGuard(260_000, mfpg, ETH, 0.95, 1).fits, false, "does not fit once $0.95 is already spent");
});

test("raising the daily cap lets the same big bid through", () => {
  const mfpg = gw(25.04);
  assert.equal(gasBudgetGuard(260_000, mfpg, ETH, 0, 1).fits, false, "blocked at $1");
  assert.equal(gasBudgetGuard(260_000, mfpg, ETH, 0, 50).fits, true, "allowed at $50");
});
