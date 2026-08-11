# Letena Content OS
## G. Build Sequence, Developer Backlog, Acceptance Criteria and Pilot Plan

Version 1.0 | 11 August 2026

---

### 1. Sequencing principle

Build the knowledge spine first, the demand sensor second, the factory third, distribution last. The reason is capacity, not preference: the factory is worthless without approved knowledge, and approving 20 knowledge cards is 6 to 8 weeks of clinical time that runs in parallel with engineering. Starting clinical drafting in week 1 is what makes the week 14 factory useful on the day it ships.

Two tracks run concurrently throughout.

```
ENGINEERING   R1 spine ──▶ R2 demand ──▶ R3 factory ──▶ R4 distribution ──▶ pilot
CLINICAL      card drafting ──▶ card approval ──▶ Amharic knowledge ──▶ review load-in
LANGUAGE           terminology seeding ──────────▶ Amharic knowledge ──▶ review load-in
```

### 2. Release plan

#### R1 Knowledge Spine — weeks 1 to 4

Ships: Postgres with the full schema, the API skeleton with auth and RBAC, the state engine, the knowledge module, the terminology module, the clinical review queue, versioning, audit, and the first four screens.

| # | Task | Est | Depends on |
|---|---|---|---|
| 1.1 | Repo scaffold, pnpm workspaces, CI pipeline, Docker Compose dev | 2d | |
| 1.2 | Prisma schema from `LCOS_03_schema.sql`, migrations, seed | 3d | 1.1 |
| 1.3 | Auth: email plus TOTP, sessions, refresh, revocation | 3d | 1.1 |
| 1.4 | RBAC plugin, permission table loading, endpoint decorators | 2d | 1.3 |
| 1.5 | State transition engine with guard registry and audit emission | 4d | 1.2, 1.4 |
| 1.6 | Knowledge module: sources, claims, claim sources, precedence | 4d | 1.5 |
| 1.7 | Knowledge module: cards, versions, card claims, myths, content hashing | 5d | 1.6 |
| 1.8 | Source supersession and card expiry cascades, tested | 2d | 1.7 |
| 1.9 | Terminology module and review | 3d | 1.5 |
| 1.10 | Review task engine, SLA, assignment, escalation | 4d | 1.5 |
| 1.11 | Web shell: auth, routing, role gating, layout, Amharic UI strings | 4d | 1.3 |
| 1.12 | Screen: Knowledge Library and Knowledge Card Detail | 5d | 1.7, 1.11 |
| 1.13 | Screen: Medical Claims and Medical Sources | 3d | 1.6, 1.11 |
| 1.14 | Screen: Clinical Review queue and review context panel | 5d | 1.10, 1.12 |
| 1.15 | Screen: Terminology | 3d | 1.9, 1.11 |
| 1.16 | Audit log write path plus read screen | 2d | 1.5 |
| 1.17 | Permission matrix test, every endpoint times every role | 3d | 1.4 |
| 1.18 | Staging deploy, Caddy, backups, monitoring | 3d | 1.1 |

**R1 acceptance criteria**

1. A clinician can create a source, create a claim citing it with a locator and quote, attach the claim to a card, submit the card, and approve it, entirely in the UI, without a developer.
2. Approving a card without a reviewer, without a claim, or with an unapproved claim is refused with a readable message naming the guard.
3. Editing an approved card creates a version and moves the card to `NEEDS_UPDATE`. The prior version remains readable.
4. Superseding a source moves every dependent claim and card to `NEEDS_UPDATE` within one transaction, verified by an automated test.
5. A user with the `developer` role receives 403 on every approval endpoint. Proven by the permission matrix test.
6. Every state change appears in the audit log with actor, from state, to state and reason.
7. The content hash on an approved card changes when the body changes, and the recorded approval no longer validates.
8. Restore from backup into an empty database reproduces the full schema and data, tested once.

#### R2 Demand Intelligence — weeks 5 to 8

Ships: ingestion, de-identification, classification, embeddings, clustering, priority and coverage scoring, the question screens and the coverage gap board.

| # | Task | Est | Depends on |
|---|---|---|---|
| 2.1 | `packages/deid`: deterministic pass, fixture corpus of 300 questions | 5d | |
| 2.2 | De-id NER and sweep agents, gateway integration, confidence scoring | 4d | 2.1, 3.1 |
| 2.3 | Ingest endpoint, HMAC, forbidden key rejection, batch tracking | 3d | 1.5 |
| 2.4 | CSV ingest path for surveys and events | 2d | 2.3 |
| 2.5 | letena.et outbound exporter (PHP side, in the existing codebase) | 4d | 2.3 |
| 2.6 | Quarantine queue and redaction screen | 3d | 2.2 |
| 2.7 | Question classifier agent plus classification write path | 4d | 3.1 |
| 2.8 | Embedding worker, pgvector index, semantic search endpoint | 3d | 1.2 |
| 2.9 | Clustering job with the topic and clinical-distinctness guards | 5d | 2.8 |
| 2.10 | Cluster split, merge, relabel and mark-distinct endpoints and screen | 4d | 2.9 |
| 2.11 | `packages/scoring`: priority formula, coverage states, golden fixtures | 4d | |
| 2.12 | Daily scoring job, snapshots, `v_coverage_gaps` | 3d | 2.11 |
| 2.13 | Screen: Questions, with filters and semantic search | 4d | 2.7 |
| 2.14 | Screen: Question Clusters | 3d | 2.10 |
| 2.15 | Screen: Coverage Gaps | 4d | 2.12 |
| 2.16 | n8n WF01 to WF05, exported and version controlled | 5d | 2.3 to 2.12 |

**R2 acceptance criteria**

1. A batch of 500 real anonymized questions ingests, de-identifies, classifies, embeds and clusters end to end in under 15 minutes.
2. The de-identification fixture suite reports 100 percent recall on injected identifiers. This is a release gate, not a target.
3. A question containing a forbidden key at the API boundary rejects the whole batch with a clear error, and no text is written to the database.
4. The database contains no column capable of holding raw question text, verified by a schema assertion test.
5. Two questions with different correct medical answers are not merged into one cluster, verified against a curated negative-pairs set of at least 40 pairs.
6. The coverage gap board loads in under 2 seconds and its top 10 rows are judged sensible by the content lead in a review session.
7. Changing a weight in `settings.priority.weights` changes the board on the next recompute with no deploy.

#### R3 Content Factory — weeks 9 to 14

Ships: concepts, scripts, claim validation, Amharic localization, language QA, risk routing, asset library, templates, Creatomate rendering, the review dashboard, and Turn Into Content.

| # | Task | Est | Depends on |
|---|---|---|---|
| 3.1 | Agent Gateway: prompt loading, schema validation, PII assertion, cost | 5d | 1.2 |
| 3.2 | `ai_prompts` seeding and the prompt management screen | 2d | 3.1 |
| 3.3 | Agent eval harness and fixture sets for six agents | 5d | 3.1 |
| 3.4 | Content families and concepts, creative director agent | 4d | 3.1 |
| 3.5 | Screen: Content Factory and Creative Concepts | 4d | 3.4 |
| 3.6 | Script module, versions, script writer agent, `NEEDS_KNOWLEDGE` path | 5d | 3.4 |
| 3.7 | Claim validator agent plus the deterministic overlay | 6d | 3.6 |
| 3.8 | Seeded-defect test suite for the validator, 120 scripts | 4d | 3.7 |
| 3.9 | Amharic localizer, back translator, drift scoring | 5d | 3.6 |
| 3.10 | Language QA agent and deterministic Amharic checks | 4d | 3.9 |
| 3.11 | Screen: Script Review, Language Review, with the claim map panel | 6d | 3.7, 3.10 |
| 3.12 | Risk tier computation and routing rules | 3d | 3.7 |
| 3.13 | Asset library: upload, presigned URLs, tagging, semantic search | 5d | 1.2 |
| 3.14 | Asset rights, consent and expiry tracking plus the clinical asset gate | 3d | 3.13 |
| 3.15 | Video templates and template variables, Creatomate templates built | 5d | |
| 3.16 | Production router and job creation | 4d | 3.12, 3.13 |
| 3.17 | Creatomate submission, render polling worker, R2 storage | 5d | 3.15 |
| 3.18 | Screen: Production Queue, Asset Library, Video Review | 6d | 3.17 |
| 3.19 | Turn Into Content pipeline endpoint and UI | 4d | 3.4 to 3.16 |
| 3.20 | n8n WF06 to WF15 | 8d | 3.4 to 3.18 |

**R3 acceptance criteria**

1. From an approved knowledge card, one click produces 4 distinct concepts, and no concept references a claim id outside the card's claim set.
2. The seeded-defect validator suite detects 100 percent of BLOCKER defects and produces under 10 percent false blockers on the clean set. This gates the release.
3. A script containing an unsupported statement cannot reach `APPROVED` by any route, including a direct API call by an admin.
4. `NEEDS_KNOWLEDGE` correctly fires on a card deliberately missing a required fact, and creates a clinical review task naming the missing fact.
5. An Amharic script with a seeded meaning change (a negation removed, a 72 hour window changed to 3 days) is caught by the deterministic checks, not only by the agent.
6. A clinician can complete a Tier 3 script review in under 5 minutes with everything needed on one screen, measured in a timed session with a real clinician.
7. A render completes end to end from approved script to reviewable MP4 in under 10 minutes for the V01 template.
8. A medical illustration cannot be generated. The attempt is refused by the agent and blocked by the database constraint.
9. Turn Into Content takes an anonymized question and produces concepts, scripts and a review queue entry with a single click by the intake coordinator.

#### R4 Distribution and Learning — weeks 15 to 20

Ships: platform publishing, analytics collection, the three scores, experiments, cost observability, the dashboard.

| # | Task | Est | Depends on |
|---|---|---|---|
| 4.1 | Platform accounts, credential references, token expiry monitoring | 3d | |
| 4.2 | Publishing jobs, approval gate, calendar, platform copy variants | 4d | 3.17 |
| 4.3 | Telegram adapter | 2d | 4.1 |
| 4.4 | Meta adapter (Instagram Reels, Facebook Reels) | 4d | 4.1 |
| 4.5 | YouTube adapter | 3d | 4.1 |
| 4.6 | TikTok adapter, starting with upload-for-review | 4d | 4.1 |
| 4.7 | Screen: Publishing Calendar and Published Content | 5d | 4.2 |
| 4.8 | Analytics collection workers per platform, honest null handling | 5d | 4.3 to 4.6 |
| 4.9 | letena.et aggregate feed for consultation and referral attribution | 3d | 4.8 |
| 4.10 | Three score formulas with percentile normalisation and confidence | 4d | 4.8 |
| 4.11 | Screen: Analytics, with the family rollup view | 5d | 4.10 |
| 4.12 | Experiments module and screen | 4d | 4.10 |
| 4.13 | Cost rollup, cost per piece, cost dashboard | 3d | 3.1, 3.17 |
| 4.14 | Screen: Dashboard | 4d | all |
| 4.15 | Screen: System Settings, Users and Roles, Audit Log | 4d | 1.16 |
| 4.16 | n8n WF16 to WF20 | 6d | 4.2 to 4.13 |
| 4.17 | Production hardening, spend caps, dead letter dashboard, runbook | 4d | all |

**R4 acceptance criteria**

1. A render approved at 09:00 publishes to Telegram, Instagram, Facebook and YouTube on schedule, with the correct per-platform copy, and appears as four `published_content` rows sharing one `family_id`.
2. Publishing is blocked when the underlying knowledge card is no longer approved, verified by retiring a card with a scheduled job pending.
3. Analytics for a post shows exactly which metrics each platform returned and which it did not. No zeros stand in for missing data.
4. The three scores compute for a post with at least 10 comparable prior posts, and report `confidence: LOW` when they do not.
5. Cost per approved published piece appears on the dashboard, broken into AI, render and voice.
6. Killing the render provider mid-pipeline produces a dead letter with a replayable payload and an owner, and nothing is lost.
7. The dashboard loads the day's operational picture in under 2 seconds.

### 3. Parallel clinical and language track

| Week | Clinical | Language |
|---|---|---|
| 1 to 2 | Agree the source hierarchy. Load FMoH guidance, WHO, UNFPA into `medical_sources` with precedence. | Seed 150 terminology entries for the six pilot topics from existing Letena scripts. |
| 3 to 6 | Draft claims for the 20 pilot cards. Target 6 to 10 claims per card. | Review and approve terminology. Agree the loanword list. |
| 7 to 10 | Approve claims. Draft card bodies including prohibited claims, referral conditions, urgent conditions and approved CTAs. | Draft Amharic canonical answers for the 20 cards, authored in Amharic rather than translated. |
| 11 to 14 | Approve all 20 cards. Set risk tiers. Set review intervals. | Approve Amharic knowledge. Build the negative examples file for the localizer. |
| 15 to 16 | Review load-in: run 20 test scripts through the review queue, time them, tune the SLA. | Same for language review. |
| 17 to 20 | Pilot review load. | Pilot review load. |

The clinical track is the critical path from week 7 onward. If card approval slips, the pilot slips, and no amount of engineering recovers it. Protect two half-days a week of clinical time from week 3.

### 4. The 20-card pilot backlog

Chosen for demand volume, myth density and consultation relevance. Codes match the full 100-card backlog.

| # | Code | Question | Topic | Tier | Why in the pilot |
|---|---|---|---|---|---|
| 1 | EC-001 | What is emergency contraception? | EC | 3 | Foundation card for the highest-demand topic |
| 2 | EC-002 | How soon should emergency contraception be taken? | EC | 3 | Time window, the classic drift failure |
| 3 | EC-003 | Does emergency contraception cause abortion? | EC | 3 | The dominant myth |
| 4 | EC-004 | Can emergency contraception cause infertility? | EC | 3 | The dominant fear |
| 5 | EC-005 | Can emergency contraception be used more than once? | EC | 3 | High repeat-use question volume |
| 6 | CON-001 | How do condoms prevent pregnancy? | CON | 2 | Highest volume male-audience entry point |
| 7 | CON-004 | What should someone do if a condom breaks? | CON | 3 | Urgent, actionable, links to EC |
| 8 | CON-008 | Does the pill cause infertility? | CON | 2 | Myth blocking uptake |
| 9 | CON-011 | Can the implant change bleeding patterns? | CON | 3 | Named in the brief as a live coverage gap |
| 10 | CON-012 | Does an implant cause infertility? | CON | 2 | Paired with 9, discontinuation driver |
| 11 | PREG-002 | How soon can a pregnancy test work? | PREG | 3 | Anxiety peak, timing sensitive |
| 12 | PREG-003 | Why can a pregnancy test be negative when a period is late? | PREG | 3 | High volume, high confusion |
| 13 | PREG-006 | Can pregnancy happen during menstruation? | PREG | 2 | Perennial myth, strong visual format fit |
| 14 | PREG-008 | Can withdrawal reliably prevent pregnancy? | PREG | 2 | Widespread practice, low knowledge |
| 15 | MEN-002 | Why can a period be late? | MEN | 2 | Highest raw volume of any question |
| 16 | MEN-005 | When can pregnancy occur during the menstrual cycle? | MEN | 2 | Anchors the V04 visual explainer |
| 17 | STI-002 | Can someone have an STI without symptoms? | STI | 3 | Testing behaviour driver |
| 18 | STI-004 | How can STI risk be reduced? | STI | 3 | Practical, links to condoms and testing |
| 19 | HIV-002 | How is HIV not transmitted? | HIV | 3 | Stigma reduction, high share potential |
| 20 | HIV-006 | What is the HIV testing window period? | HIV | 3 | Time window, testing behaviour |

Format and language plan per card: 4 treatments times 2 languages equals 160 candidate pieces.

| Card group | Treatment 1 | Treatment 2 | Treatment 3 | Treatment 4 |
|---|---|---|---|---|
| EC cards | V01 Question explainer | V02 Chat story | V03 Illustrated scenario | C01 Carousel |
| CON cards | V01 | V02 | V04 Medical visual | C01 |
| PREG cards | V01 | V03 | V04 | C03 Telegram post |
| MEN cards | V01 | V04 | V03 | C01 |
| STI and HIV cards | V01 | V05 Digital presenter | V02 | C03 |

Selection target: the team publishes 40 to 60 of the 160. Generating abundance and selecting hard is the point. Rejection rate is a metric, not a failure.

### 5. The 30-day pilot

**Runs weeks 17 to 20.** Publishing on the normal Letena cadence, 5 pieces per week per platform, drawn from the selected pool.

**Measured per piece**

topic, knowledge card, risk tier, format, hook type, language, duration, audience segment, platform, posting time, 3-second view rate, completion rate, shares, saves, comments, questions generated in the 72 hours after posting, consultation actions attributed, clinician minutes spent on review, AI cost, render cost, time from concept to publish.

**Measured for the system**

| Metric | Target |
|---|---|
| Pieces generated | 160 |
| Pieces published | 40 to 60 |
| Unsupported claims reaching publication | 0 |
| Validator false blocker rate on clean scripts | under 10 percent |
| Amharic scripts requiring full rewrite | under 25 percent |
| Median concept to approved render | under 48 hours |
| Clinician minutes per approved piece | under 12 |
| Dead letters unresolved at end of pilot | 0 |
| Commissioned pieces traceable to a ranked gap | 80 percent |
| Cost per approved published piece | measured, reported, no target |

**Deliberate experiments during the pilot** (one variable each, per the experiment framework):

1. Same script, Amharic hook versus English hook, on TikTok, primary metric 3-second view rate.
2. Same knowledge card, V01 explainer versus V02 chat story, primary metric completion rate.
3. Same script, question-first hook versus fear-first hook, primary metric shares.
4. Same content, posting 20:00 versus 22:00 EAT, primary metric reach.

Four experiments over 30 days is the honest limit at Letena's publishing volume. Running more would produce numbers without confidence.

**Pilot review at day 30** produces: a go or no-go on scaling to 100 cards, a revised priority formula if the board did not match clinical judgement, a revised set of prompts based on validator and language editor findings, and a decision on whether Amharic AI voice passed the blind listening test.

### 6. Path from 20 cards to 100

| Phase | Cards | Weeks | Gate to enter |
|---|---|---|---|
| Pilot | 20 | 17 to 20 | R3 acceptance passed |
| Wave 1 | +25 (CON, PREG, MEN completion) | 21 to 28 | Pilot go decision, validator false blocker rate under 10 percent |
| Wave 2 | +25 (STI, HIV, FERT, SEX) | 29 to 36 | Clinical review load sustainable at under 15 minutes per card |
| Wave 3 | +20 (MAT, POST, HPV, YTH) | 37 to 44 | Amharic knowledge authored natively for at least 60 percent of cards |
| Wave 4 | +10 (SAFE and Tier 4 content) | 45 to 52 | Tier 4 governance rehearsed, second-reader process running, GBV content protocol signed off by the medical director |

Tier 4 content is deliberately last. Emergency, GBV and assault content carries the highest duty of care and should be produced by a system whose governance has been exercised on lower-risk content for six months first.

Throughput assumption at steady state: 15 to 20 published pieces per week from a library of 100 approved cards, with 30 percent of output being refreshes of high-performing content rather than new topics.

### 7. Team and effort

| Role | Commitment | Notes |
|---|---|---|
| Backend engineer | 1.0 FTE, weeks 1 to 20 | The main build |
| Frontend engineer | 0.8 FTE, weeks 3 to 20 | 25 screens |
| Automation engineer | 0.5 FTE, weeks 5 to 20 | n8n, workers, integrations |
| Medical director | 0.3 FTE, weeks 1 to 20 | Card approval is the critical path |
| Consulting doctors | 0.2 FTE each, weeks 3 to 20 | Claim drafting and review |
| Language editor | 0.5 FTE from week 3 | Terminology then Amharic knowledge, a hire to make |
| Content lead | 0.4 FTE throughout | Requirements, concept selection, pilot |
| Producer | 0.3 FTE from week 9 | Templates, assets, B-roll library |
| Intake coordinator | 0.2 FTE from week 5 | Question streams, quarantine queue |

The language editor is the one role that does not exist today and is required. Amharic quality is the difference between this system producing content Ethiopians watch and content that reads as translated. Appoint before week 3.

### 8. What could go wrong, and what has been designed against it

| Risk | Likelihood | Design response | Residual |
|---|---|---|---|
| Clinical approval does not keep pace | High | Claim-level reuse, tiered review, sampling, batched queue, protected clinical time | Real. Monitor weekly from week 3. |
| Amharic reads as translated | High | Native Amharic knowledge authoring, terminology database, back-translation drift, human veto | Reduced but present. The listening test at day 30 is the checkpoint. |
| The validator blocks too much and the team routes around it | Medium | False blocker rate is a tracked metric with a 10 percent ceiling, and the seeded-defect suite tunes it | Watch for out-of-system publishing. |
| Platform API access denied | Medium | Prepare-and-hand-off path always exists, TikTok starts manual | Low impact. |
| Cost per piece exceeds value | Medium | Cost recorded from R3, caps enforced at enqueue, template rendering over generative video | Measurable from week 9. |
| Nobody uses the coverage board | Medium | It is the commissioning entry point, and the 80 percent traceability target makes non-use visible | Behavioural, not technical. |
| A privacy incident | Low | Zone separation, no raw text column, forbidden key rejection, PII assertion before every AI call, quarantine on low confidence | Fails closed everywhere. |
| Scope creep into a patient-facing chatbot | Medium | Explicit non-goal in the product definition | Hold the line. |

### 9. Remaining specification to produce

This document set covers deliverables 1 to 12, 22 to 23, 26 in outline, 27 to 31, 33 to 36, 40 to 46. Still to write, in this order:

1. Screen-by-screen UI requirements for all 25 screens, with wireframes for the six that carry real complexity: Coverage Gaps, Knowledge Card Detail, Script Review, Language Review, Production Queue, Dashboard.
2. Clinical QA test cases, the full seeded-defect catalogue for the validator.
3. Language QA test cases, including the Amharic negation and time-window corpus.
4. Automation test cases, the 12 named failure paths end to end.
5. The Creatomate template specifications, variable by variable, for the six master templates.
6. The HeyGen integration detail including avatar consent documentation and the presenter labelling standard.
7. The runbook: on-call, dead letter triage, token rotation, restore drill.
8. Future roadmap beyond 100 cards: Afaan Oromo and Tigrinya, the Abeba app content surface, partner content syndication, and the research and evidence pipeline for the grant programme.
