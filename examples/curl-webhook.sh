#!/usr/bin/env bash
# Send a signed lead to LeadPilot's inbound webhook.
#
#   LEADPILOT_URL=http://localhost:3000 \
#   LEADPILOT_WEBHOOK_SECRET=whsec_... \
#   ./examples/curl-webhook.sh
#
# Signature: hex HMAC-SHA256 of "<timestamp>.<raw body>" with the workspace webhook
# secret (Settings → Webhook), sent as "X-LeadPilot-Signature: sha256=<hex>".
# Requests older than 5 minutes are rejected (replay protection).
set -euo pipefail

URL="${LEADPILOT_URL:-http://localhost:3000}"
SECRET="${LEADPILOT_WEBHOOK_SECRET:?set LEADPILOT_WEBHOOK_SECRET (Settings → Webhook secret)}"
WORKSPACE="${LEADPILOT_WORKSPACE:-ws_demo}"
EXTERNAL_ID="${1:-crm-$(date +%s)}"   # pass the same id twice to see deduplication

# The exact bytes you sign must be the exact bytes you send.
BODY=$(cat <<JSON
{"external_id":"${EXTERNAL_ID}","name":"Maya Chen","email":"maya@brightpath.example","company":"BrightPath Logistics","message":"Hi! I run operations at a 90-person logistics company. We re-key ~300 shipment requests a week from email into our TMS and want an AI agent to do it. Budget around \$18k, we'd like to start next month.","source":"curl-example"}
JSON
)
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -sS -X POST "${URL}/api/inbound/webhook?workspace=${WORKSPACE}" \
  -H "Content-Type: application/json" \
  -H "X-LeadPilot-Timestamp: ${TS}" \
  -H "X-LeadPilot-Signature: sha256=${SIG}" \
  --data-binary "$BODY"
echo
