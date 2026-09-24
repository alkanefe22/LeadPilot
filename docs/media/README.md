# Media to record

The main README references these files. Record them from a **local run with real keys**
(real Claude model; Google/HubSpot/Resend optional), 1440×900 window, dark theme unless noted.

| File                              | What to show                                                                              | Length / format    |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `hero-trace.gif`                  | Click **Simulate lead** → trace fills in live → run summary shows cost/time               | 8–12 s GIF, ≤ 8 MB |
| `overview.png`                    | Overview page with KPIs and charts after ~10 runs                                         | PNG                |
| `lead-trace.png`                  | Lead detail with one tool step expanded (input/output JSON) and the run summary header    | PNG                |
| `injection-flag.png`              | The injection lead (seed 16): ⚠ Flagged banner with matched patterns + disqualified trace | PNG                |
| `approvals.png`                   | Approvals page with a held booking/email and the Approve / Edit / Reject controls         | PNG                |
| `settings-integrations.png`       | Settings → Integrations with Test connection results                                      | PNG                |
| `n8n-workflow.png`                | The imported n8n workflow and the 202 response in the HTTP node output                    | PNG                |
| `terminal-trace.png` _(optional)_ | `pnpm agent:run --seed 1` output in a terminal                                            | PNG                |

Tip: blur or use demo data for anything personal; the public demo masks contact details automatically.
