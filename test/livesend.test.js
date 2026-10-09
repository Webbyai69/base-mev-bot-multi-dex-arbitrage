/**
 * Live send decision (src/executor.ts pickLiveSend). Default mode only sends
 * positive expected-value finds; act mode (0.9) sends every find that passed the
 * on-chain simulation, ranked by net profit — the learning sizes the bid, not a veto.
 * The on-chain-simulation requirement and the routes-only-when-allowed rule hold in both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLiveSend } from "../dist/executor.js";

// pickLiveSend only calls learner.evaluate(o, ctx); a stub returns each opp's chosen EV.
const learner = { evaluate: (o) => ({ evUsd: o._ev, bidGwei: 0.1, pLand: 0.5, evidence: 5, bidWhy: "test" }) };
const ctx = { ethUsd: 3000, gasUnits: 260000, basePriorityGwei: 0.005, maxBidShare: 0.3, evMinUsd: 0.01 };
const opp = (over = {}) => ({ sim: "executor-ok", route: false, netUsd: 0.5, _ev: 0.5, ...over });

test("default (EV-gated) mode does not send a negative expected-value find", () => {
  const r = pickLiveSend([opp({ netUsd: 1, _ev: -0.1 })], learner, ctx, false);
  assert.equal(r.send, undefined);
});

test("act mode executes a simulated-profitable find even when predicted EV is negative", () => {
  const r = pickLiveSend([opp({ netUsd: 1, _ev: -0.1 })], learner, { ...ctx, act: true }, false);
  assert.ok(r.send);
  assert.equal(r.send.o.netUsd, 1);
});

test("act mode picks the highest net profit among the simulated-ok finds", () => {
  const r = pickLiveSend([opp({ netUsd: 0.3, _ev: 5 }), opp({ netUsd: 0.9, _ev: -1 })], learner, { ...ctx, act: true }, false);
  assert.equal(r.send.o.netUsd, 0.9);
});

test("a find that failed the on-chain simulation is never sent, even in act mode", () => {
  const r = pickLiveSend([opp({ sim: "executor-revert", netUsd: 5, _ev: 5 })], learner, { ...ctx, act: true }, false);
  assert.equal(r.send, undefined);
});

test("routes are only sent when the RouteExecutor is live (allowRoutes)", () => {
  const route = opp({ route: true, netUsd: 1, _ev: 5 });
  assert.equal(pickLiveSend([route], learner, { ...ctx, act: true }, false).send, undefined);
  assert.ok(pickLiveSend([route], learner, { ...ctx, act: true }, true).send);
});
