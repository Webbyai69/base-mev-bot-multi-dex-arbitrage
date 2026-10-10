#!/usr/bin/env bash
#
# Turn a copy of the home PC's .env into the server's .env, in paper mode with no wallet key, without
# printing any value. Run on the server as the bot user:
#
#   bash deploy/ashburn/make-server-env.sh /tmp/home.env [RPC_URL]
#
# Everything else (RPC settings, executor addresses, gas caps, bidding, learning) is copied verbatim, so
# both copies scan the same way and the comparison is fair. Pass a second argument to replace RPC_URL.
# The source file is shredded afterwards.
set -euo pipefail

SRC="${1:?usage: make-server-env.sh /path/to/home.env [RPC_URL]}"
NEW_RPC="${2:-}"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${APP_DIR}/.env"

umask 077
tmp="$(mktemp "${APP_DIR}/.env.XXXXXX")"
# grep -v exits 1 when it filters out every line; that's still success here.
drop() { grep -vE "^[[:space:]]*($1)[[:space:]]*=" || [ $? -eq 1 ]; }
# Strip CRLF, drop every line that could sign or send, and drop the lines this script sets itself.
sed 's/\r$//' "${SRC}" \
  | drop 'PRIVATE_KEY|KEYSTORE_FILE|KEYSTORE_PASSPHRASE|KEYSTORE_PASSPHRASE_FILE|MODE|LIQUIDATIONS_LIVE|UI_PORT|DATA_DIR|REPORT_DIR' \
  > "${tmp}"
if [ -n "${NEW_RPC}" ]; then
  drop 'RPC_URL' < "${tmp}" > "${tmp}.2"
  mv "${tmp}.2" "${tmp}"
  printf 'RPC_URL=%s\n' "${NEW_RPC}" >> "${tmp}"
fi
cat >> "${tmp}" <<'EOF'

# --- Server overrides (make-server-env.sh) ---
# Paper only. There is deliberately no PRIVATE_KEY or KEYSTORE_FILE on this box, so it cannot sign even if
# MODE is changed by mistake. Only one copy may ever send live transactions.
MODE=paper
LIQUIDATIONS_LIVE=false
# The dashboard listens on 127.0.0.1 only. 8788 so the SSH tunnel (localhost:8788) doesn't clash with
# the home PC's 8787; the page refuses a Host header for any other port.
UI_PORT=8788
DATA_DIR=./data
REPORT_DIR=./reports
EOF
mv "${tmp}" "${OUT}"
chmod 600 "${OUT}"
shred -u "${SRC}" 2>/dev/null || rm -f "${SRC}"

# Report what's set, never the values.
echo "wrote ${OUT} ($(grep -cE '^[A-Z0-9_]+=' "${OUT}") settings, mode 600)"
for k in MODE LIQUIDATIONS_LIVE UI_PORT; do grep -E "^${k}=" "${OUT}"; done
grep -qE '^(PRIVATE_KEY|KEYSTORE_FILE)=' "${OUT}" && { echo "ERROR: a key line survived" >&2; exit 1; } || echo "no wallet key in .env"
for k in RPC_URL RPC_FALLBACK_URLS EXECUTOR_ADDRESS ROUTE_EXECUTOR_ADDRESS; do grep -qE "^${k}=." "${OUT}" && echo "${k}: set" || echo "${k}: missing"; done
