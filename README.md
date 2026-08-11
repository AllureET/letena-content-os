# Letena Content OS

Medically governed SRH content system for Letena Ethiopia: real anonymized
questions → demand intelligence → approved medical knowledge → AI-generated,
claim-validated, Amharic-localized content → human review → production →
publishing → analytics → back to demand.

The governing rule, enforced in code and in the database: **AI repackages
approved medical claims and never authors one.** A script needing a fact with
no approved claim stops with `NEEDS_KNOWLEDGE` and files a task for the
clinical team.

Specification documents live in the Claude project (`claude/letena_content_os/`)
and in `docs/` where copied. This README is the run book.

## Quick start (zero credentials needed)

```bash
# Prerequisites: Node 22+, PostgreSQL 16 with pgvector (or use docker compose)
git clone <repo> && cd letena-content-os
npm install

# Database (local Postgres; or: docker compose up postgres)
createdb lcos
npm run migrate          # applies packages/db/migrations/*.sql
npm run seed:demo        # base seed + DEMO medical fixtures (clearly marked)

npm test                 # 53 tests: deid, scoring, governance, full e2e
npm run demo             # the 13-step acceptance demonstration, narrated
npm run api              # http://localhost:8080 — UI + API
```

Or entirely in Docker: `docker compose up` (Postgres + API + n8n; the API
container migrates and demo-seeds itself).

Sign in at http://localhost:8080 — demo accounts, password `letena-dev-2026`:

| Email | Role |
|---|---|
| admin@letena.local | Administrator |
| meddir@letena.local | Medical Director (approves cards, Tier 4) |
| doctor@letena.local | Consulting Doctor (Tier 3 scripts) |
| content@letena.local | Content Lead |
| language@letena.local | Amharic Language Editor |
| intake@letena.local | Intake Coordinator (Turn Into Content) |
| social@letena.local | Social Lead (publishing) |
| producer@letena.local | Producer (renders, assets) |
| dev@letena.local | Developer (operates; **cannot approve anything**) |

## Try the critical workflow in the UI

1. Sign in as `intake@letena.local` → Questions → the seeded Postpill question
   → **Turn into content**.
2. Sign in as `doctor@letena.local` → Scripts → open the `CLINICAL_REVIEW`
   script. The claim map shows every medical sentence with its claim and
   verdict; the Amharic sits beside its blind back-translation. Approve.
3. As `producer@letena.local` → Scripts → Produce → Production queue shows the
   render (mock Creatomate) → approve the render.
4. As `social@letena.local` → publish to Telegram (mock) → Published content →
   Analytics.
5. As `admin@letena.local` → Audit log shows the entire journey.

## Demo data vs production medical data

`npm run seed` seeds structure only: 20 pilot knowledge cards as DRAFT shells
with no claims. `npm run seed:demo` adds a DEMO source ("Letena DEMO fixtures
(not a medical authority)") and DEMO-prefixed claims approved by a fixture user
named "DEMO Clinician (fixture, not a real approval)". Every demo medical row
carries "DEMO DATA — not clinically approved for production" in its notes.
Before real use: real clinicians write real claims from real sources through
the UI, and demo fixtures are retired.

## Architecture (implemented)

```
apps/api        Fastify API + agent gateway + adapters + pipeline + admin UI
apps/web        No-build admin UI in the Letena EMR design language
packages/db     SQL migrations (51 tables, tested), seed, pool
packages/deid   De-identification (deterministic pass, span applier, PII gate)
packages/scoring Priority/coverage/3-scores/validator-overlay/risk-tiers (pure, tested)
integrations/letena-emr  Exporter + aggregates PHP for letenav2 (EMR-side)
n8n/            Importable thin orchestration workflows
scripts/demo.mjs The 13-step acceptance demonstration
```

Key properties, all covered by tests (`apps/api/test/e2e.pilot.test.mjs`):

- An unsupported medical statement FAILS validation and cannot reach APPROVED
  by any route, including admin.
- Tier 3/4 scripts require a clinician; Tier 4 requires the medical director,
  on both script and final render. Developers hold no approval permissions.
- PII is stripped in memory before storage; there is no raw-text column; a PII
  pattern in any outbound AI payload blocks the call (`BLOCKED_PII`).
- Retiring or expiring a knowledge card cancels scheduled publishes (DB
  trigger) and blocks new ones (publish-time re-check).
- A failed render cannot be approved; an unapproved render cannot be scheduled.
- Every state change writes an append-only audit row.
- Every AI call records prompt version, tokens, latency, cost and outcome.

## AI and adapter modes

`LCOS_AI_PROVIDER=MOCK|OPENAI|ANTHROPIC` — the mock is deterministic and does
real containment checking in the claim validator, so governance tests are
meaningful offline. `LCOS_ADAPTER_MODE=MOCK|LIVE` — mock renders write
placeholder files; live mode uses Creatomate, HeyGen, Kling (generative b-roll,
never anatomy), ElevenLabs (Amharic TTS, tiers 1–2 only), Gemini (images),
Canva (carousels), Telegram/Meta/YouTube/TikTok (publishing).

## letena.et EMR integration

The EMR already listens, triages and categorizes. LCOS rides that:
`integrations/letena-emr/lcos_export.php` (cron in letenav2) exports new
`unified_inbox` messages with category/urgency/language hints;
`lcos_aggregates.php` returns counts-only consultation attribution. Deploy
per `integrations/letena-emr/README.md` — verify EMR column names against the
live repo first (checklist inside).

## Tests

```bash
npm test                          # everything
node --test packages/deid/test/   # privacy suite alone
node --test apps/api/test/        # e2e + governance
```

## Production notes

Set real secrets in `.env` (never commit), put Caddy or nginx with TLS in
front, switch `LCOS_ADAPTER_MODE=LIVE` and `LCOS_AI_PROVIDER=OPENAI` or
`ANTHROPIC`, keep `pg_dump` nightly + PITR, and see `BUILD_STATE.md` for
what remains before production sign-off.
