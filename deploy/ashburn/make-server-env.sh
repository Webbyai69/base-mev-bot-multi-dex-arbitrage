#!/usr/bin/env bash
#
# Turn the home PC's .env into the server's .env, in paper mode with no wallet key, without printing any
# value. Run it on the PC (Git Bash), so the wallet key never reaches the server, then upload OUT only:
#
#   bash deploy/ashburn/make-server-env.sh .env /path/to/server.env [RPC_URL]
#
# The server's RPC_URL is, in order: the third argument, else SERVER_RPC_URL from SRC, else SRC's own
# RPC_URL. When it changes, RPC_FALLBACK_URLS becomes https://mainnet.base.org and no other setting may
# still point at the home provider (so the two copies never share a key). SERVER_RPC_URL itself is left
# out. Everything else (executor addresses, gas caps, bidding, learning) is copied verbatim, so both
# copies scan the same way. SRC is only read, never changed or deleted.
set -euo pipefail

SRC="${1:?usage: make-server-env.sh SRC_ENV OUT_ENV [RPC_URL]}"
OUT="${2:?usage: make-server-env.sh SRC_ENV OUT_ENV [RPC_URL]}"
NEW_RPC="${3:-}"
[ -f "${SRC}" ] || { echo "no such file: ${SRC}" >&2; exit 1; }
[ "$(cd "$(dirname "${SRC}")" && pwd)/$(basename "${SRC}")" != "$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT}")" ] || { echo "OUT must not be SRC" >&2; exit 1; }

# The value of KEY in SRC (CRLF, surrounding spaces and quotes stripped), or empty.
value() { sed 's/\r$//' "${SRC}" | grep -E "^[[:space:]]*$1[[:space:]]*=" | head -1 | sed -E "s/^[^=]*=[[:space:]]*//; s/[[:space:]]+\$//; s/^[\"']//; s/[\"']\$//" || true; }
host() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^/:?]+).*#\1#'; }

RPC_SOURCE="home RPC_URL (unchanged)"
if [ -n "${NEW_RPC}" ]; then
  RPC_SOURCE="command-line argument"
elif [ -n "$(value SERVER_RPC_URL)" ]; then
  NEW_RPC="$(value SERVER_RPC_URL)"
  RPC_SOURCE="SERVER_RPC_URL"
fi
OLD_HOST="$(host "$(value RPC_URL)")"

# dRPC: the network is part of the URL (lb.drpc.live/<network>/<key>, or ?network=<network>), and a key
# copied with another chain selected answers "method is not available" to everything. Its free plan also
# refuses JSON-RPC batches of more than 3, and the bot's default batch for an unknown provider is 20.
IS_DRPC=0
if [ -n "${NEW_RPC}" ] && printf '%s' "${NEW_RPC}" | grep -qE '^https://[^/]*drpc\.(live|org)/'; then
  IS_DRPC=1
  net="$(printf '%s' "${NEW_RPC}" | sed -E 's#^https://[^/]+/([^/?]+)/.*#\1#; s#^https://[^?]*\?(.*&)?network=([^&]+).*#\2#')"
  [ "${net}" = "base" ] || { echo "ERROR: the dRPC URL is for network '${net}', not 'base'. Copy the Base endpoint from the dRPC dashboard." >&2; exit 1; }
fi

umask 077
tmp="$(mktemp "$(dirname "${OUT}")/.env.XXXXXX")"
trap 'rm -f "${tmp}" "${tmp}.2"' EXIT
# grep -v exits 1 when it filters out every line; that's still success here.
drop() { grep -vE "^[[:space:]]*($1)[[:space:]]*=" || [ $? -eq 1 ]; }
# Strip CRLF, drop every line that could sign or send, and drop the lines this script sets itself.
sed 's/\r$//' "${SRC}" \
  | drop 'PRIVATE_KEY|KEYSTORE_FILE|KEYSTORE_PASSPHRASE|KEYSTORE_PASSPHRASE_FILE|MODE|LIQUIDATIONS_LIVE|UI_PORT|DATA_DIR|REPORT_DIR|SERVER_RPC_URL' \
  > "${tmp}"
if [ -n "${NEW_RPC}" ]; then
  drop 'RPC_URL|RPC_FALLBACK_URLS|RPC_BATCH_MAX_COUNT|RPC_CONCURRENCY|RPC_MIN_INTERVAL_MS' < "${tmp}" > "${tmp}.2"
  mv "${tmp}.2" "${tmp}"
  {
    echo
    echo "# --- Server RPC (make-server-env.sh, from ${RPC_SOURCE}) ---"
    printf 'RPC_URL=%s\n' "${NEW_RPC}"
    echo "RPC_FALLBACK_URLS=https://mainnet.base.org"
    if [ "${IS_DRPC}" = 1 ]; then
      echo "# dRPC free plan: at most 3 requests per JSON-RPC batch. Concurrency and spacing match the PC's"
      echo "# Alchemy defaults (2 in flight, 60 ms apart) so both copies pace requests the same way."
      echo "RPC_BATCH_MAX_COUNT=3"
      echo "RPC_CONCURRENCY=2"
      echo "RPC_MIN_INTERVAL_MS=60"
    fi
  } >> "${tmp}"
  # No other setting (WS_URL, FLASHBLOCKS_RPC_URL, ...) may still use the home provider.
  if [ -n "${OLD_HOST}" ] && [ "${OLD_HOST}" != "$(host "${NEW_RPC}")" ] && grep -E '^[A-Z0-9_]+=' "${tmp}" | grep -qF "${OLD_HOST}"; then
    echo "ERROR: these settings still point at ${OLD_HOST}: $(grep -E '^[A-Z0-9_]+=' "${tmp}" | grep -F "${OLD_HOST}" | cut -d= -f1 | tr '\n' ' ')" >&2
    exit 1
  fi
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

# Also catch a private key stored under any other name: 64 hex digits, with or without 0x.
if grep -qE '^(PRIVATE_KEY|KEYSTORE_FILE)=|(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)' "${tmp}"; then
  echo "ERROR: something that looks like a private key survived; nothing written" >&2
  exit 1
fi
mv "${tmp}" "${OUT}"
chmod 600 "${OUT}"
trap - EXIT

# Report what's set, never the secret values.
echo "wrote ${OUT} ($(grep -cE '^[A-Z0-9_]+=' "${OUT}") settings, mode 600)"
echo "no wallet key in .env"
for k in MODE LIQUIDATIONS_LIVE UI_PORT RPC_FALLBACK_URLS RPC_BATCH_MAX_COUNT RPC_CONCURRENCY RPC_MIN_INTERVAL_MS; do grep -E "^${k}=" "${OUT}" || true; done
net_note=""; [ "${IS_DRPC}" = 1 ] && net_note=", network base"
echo "RPC_URL: host $(host "$(grep -E '^RPC_URL=' "${OUT}" | cut -d= -f2-)")${net_note}, from ${RPC_SOURCE}"
for k in EXECUTOR_ADDRESS ROUTE_EXECUTOR_ADDRESS; do grep -qE "^${k}=." "${OUT}" && echo "${k}: set" || echo "${k}: missing"; done
if grep -qE '^[[:space:]]*SERVER_RPC_URL[[:space:]]*=' "${OUT}"; then rm -f "${OUT}"; echo "ERROR: SERVER_RPC_URL leaked; ${OUT} deleted" >&2; exit 1; fi
echo "SERVER_RPC_URL: not copied"
