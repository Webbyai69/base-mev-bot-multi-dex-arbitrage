#!/usr/bin/env bash
#
# Turn the home PC's .env into the server's .env, in paper mode with no wallet key, without printing any
# value. Run it on the PC (Git Bash), so the wallet key never reaches the server, then upload OUT only:
#
#   bash deploy/ashburn/make-server-env.sh .env /path/to/server.env [RPC_URL]
#
# Everything else (executor addresses, gas caps, bidding, learning) is copied verbatim, so both copies
# scan the same way. Pass a third argument to replace RPC_URL. SRC is only read, never changed or deleted.
set -euo pipefail

SRC="${1:?usage: make-server-env.sh SRC_ENV OUT_ENV [RPC_URL]}"
OUT="${2:?usage: make-server-env.sh SRC_ENV OUT_ENV [RPC_URL]}"
NEW_RPC="${3:-}"
[ -f "${SRC}" ] || { echo "no such file: ${SRC}" >&2; exit 1; }
[ "$(cd "$(dirname "${SRC}")" && pwd)/$(basename "${SRC}")" != "$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT}")" ] || { echo "OUT must not be SRC" >&2; exit 1; }

umask 077
tmp="$(mktemp "$(dirname "${OUT}")/.env.XXXXXX")"
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

# Report what's set, never the values.
echo "wrote ${OUT} ($(grep -cE '^[A-Z0-9_]+=' "${OUT}") settings, mode 600)"
for k in MODE LIQUIDATIONS_LIVE UI_PORT; do grep -E "^${k}=" "${OUT}"; done
# Also catch a private key stored under any other name: 64 hex digits, with or without 0x.
if grep -qE '^(PRIVATE_KEY|KEYSTORE_FILE)=|(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)' "${OUT}"; then
  rm -f "${OUT}"
  echo "ERROR: something that looks like a private key survived; ${OUT} deleted" >&2
  exit 1
fi
echo "no wallet key in .env"
for k in RPC_URL RPC_FALLBACK_URLS EXECUTOR_ADDRESS ROUTE_EXECUTOR_ADDRESS; do grep -qE "^${k}=." "${OUT}" && echo "${k}: set" || echo "${k}: missing"; done
