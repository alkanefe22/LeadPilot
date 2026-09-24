# LeadPilot — AI Lead Qualification & Booking Agent

> 🚧 Work in progress — the full portfolio README lands in milestone 6.

An autonomous agent that receives inbound leads (web form, email, or n8n/Zapier/Make webhooks),
qualifies them with Claude, asks follow-up questions, books meetings, updates your CRM and sends
follow-up emails — with every step visible in an inspectable **agent trace**.

## Quick start

```bash
pnpm install
cp .env.example .env.local        # set DATABASE_URL (and ANTHROPIC_* for the agent)
pnpm db:local                     # optional: local Postgres via PGlite on :5433 (separate terminal)
pnpm db:migrate && pnpm db:seed
pnpm dev
```

## Scripts

| Script                                              | What it does                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                          | Next.js dev server                                                                                             |
| `pnpm db:local`                                     | Local Postgres-compatible server (PGlite) persisted in `./.pglite`                                             |
| `pnpm db:migrate` / `db:seed` / `db:reset`          | Apply migrations / insert 18 demo leads (incl. a prompt-injection attempt and two look-alikes) / wipe + reseed |
| `pnpm agent:run <leadId>` / `--seed <n>` / `--list` | Run the agent on one lead and print a live, step-by-step trace                                                 |
| `pnpm google:auth`                                  | One-time Google OAuth flow; prints `GOOGLE_REFRESH_TOKEN`                                                      |
| `pnpm test`                                         | Vitest (unit + in-memory Postgres integration tests)                                                           |
| `pnpm typecheck` / `lint` / `format`                | Quality gates                                                                                                  |

## Integrations

Every integration sits behind an adapter interface. With no keys the app runs in **demo mode**
(built-in calendar, internal CRM, console outbox). Add keys and the real provider is used
automatically. At runtime there is **no silent fallback**: if a provider call fails (auth error,
rate limit, 5xx — retried once with backoff) the tool returns a clear error that is recorded in the
agent trace, and the adapter shows a red badge with the last error in **Settings**, where each
adapter also has a **Test connection** button (harmless read call, admin only).

> Demo safety: seeded and simulated leads never reach real providers — no emails and no calendar
> invites are sent to their made-up addresses, even when real keys are configured.

| Kind     | Built-in (demo)                  | Real providers                                                                              |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| Calendar | Business-hours demo calendar     | **Google Calendar** (free/busy, events with Google Meet)                                    |
| CRM      | Contacts table in Postgres       | **HubSpot** (upsert by email + qualification note) · Airtable: interface ready, easy to add |
| Email    | Console outbox (shown in the UI) | **Resend** (sending + inbound replies)                                                      |

### Google Calendar

1. Google Cloud Console → enable the **Google Calendar API** → configure the **OAuth consent screen**
   → create an OAuth client of type **Desktop app**.
2. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`, run `pnpm google:auth`, open the
   printed URL, allow access and copy the printed `GOOGLE_REFRESH_TOKEN` into your env.
3. Optional: `GOOGLE_CALENDAR_ID` (defaults to `primary`).

> ⚠️ **Refresh tokens expire after 7 days while the OAuth consent screen is in “Testing” mode.**
> The agent will then fail with `invalid_grant` (visible in the trace and in Settings). To avoid it,
> set the app’s publishing status to **In production** (OAuth consent screen → _Publish app_) and run
> `pnpm google:auth` again. Personal/internal use doesn’t require Google verification — users just
> see an “unverified app” notice during consent. With Google Workspace you can instead make the app
> **Internal**, which also issues long-lived tokens.

Availability is computed in the **workspace timezone** (Settings): weekdays 09:00–17:00 minus Google
free/busy minus existing bookings, DST-safe. Events are created with that timezone and a Google Meet link.

### HubSpot

Create a **Private App** (Settings → Integrations → Private Apps) with scopes
`crm.objects.contacts.read` and `crm.objects.contacts.write`, and set `HUBSPOT_ACCESS_TOKEN`.
Contacts are upserted by email (name, company, phone, website, `hs_lead_status`) and every agent
update attaches a note with the qualification summary: score, BANT and reasoning.

### Resend

- **Sending:** `RESEND_API_KEY` + `EMAIL_FROM` on a verified domain. Replies go to
  `reply+<token>@INBOUND_EMAIL_DOMAIN`, so they thread back to the right lead.
- **Inbound:** enable Receiving for your domain, add a webhook for `email.received` pointing to
  `https://YOUR-APP/api/inbound/email`, and set its signing secret as `RESEND_WEBHOOK_SECRET`
  (requires a full-access API key: the webhook carries metadata only, the body is fetched from the API).

### Airtable (easy to add)

Implement `CrmAdapter` (`upsertContact` + `testConnection`) in `src/server/adapters/crm/` and add a
branch in `src/server/adapters/index.ts` — the agent, traces, Settings and tests need no changes.
