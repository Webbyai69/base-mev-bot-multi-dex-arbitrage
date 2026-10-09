/**
 * Live execution through the ArbExecutor contract. Only used when MODE=live.
 *
 * Who holds what: your own wallet deploys and owns the ArbExecutor (from the
 * dashboard), so profits sit in a contract only you can withdraw from. The bot
 * has its own wallet (PRIVATE_KEY, made by `node dist/main.js new-wallet`) that
 * holds nothing but gas money and is authorised as the contract's operator.
 *
 * Safety rails:
 *   - nothing is sent until the live setup checks out: the exact ArbExecutor
 *     code at EXECUTOR_ADDRESS, the bot wallet authorised on it, and gas money
 *     in the bot wallet (re-checked every minute while blocked, every 5 after)
 *   - only classic two-pool routes that passed the on-chain simulation are sent
 *   - one transaction in flight at a time (no nonce races, no double-spend of a
 *     single opportunity)
 *   - the on-chain minProfit check makes a losing trade revert; we still pay
 *     gas for the revert, which is why paper mode comes first
 *   - a file named STOP in the data directory halts sending immediately
 *   - a daily gas budget (MAX_DAILY_GAS_USD) stops the bot if reverts pile up
 *   - after MAX_CONSECUTIVE_FAILURES reverted or dropped transactions in a row
 *     the executor writes the STOP file itself (a circuit breaker: repeated
 *     failures usually mean a bug or a stale model, not bad luck)
 */
import { writeFileSync } from "node:fs";
import { Wallet, keccak256, type TransactionReceipt, type TransactionResponse } from "ethers";
import { executorIface, routeExecutorIface } from "./abi.js";
import type { Chain } from "./rpc.js";
import type { Opportunity } from "./scanner.js";
import type { Store } from "./store.js";
import { SIM_EXECUTOR_RUNTIME } from "./simBytecode.js";
import { ROUTE_EXECUTOR_RUNTIME } from "./simBytecodeRoute.js";
import type { Evaluation, Learner } from "./learn.js";
import { log } from "./log.js";

/** Live mode only sends classic two-pool routes that passed the on-chain simulation: the best one, not just the top find. */
export function pickLiveOpportunity(opps: Opportunity[]): Opportunity | undefined {
  return opps.filter((o) => !o.route && o.sim === "executor-ok").sort((a, b) => b.netUsd - a.netUsd)[0];
}

/**
 * With the learning engine: of the eligible finds, the one with the best
 * expected value (chance it lands x profit, minus chance it fails x the gas it
 * burns), if that is above `evMinUsd`, with the bid to send it at. The rest are
 * returned with their reason, so the log can say why nothing was sent.
 */
export function pickLiveSend(
  opps: Opportunity[],
  learner: Learner,
  ctx: { ethUsd: number; gasUnits: number; basePriorityGwei: number; maxBidShare: number; evMinUsd: number },
  /** Routes (multi-hop and concentrated-liquidity) are considered only when the RouteExecutor is live. */
  allowRoutes = false,
): { send?: { o: Opportunity; ev: Evaluation }; passed: Array<{ o: Opportunity; ev: Evaluation }> } {
  const passed: Array<{ o: Opportunity; ev: Evaluation }> = [];
  let send: { o: Opportunity; ev: Evaluation } | undefined;
  for (const o of opps) {
    if (o.sim !== "executor-ok") continue;
    if (o.route && !allowRoutes) continue;
    const ev = learner.evaluate(o, ctx);
    if (ev.evUsd > ctx.evMinUsd && (!send || ev.evUsd > send.ev.evUsd)) {
      if (send) passed.push(send);
      send = { o, ev };
    } else passed.push({ o, ev });
  }
  return { ...(send ? { send } : {}), passed };
}

export interface LiveCheck {
  ok: boolean;
  /** Plain-language reasons the bot won't send yet (empty when ok). */
  problems: string[];
  executor: string;
  bot: string;
  /** True when EXECUTOR_ADDRESS holds exactly this version's ArbExecutor. */
  codeMatches: boolean;
  owner: string | null;
  operator: string | null;
  botBalanceWei: bigint;
  /** What one attempt can cost at today's gas price (gas limit x max fee). */
  minGasWei: bigint;
  checkedAt: string;
}

const EXPECTED_CODE_HASH = keccak256(SIM_EXECUTOR_RUNTIME);
const ROUTE_EXPECTED_CODE_HASH = keccak256(ROUTE_EXECUTOR_RUNTIME);

/** What `checkLiveSetup` is checking: the two-pool ArbExecutor, or the multi-hop / CL RouteExecutor. */
export interface ContractKind {
  label: string;
  envVar: string;
  expectedCodeHash: string;
}
export const ARB_CONTRACT: ContractKind = { label: "ArbExecutor", envVar: "EXECUTOR_ADDRESS", expectedCodeHash: EXPECTED_CODE_HASH };
export const ROUTE_CONTRACT: ContractKind = { label: "RouteExecutor", envVar: "ROUTE_EXECUTOR_ADDRESS", expectedCodeHash: ROUTE_EXPECTED_CODE_HASH };

/**
 * Fee caps for a send: twice the latest base fee plus our tip. (ethers' getFeeData() adds a
 * 1 gwei tip to its cap, which on Base is ~100x the real price and would make the node
 * demand far more ETH in the bot wallet than a transaction actually costs.)
 */
export async function liveFees(chain: Chain, priorityFeeGwei: number): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const priority = BigInt(Math.round(priorityFeeGwei * 1e9));
  const block = await chain.provider.getBlock("latest");
  const base = block?.baseFeePerGas ?? (await chain.provider.getFeeData()).gasPrice ?? 0n;
  return { maxFeePerGas: base * 2n + priority, maxPriorityFeePerGas: priority };
}

/**
 * Is everything in place to trade? Reads the contract code, its owner and
 * operator, and the bot wallet's balance. Never throws: RPC trouble becomes a problem line.
 */
export async function checkLiveSetup(chain: Chain, executor: string, bot: string, gasLimit: number, priorityFeeGwei: number, kind: ContractKind = ARB_CONTRACT): Promise<LiveCheck> {
  const problems: string[] = [];
  const r: LiveCheck = { ok: false, problems, executor, bot, codeMatches: false, owner: null, operator: null, botBalanceWei: 0n, minGasWei: 0n, checkedAt: new Date().toISOString() };
  const p = chain.provider;
  try {
    const [code, balance, fees] = await Promise.all([p.getCode(executor), p.getBalance(bot), liveFees(chain, priorityFeeGwei)]);
    r.botBalanceWei = balance;
    r.minGasWei = BigInt(gasLimit) * fees.maxFeePerGas;
    if (!code || code === "0x") {
      problems.push(`There is no contract at ${kind.envVar} (${executor}). Deploy the ${kind.label} from the dashboard and put its address in .env.`);
    } else {
      r.codeMatches = keccak256(code) === kind.expectedCodeHash;
      if (!r.codeMatches) problems.push(`The contract at ${kind.envVar} (${executor}) isn't this version's ${kind.label}. Deploy one from the dashboard and put its address in .env.`);
      const read = async (fn: "owner" | "operator"): Promise<string | null> => {
        try {
          const ret = await p.call({ to: executor, data: executorIface.encodeFunctionData(fn, []) });
          return String(executorIface.decodeFunctionResult(fn, ret)[0]).toLowerCase();
        } catch {
          return null; // not our contract, or an older version without an operator
        }
      };
      [r.owner, r.operator] = await Promise.all([read("owner"), read("operator")]);
      const me = bot.toLowerCase();
      if (r.owner !== me && r.operator !== me) {
        problems.push(`The bot wallet ${bot} isn't authorised on the ${kind.label}. On the dashboard, connect the owner's wallet${r.owner ? ` (${r.owner})` : ""} and press "Authorise bot wallet".`);
      }
    }
    if (balance < r.minGasWei * 3n) {
      problems.push(`The bot wallet ${bot} has ${(Number(balance) / 1e18).toFixed(6)} ETH, not enough for gas. Top it up from the dashboard.`);
    }
  } catch (err) {
    problems.push(`Couldn't check the live setup: ${(err as Error).message.slice(0, 120)}`);
  }
  r.ok = problems.length === 0;
  return r;
}

export interface LiveRecord {
  kind: "live";
  id: string;
  block: number;
  sentAt: string;
  txHash: string;
  status: "pending" | "success" | "reverted" | "dropped";
  /** A multi-hop / CL route sent through the RouteExecutor (vs a classic two-pool ArbExecutor trade). */
  route?: boolean;
  /** Priority fee bid, in gwei. */
  priorityFeeGwei?: number;
  gasUsedWei?: bigint;
  minedBlock?: number;
  expectedProfitUsd: number;
}

/** One day of live sends (UTC), for the digest and the daily review. */
export interface LiveDay {
  day: string;
  sent: number;
  landed: number;
  reverted: number;
  dropped: number;
  pending: number;
  /** Gas paid, including Base's L1 data fee. */
  gasUsd: number;
  /** What the landed trades were expected to make after gas, as modelled when sent. */
  expectedNetUsd: number;
  avgBidGwei: number | null;
}

/** Live sends per day from data/live.jsonl, newest day first. `ethUsd` prices records that predate gasUsd. */
export async function summarizeLive(store: Store, ethUsd: number): Promise<LiveDay[]> {
  const last = new Map<string, Record<string, unknown>>();
  try {
    for await (const r of store.read<Record<string, unknown>>("live.jsonl")) {
      if (r.kind === "live" && typeof r.txHash === "string") last.set(r.txHash, r);
    }
  } catch {
    return [];
  }
  const days = new Map<string, LiveDay & { bidSum: number; bidN: number }>();
  for (const r of last.values()) {
    const day = String(r.sentAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, sent: 0, landed: 0, reverted: 0, dropped: 0, pending: 0, gasUsd: 0, expectedNetUsd: 0, avgBidGwei: null, bidSum: 0, bidN: 0 }));
    d.sent++;
    if (r.status === "success") {
      d.landed++;
      d.expectedNetUsd += Number(r.expectedProfitUsd ?? 0) || 0;
    } else if (r.status === "reverted") d.reverted++;
    else if (r.status === "dropped") d.dropped++;
    else d.pending++;
    let gas = typeof r.gasUsd === "number" ? r.gasUsd : 0;
    if (typeof r.gasUsd !== "number" && r.gasUsedWei !== undefined && r.gasUsedWei !== null) {
      try {
        gas = (Number(BigInt(String(r.gasUsedWei))) / 1e18) * ethUsd;
      } catch {
        gas = 0;
      }
    }
    if (Number.isFinite(gas)) d.gasUsd += gas;
    if (typeof r.priorityFeeGwei === "number") {
      d.bidSum += r.priorityFeeGwei;
      d.bidN++;
    }
  }
  return [...days.values()]
    .map(({ bidSum, bidN, ...d }) => ({ ...d, avgBidGwei: bidN ? bidSum / bidN : null }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

export interface LiveSafety {
  consecutiveFailures: number;
  limit: number;
  gasSpentTodayUsd: number;
  maxDailyGasUsd: number;
  /** Why nothing is being sent yet (null = ready). */
  blocked: string | null;
  check: null | LiveCheckView;
  /** The RouteExecutor's status: undefined = routes not configured (CL/multi-hop stay paper-only). */
  routeBlocked?: string | null;
  routeCheck?: null | LiveCheckView;
  sent: number;
  succeeded: number;
}

export interface LiveCheckView {
  ok: boolean;
  problems: string[];
  executor: string;
  bot: string;
  codeMatches: boolean;
  owner: string | null;
  operator: string | null;
  botBalanceEth: number;
  minGasEth: number;
  checkedAt: string;
}

export class LiveExecutor {
  private inFlight: Promise<void> | null = null;
  private gasSpentTodayUsd = 0;
  private day = "";
  private consecutiveFailures = 0;
  private sent = 0;
  private succeeded = 0;
  /** Next nonce we expect to use; guards against a provider's cached transaction count right after a send. */
  private nextNonce = 0;
  private checkTimer: NodeJS.Timeout | null = null;
  /** Why nothing is being sent yet; null once the live setup checks out. */
  blocked: string | null = "Checking the live setup…";
  lastCheck: LiveCheck | null = null;
  /** Same, for the multi-hop / CL RouteExecutor; null = ready, undefined = routes not configured. */
  routeBlocked: string | null | undefined;
  lastRouteCheck: LiveCheck | null = null;
  readonly wallet: Wallet;
  /** Called when the circuit breaker trips (alerts hook). */
  onTrip?: (reason: string) => void;
  /** Called when sending becomes possible, or stops being possible. */
  onReadyChange?: (ready: boolean, reason: string | null) => void;
  /** Called with every finished send (the learning engine listens). */
  onResult?: (o: Opportunity, status: "success" | "reverted" | "dropped", gasUsd: number, priorityFeeGwei: number) => void;

  constructor(
    readonly chain: Chain,
    readonly store: Store,
    privateKey: string,
    readonly executorAddress: string,
    readonly opts: {
      gasLimit: number;
      priorityFeeGwei: number;
      maxDailyGasUsd: number;
      useFlash: boolean;
      maxConsecutiveFailures?: number;
      /** The multi-hop / CL RouteExecutor, deployed from the dashboard; when set, CL and multi-hop routes go live too. */
      routeExecutorAddress?: string;
      routeGasLimit?: number;
      /** Flash-loan source id for routes (0 own capital, 1 Morpho, 2 Balancer); must match the one simulation used. */
      routeFlashSource?: number;
    },
  ) {
    this.wallet = new Wallet(privateKey, chain.provider);
    this.routeBlocked = opts.routeExecutorAddress ? "Checking the live setup…" : undefined;
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** True while verified route sending is possible (RouteExecutor configured and its setup checks out). */
  get routeReady(): boolean {
    return this.routeBlocked === null;
  }

  /** Re-run the live setup check(s) now. Sending is enabled only while it passes. */
  async verify(): Promise<LiveCheck> {
    const c = await checkLiveSetup(this.chain, this.executorAddress, this.wallet.address, this.opts.gasLimit, this.opts.priorityFeeGwei, ARB_CONTRACT);
    this.lastCheck = c;
    const was = this.blocked;
    this.blocked = c.ok ? null : c.problems.join(" ");
    if (was !== null && this.blocked === null) {
      log.warn(`LIVE: setup checks out (bot wallet ${this.wallet.address}, ${(Number(c.botBalanceWei) / 1e18).toFixed(5)} ETH for gas); sending enabled`);
      this.onReadyChange?.(true, null);
    } else if (this.blocked !== null && this.blocked !== was) {
      log.warn(`LIVE: not sending yet. ${this.blocked}`);
      this.onReadyChange?.(false, this.blocked);
    }
    if (this.opts.routeExecutorAddress) await this.verifyRoute();
    return c;
  }

  /** The RouteExecutor's own check. It shares the bot wallet and gas, so only the contract and role differ. */
  private async verifyRoute(): Promise<void> {
    const c = await checkLiveSetup(this.chain, this.opts.routeExecutorAddress!, this.wallet.address, this.opts.routeGasLimit ?? this.opts.gasLimit, this.opts.priorityFeeGwei, ROUTE_CONTRACT);
    this.lastRouteCheck = c;
    const was = this.routeBlocked;
    this.routeBlocked = c.ok ? null : c.problems.join(" ");
    if (was !== null && this.routeBlocked === null) log.warn(`LIVE: RouteExecutor setup checks out (${this.opts.routeExecutorAddress}); multi-hop and CL routes will be sent too`);
    else if (this.routeBlocked !== null && this.routeBlocked !== was) log.warn(`LIVE: not sending routes yet. ${this.routeBlocked}`);
  }

  /** Check now, then every minute while blocked and every 5 minutes while ready (the gas money can run out). */
  startChecks(): void {
    const loop = async () => {
      await this.verify().catch(() => undefined);
      this.checkTimer = setTimeout(() => void loop(), this.blocked ? 60_000 : 300_000);
      this.checkTimer.unref?.();
    };
    void loop();
  }

  stopChecks(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  /** For the dashboard's safety panel. */
  get safety(): LiveSafety {
    const view = (c: LiveCheck | null): LiveCheckView | null =>
      c && {
        ok: c.ok,
        problems: c.problems,
        executor: c.executor,
        bot: c.bot,
        codeMatches: c.codeMatches,
        owner: c.owner,
        operator: c.operator,
        botBalanceEth: Number(c.botBalanceWei) / 1e18,
        minGasEth: Number(c.minGasWei) / 1e18,
        checkedAt: c.checkedAt,
      };
    return {
      consecutiveFailures: this.consecutiveFailures,
      limit: this.opts.maxConsecutiveFailures ?? 5,
      gasSpentTodayUsd: this.gasSpentTodayUsd,
      maxDailyGasUsd: this.opts.maxDailyGasUsd,
      blocked: this.blocked,
      check: view(this.lastCheck),
      ...(this.opts.routeExecutorAddress ? { routeBlocked: this.routeBlocked ?? null, routeCheck: view(this.lastRouteCheck) } : {}),
      sent: this.sent,
      succeeded: this.succeeded,
    };
  }

  private stopped(): boolean {
    return this.store.exists("STOP");
  }

  /** Shared pre-flight for a send; returns null to proceed or a reason it won't. `blocked` is the relevant readiness. */
  private gate(o: Opportunity, blocked: string | null | undefined): string | null {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.gasSpentTodayUsd = 0;
    }
    if (blocked) return blocked;
    if (this.stopped()) return "STOP file present";
    if (this.inFlight) return "another transaction is in flight";
    if (this.gasSpentTodayUsd > this.opts.maxDailyGasUsd) return `daily gas budget exhausted ($${this.gasSpentTodayUsd.toFixed(2)})`;
    if (o.sim !== "executor-ok") return `simulation state is ${o.sim}`;
    return null;
  }

  /** Fire-and-track a classic two-pool trade through the ArbExecutor. Returns false if it was not sent. */
  trySend(o: Opportunity, ethUsd: number, priorityFeeGwei?: number): boolean {
    if (o.route) return false; // routes go through trySendRoute
    const no = this.gate(o, this.blocked);
    if (no) {
      log.debug(`not sending ${o.id}: ${no}`);
      return false;
    }
    const bid = priorityFeeGwei !== undefined && Number.isFinite(priorityFeeGwei) && priorityFeeGwei >= 0 ? priorityFeeGwei : this.opts.priorityFeeGwei;
    // Give up 5% of the modelled profit to reserve slack for reserve drift within the block.
    const minProfit = (o.profit * 95n) / 100n;
    const fn = this.opts.useFlash ? "executeFlash" : "executeWithCapital";
    const data = executorIface.encodeFunctionData(fn, [o.buyPool, o.sellPool, o.tokenIn, o.amountIn, o.amountMid, o.amountOut, minProfit]);
    this.inFlight = this.submit(o, ethUsd, bid, this.executorAddress, this.opts.gasLimit, data).finally(() => {
      this.inFlight = null;
    });
    return true;
  }

  /** Fire-and-track a multi-hop / concentrated-liquidity route through the RouteExecutor. Returns false if it was not sent. */
  trySendRoute(o: Opportunity, ethUsd: number, priorityFeeGwei?: number): boolean {
    if (!o.route || !this.opts.routeExecutorAddress) return false;
    const no = this.gate(o, this.routeBlocked);
    if (no) {
      log.debug(`not sending route ${o.id}: ${no}`);
      return false;
    }
    const bid = priorityFeeGwei !== undefined && Number.isFinite(priorityFeeGwei) && priorityFeeGwei >= 0 ? priorityFeeGwei : this.opts.priorityFeeGwei;
    const minProfit = (o.profit * 95n) / 100n;
    const source = this.opts.routeFlashSource ?? 1;
    const hops = o.route.executorHops.map((h) => [h.pool, h.kind, h.feePpm] as const);
    const data = routeExecutorIface.encodeFunctionData("execute", [o.route.tokens, hops, o.amountIn, minProfit, source]);
    this.inFlight = this.submit(o, ethUsd, bid, this.opts.routeExecutorAddress, this.opts.routeGasLimit ?? this.opts.gasLimit, data).finally(() => {
      this.inFlight = null;
    });
    return true;
  }

  /** Sign, send and track one transaction to `target`, whichever contract it is. */
  private async submit(o: Opportunity, ethUsd: number, bidGwei: number, target: string, gasLimit: number, data: string): Promise<void> {
    // Re-bind to whichever RPC endpoint is active now (the client fails over between endpoints).
    const wallet = this.wallet.connect(this.chain.provider);
    let tx: TransactionResponse;
    try {
      const [fees, pending] = await Promise.all([liveFees(this.chain, bidGwei), this.chain.provider.getTransactionCount(this.wallet.address, "pending")]);
      tx = await wallet.sendTransaction({
        to: target,
        data,
        gasLimit,
        ...fees,
        nonce: Math.max(pending, this.nextNonce),
        type: 2,
      });
      this.nextNonce = tx.nonce + 1;
    } catch (err) {
      const msg = (err as Error).message;
      log.error("send failed:", msg.slice(0, 200));
      this.nextNonce = 0; // trust the node's count next time
      // Out of gas money (or the role was revoked): re-check, which blocks sending until it's fixed.
      if (/insufficient funds|NotOperator|NotOwner/i.test(msg)) void this.verify().catch(() => undefined);
      return;
    }
    this.sent++;
    const rec: LiveRecord = { kind: "live", id: o.id, block: o.block, sentAt: new Date().toISOString(), txHash: tx.hash, status: "pending", priorityFeeGwei: bidGwei, expectedProfitUsd: o.netUsd, ...(o.route ? { route: true } : {}) };
    this.store.append("live.jsonl", rec);
    log.info(`live: sent ${tx.hash} for ${o.pairSymbols}${o.route ? ` (${o.route.pools.length}-hop route)` : ""} expecting net $${o.netUsd.toFixed(3)}`);
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await tx.wait(1, 60_000);
    } catch (err) {
      // ethers v6 throws CALL_EXCEPTION for a mined-but-reverted transaction, with the receipt
      // attached. That's a revert (gas was paid), not a dropped transaction.
      const e = err as { code?: string; receipt?: TransactionReceipt | null; message?: string };
      if (e.code === "CALL_EXCEPTION" && e.receipt) receipt = e.receipt;
      else log.warn("live: wait failed:", String(e.message ?? err).slice(0, 160));
    }
    if (!receipt) {
      this.store.append("live.jsonl", { ...rec, status: "dropped" });
      this.nextNonce = 0; // a dropped transaction leaves its nonce unused
      this.recordFailure("dropped");
      this.report(o, "dropped", 0, bidGwei);
      return;
    }
    // On Base the fee is L2 gas plus an L1 data fee, which only the raw receipt carries.
    const raw = (await this.chain.provider.send("eth_getTransactionReceipt", [tx.hash]).catch(() => null)) as { l1Fee?: string } | null;
    const l1Fee = raw?.l1Fee ? BigInt(raw.l1Fee) : 0n;
    const gasWei = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? 0n) + l1Fee;
    const gasUsd = (Number(gasWei) / 1e18) * ethUsd;
    this.gasSpentTodayUsd += gasUsd;
    const status = receipt.status === 1 ? "success" : "reverted";
    this.store.append("live.jsonl", { ...rec, status, gasUsedWei: gasWei, gasUsd: Math.round(gasUsd * 1e6) / 1e6, minedBlock: receipt.blockNumber });
    if (status === "success") {
      this.consecutiveFailures = 0;
      this.succeeded++;
    } else {
      this.recordFailure("reverted");
      // A revert can mean the setup changed (bot wallet revoked, gas nearly gone): re-check now.
      void this.verify().catch(() => undefined);
    }
    log[status === "success" ? "info" : "warn"](`live: ${tx.hash} ${status} in block ${receipt.blockNumber}, gas $${gasUsd.toFixed(3)}`);
    this.report(o, status, gasUsd, bidGwei);
  }

  private report(o: Opportunity, status: "success" | "reverted" | "dropped", gasUsd: number, bidGwei: number): void {
    try {
      this.onResult?.(o, status, gasUsd, bidGwei);
    } catch (err) {
      log.warn("learning from a live result failed:", (err as Error).message.slice(0, 120));
    }
  }

  /** Circuit breaker: too many failed sends in a row writes the STOP file. */
  private recordFailure(kind: "reverted" | "dropped"): void {
    this.consecutiveFailures++;
    const limit = this.opts.maxConsecutiveFailures ?? 5;
    if (this.consecutiveFailures < limit || this.stopped()) return;
    const reason = `${this.consecutiveFailures} live transactions in a row failed (last: ${kind}); sending stopped. Investigate, then delete ${this.store.path("STOP")} to resume.`;
    try {
      writeFileSync(this.store.path("STOP"), `${new Date().toISOString()} ${reason}\n`);
    } catch (err) {
      log.error("could not write the STOP file:", (err as Error).message);
    }
    log.error(`circuit breaker: ${reason}`);
    this.onTrip?.(reason);
  }
}
