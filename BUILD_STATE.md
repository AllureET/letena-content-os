# BUILD_STATE — Letena Content OS

Authoritative resume point. Updated 2026-08-14, working directly against
Nate's Mac checkout (/Users/natezewdu/Desktop/lcos, connected this session
via the device bridge), branch main, HEAD 7103682, clean, tracking
origin/main. The paragraph below dated 2026-08-12 was the previous
resume point and is left in place as history, not current status.

STABILITY + AUTOMATION FIXES SHIPPED 13-14 Aug, the day after the bulk-
generation ship below, in commit order: batch-size choice (100/250/500)
added to "Classify pending questions"; deploy.sh hardened three times over
(real SSH error surfaced instead of a blanket "not configured", switched
from root to lcossvc with a narrow sudo rule scoped to just restarting
lcos-api, retries a transient Postgres auth blip on migrate instead of
aborting the whole deploy after code already landed on disk); audit-log
crash on bulk classify/cleanup/commission fixed. ROOT CAUSE FOUND for
"every real AI call silently failing all night": Anthropic rejects the
temperature param on this model, provider.mjs no longer sends it. The
question_classifier prompt was given a schema-derived field guide injected
at call time, fixing recurring SCHEMA_FAIL errors. The classifier now reads
the full thread and the doctor's answer_text when a consult captured them,
not just the opening message (Nate caught this live: "are you sure youre
reading the back and forth and not just the original question"), and a new
is_genuine_question flag (migration 0010) quarantines greetings and bare
demographic replies ("Eshi", "Age 28 Addis Ababa") instead of feeding them
into the demand clusters. The EMR SSO hand-off endpoint was being rejected
by the global bearer-token check before its own signature check ever ran,
now exempted. topic_priority_scores had a uniqueness rule that a NULL
card/segment made into a no-op, letting duplicate rows pile up, fixed with
NULLS NOT DISTINCT plus a one-time dedupe (migration 0011). And
classify-pending now runs automatically every 5 minutes, so the backlog
clears without anyone needing a browser tab open.

EMR EXPORTER FIXED FOR REAL 14 Aug 2026 (letenav2 commit 3d4d747, local main,
NOT pushed yet -- Nate needs to run the push himself). The gap below was
flagged but the first pass at fixing it (13-14 Aug, letenav2 commits 5d4c305
through 9ad97bd) still read from `questions`/`answers`, which turned out to
be the OLD write path (live `questions` table holds 9 rows total). Traced
lib/consult.php end to end: the live doctor workspace and the coordinator's
inbox reply both write every message, patient inbound and doctor outbound,
into `consult_message` (letena_consult_add_inbound() / letena_consult_respond()).
cron_lcos_export_inquiries.php now reads consult_message FIRST for every
consult (opening = first inbound row, answer_text = last outbound row,
everything else rides in thread with role patient/doctor), keeping the
questions/answers-plus-letenaet_complete path as a fallback only for older
consults with no consult_message rows. No LCOS-side change needed --
migration 0004's thread/answer_text/consult_mode columns and the ingest
contract already cover this shape; verified against demand.mjs's
THREAD_ROLES/THREAD_KEYS/MAX_THREAD_SEGMENTS and the HMAC-over-raw-bytes
check, both unchanged and both already compatible. php -l clean. Once Nate
pushes letenav2 main, the classifier should start seeing real multi-turn
threads on live traffic within one export cycle.

Original gap (context, now fixed as of the paragraph above):
cron_lcos_export_inquiries.php on the EMR side guessed at table names
(consult_message, clarification_threads, answers) that did not exist
anywhere in the live emr_v2 codebase, so it silently fell back to exporting
the opening message alone for every written/chat consult reaching LCOS. The
classifier can use a full thread when it has one; almost none of the traffic
up to 14 Aug actually supplied one.

BULK GENERATION SHIPPED 2026-08-12 (Nate decision: "I don't want to have to
approve knowledge cards anymore... generate content automatically... human
approval each step of the way, IE script, ie video"). Root cause of "why do
I have to click one question at a time": classifyQuestion() only ever ran
per-question, on demand; the EMR backfill landed thousands of questions but
nothing swept them, so they piled up at DEIDENTIFIED and never reached a
cluster or the gap board (confirmed live: one cluster total, gap board
empty after recompute, against thousands ingested). planner.auto_commission
turned out to be dead: it only exists in the WF05 n8n doc, never wired into
the real API (Turn Into Content runs in-process by design, n8n was never
actually deployed for sweeps).
Two new pieces: POST /questions/classify-pending (apps/api/src/modules/
demand.mjs, cluster.manage-gated) walks up to 500 DEIDENTIFIED questions
newest-first per call and classifies them, which also triggers clustering
(assignCluster already runs inside classifyQuestion, so this alone
populates the cluster and gap boards). bulkCommission() + POST
/content/bulk-commission (apps/api/src/modules/content.mjs,
question.turn_into_content-gated) loops the top N (default 10, capped 25)
knowledge cards with real cluster demand behind them -- approved or not --
through generateContent() with the full active output-type spread (9
formats). Requires admin actor + approval.override=ADMIN_TEST_MODE to
reach unapproved cards, same door as the existing single-card override;
unapproved-card output carries is_test_content=true same as before.
Deliberately unchanged: resolveCardForGeneration()'s admin+test-mode guard,
and executePublish()'s card.status='APPROVED' re-check at publish time --
Nate confirmed clinical review still happens at script (EN+AM) and final
output (EN+AM) review, by medical and content teams, so the human
checkpoint moves later in the pipeline rather than disappearing. UI:
"Classify pending questions" button on Question clusters, "Generate
content now" button on Coverage gaps (apps/web/app.js). NOT run against a
live DB in this sandbox (no Postgres here) -- node --check clean on all
three files, verify live on lcos.letena.et after deploy the way every prior
increment this session was verified.

Authoritative resume point. Updated: 2026-08-12, session 2, increment 5 (domain, HTTPS, deploy key, menu link).
Tests: 78/78 green. Demo: 14 steps green. DEPLOYED TO LETENAV2 (all byte-verified after commit): phase82 migrations, cron_lcos_export.php, cron_lcos_backfill.php (NEW: legacy questions history), api/lcos/aggregates.php, content_os.php (live), lcos_export + lcos_backfill registered in the dispatch allowlist, cron.yml schedules both every 15 min, and the LCOS credentials card is LIVE on letena.et/integration_credentials.php (lib/integration_creds.php registry edit; verified rendering with all three fields). DEPLOYED TO PRODUCTION 2026-08-11 night: Hetzner CX23 "lcos-1", 204.168.161.47, Helsinki, Ubuntu 24.04. Bootstrap via cloud-init (scripts/bootstrap-hetzner.sh; two live fixes: dpkg --configure -a for a postgres configure race, ALTER ROLE lcos CREATEROLE for the 0001 role grants). Service lcos-api active, UI live at http://204.168.161.47:8080, ufw allows 22+8080, all secrets minted on-server in /root/lcos-handoff.txt. phase82 confirmed applied on the EMR (run_updates: 173 applied, 0 pending). Repo upload complete (61/61 files). PIPELINE VERIFIED LIVE 2026-08-12 ~00:40 EAT: EMR exporter and legacy backfill both delivering 202-accepted batches to lcos-1. Fixed in the process: ingest HMAC now verified over RAW request bytes (PHP json_encode escaping differs from JSON.stringify; JS-only tests had masked it); admin password operator-set via scripts/reset-admin.mjs; ingest secret operator-set via scripts/set-ingest-secret.mjs (transcription-proof). DOMAIN + HTTPS LIVE 2026-08-12 ~03:00 EAT: lcos.letena.et A 204.168.161.47 added in the Ethio Telecom Hosting Portal (myportal.ethiotelecom.et, DNS module racent_zdns; the REAL zone lives there, NOT in Plesk, whose subscription has no DNS management; Plesk-created subdomains do land in that zone, which is how test.letena.et got there). Caddy 2.6.2 from Ubuntu universe on lcos-1, /etc/caddy/Caddyfile is just `lcos.letena.et { reverse_proxy 127.0.0.1:8080 }`, Let's Encrypt cert auto-issued, ufw allows 80+443, https://lcos.letena.et serves the UI. EMR card lcos_base_url updated to https://lcos.letena.et (saved 23:51 UTC); content_os.php shows connected with the HTTPS button. Content app sidebar now has a Content OS item (lib/content_nav.php, gated content.dashboard). Deploy key DONE: ed25519 key on lcos-1, added read-only to the GitHub repo (fingerprint SHA256:AnAJtRy50tO/DaHUYh3GwO226K8S/y+TIv1UjKtcXso); /root/.ssh/config aliases Host gh -> github.com, remote origin is gh:AllureET/letena-content-os.git, `git -C /opt/lcos pull` works with NO visibility flips ever again. Console craft learned the hard way: the Hetzner web console DROPS ALL MODIFIERS (every shifted symbol types as its unshifted key: @>2, :>;, {>[ etc.; Ctrl combos type the bare letter, so Ctrl+D never works) AND drops keystrokes beyond ~170 chars per typing burst. File delivery recipe that works: type `dd of=/tmp/x.hex bs=1 count=N` (N = exact byte count INCLUDING newlines; exact count replaces EOF), type hex in short bursts, then `xxd -r -ps /tmp/x.hex /target` — but rm the target first, xxd -r does NOT truncate. Verify with sha256sum. A stuck dd can only be cleared by the console's Ctrl+Alt+Del button (graceful VM reboot; root must log back in). Remaining: verify first ingest 202 arriving via https://lcos.letena.et (next cron), then optionally ufw deny 8080; team passwords in the LCOS Users screen; optional cleanup of the now-unused lcos subdomain + app.js relay inside Plesk (DNS bypasses it entirely).

CRITICAL HOSTING FACTS (confirmed 2026-08-12 against the letena-emr-knowledge
skill and live phpMyAdmin): the LIVE docroot for letena.et IS the
test.letena.et folder (/data/var/www/vhosts/letena.et/test.letena.et);
httpdocs exists but is orphaned and unserved. The LIVE database is
letena_test_db (user letenaai1). letenaet_complete is the OLD pre-migration
system's database, stale since 2026-03, and the live DB user has NO access to
it (SELECT denied, verified). Never treat anything named test.letena.et as
disposable. The only Plesk folder safe to remove from this session's work is
lcos.letena.et (the abandoned relay: default site files + app.js).

THE 140-QUESTIONS MYSTERY, SOLVED 2026-08-12: LCOS's 140 questions are the
complete live dataset. unified_inbox had 153 messages ever (watermark
inbox=153); 140 had text (3 WHATSAPP + 5 TELEGRAM + 132 MANUAL_ENTRY over 3
batches). The live questions table holds only 9 rows (ids 1-103), so the
legacy backfill finished in ONE run (watermark legacy_q=1). The real written
Q&A archive is letenaet_complete.questions: 3,885 rows, 2025-03-03 to
2026-03-09, every one inside 18 months, with question_text populated, and an
answers table beside it. Import plan (awaiting Nate's go): grant the live DB
user read access to letenaet_complete in Plesk Databases > User Management,
then a cron_lcos_backfill_old.php walking letenaet_complete.questions
newest-first with watermark k='legacy_q_old', same privacy contract.

MOBILE UI SHIPPED 2026-08-12: lcos.letena.et admin UI is now responsive.
index.html gained a mobile drawer (fixed #mtop topbar + burger, #side slides
in under 860px, #navveil overlay, cards scroll tables horizontally, grid2
stacks, 16px inputs against iOS zoom); app.js shell() renders #mtop/#navveil
and a delegated click handler toggles body.nav-open. Deployed via deploy-key
pull + service restart; index.html references /app.js?v=2 for cache busting.

PLATFORM EXPORT SPECS SHIPPED 2026-08-12: 2026-sourced per-platform video
sizing (Instagram Reels, TikTok, Facebook, Telegram, plus generic
placeholders for YouTube/LinkedIn/X/Website) now lives in
lcos.platform_specs (migration 0008), admin-editable via
GET/PUT /api/v1/platform/specs (apps/api/src/modules/platform_specs.mjs),
matching the voice_lexicon table pattern. Wired into
POST /distribution/jobs: scheduling a render to a platform looks up that
platform's spec and runs evaluateContent() (pure, unit-tested), which flags
-- never blocks -- a render whose duration exceeds the platform's
recommended or max length, or whose aspect ratio does not match. The spec
and any warnings ride along on the publishing job's response and its
payload jsonb column, so nothing new to migrate on publishing_jobs itself.
11 new tests (evaluateContent unit tests + GET/PUT specs + the schedule-time
warning, both compliant and flagged cases); 102/102 green after the change.
Not yet wired: apps/web (a separate pass), and render-time dimension
selection in production.mjs/adapters (renders stay platform-agnostic today,
one render can serve several platforms via separate publishing_jobs rows,
so the spec lookup happens at schedule time where the platform is actually
known).

CREDENTIALS PAGE SHIPPED 2026-08-12 (Nate approved all three streams below):
the LCOS Settings screen now has an "API keys and providers" section, the
EMR-integration-credentials pattern: apps/api/src/creds.mjs (CRED_REGISTRY of
21 keys across AI generation / Production services / Publishing; cred() reads
DB-first env-fallback from lcos.settings rows keyed cred.<NAME> with
is_secret=true; loadCreds() cache refreshed at boot and on save),
GET/PUT /api/v1/platform/credentials (settings.manage gated, statuses only,
never values, audit-logged), provider.mjs/gateway.mjs/adapters/index.mjs all
read via cred() so saving a key or flipping LCOS_AI_PROVIDER/LCOS_ADAPTER_MODE
takes effect WITHOUT a restart. 78/78 tests green after the change. One
regression caught live: #navveil needed display:none outside the mobile media
query or it consumed a desktop grid cell. Note: Chrome autofill fills random
saved values into these inputs despite autocomplete=off; consider
autocomplete=new-password on secret inputs later.

OLD-ARCHIVE IMPORT SHIPPED 2026-08-12 ~12:05 UTC: cron_lcos_backfill_old.php
live in letenav2 (walks `letenaet_complete`.`questions` cross-schema,
newest-first 300/run, watermark k='legacy_q_old', source_hash namespace
sha256(salt:legacy_old:id), graceful exit-0 skip while the DB grant is
missing so runs never fail); registered as job=lcos_backfill_old in
api/cron/dispatch.php and scheduled every 15 min in cron.yml. Plesk grant
DONE: DB user letenaai1 changed from letena_test_db-only to "Any database"
(covers letenaet_complete; all within the same subscription). Expect the
~3,885-question archive to drain in ~13 cron cycles (~3.5 h). These batches
travel via https://lcos.letena.et, which doubles as the HTTPS-path proof.
The old DB's answers table is NOT exported yet; answers ride in with the
full-inquiry export v2 (update-capable ingest keyed by source_hash).
2. FULL-INQUIRY EXPORT V2 (Nate said go; his words: "export our past 2000
   full inquiries"): consult-level export covering BOTH started_mode written
   AND phone, carrying the whole back-and-forth (multi-turn patient/doctor
   thread), not just first message: for written consults assemble patient
   messages (unified_inbox / clarification threads) + doctor replies
   (answers); for phone consults the material is clinical notes, which is
   deeper PHI, so decide deliberately what phone consults contribute
   (candidates: category + ai_triage_results.message_summary + outcome, not
   raw notes) and flag to Dr. Ousman if in doubt.
   OWNER DECISION (Nate, 2026-08-12): clinical notes ARE approved as export
   material for phone consults. His reasoning: names etc are not shared, he
   wants the most accurate content engine possible from the data in hand,
   and the medical notes double as an accuracy check on generated content.
   So export note text through the same deid pipe (identifiers stripped on
   arrival, clinical substance kept), not summaries only. LCOS side: additive
   migration (thread jsonb / answer_text on audience_questions or a new
   inquiries table), ingest contract extension, deid every segment on
   arrival, same HMAC pipe. Doctor answers can seed knowledge cards.
   ai_triage_results.message_summary solves the "hello doctor" greeting
   problem for the summary field.

PRODUCT DIRECTION (Nate, 2026-08-12): first inbox messages are often just
greetings ("hello doctor", "can I ask a question"), so single-message export
is weak raw material. Wanted: consult-level export carrying the back and
forth and the doctor's ANSWER (see letena_test_db consult/answers/
clarification_threads; ai_triage_results.message_summary already distills
the real question). Design sketch: exporter v2 posts per-consult Q&A pairs
(summary or concatenated patient side + answer text), LCOS ingest contract
gains optional answer/summary fields (additive migration), same HMAC and
PII-stripping path; doctor answers can seed knowledge cards. Not built yet.

## Backfill + HTTPS verification outcome (12 Aug, afternoon)

VERIFIED FLOWING. After the Plesk grant (letenaai1 -> Any database, ~12:05
UTC) the old-archive job's probe passes and cron_lcos_backfill_old.php posts
up to 300 archive questions per 15-minute cycle. Dashboard questions_24h
climbed 140 -> 441 within the first cycles, heading toward ~4,000 over
~3.5h. journalctl on lcos-1 shows the ingest POSTs arriving with hostname
lcos.letena.et and remoteAddress 127.0.0.1, i.e. through Caddy over HTTPS,
which closes the pending HTTPS-path verification (earlier entries still show
the old direct 204.168.161.47:8080 path for contrast). letenav2 Actions
runs all green. Port 8080 can now be closed (ufw delete allow 8080/tcp);
offered to Nate, not yet executed.

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

## THE PIVOT (owner decision, Nate, 12 Aug 2026) — read this first

Nate's words: the per-piece multi-role review chain was "going overboard...
imaginary safeguards. Cancel that." The operating model is now: **doctors
approve FACTS once (knowledge cards); the machine generates, claim-checks
against the approved card, and content flows by `publishing.mode`**:

- `DRAFT_BATCH` (start mode): everything queues; ONE click approves the
  batch; each rendered item gets a Publish button (Telegram live) plus
  copy-caption and download for channels without API keys yet.
- `AUTO_EXCEPT_SENSITIVE`: tiers 1-3 self-approve, TIER_4 (abortion, GBV)
  still gets one human look.
- `FULL_AUTO`: everything from an approved card flows.

Mode is a Settings dropdown (migration 0005 seeds it; PUT /platform/settings
edits it). What did NOT get cut: deid at ingest (invisible, costs nothing)
and claim validation against approved cards (it is what makes automation
safe). SHIPPED AND LIVE 12 Aug: batch-approve endpoint
(POST /reviews/batch-approve, also clears succeeded renders' final look),
GET /distribution/queue aggregate, the Queue screen (approve all → produce
all → publish/copy/download → recently published), publishing-mode card in
Settings, Azure Speech + TikTok credential fields.

Also SHIPPED AND LIVE 12 Aug — ingest v2 (full inquiries): migration 0004
adds answer_text / answered_at / thread jsonb / consult_mode to
audience_questions; /ingest/questions accepts answer_text + thread
(role patient|doctor|note, strict shape, every segment through deidentify(),
one low confidence quarantines the whole row) and is UPDATE-CAPABLE on a
known source_hash (attaches answers/threads to rows ingested earlier as bare
text; quarantined records never update clean rows). 82/82 tests green.
Owner approved clinical notes as content material (role 'note').

ALSO SHIPPED AND LIVE 12 Aug — the basics knowledge library: 16 real
sources (3 WHO fact sheets, Ethiopian FMOH FP guideline 2020, 8 NHS pages,
4 CDC pages, every claim cited to a page actually fetched), 86 claims, all
20 pilot cards now carry claims + an EN canonical answer + an Amharic
canonical answer + key points + prohibited claims + referral conditions.
Data files packages/db/src/basics_facts.json + basics_amharic.json, seeder
seed_basics.mjs (npm run seed:basics, idempotent, never touches APPROVED).
Seeded on the server: everything IN_REVIEW. Doctors approve on the Cards
screen: per-card "Approve facts + card" or one "Approve all 20 + their
facts" button (POST /knowledge/cards/:id/approve-with-claims approves
attached claims the actor did not author, then runs the card through the
normal state machine so its guards still hold). Console gotcha learned:
`:` and `_` both drop on the Hetzner console; ran the seeder via
node + backtick-grep substitution.

Remaining owner asks captured 12 Aug (in flight):
1. DONE (see above) — basics knowledge cards await the doctors' click.
2. English-first UI everywhere (Nate cannot read Amharic): store an EN
   translation for Amharic text, show EN by default with the original a tap
   away; handle Amharish (Latin-script Amharic); TMEM stays on the roadmap.
3. Real drill-downs: dashboard tiles → filtered lists → question → full
   conversation view (data layer for this is ingest v2, done).
4. UI overhaul with the ui-ux-pro-max skill against the EMR brand kit
   (Nate: colors are token-matched but it doesn't feel like the EMR).
5. EMR-side full-inquiry exporter v2 (threads + answers + clinical notes
   for written AND phone consults) feeding ingest v2.
6. Publish-path niceties: OneDrive/accessible store for manual-channel
   packages (Nate: "maybe even storing it on our one drive").

What only Nate can do: enter ANTHROPIC_API_KEY on Settings → API keys; then
content generation goes real. (OpenAI support was removed 14 Aug 2026 --
the org has no OpenAI key -- so real embeddings still run on the mock
trigram fallback; only Anthropic-backed generation goes real.)

## Current phase

MVP core complete + breadth increment complete: publishing calendar and
automation sweeps, terminology + structured language review, asset library
with upload/search/generation, experiments + weekly report, security
hardening (rate limits, headers, TOTP). Pivot increment (above) live.

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
- Providers: Mock (deterministic), Anthropic (OpenAI support removed 14 Aug
  2026, no OpenAI key exists); mock trigram embeddings making pgvector
  search/clustering work offline (no provider here has real embeddings
  since AnthropicProvider has no embed() of its own)
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

## Next tasks (post-pivot order; items 1-6 in THE PIVOT section come first)

1. DONE Knowledge cards basics library (pivot item 1) — was the content
   blocker; bulk generation + the 13-14 Aug stability fixes above are what
   actually made it usable end to end.
2. English-first UI + drill-downs + ui-ux-pro-max pass (pivot items 2-4).
3. DONE 14 Aug 2026 — EMR full-inquiry exporter v2 (pivot item 5): fixed
   for real (see the paragraph near the top of this file), reads
   consult_message as the primary thread source. Committed locally in
   letenav2 (3d4d747); needs Nate to push before it takes effect on live
   traffic.
4. WF12-style asset binding in the production router: search library for
   scene_plan asset_requirements and bind storage keys into the Creatomate
   payload (currently typography-only modifications ship)
5. Quarantine purge job (14-day rule) + questions text purge at 24 months;
   experiment variant auto-attach; platform variants already apply on
   publishing jobs.

## Outstanding blockers (need Nate)
- Meta App Review / Business Verification still gates live Meta publishing
  (same blocker as the EMR webhooks; status as of 2026-08-03)
- TikTok Content Posting API application not started
- Live credentials: Creatomate, HeyGen avatar (consent!), ElevenLabs voice,
  Kling, Gemini, Canva — all optional, system runs MOCK without them
- Language Editor hire (pilot rule: every Amharic script sees the editor)

## Migration status

0001_init.sql through 0011_topic_priority_dedupe.sql, forward-only, runner
records in public.schema_migrations. As of 14 Aug: 0001 full schema, 0002
EMR integration, 0003 EMR topic slugs, 0004 full inquiries (thread/answer),
0005 publishing mode, 0006 translations + voice lexicon, 0007 admin
test-mode + output types, 0008 platform specs, 0009 tone presets, 0010
classifier full-thread + is_genuine_question, 0011 topic_priority_scores
dedupe. Applied live on lcos-1 through deploy.sh's migrate step.

## Test status

Last confirmed count was 102/102 green as of the platform-specs increment
(12 Aug), before the 13-14 Aug stability fixes above. Not independently
re-run as part of this update: neither this session's cloud sandbox nor the
device-bridge connection to Nate's Mac has a reachable Postgres to test
against. Whoever runs `npm test` next against a real DB should update this
line with the actual current count.

## Run instructions

```bash
createdb lcos && npm install && npm run migrate && npm run seed:demo
npm test && npm run demo && npm run api   # UI at :8080
```

## Continuation command

Say: **"Continue building LCOS from BUILD_STATE.md — start with the next
task."** The real, current repo is Nate's Mac checkout at
`/Users/natezewdu/Desktop/lcos` (connect it via the device bridge, on
branch main, remote origin -> github.com/AllureET/letena-content-os).
There is also an orphaned, stale clone at `/home/claude/lcos` in a cloud
session's own sandbox workspace with no git remote and no ssh binary
available; it forked from an earlier point in this repo's history and
diverged, do not use it as a source of truth or push from it, the Mac
checkout above is authoritative. Docs are in `claude/letena_content_os/`
in the Letena Ethiopia Claude project.
