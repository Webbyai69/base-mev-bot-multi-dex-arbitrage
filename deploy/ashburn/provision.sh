#!/usr/bin/env bash
#
# Provision an Ubuntu 22.04/24.04 box (Oracle Always Free A1 in us-ashburn-1, or Hetzner `ash`) as the
# Base arb-bot send-path. Run as a sudo-capable user. Idempotent. Takes no outward action beyond
# installing packages and cloning the repo you point it at — it never touches .env or any key.
#
# Assumes the `bot` user already has GitHub read access to the private repo (deploy key or token) — see
# README. Override defaults with env vars: REPO=, BRANCH=, BOT_USER=.
set -euo pipefail

REPO="${REPO:-git@github.com:Webbyai69/base-mev-bot-multi-dex-arbitrage.git}"
BRANCH="${BRANCH:-upgrade/v3-multihop-flashblocks-liquidations}"
BOT_USER="${BOT_USER:-bot}"
APP_DIR="/home/${BOT_USER}/base-arb-bot"

echo "== packages =="
sudo apt-get update -y
sudo apt-get install -y git curl ufw ca-certificates build-essential

echo "== Node 20 LTS =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v && npm -v

echo "== non-root bot user =="
id "${BOT_USER}" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "${BOT_USER}"

echo "== firewall: deny inbound except SSH (the bot is outbound-only; no app ports) =="
sudo ufw --force default deny incoming
sudo ufw --force default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable

echo "== clone + build as ${BOT_USER} =="
sudo -u "${BOT_USER}" bash -lc "
  set -euo pipefail
  if [ ! -d '${APP_DIR}/.git' ]; then
    git clone --branch '${BRANCH}' '${REPO}' '${APP_DIR}'
  fi
  cd '${APP_DIR}'
  git fetch origin '${BRANCH}'
  git checkout '${BRANCH}'
  git pull --ff-only
  npm ci
  npm run build
  mkdir -p data
  test -f dist/main.js && echo 'build ok: dist/main.js present'
"

cat <<EOF

Provisioned. Next (as the ${BOT_USER} user, see README for detail):
  1. cp deploy/ashburn/.env.ashburn.example .env   and fill it in (MODE stays paper)
  2. node dist/main.js encrypt-wallet              (creates data/keystore.json)
  3. add KEYSTORE_FILE to .env and remove PRIVATE_KEY yourself
  4. install the systemd credential + arb-bot.service, then: sudo systemctl enable --now arb-bot
EOF
