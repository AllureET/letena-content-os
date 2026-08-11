# letena.et (EMR) integration

LCOS does not recreate what the EMR already does. The EMR keeps ownership of:
message intake across all channels (`unified_inbox`), AI triage and language
detection (`ai_triage_results`), the canonical 17-category taxonomy on
consults, and consultation/referral counting. LCOS consumes those as hints and
aggregates through two small PHP files deployed into letenav2.

## Files

| File | Deploys to (letenav2) | Purpose |
|---|---|---|
| `lcos_export.php` | `api/cron/jobs/lcos_export.php` | Every 15 min: exports new inbox messages to LCOS ingest with category/urgency/language hints. Watermark advances only on success. |
| `lcos_aggregates.php` | `api/lcos/aggregates.php` | Counts-only endpoint LCOS calls daily for consultation and referral attribution. Never returns records. |
| `lcos_export_migration_up.sql` / `_down.sql` | `migrations/phaseNN_lcos_export_*` | Additive watermark table. Check the highest existing phase number first. |

## Deploy checklist (EMR house rules)

1. **Schema VERIFIED against the live repo 2026-08-11** (db_migration_ai.sql,
   phase1_up.sql, db_patient_model.sql): `unified_inbox` uses `platform`,
   `raw_message`, `language_detected`, `received_at`, denormalized
   `triage_level`; the category hint is `ai_triage_results.extracted_topic`
   (free text, slugified on export); consult categories are the coded
   `category` + `category_tag` join (aggregates endpoint prefers it, falls
   back to `consult_category`). No re-verification needed unless those files
   change.
2. Migration: number it against the highest existing `migrations/phaseNN_*`,
   apply via `run_updates.php`.
3. Credentials: enter `lcos_base_url`, `lcos_ingest_secret`, `lcos_hash_salt`
   through `integration_credentials.php` (the admin credentials page). Mint the
   secret fresh (`openssl rand -hex 24`); enter the same value in the LCOS
   `.env` as `LETENA_INGEST_SHARED_SECRET`. Never commit either.
4. Register `lcos_export` in `api/cron/dispatch.php` and add a 15-minute
   schedule to `.github/workflows/cron.yml` (UTC). Note: all EMR cron jobs
   fail closed until `config/cron_auth.php` exists — check that first.
5. Deploy via the GitHub web editor per the EMR deploy rules (upload path for
   new files, never paste-replace).

## What crosses the boundary

Exported: message text (de-identified at the LCOS gate, in memory),
channel, timestamp, `sha256(salt + inbox_id)`, category hint slugs,
triage level, language code.

Never exported: patient_id, consult_id, phone, platform_user_id, alias,
names, `message_summary` (may paraphrase PII), reply drafts.

LCOS additionally rejects any payload containing a forbidden key at the
boundary (422, whole batch, deliberately loud).
