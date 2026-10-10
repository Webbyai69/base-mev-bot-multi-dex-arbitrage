# Running the bot on an Oracle Cloud server

`oracle-cloud-init.yaml` sets up a fresh Oracle Cloud **Always Free** Ampere A1
(Arm) instance running Ubuntu 24.04 for the bot. It installs Node.js 22, tunes
the network, adds the `arb-bot` service, and creates an `arb` user to run it.
It installs no keys and no bot code: you add those yourself, below.

## Before you start: idle reclamation

Oracle reclaims Always Free instances that look idle over 7 days. For A1 that
means CPU, network and memory all below 20% at the 95th percentile. A paper-mode
bot can easily stay under that. To be safe, upgrade the account to **Pay As You
Go**: usage within the Always Free limits stays free, and the instance isn't
reclaimed. Check Oracle's current "Always Free Resources" page, since the rules
change.

## 1. Create the instance

1. Compute > Instances > Create instance.
2. Image: **Canonical Ubuntu 24.04**. Shape: **VM.Standard.A1.Flex**, up to 4 OCPUs and 24 GB on the free tier.
3. Add your SSH public key.
4. Advanced options > Management > **Paste cloud-init script**: paste the whole of `oracle-cloud-init.yaml`.
5. Create. Setup takes about 5 minutes after the instance is up.

Region matters more than anything else on the machine. Run `cat ~/latency-check.txt`
(saved on first boot) or `base-latency` in two or three regions and keep the
fastest. The hosts sit behind CDNs, so this compares regions; it doesn't measure
the distance to Base's sequencer.

## 2. Check the setup finished

```bash
ssh ubuntu@<server-ip>
cloud-init status --wait          # "status: done"
node --version                    # v22.x
sysctl net.ipv4.tcp_congestion_control   # bbr
cat ~/latency-check.txt
```

## 3. Install the bot (as the `arb` user)

You log in as `ubuntu`, and the bot runs as `arb`. `arb` has no sudo and no
SSH login, so a compromised bot can't take over the machine.

```bash
sudo -u arb -H bash
cd ~/base-arb-bot
git clone -b main https://github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage .
npm ci && npm run build && npm test
```

Until the 0.9.1 changes are merged, clone with
`-b claude/funny-noether-w89o4t` instead of `-b main`.

## 4. Copy your settings and memory from the PC

From your PC, in the bot folder (PowerShell or any shell with `scp`):

```bash
scp .env ubuntu@<server-ip>:/tmp/arb.env
scp data/pools.json data/learned.json data/tuning.json data/aave-borrowers.json ubuntu@<server-ip>:/tmp/
```

On the server:

```bash
sudo install -o arb -g arb -m 600 /tmp/arb.env /home/arb/base-arb-bot/.env
sudo install -o arb -g arb -m 644 -D -t /home/arb/base-arb-bot/data /tmp/pools.json /tmp/learned.json /tmp/tuning.json /tmp/aave-borrowers.json
sudo shred -u /tmp/arb.env; rm -f /tmp/pools.json /tmp/learned.json /tmp/tuning.json /tmp/aave-borrowers.json
```

Copy only the data files you have; skip any that don't exist yet. Then check
`.env` with `sudo -u arb nano /home/arb/base-arb-bot/.env`:

- `LIVE_ACT_ALWAYS=false` (expected-value gating)
- `FLASHBLOCKS=true` if you want the Flashblocks loop
- **Only one bot sends live with a given `PRIVATE_KEY`.** Stop the PC copy (or
  set it to `MODE=paper`) before the server goes live: two senders on one
  wallet clash on nonces.

## 5. Start it

```bash
sudo systemctl enable --now arb-bot
journalctl -u arb-bot -f          # live log; Ctrl+C stops watching, not the bot
```

The first lines say which `LIVE_ACT_ALWAYS` mode is in force and whether the
Flashblocks stream connected. The service won't start until both `dist/main.js`
and `.env` exist, restarts 5 s after a crash, and starts again after a reboot.

## 6. Open the dashboard

The dashboard only listens on the server itself (127.0.0.1:8787). Don't open
port 8787 in Oracle's security list. Reach it through SSH instead:

```bash
ssh -L 8787:localhost:8787 ubuntu@<server-ip>
```

Then open http://localhost:8787 on your PC. For your phone, use the online copy
(`cloud/README.md`).

## Day to day

| Task | Command |
|---|---|
| Update to the latest code (pull, build, test, restart; stops if tests fail) | `sudo arb-bot-update` |
| Switch branch and update | `sudo arb-bot-update main` |
| Live log / last hour | `journalctl -u arb-bot -f` / `journalctl -u arb-bot --since -1h` |
| Stop / start / restart | `sudo systemctl stop arb-bot` (etc.) |
| Stop live sending only (the bot keeps running) | `sudo -u arb touch /home/arb/base-arb-bot/data/STOP` |
| Re-measure latency | `base-latency` |

`Restart=always` also restarts the bot after a clean exit. To keep it down, use
`systemctl stop`, not a kill.

## What the script changes on the server

- **Packages:** git, build tools, curl, jq, htop, chrony (time sync), unattended
  security updates, Node.js 22 from NodeSource, 4 GB swap.
- **Network** (`/etc/sysctl.d/99-arb-bot.conf`): BBR, no slow start after idle,
  60 s keepalives, larger socket buffers. BBR is loaded on every boot.
- **Journal** capped at 500 MB (`/etc/systemd/journald.conf.d/arb-bot.conf`).
- **`arb-bot.service`:** runs `node dist/main.js run` as `arb`, can write only
  its own folder, can't gain privileges, waits for network and synced time.
- **`/usr/local/bin/arb-bot-update`** and **`/usr/local/bin/base-latency`**.
