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
import { executorIface } from "./abi.js";
import type { Chain } from "./rpc.js";
import type { Opportunity } from "./scanner.js";
import type { Store } from "./store.js";
import { SIM_EXECUTOR_RUNTIME } from "./simBytecode.js";
import { log } from "./log.js";

/** Live mode only sends classic two-pool routes that passed the on-chain simulation: the best one, not just the top find. */
export function pickLiveOpportunity(opps: Opportunity[]): Opportunity | undefined {
  return opps.filter((o) => !o.route && o.sim === "executor-ok").sort((a, b) => b.netUsd - a.netUsd)[0];
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
export async function checkLiveSetup(chain: Chain, executor: string, bot: string, gasLimit: number, priorityFeeGwei: number): Promise<LiveCheck> {
  const problems: string[] = [];
  const r: LiveCheck = { ok: false, problems, executor, bot, codeMatches: false, owner: null, operator: null, botBalanceWei: 0n, minGasWei: 0n, checkedAt: new Date().toISOString() };
  const p = chain.provider;
  try {
    const [code, balance, fees] = await Promise.all([p.getCode(executor), p.getBalance(bot), liveFees(chain, priorityFeeGwei)]);
    r.botBalanceWei = balance;
    r.minGasWei = BigInt(gasLimit) * fees.maxFeePerGas;
    if (!code || code === "0x") {
      problems.push(`There is no contract at EXECUTOR_ADDRESS (${executor}). Deploy the ArbExecutor from the dashboard and put its address in .env.`);
    } else {
      r.codeMatches = keccak256(code) === EXPECTED_CODE_HASH;
      if (!r.codeMatches) problems.push(`The contract at EXECUTOR_ADDRESS (${executor}) isn't this version's ArbExecutor. Deploy one from the dashboard and put its address in .env.`);
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
        problems.push(`The bot wallet ${bot} isn't authorised on the ArbExecutor. On the dashboard, connect the owner's wallet${r.owner ? ` (${r.owner})` : ""} and press "Authorise bot wallet".`);
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
  gasUsedWei?: bigint;
  minedBlock?: number;
  expectedProfitUsd: number;
}

export interface LiveSafety {
  consecutiveFailures: number;
  limit: number;
  gasSpentTodayUsd: number;
  maxDailyGasUsd: number;
  /** Why nothing is being sent yet (null = ready). */
  blocked: string | null;
  check: null | {
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
  };
  sent: number;
  succeeded: number;
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
  readonly wallet: Wallet;
  /** Called when the circuit breaker trips (alerts hook). */
  onTrip?: (reason: string) => void;
  /** Called when sending becomes possible, or stops being possible. */
  onReadyChange?: (ready: boolean, reason: string | null) => void;

  constructor(
    readonly chain: Chain,
    readonly store: Store,
    privateKey: string,
    readonly executorAddress: string,
    readonly opts: { gasLimit: number; priorityFeeGwei: number; maxDailyGasUsd: number; useFlash: boolean; maxConsecutiveFailures?: number },
  ) {
    this.wallet = new Wallet(privateKey, chain.provider);
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Re-run the live setup check now. Sending is enabled only while it passes. */
  async verify(): Promise<LiveCheck> {
    const c = await checkLiveSetup(this.chain, this.executorAddress, this.wallet.address, this.opts.gasLimit, this.opts.priorityFeeGwei);
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
    return c;
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
    const c = this.lastCheck;
    return {
      consecutiveFailures: this.consecutiveFailures,
      limit: this.opts.maxConsecutiveFailures ?? 5,
      gasSpentTodayUsd: this.gasSpentTodayUsd,
      maxDailyGasUsd: this.opts.maxDailyGasUsd,
      blocked: this.blocked,
      check: c && {
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
      },
      sent: this.sent,
      succeeded: this.succeeded,
    };
  }

  private stopped(): boolean {
    return this.store.exists("STOP");
  }

  /** Fire-and-track. Returns false if the opportunity was not sent. */
  trySend(o: Opportunity, ethUsd: number): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.gasSpentTodayUsd = 0;
    }
    if (this.blocked) {
      log.debug(`not sending ${o.id}: ${this.blocked}`);
      return false;
    }
    if (this.stopped()) {
      log.warn("STOP file present; not sending");
      return false;
    }
    if (this.inFlight) return false;
    if (this.gasSpentTodayUsd > this.opts.maxDailyGasUsd) {
      log.warn(`daily gas budget exhausted ($${this.gasSpentTodayUsd.toFixed(2)}); not sending`);
      return false;
    }
    if (o.route) {
      // Multi-hop / CL routes need RouteExecutor and stay paper-only for now;
      // never send them through the two-pool ArbExecutor.
      log.debug(`not sending ${o.id}: multi-hop routes are paper-only`);
      return false;
    }
    if (o.sim !== "executor-ok") {
      log.warn(`refusing to send ${o.id}: simulation state is ${o.sim} (${o.simDetail ?? ""})`);
      return false;
    }
    this.inFlight = this.send(o, ethUsd).finally(() => {
      this.inFlight = null;
    });
    return true;
  }

  private async send(o: Opportunity, ethUsd: number): Promise<void> {
    // Give up 5% of the modelled profit to reserve slack for reserve drift within the block.
    const minProfit = (o.profit * 95n) / 100n;
    const fn = this.opts.useFlash ? "executeFlash" : "executeWithCapital";
    const data = executorIface.encodeFunctionData(fn, [o.buyPool, o.sellPool, o.tokenIn, o.amountIn, o.amountMid, o.amountOut, minProfit]);
    // Re-bind to whichever RPC endpoint is active now (the client fails over between endpoints).
    const wallet = this.wallet.connect(this.chain.provider);
    let tx: TransactionResponse;
    try {
      const [fees, pending] = await Promise.all([liveFees(this.chain, this.opts.priorityFeeGwei), this.chain.provider.getTransactionCount(this.wallet.address, "pending")]);
      tx = await wallet.sendTransaction({
        to: this.executorAddress,
        data,
        gasLimit: this.opts.gasLimit,
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
    const rec: LiveRecord = { kind: "live", id: o.id, block: o.block, sentAt: new Date().toISOString(), txHash: tx.hash, status: "pending", expectedProfitUsd: o.netUsd };
    this.store.append("live.jsonl", rec);
    log.info(`live: sent ${tx.hash} for ${o.pairSymbols} expecting net $${o.netUsd.toFixed(3)}`);
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
      return;
    }
    // On Base the fee is L2 gas plus an L1 data fee, which only the raw receipt carries.
    const raw = (await this.chain.provider.send("eth_getTransactionReceipt", [tx.hash]).catch(() => null)) as { l1Fee?: string } | null;
    const l1Fee = raw?.l1Fee ? BigInt(raw.l1Fee) : 0n;
    const gasWei = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? 0n) + l1Fee;
    const gasUsd = (Number(gasWei) / 1e18) * ethUsd;
    this.gasSpentTodayUsd += gasUsd;
    const status = receipt.status === 1 ? "success" : "reverted";
    this.store.append("live.jsonl", { ...rec, status, gasUsedWei: gasWei, minedBlock: receipt.blockNumber });
    if (status === "success") {
      this.consecutiveFailures = 0;
      this.succeeded++;
    } else {
      this.recordFailure("reverted");
      // A revert can mean the setup changed (bot wallet revoked, gas nearly gone): re-check now.
      void this.verify().catch(() => undefined);
    }
    log[status === "success" ? "info" : "warn"](`live: ${tx.hash} ${status} in block ${receipt.blockNumber}, gas $${gasUsd.toFixed(3)}`);
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
