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

| Script                                              | What it does                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                                          | Next.js dev server                                                                         |
| `pnpm db:local`                                     | Local Postgres-compatible server (PGlite) persisted in `./.pglite`                         |
| `pnpm db:migrate` / `db:seed` / `db:reset`          | Apply migrations / insert 16 demo leads (incl. a prompt-injection attempt) / wipe + reseed |
| `pnpm agent:run <leadId>` / `--seed <n>` / `--list` | Run the agent on one lead and print a live, step-by-step trace                             |
| `pnpm test`                                         | Vitest (unit + in-memory Postgres integration tests)                                       |
| `pnpm typecheck` / `lint` / `format`                | Quality gates                                                                              |
