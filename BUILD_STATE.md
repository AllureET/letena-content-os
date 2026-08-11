# BUILD_STATE — Letena Content OS

Authoritative resume point. Updated: 2026-08-11, session 2, increment 4.
Tests: 78/78 green. Demo: 14 steps green. DEPLOYED TO LETENAV2 (all byte-verified after commit): phase82 migrations, cron_lcos_export.php, cron_lcos_backfill.php (NEW: legacy questions history), api/lcos/aggregates.php, content_os.php (live), lcos_export + lcos_backfill registered in the dispatch allowlist, cron.yml schedules both every 15 min, and the LCOS credentials card is LIVE on letena.et/integration_credentials.php (lib/integration_creds.php registry edit; verified rendering with all three fields). Remaining to activate: run phase82 via run_updates.php, paste the three lcos creds into the live LCOS card, and host LCOS on a VPS as its own repo (letena-content-os; repo exists, private, code upload pending).

## Historical backfill (increment 4)

cron_lcos_backfill.php walks the legacy `questions` table (years of written
Q&A) NEWEST FIRST (owner instruction, Nate, Aug 2026: freshest demand should
drive the first months of content), bounded to an editable window, default 18
months. The window is the "Backfill window (months)" field on the LCOS
credentials card (blank = 18); widening it later makes the job resume digging
further back on its own. Lifetime trends do not need the export:
api/lcos/aggregates.php already serves lifetime coded-topic counts. 300 rows
per 15-minute run, question_text plus coded topic hints from the exact join
the content dashboard uses (consult.source_question_id -> category_tag ->
category.code, verified by reading lib/content_insight.php raw). State row
k='legacy_q' in lcos_export_state stores the LOWEST id exported (descending
walk; 0 = not started, first run sets ceiling to MAX(id)+1); advances only on
2xx; empty-text pages advance without a POST so the job cannot wedge. Same
privacy contract as the live exporter: never name/sex/age/location/city/
country/address/phone/username/passcode/user_id/remarks/answers. Channel from
social_media_platform, default WEBSITE. source_hash =
sha256(salt:legacy_q:id), a distinct namespace from inbox ids.

## Current phase

MVP core complete + breadth increment complete: publishing calendar and
automation sweeps, terminology + structured language review, asset library
with upload/search/generation, experiments + weekly report, security
hardening (rate limits, headers, TOTP).

## Engineering decisions taken this session

1. **Plain ESM JavaScript + Zod, not TypeScript.** No build step, `node --test`
   runner, runtime validation where it matters (agent outputs, requests).
   Mechanical TS migration remains possible; do not mix the two.
2. **npm workspaces, not pnpm.** One less tool.
3. **SQL-file migration runner** (packages/db/src/migrate.mjs), not Prisma.
   The tested 51-table schema IS the source of truth; Prisma added codegen
   weight without value here.
4. **No-build admin UI** (vanilla ES modules) in the Letena EMR design
   language, served by the API process. EMR tokens copied exactly
   (cetacean/fuzzy-wuzzy/marigold, risk pills, Poppins/Crimson Pro).
5. **Turn Into Content runs in-process**, not through n8n, at pilot scale.
   n8n does sweeps and schedules (thin HTTP nodes, no DB credentials).
6. **MockAIProvider does real containment checking** in the claim validator,
   so governance tests are meaningful with zero credentials.
7. **EMR-first ingestion**: category/urgency/language hints from letenav2's
   existing triage ride the ingest contract; classifier treats them as priors
   with a confidence boost; `emr_category_map` maps the canonical 17-category
   taxonomy to LCOS topics.
8. **Ethiopian production stack specced**: Creatomate (template render),
   HeyGen (presenter), Kling (generative b-roll, never anatomy), ElevenLabs
   (Amharic TTS, tiers 1-2 only), Gemini (images), Canva (carousels/statics).
   All behind adapters with mock + live modes.

## Completed

- Repo scaffold, npm workspaces, Docker Compose (postgres+api+n8n)
- Migrations: 0001 (full 51-table schema, tested), 0002 (EMR integration)
- Seed: base (users, 20 pilot DRAFT cards, 6 templates, platform accounts,
  11 agent prompts) + demo layer (DEMO-marked claims, EC-004/EC-005 approved
  by an explicit fixture clinician)
- packages/deid: deterministic pass, span applier, forbidden patterns,
  confidence — 18 tests green
- packages/scoring: priority, coverage states, 3 performance scores,
  deterministic validator overlay, risk tiers — 13 tests green
- API: auth (bcrypt+JWT), RBAC (table-driven), append-only audit, state
  machines with named guards (cards, claims, scripts)
- Agent gateway: prompt loading from ai_prompts, PII assertion (BLOCKED_PII),
  zod validation with one repair retry, ai_invocations recording
- Providers: Mock (deterministic), OpenAI, Anthropic; mock trigram embeddings
  making pgvector search/clustering work offline
- Modules: knowledge, demand (ingest/classify/cluster/priority/coverage),
  content (families/concepts/scripts/validate/localize/reviews/TIC),
  production (router/jobs/renders via adapters), distribution
  (publish/published/lineage/analytics/scores), platform (dashboard/audit/settings)
- Admin UI: login + 17 functional screens in EMR style (dashboard, questions,
  quarantine, clusters, coverage, cards+detail, claims, sources, gaps,
  families, concepts, scripts+review detail, review queue, production,
  assets, published, analytics, settings, audit)
- integrations/letena-emr: exporter + aggregates PHP + deploy README
- n8n: WF02/03 + WF05 importable JSON, pattern README
- scripts/demo.mjs: 13-step narrated acceptance demonstration — PASSES
- Tests: 53 total, all green (18 deid + 13 scoring + 22 e2e/governance)

## Verified end-to-end (the acceptance test)

Postpill question → ingest (name+phone stripped in memory) → classify (EC,
EC-004, hint-boosted) → cluster → Turn Into Content → 2 concepts → 2 scripts
→ claim validation PASS (and a seeded unsupported statement correctly FAILS
and stays blocked) → Tier 3 → Amharic + blind back-translation + drift →
doctor approves (dev/content refused) → mock Creatomate render → render
approval → publish-time card re-check → Telegram publish → lineage (card,
claims, reviewer) → analytics (honest nulls) → scores → demand recompute.

## Completed this increment (previously "next five")

1. DONE Publishing calendar (`GET /distribution/calendar`), due-jobs sweep
   (`POST /distribution/publish-due`), WF16 + WF17 importable n8n JSON,
   calendar UI screen
2. DONE Terminology CRUD + approve (language_editor gated) + screen;
   structured language review `POST /content/scripts/:id/language-review`
   (decision, naturalness, meaning gate, corrected Amharic creates an
   approved translation; completes the open LANGUAGE task; UI buttons on the
   script screen)
3. DONE Asset upload (base64 JSON, 8MB bound, consent guard), namespaced
   tags, pgvector semantic search + UI; generation path: asset_prompt_writer
   → Gemini (image) or Kling (video), lands INACTIVE with a producer review
   task; MEDICAL_ILLUSTRATION refused at the boundary (guard-tested)
4. DONE Experiments (create/variants/shape-guarded start/conclude) + screen;
   weekly editorial report `GET /analytics/weekly-report` via
   editorial_analyst, rendered on the Experiments screen
5. DONE Hardening: in-memory rate limits (login 10/15min/IP, generation
   30/h/IP), security headers incl. CSP, TOTP (RFC 6238 implemented in core,
   enroll/verify endpoints, login enforcement) — all tested

## Completed increment 3

1. DONE Voice governance gate: AI_TTS holds the production job at
   VOICE_PENDING until the Amharic translation is language-APPROVED; e2e and
   demo now include the language-review step before production
2. DONE `POST /knowledge/sweep-expiry` (overdue APPROVED cards and claims →
   NEEDS_UPDATE, idempotent review tasks inside the 30-day window) + WF19 JSON
3. DONE `GET /analytics/costs` (AI by month, by agent with failure counts,
   renders by month, per-family from v_cost_per_piece) + Costs screen
4. DONE Users & roles admin: list/create (12-char minimum password)/grant
   role/deactivate with notSelf guard, deactivated users cannot log in,
   Users screen; all admin-gated and audit-logged
5. DONE **EMR schema VERIFIED against the live repo via Claude in Chrome**
   (db_migration_ai.sql read raw, byte for byte):
   - unified_inbox: `platform`, `raw_message`, `language_detected`,
     `received_at`, denormalized `triage_level`. NOT channel/message_text.
   - ai_triage_results: NO suggested_categories; the category signal is
     `extracted_topic` VARCHAR(255) free text
   - consult categories: coded JOIN model — `category` (code/label, e.g.
     UTI/OTHER, phase1_up.sql) + `category_tag` (consult_id, category_id);
     older `consult_category` exists in db_patient_model.sql
   Exporter and aggregates PHP rewritten against the real schema (aggregates
   introspects category_tag+category, falls back to consult_category);
   migration 0003 seeds extracted_topic slug mappings (31 total). PHP lint
   clean on both files.

## Next five tasks

1. Deploy the EMR exporter into letenav2 (Nate or a browser session: number
   the migration against the highest phaseNN, upload via GitHub web editor
   per EMR rules, register cron job, enter credentials via
   integration_credentials.php; note config/cron_auth.php must exist first)
2. WF12-style asset binding in the production router: search library for
   scene_plan asset_requirements and bind storage keys into the Creatomate
   payload (currently typography-only modifications ship)
3. Quarantine purge job (14-day rule) + questions text purge at 24 months
   (retention policy from LCOS_02 section 7)
4. Publishing platform variants: per-platform caption/title from
   script_versions.platform_variants applied on publishing jobs
5. Experiment variant auto-attach: link published_content into running
   experiments by family + variable, fill primary_metric_value on conclude

## Outstanding blockers (need Nate)
- Meta App Review / Business Verification still gates live Meta publishing
  (same blocker as the EMR webhooks; status as of 2026-08-03)
- TikTok Content Posting API application not started
- Live credentials: Creatomate, HeyGen avatar (consent!), ElevenLabs voice,
  Kling, Gemini, Canva — all optional, system runs MOCK without them
- Language Editor hire (pilot rule: every Amharic script sees the editor)

## Migration status

0001_init.sql + 0002_emr_integration.sql applied clean from zero. Runner
records in public.schema_migrations. Forward-only.

## Test status

`npm test` -> 74/74 green (last run this session).
`npm run demo` -> 14/14 steps complete (includes the language-review gate).

## Run instructions

```bash
createdb lcos && npm install && npm run migrate && npm run seed:demo
npm test && npm run demo && npm run api   # UI at :8080
```

## Continuation command

Say: **"Continue building LCOS from BUILD_STATE.md — start with the next five
tasks."** The repo is at `/home/claude/lcos` in the session workspace and the
full copy is archived in the Claude project as lcos-repo snapshot; docs are in
`claude/letena_content_os/`.
