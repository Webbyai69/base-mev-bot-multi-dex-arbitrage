# Setting up from GitHub

Your bot's settings, its wallet key and everything it has learned live in
`.env` and `data\`. Git ignores both, so they never go to GitHub, and a copy
of the code from GitHub starts without them. This page gets a fresh copy
running where the old one left off: same funded bot wallet, same executors,
same memory.

## Updating the folder you already run (fastest)

Your bot folder is already a git copy of this repo. Updating it in place
leaves `.env`, the wallet and `data\` exactly as they are. Stop the bot
first ([how](#stopping-the-bot)), then:

```powershell
cd C:\path\to\base-arb-bot
git pull
npm ci
npm run build
```

Then start the bot the way you always do.

If `git pull` stops with "untracked working tree files would be overwritten
by merge: run-24h.ps1", your folder has its own copy of that script from
before it was added here. The repo's copy is the same script. Rename yours
with `ren run-24h.ps1 run-24h.ps1.bak` and run `git pull` again.

## A new folder, or another computer

1. Install [Node.js 22 LTS](https://nodejs.org) and [Git](https://git-scm.com).
2. Get the code next to your old folder:
   ```powershell
   cd C:\path\to
   git clone https://github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage.git base-arb-bot-new
   ```
   This gives you `main`. Until the pull request that brings `main` up to
   date is merged, add `-b upgrade/v3-multihop-flashblocks-liquidations`.
3. Install, build, and carry over your settings and the bot's memory from the
   old folder:
   ```powershell
   cd base-arb-bot-new
   .\setup.cmd "C:\path\to\base-arb-bot"
   ```
   The carry-over prints the bot wallet's address for the old and the new
   folder (they must match), the executor addresses it brought across, and
   the ETH the wallet holds on Base. It never prints the key or your RPC
   URL. To see what it would copy first:
   `node scripts\carry-over.mjs --from "C:\path\to\base-arb-bot" --dry-run`.
4. Stop the old bot, then start the new one from PowerShell in the new
   folder and open `http://localhost:8787`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File run-24h.ps1
   ```

If the new folder already has a `.env` or data that differ from the old
ones, the carry-over leaves them alone and tells you. `--force` replaces
them and keeps the new folder's copies as `*.bak`.

## Stopping the bot

`run-24h.ps1` runs the bot in the background and writes its process id to
`reports\run-24h.status.txt`, in the line `bot pid 1234 started …`. Stop it
with `Stop-Process -Id 1234`, using that number. The script stops it the same
way at the end of a run.

## Your bot wallet and its gas money

- The ETH is in the bot wallet on Base, not in a folder. Whatever install has
  the wallet's key can use it, and the permission your own wallet gave it on
  the executors is stored on-chain, so a new install with the same `.env`
  needs no new authorisation.
- The key is in `.env`. Keep an offline backup of that file. If every copy of
  the key is lost, the gas money in the wallet is lost with it.
- Run one live copy per wallet at a time. Two copies sending from one wallet
  compete for the same transaction slots and waste gas.
- `data\STOP` comes across with `data\`: live sending stays off until you
  delete it.

## Moving to a server

Encrypt the key before it leaves your PC:

```powershell
node dist/main.js encrypt-wallet
```

It writes `data\keystore.json` and prints only the address. On the server,
`.env` gets `KEYSTORE_FILE=./data/keystore.json` instead of `PRIVATE_KEY`, and
the bot asks for the passphrase at start (or reads it from
`KEYSTORE_PASSPHRASE_FILE`). The carry-over copies `data\keystore.json` along
with the rest of `data\`. Server setup itself is in
[deploy/ashburn/README.md](deploy/ashburn/README.md); newer server kits wait
in their own pull requests until they're merged.

A server that runs in paper mode needs no key at all. Before a server sends
live with the bot wallet, stop the PC's bot or set `MODE=paper` in the PC's
`.env`, so only one copy sends from the wallet.
