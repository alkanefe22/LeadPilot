# Integration examples

| File                | What it shows                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `curl-webhook.sh`   | Sends a signed lead from the shell (computes the HMAC with `openssl`). Pass the same id twice to see deduplication. |
| `n8n-workflow.json` | Minimal n8n workflow: trigger → Code node (build + sign) → HTTP Request. Import via _Workflows → Import from file_. |

## Webhook contract

`POST /api/inbound/webhook?workspace=<workspace id>`

| Header                  | Value                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `Content-Type`          | `application/json`                                                                           |
| `X-LeadPilot-Timestamp` | Unix time in seconds (must be within 5 minutes)                                              |
| `X-LeadPilot-Signature` | `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` using the workspace webhook secret |

Body (only `message` — or its aliases `notes` / `body` — is required):

```json
{
  "external_id": "crm-123",
  "name": "Maya Chen",
  "email": "maya@brightpath.example",
  "company": "BrightPath Logistics",
  "phone": "+1 415 555 0100",
  "website": "brightpath.example",
  "message": "We want an AI agent for shipment intake. Budget ~$18k.",
  "source": "typeform",
  "metadata": { "utm_campaign": "spring" }
}
```

Responses:

- `202 {"status":"accepted","lead_id":"lead_…","agent":"queued"}` — stored; the agent runs right after the response.
- `200 {"status":"duplicate","lead_id":"lead_…"}` — a retry of something already accepted (same `external_id`, or the identical body when no id is sent). No new lead, no new run.
- `401` bad/missing signature or stale timestamp · `413` body over 64 KB · `422` invalid payload · `429` rate limited.

Zapier / Make: use a "Code" step (JavaScript) with the same signing snippet as the n8n Code node, then a "Webhooks / HTTP" POST with the raw body.
