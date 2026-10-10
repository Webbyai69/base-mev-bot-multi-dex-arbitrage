#!/usr/bin/env bash
#
# TCP connect, TLS handshake and first-response times to the endpoints the bot talks to. Each sample is a
# fresh connection (no keep-alive), so it measures the network path, not the RPC provider's caching.
# Runs the same on the server and on the home PC (Git Bash has curl). Never sends an API key: the RPC
# provider is hit at its bare host, which is enough to time the connection.
#
#   bash deploy/ashburn/latency.sh [samples]     # default 15
set -uo pipefail

N="${1:-15}"
BODY='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
TARGETS=(
  "https://mainnet-sequencer.base.org"
  "https://mainnet.base.org"
  "https://base-mainnet.g.alchemy.com"
)

median() { sort -n | awk '{a[NR]=$1} END {if (NR==0) {print "-"} else if (NR%2) {print a[(NR+1)/2]} else {print (a[NR/2]+a[NR/2+1])/2}}'; }

printf '%s from %s (%s), %s samples each, times in ms (median / min / max)\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(uname -sm)" "$N"
printf '%-32s %-20s %-20s %-20s\n' host "tcp connect" "tls done" "first byte"
for url in "${TARGETS[@]}"; do
  c=(); t=(); f=()
  for _ in $(seq "$N"); do
    out=$(curl -s -o /dev/null --max-time 10 -H 'content-type: application/json' --data "$BODY" \
      -w '%{time_connect} %{time_appconnect} %{time_starttransfer}' "$url") || continue
    read -r tc ta ts <<<"$out"
    c+=("$(awk -v x="$tc" 'BEGIN{printf "%.1f", x*1000}')")
    t+=("$(awk -v x="$ta" 'BEGIN{printf "%.1f", x*1000}')")
    f+=("$(awk -v x="$ts" 'BEGIN{printf "%.1f", x*1000}')")
  done
  stats() { local s; s=$(printf '%s\n' "$@" | median); printf '%s / %s / %s' "$s" "$(printf '%s\n' "$@" | sort -n | head -1)" "$(printf '%s\n' "$@" | sort -n | tail -1)"; }
  if [ "${#c[@]}" -eq 0 ]; then printf '%-32s unreachable\n' "${url#https://}"; continue; fi
  printf '%-32s %-20s %-20s %-20s\n' "${url#https://}" "$(stats "${c[@]}")" "$(stats "${t[@]}")" "$(stats "${f[@]}")"
done
