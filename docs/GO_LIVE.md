# Going live

Live mode sends real transactions. Before you start, know what it can and
can't do:

- It only sends **classic two-pool trades** (Uniswap V2 / SushiSwap /
  BaseSwap / Aerodrome volatile pools) that passed the on-chain test run at
  the same block. Multi-hop and concentrated-liquidity routes stay paper-only.
- Every trade borrows what it needs with a flash swap, so it needs **no
  trading capital**, only gas. A trade that would lose money reverts. You
  pay its gas (about a cent on Base) but never lose principal.
- Paper results tell you how often it will find anything. If the digest's
  "classic V2 two-pool" line shows no verified finds, live mode will mostly
  sit and wait.

## Who holds what

```
your wallet (Brave, MetaMask…)          bot wallet (made by new-wallet)
  deploys and OWNS the ArbExecutor        key in .env, never shown
  withdraws the profit                    holds only gas money
  authorises / revokes the bot            OPERATOR: can trade, can't withdraw
            │                                       │
            └──────────►  ArbExecutor  ◄────────────┘
                          profit accumulates here
```

A leaked bot key can spend the gas money in the bot wallet and nothing else.
Your own wallet's key never goes in a file.

## Steps

1. **Update and build** (stop the bot first):
   `git pull`, `npm run build`, `npm test`.
2. **Create the bot wallet** in PowerShell, in the bot's folder:
   `node dist/main.js new-wallet`.
   It writes `PRIVATE_KEY` into `.env` and prints only the address. It never
   replaces an existing key.
3. **Set the live limits** in `.env`:
   - `MAX_DAILY_GAS_USD=1`: sending stops for the day once $1 of gas is spent.
   - `MAX_CONSECUTIVE_FAILURES=5`: after 5 failed trades in a row the bot writes
     the `STOP` file and stops sending until you delete it.
   - Leave `WS_URL` empty. The websocket costs more Alchemy credit than polling
     and can go quiet without warning.
   - Optional, for a faster bot that uses fewer credits: `MULTI_HOP=false`,
     `CL_POOLS=false`, `LIQUIDATIONS=false`. Live mode can't send any of those
     anyway; turn them back on when you want the paper numbers for them.
4. **Restart the bot** (still `MODE=paper`). Open http://localhost:8787 and
   connect your own wallet in **Wallet and contracts**. Make sure it's on Base.
5. **Deploy the trading contract** with the button under *Trading contract
   (ArbExecutor)*. Your wallet becomes its owner. Copy the
   `EXECUTOR_ADDRESS=0x…` line it shows.
6. **Authorise bot wallet**, with the button under the same contract.
7. **Top up the bot wallet** with gas money under *Bot wallet*. The $5 / $10 /
   $20 buttons fill in the ETH amount; your wallet shows the exact amount
   before you approve.
8. **Switch to live** in `.env`: paste the `EXECUTOR_ADDRESS=` line and set
   `MODE=live`. Restart the bot.

The bot checks the setup before it sends anything, and again every minute
until it passes, then every 5 minutes:

- the contract at `EXECUTOR_ADDRESS` is exactly this version's ArbExecutor;
- the bot wallet is its owner or operator;
- the bot wallet has gas money.

The log says `LIVE: setup checks out … sending enabled`. The dashboard's
*Live setup* list shows all seven steps green, and Telegram, if set up, says
"Live trading enabled". Until then the dashboard says what's missing and
nothing is sent.

## While it runs

- **Stop sending:** the button on the dashboard, or create a file named `STOP`
  in the data folder. Delete it to resume.
- **Take the profit:** *Withdraw all WETH / USDC / ETH* under *Trading
  contract*, with the owner wallet connected.
- **Take the bot's access away:** *Revoke the bot wallet*. The bot stops
  sending at its next check, within 5 minutes; use Stop sending for an
  immediate halt.
- **Leftover gas money** stays in the bot wallet. To move it, import the bot
  wallet's key into a wallet app (it's in `.env`), or simply leave it for later.
- Every attempt is logged in `data/live.jsonl` and on the dashboard
  (*Trades sent*), with its gas, including Base's L1 data fee.
- **Why it did or didn't send:** with learning on (the default since 0.6) a
  find is sent only when its expected value is positive. The log says
  `live: sending … lands 50% of the time … bid 0.16 gwei (rivals' p60 …)` or
  `live: not sending … expected value $-0.004`, and the dashboard's *What it
  has learned* panel shows the record behind it. Suggested changes there take
  effect when you press **Apply**; nothing changes the mode, the daily gas limit
  or the keys but you, in `.env`.

## Going back to paper

Set `MODE=paper` and restart. The contract and the bot wallet stay as they are.
