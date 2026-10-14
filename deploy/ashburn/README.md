# Ashburn send-path deploy kit

Tier-0 of the roadmap: run **only** the latency-critical send-path on a box in Ashburn, VA (next to
Base's sequencer metro), and keep the home PC as the paper/learning brain. Strategy, costs, risks and
the go/no-go are in **`ashburn-plan.md`** (sent in chat) — read that first. This folder is the
mechanical kit to stand the box up once you've created the account.

Constraints unchanged: backrun/liquidations only; owner/operator model (gas-only key, no withdraw);
`.env` edited only by you; bot wallet holds only gas.

## What you do vs. what's scripted

**You (an AI can't create accounts or enter payment):**
1. **Create the server.** Oracle Cloud Always Free, **home region `US East (Ashburn) — us-ashburn-1`** (permanent — pick it right), shape `VM.Standard.A1.Flex` 4 OCPU / 24 GB, Ubuntu 22.04/24.04 (aarch64), upload your SSH key. If Arm shows *"Out of host capacity,"* retry the 3 Ashburn ADs / off-peak, or use the Hetzner `ash` fallback (see plan §6b). Verify-only card; Always Free stays $0.
2. **Give the box GitHub read access** to the private repo — add a read-only **deploy key** (an SSH key on the box, added under the repo's Deploy keys), or a fine-scoped token. `provision.sh` clones over SSH by default.
3. **Fill in `.env`** on the box from `.env.ashburn.example`, copying your executor addresses, gas cap and bidding settings **verbatim from your home `.env`**.
4. **Encrypt the key** on the box: `node dist/main.js encrypt-wallet`, then add `KEYSTORE_FILE` and remove `PRIVATE_KEY` from `.env` yourself.
5. **Set the systemd passphrase credential** (one command, below) and start the service.

**Scripted (take no outward action by themselves):** `provision.sh` (Node 20, firewall, non-root `bot` user, clone, `npm ci`, build), `arb-bot.service` (systemd, auto-restart, passphrase via encrypted credential), `.env.ashburn.example`.

## Steps on the box

```bash
# as a sudo user, after SSHing in and configuring the deploy key for the bot user:
curl -fsSLO https://raw.githubusercontent.com/Webbyai69/base-mev-bot-multi-dex-arbitrage/upgrade/v3-multihop-flashblocks-liquidations/deploy/ashburn/provision.sh
# (or scp it up) — review it, then:
bash provision.sh

# configure the bot:
sudo -u bot -i
cd ~/base-arb-bot
cp deploy/ashburn/.env.ashburn.example .env
nano .env                      # fill in RPC_URL (US-East), executor addresses, etc. MODE stays "paper".
node dist/main.js encrypt-wallet   # type a passphrase; it writes data/keystore.json, prints the address
nano .env                      # add KEYSTORE_FILE=./data/keystore.json ; remove the PRIVATE_KEY line
exit

# wire the passphrase as an encrypted systemd credential (prompts for the passphrase, nothing on disk in clear):
sudo mkdir -p /etc/arb-bot
printf '%s' 'YOUR-KEYSTORE-PASSPHRASE' | sudo systemd-creds encrypt --name=keystore-pass - /etc/arb-bot/keystore-pass.cred
sudo cp deploy/ashburn/arb-bot.service /etc/systemd/system/arb-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now arb-bot
journalctl -u arb-bot -f        # watch it boot in paper mode and start scanning
```

Fund the keystore address with a little gas only when you're ready to flip to live — **not** before the
paper week passes the plan's GO/NO-GO. Keep the home PC running in paper the whole week as the baseline.

## Going live (only after GO/NO-GO in the plan passes)

Edit `.env` on the box: `MODE=live`. Confirm the executor addresses match your deployed contracts, the
`$1` daily gas cap is set, and the circuit breaker is armed. `sudo systemctl restart arb-bot`. Leave home
in paper as the control.
