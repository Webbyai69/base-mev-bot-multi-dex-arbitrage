#!/usr/bin/env bash
#
# Provision an Ubuntu 22.04/24.04 box (Oracle Always Free A1 in us-ashburn-1, or Hetzner `ash`) for the
# Base arb-bot. Run as a sudo-capable user (ubuntu on Oracle). Idempotent: safe to run again, and you
# will run it twice on a fresh box (once to create the GitHub deploy key, once after you've added it).
# Takes no outward action beyond installing packages and cloning the repo you point it at. It never
# touches .env or any wallet key.
#
#   bash provision.sh                       # clone over SSH with the bot user's deploy key
#   REPO=/tmp/arb.bundle BRANCH=deploy/linux-arm-prep bash provision.sh   # clone from a git bundle you scp'd up
#
# Env overrides: REPO, BRANCH, BOT_USER, NODE_MAJOR, SWAP_GB, FIREWALL (auto|ufw|skip).
set -euo pipefail

REPO="${REPO:-git@github.com:Webbyai69/base-mev-bot-multi-dex-arbitrage.git}"
BRANCH="${BRANCH:-deploy/server-at-1b00467}"
BOT_USER="${BOT_USER:-bot}"
NODE_MAJOR="${NODE_MAJOR:-24}"   # same major as the home PC
SWAP_GB="${SWAP_GB:-4}"
FIREWALL="${FIREWALL:-auto}"
APP_DIR="/home/${BOT_USER}/base-arb-bot"

echo "== packages =="
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl jq ca-certificates gnupg build-essential chrony ufw

echo "== Node ${NODE_MAJOR} (NodeSource) =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
echo "node $(node -v), npm $(npm -v), $(uname -m)"

echo "== timezone UTC, clock via chrony =="
sudo timedatectl set-timezone UTC
# Oracle Cloud serves NTP on its link-local metadata address; prefer it there (lowest jitter).
if grep -qi oracle /sys/class/dmi/id/chassis_asset_tag 2>/dev/null; then
  sudo mkdir -p /etc/chrony/sources.d
  echo "server 169.254.169.254 iburst prefer" | sudo tee /etc/chrony/sources.d/oci.sources >/dev/null
fi
sudo systemctl enable --now chrony
sudo chronyc reload sources >/dev/null 2>&1 || true

echo "== ${SWAP_GB} GB swap file =="
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  sudo fallocate -l "${SWAP_GB}G" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null

echo "== network tuning: fq + BBR, TCP fast open, no slow start after idle =="
sudo tee /etc/sysctl.d/90-arb-bot.conf >/dev/null <<'EOF'
# Low-latency TCP for a bot that keeps a few long-lived HTTPS/WSS connections to RPC endpoints.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
# Fast open for outgoing (1) and incoming (2) connections.
net.ipv4.tcp_fastopen = 3
# Keep the congestion window on idle keep-alive connections, so the next request isn't throttled.
net.ipv4.tcp_slow_start_after_idle = 0
# Send small writes sooner instead of queueing them behind bulk data.
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_mtu_probing = 1
# Use the swap file only under real memory pressure.
vm.swappiness = 10
EOF
sudo modprobe tcp_bbr 2>/dev/null || true
echo tcp_bbr | sudo tee /etc/modules-load.d/bbr.conf >/dev/null
sudo sysctl --system >/dev/null
echo "qdisc $(sysctl -n net.core.default_qdisc), cc $(sysctl -n net.ipv4.tcp_congestion_control)"

echo "== open-file limit 65535 =="
sudo tee /etc/security/limits.d/90-arb-bot.conf >/dev/null <<'EOF'
*    soft nofile 65535
*    hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF
# The systemd unit sets LimitNOFILE=65535 for the service itself.

echo "== firewall (${FIREWALL}) =="
# Oracle's Ubuntu images already ship iptables rules (and the VCN security list) that allow only SSH in.
# Enabling ufw on top of them is a known way to lock yourself out there, so "auto" leaves them alone.
if [ "${FIREWALL}" = "ufw" ] || { [ "${FIREWALL}" = "auto" ] && [ ! -f /etc/iptables/rules.v4 ]; }; then
  sudo ufw --force default deny incoming
  sudo ufw --force default allow outgoing
  sudo ufw allow OpenSSH
  sudo ufw --force enable
else
  echo "leaving the existing firewall as it is (Oracle image rules or FIREWALL=skip)"
fi

echo "== non-root ${BOT_USER} user =="
id "${BOT_USER}" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "${BOT_USER}"

if [[ "${REPO}" == git@github.com:* ]]; then
  echo "== GitHub deploy key for ${BOT_USER} (read-only) =="
  sudo -u "${BOT_USER}" bash -c '
    set -euo pipefail
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    [ -f ~/.ssh/github_deploy ] || ssh-keygen -q -t ed25519 -N "" -C "arb-bot@$(hostname) deploy key" -f ~/.ssh/github_deploy
    grep -q "^Host github.com" ~/.ssh/config 2>/dev/null || printf "Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config
    chmod 600 ~/.ssh/config
    ssh-keygen -F github.com >/dev/null || ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
  '
  if ! sudo -u "${BOT_USER}" git ls-remote "${REPO}" HEAD >/dev/null 2>&1; then
    echo
    echo "GitHub doesn't accept this box's deploy key yet. Add this public key under the repo's"
    echo "Settings > Deploy keys (leave 'Allow write access' unticked), then run this script again:"
    echo
    sudo -u "${BOT_USER}" cat "/home/${BOT_USER}/.ssh/github_deploy.pub"
    exit 0
  fi
fi

echo "== clone + build as ${BOT_USER} =="
sudo -u "${BOT_USER}" bash -lc "
  set -euo pipefail
  if [ ! -d '${APP_DIR}/.git' ]; then
    git clone --branch '${BRANCH}' '${REPO}' '${APP_DIR}'
  fi
  cd '${APP_DIR}'
  git fetch origin '${BRANCH}'
  git checkout '${BRANCH}'
  git pull --ff-only origin '${BRANCH}'
  npm ci
  npm run build
  mkdir -p data reports
  test -f dist/main.js && echo 'build ok: dist/main.js present'
"

cat <<EOF

Provisioned. Next (see README for detail):
  1. on the PC: bash deploy/ashburn/make-server-env.sh .env server.env   (paper mode, no wallet key)
     then upload only server.env to ${APP_DIR}/.env (owner ${BOT_USER}, mode 600)
  2. upload data/ (the learning history) into ${APP_DIR}/data
  3. sudo cp ${APP_DIR}/deploy/ashburn/arb-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
     sudo systemctl enable --now arb-bot && journalctl -u arb-bot -n 50
EOF
