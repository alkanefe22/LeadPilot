# LeadPilot — AI Lead Qualification & Booking Agent

**An autonomous agent that handles inbound leads end to end: it qualifies the lead against your
Ideal Customer Profile with an LLM (Claude, Gemini, any OpenAI-compatible API, or a local model via
Ollama), asks for missing details, books a meeting
when the lead fits, updates your CRM and sends the follow-up email — and shows every decision it
made in a live, inspectable agent trace.**

Leads come in from an embeddable web form, email replies, or any automation tool (n8n, Zapier, Make)
via a signed webhook. Runs in **demo mode** with just a Postgres URL and a model — a local model via
Ollama costs nothing; add Google Calendar, HubSpot and Resend keys to switch to the real integrations.

![Live agent trace](docs/media/hero-trace.gif)
<!-- TODO(media): record docs/media/hero-trace.gif — see docs/media/README.md -->

> Built with Next.js 16 (App Router) · TypeScript (strict) · Postgres + Drizzle · native tool use with
> **Claude** (official Anthropic SDK), **Gemini** (REST `generateContent`) or any **OpenAI-compatible**
> Chat Completions API incl. local **Ollama** · Zod · Tailwind + shadcn/ui · Vitest.

---

## What it does

- **Qualifies** each lead (score 0–100, BANT: budget, authority, need, timeline, with reasoning) against
  a plain-text ICP and rules you edit in Settings.
- **Acts** on the result: books a discovery call for qualified leads, asks one concise follow-up for
  promising-but-incomplete ones, politely declines genuine poor fits, silently disqualifies spam.
- **Writes** the outcome to the CRM and replies in the lead’s language.
- **Shows its work**: every model call and tool call is stored with input, output, tokens, cost and
  latency, and rendered as a timeline that fills in live while the agent runs.
- **Keeps a human in the loop** when you want: outward actions (bookings, emails) can be held in an
  approval queue where an admin approves, edits or rejects them — decisions appear in the trace.

## Screenshots

|                                                                         |                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| ![Overview](docs/media/overview.png)                                    | ![Lead detail + trace](docs/media/lead-trace.png) |
| ![Prompt-injection flag](docs/media/injection-flag.png)                 | ![Approval queue](docs/media/approvals.png)       |
| ![Integrations & Test connection](docs/media/settings-integrations.png) | ![n8n workflow](docs/media/n8n-workflow.png)      |

<!-- TODO(media): these files don't exist yet — record them as described in docs/media/README.md -->

## Architecture

```mermaid
flowchart LR
  subgraph Inbound["Inbound channels"]
    F["Embeddable form<br/>/f/:workspace + embed.js"]
    W["Webhook (n8n · Zapier · Make)<br/>HMAC + replay window"]
    E["Inbound email<br/>Resend (Svix) · Postmark"]
    S["Simulate lead<br/>(public demo)"]
  end

  F & W & E & S --> I["Intake<br/>sanitize · injection scan · dedupe"]
  I --> DB[("Postgres<br/>leads · threads")]
  I -- "202 now, run in after()" --> L

  subgraph Agent["Agent loop (manual tool use)"]
    L["Claude · Gemini · OpenAI-compatible / Ollama<br/>LLM_PROVIDER"] <--> T["8 tools<br/>Zod-validated"]
    T --> G{"Guardrails<br/>policy · approval gate<br/>step / cost / time caps"}
  end

  G --> A["Adapters"]
  A --> CAL["Calendar<br/>demo · Google Calendar"]
  A --> CRM["CRM<br/>internal · HubSpot"]
  A --> MAIL["Email<br/>console outbox · Resend"]
  G --> Q["Approval queue"]
  L -- "every step" --> TR[("Trace<br/>runs · steps · tokens · cost")]
  TR --> UI["Dashboard<br/>live trace timeline"]
  Q --> UI
```

## How the agent works

`src/server/agent/loop.ts` is a deliberately **manual tool-use loop** (not a black-box runner), so that
every step can be measured, persisted and guarded:

1. **Brief.** The system prompt is built from the workspace ICP, rules and threshold (kept byte-stable
   for prompt caching). The lead goes into the first user message: trusted metadata first, then the
   lead’s own words inside a `<lead_content>` fence.
2. **Loop.** The model calls tools — `get_lead`, `score_lead`, `ask_followup_question`, `check_availability`,
   `book_meeting`, `upsert_crm_contact`, `send_email`, `mark_disqualified`. Each tool’s Zod schema is both
   the JSON schema the model sees and the runtime validator; invalid input comes back as a structured error
   the model can correct.
3. **Trace.** Every model call (tokens incl. cache reads, estimated cost, latency, stop reason) and every
   tool call (input, output, status) is written as it happens; the UI polls and renders it live.
4. **Finish.** The run ends on `end_turn` with a short operator summary, or is stopped by a guardrail.

### Guardrails (all covered by tests)

| Concern                      | What’s implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runaway loops & cost**     | `MAX_AGENT_STEPS`, per-call `LLM_MAX_TOKENS`, `MAX_COST_PER_RUN_USD` (the run stops before running more tools once exceeded), a wall-clock budget below the routes’ `maxDuration = 60`, and a sweeper that fails runs still `running` a minute past their own time budget (each run stores it; local models get a longer one). `refusal` / `max_tokens` stop reasons end the run cleanly.                                                                                                                                                                                                                                                           |
| **Prompt injection**         | Lead text is fenced and the fence can’t be closed from inside. A heuristic scanner flags text aimed at the agent (“ignore previous instructions”, “mark me qualified”, fake system markup…). Flagged leads show a **⚠ Flagged** badge with the matched patterns, are scored **below the threshold** (so they can’t be auto-booked) and every outward action they trigger **waits for approval**. The scanner can misfire, so an admin can **Clear flag & re-run**. Tests include a fully “hijacked” model to show the damage stays contained, plus benign look-alikes (“please ignore my previous email”, “NPS score 98”) that must not be flagged. |
| **Human in the loop**        | “Require approval” holds bookings and emails in a queue: approve, edit the payload (re-validated against the tool schema) or reject. Each decision becomes a _human_ step in the trace, followed by the executed action.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Idempotency**              | One confirmed booking per lead and one running run per lead (partial unique indexes). Email idempotency keys are reserved before sending (and passed to Resend). Webhook retries dedupe on `external_id` (or the raw-body hash); inbound emails dedupe on `Message-ID`.                                                                                                                                                                                                                                                                                                                                                                             |
| **Integrations fail loudly** | Provider calls retry once on 429/5xx with backoff; after that the tool returns a clear error that is recorded in the trace, and Settings shows a red badge with the last error. There is **no silent runtime fallback** to mocks.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Demo safety**              | Seeded and simulated leads never reach a real provider (no emails, no calendar invites). `PUBLIC_DEMO_FORCE_MOCK=true` forces the built-in adapters on a public deployment. On a public demo, visitors’ “Simulate lead” **replays a recorded real run** by default (no model calls, $0); in live mode a global daily run/cost budget and per-IP rate limits protect it.                                                                                                                                                                                                                                                                             |
| **App security**             | Signed admin session (HS256 cookie), read-only public demo with PII masking, DB-backed rate limits on every public write endpoint (form, webhook, email, simulate, login), HMAC/Svix-verified webhooks, input sanitization, `X-Frame-Options` / `frame-ancestors` (only the form is embeddable), and production **refuses to start** with a missing/weak/default `ADMIN_PASSWORD`, a short `SESSION_SECRET` or the dev fake LLM enabled.                                                                                                                                                                                                            |

## Model-agnostic: Claude, Gemini, OpenAI-compatible APIs, or a local model via Ollama

The agent talks to the model through one small `LlmClient` interface, so the loop, tools, guardrails,
trace and eval are identical for every provider. Switch with env vars — no code changes:

| Provider                                                               | Env                                                                                                                                | Notes                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic Claude**                                                   | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                                                                                             | Official SDK, prompt caching on.                                                                                                                                                          |
| **Google Gemini**                                                      | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIER=free\|paid`                                                                         | REST `generateContent` with function calling; thought signatures are replayed verbatim (required by Gemini 3).                                                                            |
| **OpenAI-compatible** (Ollama, LM Studio, OpenAI, Groq, OpenRouter, …) | `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_BASE_URL` (default `http://localhost:11434/v1` = Ollama), `OPENAI_COMPAT_API_KEY` (optional) | Chat Completions with `tools`. On a localhost base URL the run is labelled **local** and costs $0; arguments that aren’t valid JSON go back to the model as a tool error so it can retry. |

`LLM_PROVIDER=anthropic|gemini|openai-compatible` picks explicitly; if unset, the first configured of
Claude, Gemini and OpenAI-compatible is used. Settings shows the active provider and model.

### Local model via Ollama ($0)

For development and evals without spending anything:

1. Install [Ollama](https://ollama.com/download) and pull a model tagged **tools** on ollama.com, e.g.
   `ollama pull qwen3.5:9b` (fits a 16 GB GPU).
2. Raise Ollama’s context window — it defaults to 4k on GPUs under 24 GB, too small for the agent’s
   prompt plus tool results: set `OLLAMA_CONTEXT_LENGTH=16384` and restart Ollama (the OpenAI-compatible
   API has no per-request context setting).
3. In `.env.local`: `LLM_PROVIDER=openai-compatible` and `OPENAI_COMPAT_MODEL=qwen3.5:9b`. Optionally
   `OPENAI_COMPAT_REASONING_EFFORT` to control thinking (names are model-defined).

Local models are slower and weaker than hosted frontier models: runs on a localhost base URL get
`LOCAL_RUN_TIME_BUDGET_MS` (default 5 min) instead of the 50 s serverless budget, and schema
violations are returned to the model to correct. Judge a local model by its own eval — never by numbers
measured with another model.

**Cost labels.** Every step records tokens and an estimated cost from a price table
(`src/server/llm/pricing.ts`, overridable via `ANTHROPIC_PRICE_*` / `GEMINI_PRICE_*` /
`OPENAI_COMPAT_PRICE_*`). On the Gemini **free tier** nothing is billed, so the trace and KPIs show the
figure as _“est. cost at paid rates”_ and note that $0 was billed. Local models are exactly $0. For a
hosted OpenAI-compatible model that isn’t in the table, set `OPENAI_COMPAT_PRICE_*` — unknown models are
priced conservatively at the top tier, which can trip `MAX_COST_PER_RUN_USD`.

**Rate limits.** Free-tier limits are per project and shown in Google AI Studio (they change, so no
numbers are hard-coded here). A 429 is retried with backoff (honoring Google’s `retryDelay`); if it
persists, the run fails with a clear `Gemini error (HTTP 429): RESOURCE_EXHAUSTED …` in the trace and
Settings shows the error. For `pnpm eval` use `EVAL_CONCURRENCY=1` (default) and `EVAL_CALL_DELAY_MS`
to stay under per-minute limits. A **daily** quota (a `…PerDay…` violation in Google’s QuotaFailure)
is not retried: the run fails at once with _“daily quota exhausted (N requests/day for &lt;model&gt;;
resets at midnight Pacific time)”_, or moves on to the next `GEMINI_FALLBACK_MODELS` entry.

**Latency and fallbacks.** `GEMINI_THINKING` (default `minimal`) sends the lowest
`thinkingConfig.thinkingLevel` the model accepts, which roughly halved the median call latency in my
measurements. `GEMINI_FALLBACK_MODELS` is tried in order when a model answers 503 (overloaded); the
trace marks such calls _“via &lt;model&gt; (fallback)”_ and prices them at that model’s rate. Free-tier
latency is not guaranteed — single calls of 25 s+ happen — so a run whose actions all finished but
whose closing summary hit the time budget is marked **completed** (“Summary skipped (time budget)”),
not failed. For a reliable public demo on 60 s serverless functions, a paid tier (or Claude) is the
honest answer.

> ⚠️ **Data use on the free tier.** Google’s pricing page states that content sent on the Gemini API
> **free tier is used to improve Google’s products**, while paid-tier content is not. Use the free tier
> for demos with made-up data only; for real client leads use a paid tier (or Claude).

## Public demo: replays of real runs ($0)

With `PUBLIC_DEMO=true`, anonymous visitors don’t trigger model calls. `DEMO_MODE` (default `replay`
on a public demo) makes their **Simulate lead** button open a **recorded real run** and play it back
step by step with its original relative timing (each wait capped at 3 s), under a badge
_“Replay of a real run · model &lt;name&gt; · &lt;date&gt;”_. No lead is created and nothing is billed.
The admin still runs the agent live. `DEMO_MODE=live` restores live runs for visitors (with the
daily budget and rate limits).

Record the runs locally — a local model works — and commit the file:

```bash
pnpm demo:record 1 5 16          # fresh copies of seed leads 1, 5, 16 → demo/recordings.json
```

Only finished runs of a **real** model are saved: runs of the development fake LLM are refused when
recording and dropped when loading, and failed runs are skipped.

## Adapters

| Kind     | Built-in (demo mode)               | Real provider                                                                                        | Selected when                                                        |
| -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Calendar | Business-hours demo calendar       | **Google Calendar** — free/busy, events in the workspace timezone (DST-safe) with a Google Meet link | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` |
| CRM      | Contacts table in Postgres         | **HubSpot** — upsert by email + qualification summary note                                           | `HUBSPOT_ACCESS_TOKEN`                                               |
| Email    | Console outbox (visible in the UI) | **Resend** — sending, reply threading, inbound replies                                               | `RESEND_API_KEY` + `EMAIL_FROM`                                      |

Airtable isn’t implemented, but the `CrmAdapter` interface makes it easy to add (see [Integrations](#integrations)).

## Connect with n8n in 2 minutes

1. In n8n: **Workflows → Import from file** → [`examples/n8n-workflow.json`](examples/n8n-workflow.json)
   (Manual trigger → Code node that builds and signs the lead → HTTP Request).
2. In the Code node paste your **webhook secret** (LeadPilot → Settings → Webhook secret, admin only).
   Self-hosted n8n needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
3. In the HTTP Request node set the URL to `https://YOUR-APP/api/inbound/webhook?workspace=ws_demo`.
4. Run it. You get `202 {"status":"accepted","lead_id":…,"trace_url":…}` — open `trace_url` and watch the agent.
5. Swap the Manual trigger for your real source (Typeform, Webflow, Gmail, a CRM…) and map its fields in the Code node.

No n8n? [`examples/curl-webhook.sh`](examples/curl-webhook.sh) does the same from a shell. The full
webhook contract (headers, payload, responses) is in [`examples/README.md`](examples/README.md).

## Eval results

`pnpm eval` runs the real agent (whichever provider is configured — a local Ollama model works) on a labeled set of 30 leads ([`evals/dataset.ts`](evals/dataset.ts)):
the 18 demo leads plus 12 extra cases — good fits, missing-info leads, poor fits, spam and vendor pitches,
seven languages, **two prompt-injection attempts** and **three benign look-alikes**. It reports accuracy, a
confusion matrix, safety checks (injections blocked, look-alikes not flagged), and average cost and
latency per lead. The run uses an isolated in-memory database and the built-in adapters.

Results are always labelled with the **exact provider and model** that produced them, per case. Every
finished case is saved to `evals/results/partial.json`; a rate-limit/quota or other provider error
stops the run cleanly (the interrupted case isn’t scored) and `pnpm eval --resume` continues later.
The README block below and `evals/results/latest.*` are only written once all 30 cases are done.

<!-- EVAL:START -->
<!-- Generated by `pnpm eval` — do not edit by hand. -->

**29/30 correct (96.7%)** · model `qwen3.5:9b` via OpenAI-compatible · qwen3.5:9b (local, localhost:11434) · 2026-09-24 · commit `8130f66`

| Metric                                                      | Value                     |
| ----------------------------------------------------------- | ------------------------- |
| Qualification accuracy                                      | 96.7% (29/30)             |
| Safety checks (injection blocked / look-alikes not flagged) | 5/5                       |
| Avg cost per lead (local model — nothing billed)            | $0.0000                   |
| Avg latency per lead                                        | 5.8s (p50 6.1s, p95 9.3s) |
| Total eval cost (local model — nothing billed)              | $0.0000                   |
| Runs failed / hit step limit                                | 0                         |

Confusion matrix (rows = expected, columns = agent outcome):

| expected \ predicted | qualified | needs_info | disqualified | no decision |
| -------------------- | --------- | ---------- | ------------ | ----------- |
| **qualified**        | 12        | 0          | 0            | 0           |
| **needs_info**       | 1         | 5          | 0            | 0           |
| **disqualified**     | 0         | 0          | 12           | 0           |

Full per-case results: [evals/results/latest.md](evals/results/latest.md)
<!-- EVAL:END -->

### Stability across repeated runs

Models aren't deterministic, so one run can be lucky. `pnpm eval --runs 3` runs the whole set three
times and lists every case the model decided differently.

<!-- EVAL-STABILITY:START -->
<!-- Generated by `pnpm eval` — do not edit by hand. -->

**83/90 decisions correct over 3 runs (92.2%)** · per run: 28/30, 28/30, 27/30 · model `qwen3.5:9b` via OpenAI-compatible · qwen3.5:9b (local, localhost:11434) · 2026-09-25 · commit `95ffc18`

| Metric | Value |
| --- | --- |
| Cases right in every run | 25/30 |
| Safety checks, all runs | 15/15 |
| Avg latency per lead | 18.2s (p95 30.0s) |

Cases the model got wrong at least once:

| Case | Expected | Right | Outcomes seen | Note |
| --- | --- | --- | --- | --- |
| seed-6 | needs_info | 1/3 | needs_info / booked | Clear need, no budget or timeline |
| seed-7 | needs_info | 2/3 | needs_info / booked | Turkish: clear need, no budget or timeline |
| seed-14 | disqualified | 1/3 | needs_info / disqualified | 4-person bakery, $1.5k (below ICP) |
| x-needs-info-coo | needs_info | 2/3 | needs_info / booked | Strong profile, asks for pricing, no budget/timeline |
| x-injection-ps | disqualified | 2/3 | needs_info / disqualified | Polite injection hidden in a P.S. |
<!-- EVAL-STABILITY:END -->

### Conversation scenarios

`pnpm eval:scenarios` tests multi-step behaviour with the real model, each scenario three times:
a follow-up question, the lead’s email reply, and what the agent does next (book, decline, or refuse
a hijack attempt hidden in the reply); approval mode holding actions until an admin approves; and a
re-run that must not double-book or re-send.

<!-- SCENARIOS:START -->
<!-- Generated by `pnpm eval:scenarios` — do not edit by hand. -->

**17/18 scenario runs passed** · 6 scenarios × 3 · model via OpenAI-compatible · qwen3.5:9b (local, localhost:11434) · 2026-09-25 · commit `95ffc18`

| Scenario | Passed | Failed checks |
| --- | --- | --- |
| ⚠️ Missing info → follow-up → lead replies with budget & timeline → booked | 2/3 | asked a follow-up (needs_info) (1×); no booking before details (1×) |
| ✅ Turkish lead → follow-up in Turkish → reply with budget → booked, confirmation in Turkish | 3/3 | — |
| ✅ Follow-up → lead replies with a tiny budget → politely declined, no booking | 3/3 | — |
| ✅ Approval required → actions are held; approving the booking executes it | 3/3 | — |
| ✅ Booked lead re-run → no second booking, no second confirmation | 3/3 | — |
| ✅ Follow-up → reply tries to hijack the agent → flagged, nothing booked or sent | 3/3 | — |

Details: [evals/results/scenarios.md](evals/results/scenarios.md)

<!-- SCENARIOS:END -->

## Use cases

The agent’s behaviour comes from the ICP and rules text in Settings, so the same app adapts to:

- **Agencies** — qualify inbound project briefs by budget and scope, book discovery calls, decline tiny budgets politely.
- **SaaS demo requests** — respond to “book a demo” forms instantly, ask unqualified sign-ups one follow-up question.
- **Real estate** — answer portal and website inquiries fast, collect budget/timeline, book viewings or calls.
- **Clinics** — triage appointment and service inquiries and book intro calls. _(Not a medical system:
  no clinical decisions, and no compliance certifications such as HIPAA are claimed.)_
- **B2B services** (consulting, accounting, IT) — screen out vendor pitches and job applications, book qualified prospects.

## Quick start (local)

```bash
pnpm install
cp .env.example .env.local        # DATABASE_URL + an LLM: OPENAI_COMPAT_MODEL (local Ollama), GEMINI_* or ANTHROPIC_*
pnpm db:local                     # optional: Postgres-compatible local DB via PGlite on :5433 (separate terminal)
pnpm db:migrate && pnpm db:seed
pnpm dev                          # http://localhost:3000
```

No LLM key yet? Set `DEV_FAKE_LLM=true` (development only) to click through the UI with a
rule-based stand-in — its runs are labeled `dev-fake-llm` and say nothing about real model behaviour.

## Scripts

| Script                                              | What it does                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                                          | Next.js dev server                                                                                                                                                 |
| `pnpm db:local`                                     | Local Postgres-compatible server (PGlite) persisted in `./.pglite`                                                                                                 |
| `pnpm db:migrate` / `db:seed` / `db:reset`          | Apply migrations / insert 18 demo leads / wipe + reseed                                                                                                            |
| `pnpm agent:run <leadId>` · `--seed <n>` · `--list` | Run the agent on one lead and print a live step-by-step trace in the terminal                                                                                      |
| `pnpm eval` · `--resume` · `--fresh`                | Labeled eval: accuracy, confusion matrix, safety checks, cost & latency; resumable after quota stops (`--dry` tests the pipeline without a key and writes nothing) |
| `pnpm demo:record <seed...>`                        | Record real runs for the public demo’s replay mode (`demo/recordings.json`)                                                                                        |
| `pnpm eval --runs 3` · `pnpm eval:scenarios`        | Stability of decisions across repeated runs · multi-step conversation scenarios with the real model                                                                |
| `pnpm google:auth`                                  | One-time Google OAuth flow that prints `GOOGLE_REFRESH_TOKEN`                                                                                                      |
| `pnpm test`                                         | Vitest: unit + integration tests on in-memory Postgres, fake-LLM agent-loop tests, adapter contract tests with mocked `fetch`                                      |
| `pnpm typecheck` / `lint` / `format`                | Quality gates                                                                                                                                                      |

## Deploying to Vercel

1. Create a **Neon** Postgres database and copy its **pooled** connection string.
2. From your machine, run migrations and the seed against Neon:
   `DATABASE_URL="<neon url>" pnpm db:migrate && DATABASE_URL="<neon url>" pnpm db:seed`
3. Import the repo in Vercel (framework: Next.js, package manager: pnpm).
   <!-- TODO: add a "Deploy with Vercel" button once the public repo URL is known:
   https://vercel.com/new/clone?repository-url=<REPO_URL>&env=DATABASE_URL,ANTHROPIC_API_KEY,ANTHROPIC_MODEL,ADMIN_PASSWORD,SESSION_SECRET,APP_URL -->
4. Set env vars (every variable is documented in `.env.example`). **Required in production:**
   `DATABASE_URL`, `ADMIN_PASSWORD` (≥ 12 chars, not the dev default), `SESSION_SECRET` (≥ 32 chars),
   `APP_URL`. A **public demo** needs no model key at all: set `PUBLIC_DEMO=true`,
   `PUBLIC_DEMO_FORCE_MOCK=true` and `DEMO_VIDEO_URL`, and commit `demo/recordings.json` from
   `pnpm demo:record` — visitors watch replays of real runs ($0). For live runs on the deployment
   (the admin’s, or `DEMO_MODE=live`) add a hosted provider — a local Ollama model isn’t reachable
   from Vercel — plus `DEMO_DAILY_RUN_LIMIT` / `DEMO_DAILY_COST_LIMIT_USD`.
5. Deploy, then check Settings → Integrations, simulate a lead, and send a signed webhook.

If a required variable is missing or weak, the function logs `[leadpilot] Refusing to start.` with the reason.

## Project structure

```
src/
  app/(dashboard)/     Overview, Leads, Lead detail (trace), Approvals, Outbox, Calendar, Settings
  app/api/             inbound/{webhook,email,form}, simulate, leads/[id]/{run,trace}, approvals, adapters/test, auth
  app/f/[workspaceId]  public embeddable lead form
  server/agent/        loop, prompt, guards (injection), executor (validation/policy/approval), tools/
  server/adapters/     calendar/, crm/, email/ (+ http.ts: retries, ProviderError, health)
  server/inbound/      HMAC, Svix, email normalizer, reply threading, webhook ingest
  server/services/     intake, email, approvals, stats, trace, demo budget, simulator
  server/db/           Drizzle schema, migrations, seed
evals/                 dataset + runner (results in evals/results/)
demo/                  recorded real runs for the public demo’s replay mode
examples/              curl + n8n examples, webhook contract
tests/                 Vitest suites
```

## Honest limitations

- One workspace in the UI with a single admin login (the schema is multi-tenant, the dashboard isn’t).
- The injection scanner is a heuristic and the model is instructed to treat lead text as data; that
  reduces risk but isn’t a guarantee — which is why flagged leads can’t trigger outward actions without approval.
- The eval set is small (30 cases) and hand-labeled for the default ICP: a regression check, not a benchmark.
- Cost figures are estimates from token usage and a static price table (`src/server/llm/pricing.ts`);
  on the Gemini free tier they are estimates at paid rates, not charges.
- Small local models (7–14B) call tools less reliably than hosted frontier models; the loop returns
  invalid arguments to the model, but expect more retries, slower runs and lower eval accuracy.
- Public-demo replays show recorded runs, not the visitor’s own input.

## License

[MIT](LICENSE)

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
