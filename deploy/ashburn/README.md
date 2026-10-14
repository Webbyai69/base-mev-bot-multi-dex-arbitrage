# Ashburn deploy kit

Runs a second copy of the bot on a box in Ashburn, VA, next to Base's sequencer metro, **in paper mode**,
so it can be compared with the home PC. Strategy, costs and the go/no-go are in `ashburn-plan.md` (sent
in chat).

**Only one copy may ever send live transactions.** The server's `.env` has no wallet key at all, so it
can't sign anything until you deliberately set it up for live (bottom of this file).

## Files

| File | What it does |
|---|---|
| `provision.sh` | Ubuntu 22.04/24.04 setup: apt upgrade, Node 24, build tools, jq, chrony + UTC, 4 GB swap, fq + BBR, TCP fast open, no slow start after idle, nofile 65535, non-root `bot` user, read-only GitHub deploy key, clone, `npm ci`, build. Idempotent. |
| `make-server-env.sh` | Run on the PC: turns your home `.env` into the server's (`MODE=paper`, `LIQUIDATIONS_LIVE=false`, `UI_PORT=8788`, no `PRIVATE_KEY`/`KEYSTORE_FILE`, everything else verbatim). Prints no values, never modifies the source, and refuses to write anything that looks like a private key. |
| `arb-bot.service` | systemd unit: same command as `run-24h.ps1` (`node --max-old-space-size=256 dist/main.js run`), `Restart=always`, `RestartSec=5`, `LimitNOFILE=65535`, hardened. |
| `latency.sh` | TCP connect / TLS / first-byte times to the sequencer, the public RPC and Alchemy. Same script on the server and the PC (Git Bash). |
| `.env.ashburn.example` | What differs on the server, for reference. |

## Steps (run from the home PC unless noted)

```bash
IP=<server ip>; KEY=~/.ssh/oci_arb
ssh -i $KEY ubuntu@$IP 'uname -m; lsb_release -ds'          # expect aarch64, Ubuntu 24.04

# 1. provision (twice on a fresh box: the first run prints the deploy key and stops)
scp -i $KEY deploy/ashburn/provision.sh ubuntu@$IP:/tmp/
ssh -i $KEY ubuntu@$IP 'bash /tmp/provision.sh'
#    -> add the printed key under GitHub > repo > Settings > Deploy keys, read-only
ssh -i $KEY ubuntu@$IP 'BRANCH=<branch> bash /tmp/provision.sh'
#    No GitHub access? Ship the code as a bundle instead:
#    git bundle create /tmp/arb.bundle <branch>; scp it to /tmp; REPO=/tmp/arb.bundle BRANCH=<branch> bash /tmp/provision.sh

# 2. .env: convert ON THE PC, upload only the result (the wallet key never reaches the server, not even /tmp)
bash deploy/ashburn/make-server-env.sh .env "$TMPDIR/server.env" [NEW_RPC_URL]   # prints no values
scp -i $KEY "$TMPDIR/server.env" ubuntu@$IP:/tmp/server.env
ssh -i $KEY ubuntu@$IP 'sudo install -o bot -g bot -m 600 /tmp/server.env /home/bot/base-arb-bot/.env && rm /tmp/server.env'
rm "$TMPDIR/server.env"

# 3. data/ (the learning history; snapshot first, because the running bot rewrites learned.json in place)
#    copy data/ to a temp folder, check every .json parses, tar it, scp, extract into /home/bot/base-arb-bot/data

# 4. service
ssh -i $KEY ubuntu@$IP 'sudo cp /home/bot/base-arb-bot/deploy/ashburn/arb-bot.service /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now arb-bot && journalctl -u arb-bot -n 50 --no-pager'

# 5. dashboard on this PC at http://localhost:8788
ssh -i $KEY -N -L 8788:127.0.0.1:8788 ubuntu@$IP
```

## Going live on the server (only after you've compared, and only after the PC stops sending)

1. Stop the PC sending first (`data\STOP` or `MODE=paper` + restart there). Never both live at once.
2. On the box as `bot`: put the key in temporarily, `node dist/main.js encrypt-wallet`, then remove
   `PRIVATE_KEY` and add `KEYSTORE_FILE=./data/keystore.json` to `.env`.
3. `printf '%s' 'PASSPHRASE' | sudo systemd-creds encrypt --name=keystore-pass - /etc/arb-bot/keystore-pass.cred`,
   then `sudo systemctl edit arb-bot` and add the two credential lines shown at the bottom of `arb-bot.service`.
4. `MODE=live` (and `LIQUIDATIONS_LIVE=true` if wanted) in the server `.env`, `sudo systemctl restart arb-bot`.
