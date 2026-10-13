# The arb system on Qortal

Qortal hosts this system's shared infrastructure on its data network (QDN):
the dashboard as a Qortal app, a shared list of Base nodes that anyone can add
to, status snapshots you choose to publish, and the release itself. The
trading stays on a machine you control, because that's where the keys are and
where the speed comes from.

## What runs where

| Where | What | Why there |
|---|---|---|
| Your machine, ideally near Base's sequencer (US East) | The bot, its keys, the node you send through, the bridge | Speed and custody: a trade is won or lost in the milliseconds between your node and the sequencer |
| Qortal (QDN) | The dashboard app, Base node lists, status snapshots, the release zip | Hosted by the network, with no server or domain to keep up |

Qortal doesn't make a transaction reach Base faster: QDN moves data in
seconds to minutes, and Base blocks come every 2 seconds. What it does for
latency is help you choose. The node lists people publish there give you
candidates, and `npm run qortal:nodes` times every one of them from your own
machine, so you pick the fastest node from where you actually are.

## Publish it

You need a registered Qortal name (Qortal Hub → Names) to publish anything.

1. **The release.** Publish `base-arb-system-….zip` as a File in Qortal Hub.
   Anyone can download it. It holds source code only: no keys, no `.env`, no
   trading data.
2. **The dashboard.** Publish `qortal/qapp/arb-terminal-qapp.zip` as an App in
   Qortal Hub. Preview it first. Rebuild it after changing the terminal with
   `npm run qortal:qapp`.
3. **Your public nodes** (optional). In the app, Network → Share your nodes.
   List only endpoints you're happy for anyone to use.

## Watch your bot from the app

Qortal Hub lets a published app talk only to Qortal itself: its content
security policy blocks requests to any other address, including programs on
your own computer. So your bot shows up inside Qortal Hub through Dev Mode,
served by a small read-only bridge on the bot's machine.

1. Start the bot. In its terminal (`http://127.0.0.1:8787/terminal`): AI
   agents → Issue token, with the read scope only.
2. Copy `qortal/bridge/bridge.env.example` to `qortal/bridge/bridge.env` and
   paste the token in.
3. Run `npm run qortal:bridge` on the bot's machine and leave it running.
4. In Qortal Hub, turn on Dev Mode (your profile), open Dev Mode apps → Add
   custom framework, and enter `127.0.0.1` with port `8790`.

The terminal opens on your bot's live numbers, and publishing node lists and
status snapshots still works, because Qortal's Dev Mode proxies the bridge and
keeps `qortalRequest`. The bridge listens on 127.0.0.1 only, answers only to
loopback host names, and refuses writes: pausing, tuning, fleet control,
tokens, wallets and node tests stay in the terminal on the bot's machine. It
refuses to start with a token that can do more than read. Qortal's proxy
passes reads only and holds each answer until it ends, so the terminal polls
every 15 seconds there instead of streaming.

Nothing on Qortal can place a Base trade: Qortal's wallet works with QORT and
a few other chains (Bitcoin, Litecoin, Dogecoin, Digibyte, Ravencoin, Pirate
Chain), not Ethereum or Base, and a trade has to reach Base within its
2-second blocks. The bot sends its own trades, from its own machine, with its
own key.

The published app, opened normally, runs on demo data and says so on every
page. If Qortal Hub runs on another computer, publish status snapshots
(Network → Public status, from Dev Mode) and watch those instead.

## Pick a faster node

```
npm run qortal:nodes                       lists published on Qortal (needs Qortal Hub or Core running)
npm run qortal:nodes -- --file nodes.json  a list file instead
npm run qortal:nodes -- --template         a list to fill in with your own public nodes
npm run qortal:nodes -- --check nodes.json check your list before publishing it
```

It times each node from this machine (chain id, then five `eth_blockNumber`
round trips), ranks them, and saves `qortal/out/nodes-ranked.json`. Open that
file in the app (Base nodes → Open a list file) to see the ranking there:
Qortal Hub doesn't let the app time nodes itself. It never
edits `.env`: to use a node, put it in `RPC_URL` (or `WS_URL`,
`FLASHBLOCKS_RPC_URL`) yourself and restart the bot. Use listed nodes for
reading and comparing. Send transactions only through a node you run or pay
for: whoever runs a node sees your transaction before the sequencer does.

## Formats

Both are JSON resources on QDN, published under the publisher's name.

**`base-arb-nodes-v1`**: a node list.

```json
{
  "schema": "base-arb-nodes/1",
  "chainId": 8453,
  "updatedAt": "2026-10-13T20:00:00.000Z",
  "nodes": [
    { "label": "Base public RPC", "url": "https://mainnet.base.org", "kind": "rpc", "region": "global",
      "notes": "Rate-limited", "measured": { "p50Ms": 41, "from": "us-east", "at": "2026-10-13T19:58:00.000Z" } }
  ]
}
```

`kind` is `rpc`, `ws` or `flashblocks`. Readers refuse any entry that isn't
`https://` or `wss://`, carries a user, password or query string, points at a
private or local host, or has a path that looks like an API key. At most 50
nodes per list.

**`base-arb-status-v1`**: a bot's public status: mode, running or paused,
health and open-issue count, detection latency, finds captured, still there,
lost or closed over 6 hours, and fleet bot states. Never addresses, routes,
pairs, hosts or keys. Readers keep only those fields.

## Text on Windows

Qortal Core reads and rewrites an app's HTML pages in the computer's default
charset (windows-1252 on Windows). Characters whose UTF-8 bytes include
`81 8D 8F 90 9D A0` come out as "�?", and entities for non-ASCII characters
are decoded and re-encoded the same way. `npm run qortal:qapp` swaps the few
the pages use for look-alikes that survive, and fails on any new one.

## What never goes on Qortal

- Private keys, seed phrases, `.env` files, API keys
- Private or paid RPC addresses
- Wallet and contract addresses
- The bot's trading records (`data/*.jsonl`) and learned data

`npm run release:qortal` builds the release from what git tracks, so ignored
files (`.env`, `data/`, `reports/`) can't get in. It fails if anything looks
like a key, token or keyed RPC URL, or if any text from your own
`release.private.json` (name, local paths, addresses) remains. Copy
`release.private.example.json` to start yours; git ignores the copy.

## Building further

These are the next pieces, in the order they pay off:

1. **Measured latency from many places.** Bots publish their own timings in the
   `measured` field, so a newcomer can choose a node by real numbers from their
   region before testing anything.
2. **Fleet settings over QDN.** Token blocklists and tuning presets published
   under your name and read by your bots as suggestions with an Apply button,
   never applied on their own.
3. **A private channel to your own bots.** QDN's encrypted resources
   (`DOCUMENT_PRIVATE`) let you send your bots settings that only your key can
   read.
4. **Alerts over Q-Chat.** The bot messages your Qortal account instead of
   Telegram. It needs its own Qortal key on the bot's machine, so plan where
   that key lives first.
5. **Bots in several regions**, coordinated through status and settings on
   QDN, with each one's trade path still going straight to Base.

## Files

```
qortal/lib/registry.mjs    the node-list format and its checks (shared by the app and the CLI)
qortal/lib/status.mjs      the status-snapshot format
qortal/lib/qdn.mjs         read-only client for a local Qortal Core (port 12391)
qortal/nodes/nodes.mjs     read, check, time and rank published nodes
qortal/bridge/bridge.mjs   the read-only bridge: serves the app with your bot's numbers (Dev Mode)
qortal/qapp/src/           the app's own pages; build-qapp.mjs assembles the app
```
