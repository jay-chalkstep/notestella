#!/usr/bin/env bash
# Evening sync sidecar per build book §4.5.
# Pulls annotated PDFs modified in the last ~26h from /Daily on the reMarkable,
# rasterizes each page at 200dpi, base64-encodes each PNG, and POSTs each page
# to the evening-sync endpoint.
#
# SEMANTICS NOTE: rmapi doesn't expose mtime, so "in the last 26h" is approximated
# by the YYYY-MM-DD date embedded in the filename. If you annotate a brief from
# several days ago, this script will NOT sync it — it only looks at files whose
# filename date prefix is today or yesterday. Worth knowing if you ever write
# retroactively. A manual fix is to re-run the GitHub Action workflow after
# widening the filter, or invoke the endpoint directly for specific filenames.
#
# Required env: ENDPOINT (full URL to /api/cron/evening-sync), CRON_SECRET.
# Requires: rmapi (in PATH, ~/.config/rmapi/rmapi.conf populated),
#           pdftoppm (poppler-utils), convert (imagemagick), jq, base64, bc.

set -euo pipefail

: "${ENDPOINT:?ENDPOINT is required}"
: "${CRON_SECRET:?CRON_SECRET is required}"

TMP="$(mktemp -d -t notestella-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "[evening-sync] listing /Daily"
# rmapi ls output: "[d]  DirName" for dirs, "[f]  filename" for files.
mapfile -t DAILY_ENTRIES < <(rmapi ls /Daily 2>/dev/null | awk '$1 == "[f]" { $1=""; sub(/^ +/, ""); print }')

if [[ ${#DAILY_ENTRIES[@]} -eq 0 ]]; then
  echo "[evening-sync] /Daily is empty or unreadable"
  exit 0
fi

FILENAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}__[a-z0-9-]+__.+$'
CUTOFF_EPOCH=$(( $(date +%s) - 60*60*26 ))

# Blank-page threshold (mean gray in [0,1]; 0 = black, 1 = white).
# Pages above this threshold get skipped client-side to avoid paying for an
# Opus multimodal call that will return { skipped: true }.
BLANK_THRESHOLD=0.95

TOTAL=0
SUCCESS=0
FAIL=0
BLANK=0

for entry in "${DAILY_ENTRIES[@]}"; do
  name="$entry"
  date_prefix="${name:0:10}"
  if ! date_epoch=$(date -j -f "%Y-%m-%d" "$date_prefix" +%s 2>/dev/null); then
    # Linux (CI runner): date uses a different flag form
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
  echo "[evening-sync] pulling $name"
  # rmapi get behavior varies by version: some accept a destination path as a
  # second positional arg, some always download to CWD. cd into TMP so the file
  # lands in a known location regardless.
  if ! (cd "$TMP" && rmapi get "/Daily/$name" >/dev/null); then
    echo "[evening-sync] rmapi get failed: $name"
    FAIL=$((FAIL+1))
    continue
  fi
  local_pdf="$TMP/$name"
  if [[ ! -f "$local_pdf" ]]; then
    echo "[evening-sync] expected $local_pdf missing after rmapi get"
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

    # Blank-page filter: skip pages whose mean pixel is above the threshold.
    # Template headers on unannotated pages push the mean high; handwriting
    # drops it. Saves one Opus multimodal call per blank page.
    mean=$(convert "$png" -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
    is_blank=$(echo "$mean > $BLANK_THRESHOLD" | bc -l 2>/dev/null || echo "0")
    if [[ "$is_blank" == "1" ]]; then
      echo "[evening-sync] skip blank page: $name p$page_num (mean=$mean)"
      BLANK=$((BLANK+1))
      continue
    fi

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

echo "[evening-sync] done. files=$TOTAL success=$SUCCESS fail=$FAIL blank_pages_skipped=$BLANK"
# Exit 0 unless >50% of files failed at the per-file level.
if (( TOTAL > 0 )) && (( FAIL * 2 > TOTAL )); then
  echo "[evening-sync] fail rate > 50%"
  exit 1
fi
exit 0
