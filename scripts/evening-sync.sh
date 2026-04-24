#!/usr/bin/env bash
# Evening sync sidecar per build book §4.5.
# Pulls annotated PDFs modified in the last ~26h from /Daily on the reMarkable,
# rasterizes each page at 200dpi, base64-encodes each PNG, and POSTs each page
# to the evening-sync endpoint.
#
# Required env: ENDPOINT (full URL to /api/cron/evening-sync), CRON_SECRET.
# Requires: rmapi (in PATH, ~/.config/rmapi/rmapi.conf populated), pdftoppm, base64.

set -euo pipefail

: "${ENDPOINT:?ENDPOINT is required}"
: "${CRON_SECRET:?CRON_SECRET is required}"

TMP="$(mktemp -d -t notestella-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "[evening-sync] listing /Daily"
# rmapi ls output format: "d  DirName" or "f  filename"
mapfile -t DAILY_ENTRIES < <(rmapi ls /Daily 2>/dev/null | awk '$1 == "[f]" { $1=""; sub(/^ +/, ""); print }')

if [[ ${#DAILY_ENTRIES[@]} -eq 0 ]]; then
  echo "[evening-sync] /Daily is empty or unreadable"
  exit 0
fi

FILENAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}__[a-z0-9-]+__.+$'
CUTOFF_EPOCH=$(( $(date +%s) - 60*60*26 ))

TOTAL=0
SUCCESS=0
FAIL=0

for entry in "${DAILY_ENTRIES[@]}"; do
  name="$entry"
  # rmapi ls doesn't print mtime; we filter by filename date prefix instead.
  date_prefix="${name:0:10}"
  if ! date_epoch=$(date -j -f "%Y-%m-%d" "$date_prefix" +%s 2>/dev/null); then
    # Linux (CI runner): date uses different flag form
    if ! date_epoch=$(date -d "$date_prefix" +%s 2>/dev/null); then
      continue
    fi
  fi
  # Only process files dated today or yesterday (fits the 26h window).
  if (( date_epoch < CUTOFF_EPOCH )); then
    continue
  fi
  if ! [[ "$name" =~ $FILENAME_RE ]]; then
    echo "[evening-sync] skip non-conforming: $name"
    continue
  fi

  TOTAL=$((TOTAL+1))
  local_pdf="$TMP/$name"
  echo "[evening-sync] pulling $name"
  if ! rmapi get "/Daily/$name" "$local_pdf" >/dev/null; then
    echo "[evening-sync] rmapi get failed: $name"
    FAIL=$((FAIL+1))
    continue
  fi

  base="${name%.pdf}"
  # pdftoppm emits $base-1.png, $base-2.png, ...
  pdftoppm -r 200 -png "$local_pdf" "$TMP/$base" >/dev/null

  page_num=0
  for png in "$TMP/$base"-*.png; do
    [[ -f "$png" ]] || continue
    page_num=$((page_num+1))

    b64=$(base64 < "$png" | tr -d '\n')
    payload=$(jq -n \
      --arg f "$name" \
      --argjson p "$page_num" \
      --arg img "$b64" \
      '{filename:$f, page_number:$p, image_base64:$img}')

    http_code=$(curl -sS -o /tmp/ns-resp-$$ -w '%{http_code}' \
      -X POST "$ENDPOINT" \
      -H "Authorization: Bearer $CRON_SECRET" \
      -H "Content-Type: application/json" \
      --data-binary "$payload")

    if [[ "$http_code" =~ ^2 ]]; then
      echo "[evening-sync] $name p$page_num -> $http_code"
    else
      echo "[evening-sync] $name p$page_num -> $http_code $(cat /tmp/ns-resp-$$ | head -c 200)"
      FAIL=$((FAIL+1))
    fi
    rm -f /tmp/ns-resp-$$
  done

  SUCCESS=$((SUCCESS+1))
done

echo "[evening-sync] done. files=$TOTAL success=$SUCCESS fail=$FAIL"
# Exit 0 unless >50% of files failed at the per-file level.
if (( TOTAL > 0 )) && (( FAIL * 2 > TOTAL )); then
  echo "[evening-sync] fail rate > 50%"
  exit 1
fi
exit 0
