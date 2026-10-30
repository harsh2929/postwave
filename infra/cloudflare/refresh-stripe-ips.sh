#!/usr/bin/env bash
set -euo pipefail

STRIPE_WEBHOOK_IPS_URL="${STRIPE_WEBHOOK_IPS_URL:-https://stripe.com/files/ips/ips_webhooks.txt}"
API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
DRY_RUN=0
OUTPUT=""

usage() {
  cat <<'EOF'
Usage: refresh-stripe-ips.sh [--dry-run] [--output payload.json]

Fetches Stripe's published webhook IP ranges and replaces the Cloudflare
Rules List referenced by $stripe_webhook_ips.

Required for live update:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID

Optional:
  STRIPE_WEBHOOK_IPS_URL   Override Stripe source URL for tests.
  CLOUDFLARE_API_BASE      Override Cloudflare API base URL.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --output)
      OUTPUT="${2:-}"
      if [ -z "$OUTPUT" ]; then
        echo "--output requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
ips_file="$tmp_dir/stripe-webhook-ips.txt"
payload_file="$tmp_dir/cloudflare-list-items.json"

curl -fsSL "$STRIPE_WEBHOOK_IPS_URL" |
  awk 'NF && $1 !~ /^#/ { print $1 }' |
  sort -u > "$ips_file"

if [ ! -s "$ips_file" ]; then
  echo "Stripe webhook IP list is empty: $STRIPE_WEBHOOK_IPS_URL" >&2
  exit 1
fi

node - "$ips_file" > "$payload_file" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const ips = fs.readFileSync(path, "utf8").trim().split(/\n+/).filter(Boolean);
const items = ips.map((ip) => ({
  ip,
  comment: "Stripe webhook published IP",
}));
process.stdout.write(JSON.stringify(items, null, 2) + "\n");
NODE

count="$(wc -l < "$ips_file" | tr -d ' ')"

if [ -n "$OUTPUT" ]; then
  cp "$payload_file" "$OUTPUT"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "Prepared $count Stripe webhook IP list items."
  if [ -n "$OUTPUT" ]; then
    echo "Payload written to $OUTPUT"
  else
    cat "$payload_file"
  fi
  exit 0
fi

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID:?set CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID}"

response_file="$tmp_dir/cloudflare-response.json"
curl -fsSL -X PUT \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @"$payload_file" \
  "${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/rules/lists/${CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID}/items" \
  > "$response_file"

node - "$response_file" "$count" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const count = process.argv[3];
const body = JSON.parse(fs.readFileSync(path, "utf8"));
if (!body.success) {
  console.error(JSON.stringify(body.errors || body, null, 2));
  process.exit(1);
}
const op = body.result && body.result.operation_id ? ` operation_id=${body.result.operation_id}` : "";
console.log(`Updated Cloudflare Stripe webhook IP list with ${count} items.${op}`);
NODE
