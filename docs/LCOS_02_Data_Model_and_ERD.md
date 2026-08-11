# Letena Content OS
## C1. Data Model, ERD and State Machines

Version 1.0 | 11 August 2026 | Companion file: `LCOS_03_schema.sql`

---

### 1. Domain map

Fifty-one tables in six domains plus a platform domain. Every table lives in schema `lcos`. The schema file has been applied against PostgreSQL 16.13 with pgvector and produces 51 tables, 5 views, 29 enum types, 168 indexes, 122 foreign keys, 55 check constraints and 26 triggers.

| Domain | Tables |
|---|---|
| **Knowledge** | `medical_sources`, `medical_claims`, `claim_sources`, `knowledge_cards`, `knowledge_card_versions`, `knowledge_card_claims`, `knowledge_card_myths`, `topics`, `terminology`, `terminology_reviews`, `translations` |
| **Demand** | `ingest_batches`, `audience_questions`, `question_classifications`, `question_clusters`, `question_cluster_members`, `audience_segments`, `coverage_snapshots`, `topic_priority_scores` |
| **Content** | `content_families`, `content_concepts`, `scripts`, `script_versions`, `script_claims`, `script_findings` |
| **Production** | `assets`, `asset_tags`, `video_templates`, `template_variables`, `production_jobs`, `renders` |
| **Governance** | `review_tasks`, `clinical_reviews`, `language_reviews`, `users`, `roles`, `user_roles`, `permissions`, `role_permissions`, `audit_log` |
| **Distribution and learning** | `platform_accounts`, `publishing_jobs`, `published_content`, `content_performance`, `content_scores`, `experiments`, `experiment_variants` |
| **Platform** | `settings`, `ai_prompts`, `ai_invocations`, `workflow_events` |

### 2. Entity relationship diagram

```
                        ┌─────────────────┐
                        │ medical_sources │
                        └────────┬────────┘
                                 │ 1
                                 │
                          ┌──────▼───────┐        ┌────────────────┐
                          │ claim_sources│◀───────│ medical_claims │
                          └──────────────┘   n    └───────┬────────┘
                                                          │ n
                                            ┌─────────────▼──────────────┐
                          ┌────────┐   n    │  knowledge_card_claims     │
                          │ topics │◀───┐   └─────────────┬──────────────┘
                          └────────┘    │                 │ n
                                        │       ┌─────────▼────────┐  1   ┌──────────────────────┐
                                        └───────│ knowledge_cards  │─────▶│knowledge_card_versions│
                                                └───┬────────┬─────┘      └──────────────────────┘
                                                    │        │
                                    ┌───────────────┘        └──────────────┐
                                    │ 1                                   1 │
                       ┌────────────▼─────────┐                 ┌───────────▼──────────┐
                       │ knowledge_card_myths │                 │    translations      │
                       └──────────────────────┘                 └──────────────────────┘

  ┌────────────────┐ 1   n ┌────────────────────┐ 1   1 ┌─────────────────────────┐
  │ ingest_batches │──────▶│ audience_questions │──────▶│ question_classifications│
  └────────────────┘       └─────────┬──────────┘       └─────────────┬───────────┘
                                     │ n                              │ n
                     ┌───────────────▼────────────────┐               │
                     │    question_cluster_members    │               │ (knowledge_card_id, topic_id,
                     └───────────────┬────────────────┘               │  audience_segment_id)
                                   n │                                ▼
                          ┌──────────▼─────────┐            ┌───────────────────┐
                          │  question_clusters │───────────▶│ audience_segments │
                          └──────────┬─────────┘            └─────────┬─────────┘
                                     │                                │
                                     ▼                                │
                       ┌────────────────────────┐                     │
                       │ topic_priority_scores  │                     │
                       └────────────────────────┘                     │
                       ┌────────────────────────┐                     │
                       │  coverage_snapshots    │                     │
                       └────────────────────────┘                     │
                                                                      │
        knowledge_cards ──────────┐                                   │
                                  │ 1                                 │
                       ┌──────────▼──────────┐  n                     │
                       │  content_families   │◀───────────────────────┘
                       └──────────┬──────────┘
                                  │ 1
                       ┌──────────▼──────────┐ 1    n ┌──────────────┐ 1  n ┌───────────────┐
                       │  content_concepts   │───────▶│   scripts    │─────▶│ script_claims │
                       └─────────────────────┘        └──┬────┬──┬───┘      └───────┬───────┘
                                                         │    │  │                  │ n
                                            ┌────────────┘    │  └──────┐           ▼
                                            │ n               │ n       │ n   medical_claims
                                  ┌─────────▼────────┐  ┌─────▼──────┐  │
                                  │ script_versions  │  │script_find │  │
                                  └──────────────────┘  └────────────┘  │
                                                                        │
                       ┌────────────────────┐ n    1 ┌──────────────────▼───┐
                       │   review_tasks     │───────▶│  (script | render)   │
                       └────┬──────────┬────┘        └──────────────────────┘
                       1 │           1 │
        ┌─────────────────▼──┐  ┌───────▼────────────┐
        │  clinical_reviews  │  │  language_reviews  │
        └────────────────────┘  └────────────────────┘

  scripts ──1──▶ production_jobs ──n──▶ renders ──1──▶ publishing_jobs ──1──▶ published_content
                       │                    ▲                                       │ 1
                       │ n                  │ n                                     │ n
                       ▼                    │                              ┌────────▼─────────┐
                    assets ─── asset_tags   │                              │content_performance│
                       ▲                    │                              └──────────────────┘
                       │              video_templates ──1──n── template_variables
                       │                                                   ┌──────────────────┐
                    (R2 storage)                                           │  content_scores  │
                                                                           └──────────────────┘
  experiments ──1──n──▶ experiment_variants ──n──1──▶ published_content
  platform_accounts ──1──n──▶ publishing_jobs
  users ──n──n──▶ roles ──n──n──▶ permissions
  audit_log, workflow_events, ai_invocations reference every object polymorphically
```

### 3. Design rules applied throughout

1. **Codes are human, keys are machine.** Every governed object has a `uuid` primary key and a unique human code (`EC-001`, `EC-CLAIM-0042`, `LETENA_QA_30S_V1`). Clinicians talk in codes. Foreign keys use uuids.
2. **JSONB where the shape varies, columns where the shape is queried.** Classification confidence, scene plans, platform response bodies and template payloads are JSONB. Status, tier, language, audience, dates and scores are columns with indexes.
3. **Approvals are immutable rows, never boolean flags.** `knowledge_cards.status` says where it is now. `clinical_reviews` says who decided what, when, on what exact content hash.
4. **Content hashing guards approvals.** Every review row stores `content_sha256` of the reviewed payload. The API recomputes on publish. A mismatch invalidates the approval and blocks the transition. This is what stops a silent edit after sign-off.
5. **Versioning by append.** `knowledge_card_versions` and `script_versions` hold the full historical body. The parent row carries the current pointer. Published content stores the exact version numbers it used.
6. **Soft delete only where recovery matters.** Knowledge and content objects use `RETIRED` status rather than deletion. Questions and assets support hard delete for privacy and rights compliance.
7. **No orphan medical statements.** `script_claims` has a `NOT NULL` FK to `medical_claims`. A medically meaningful sentence with no claim cannot be recorded, so the validator's output is structurally forced to be complete.

### 4. State machines

#### 4.1 Knowledge card (`knowledge_cards.status`)

```
        ┌──────────────────────────── edit body ─────────────────┐
        ▼                                                        │
     DRAFT ──submit──▶ IN_REVIEW ──clinician approve──▶ APPROVED ─┘
        ▲                  │                              │  │
        │                  │ changes requested            │  │ review_due_at passed
        └──────────────────┘                              │  ▼
                                                          │ NEEDS_UPDATE
                                                          │  │ │
                                                          │  │ └─ resubmit ──▶ IN_REVIEW
                                                          │  ▼
                                                          └▶ RETIRED  (terminal)
```

| From | To | Who | Guard |
|---|---|---|---|
| DRAFT | IN_REVIEW | `content_lead`, `consulting_doctor`, `medical_director` | at least one claim attached, canonical question and answer non-empty, at least one source on every claim |
| IN_REVIEW | APPROVED | `medical_director`, or `consulting_doctor` when `risk_tier <= TIER_2` | every attached claim is `APPROVED`; `review_due_at` set; reviewer is not the last editor |
| IN_REVIEW | DRAFT | reviewer | comment required |
| APPROVED | NEEDS_UPDATE | system on expiry, or any clinician manually | none |
| APPROVED | DRAFT | blocked | edits create a new version and force NEEDS_UPDATE |
| any | RETIRED | `medical_director` | reason required; blocks all in-flight content on the card |

Critical guard: only `APPROVED` cards may be referenced by a `content_family` that reaches a publishing job. The check runs at three points: concept creation, script validation, and publish. Belt, braces and a third belt, because this is the failure that would matter.

#### 4.2 Medical claim (`medical_claims.status`)

Same five states. Additional rules:
- A claim cannot be `APPROVED` without at least one row in `claim_sources` whose source is `ACTIVE`.
- When a source moves to `SUPERSEDED`, every `APPROVED` claim citing it moves to `NEEDS_UPDATE` automatically and every `APPROVED` knowledge card holding that claim moves to `NEEDS_UPDATE`. This cascade is the mechanism that keeps guidance current when the Ministry publishes a revision.
- Claim text is immutable once approved. A correction is a new claim with `supersedes_claim_id` set.

#### 4.3 Script (`scripts.status`)

```
 DRAFT ──▶ VALIDATING ──┬──▶ VALIDATION_FAILED ──▶ DRAFT
                        │
                        └──▶ VALIDATED ──▶ LOCALIZING ──▶ LANGUAGE_REVIEW ──┐
                                              │                             │
                                              └──▶ (EN only, skip)          │
                                                                            ▼
                              ┌──────────────────────────────── CLINICAL_REVIEW  (Tier 3, 4)
                              │                                        │
                              ▼                                        ▼
                          APPROVED ◀───────────────────────────── (Tier 1, 2: auto on QA pass)
                              │
                              ├──▶ production_jobs
                              ├──▶ REJECTED (terminal)
                              └──▶ SUPERSEDED (a new version replaced it)

 Any state ──▶ NEEDS_KNOWLEDGE  (agent could not proceed without an unapproved fact)
              NEEDS_KNOWLEDGE ──▶ (knowledge card work) ──▶ DRAFT
```

The `NEEDS_KNOWLEDGE` state is a first-class outcome, not an error. It is the mechanism by which the content engine tells the clinical team what knowledge Letena is missing. Counting `NEEDS_KNOWLEDGE` events by topic produces the knowledge backlog automatically.

#### 4.4 Risk tier routing

`scripts.risk_tier` is inherited from the highest tier among the knowledge cards in the content family and can be raised manually, never lowered by automation.

| Tier | Content | Script gate | Final render gate | Sampling |
|---|---|---|---|---|
| 1 | Anatomy, cycle basics, general education | Automated claim validation only | Editorial approval | 10 percent monthly clinical audit |
| 2 | Contraception, STI prevention, myth correction | Automated claim validation plus language QA | Editorial approval | 25 percent clinical sampling, weekly |
| 3 | Symptoms, pregnancy testing, timing-sensitive advice | Clinician approves the script | Editorial approval | 100 percent script review |
| 4 | Urgent symptoms, GBV, sexual assault, abortion information, emergency conditions | `medical_director` approves the script | `medical_director` approves the final render | 100 percent both gates |

Tier 4 additionally requires: a referral or help-seeking instruction present in the script (validator check `MISSING_REFERRAL`), no comments-enabled publishing without a moderation plan flag, and a recorded second-reader on GBV and sexual assault content.

#### 4.5 Production job and render

```
production_jobs: QUEUED ─▶ ASSETS_PENDING ─▶ RENDERING ─▶ RENDERED
                    │            │              │            │
                    └────────────┴──────────────┴──▶ FAILED ──┴─▶ (retry ▶ QUEUED)
                                                        │
                                                        └─▶ CANCELLED (terminal)

renders: PENDING ─▶ SUBMITTED ─▶ PROCESSING ─▶ SUCCEEDED
                                     │              │
                                     ├─▶ FAILED     └─▶ review_tasks (FINAL_CONTENT)
                                     └─▶ TIMED_OUT
```

#### 4.6 Publishing

```
publishing_jobs: SCHEDULED ─▶ PUBLISHING ─▶ PUBLISHED
                     │            │             │
                     │            ├─▶ FAILED ───┤ (retry 3x)
                     │            └─▶ REJECTED  │ (platform said no, terminal, human queue)
                     └─▶ CANCELLED              └─▶ published_content row created
                                                    published_content: LIVE ─▶ RETRACTED
```

A publishing job cannot leave `SCHEDULED` unless: the render's `review_tasks` of type `FINAL_CONTENT` has decision `APPROVED`, the source knowledge card is still `APPROVED` at publish time, and the platform account token is valid. The knowledge card re-check at publish time is what stops a piece approved on Monday from publishing on Friday against guidance that was superseded on Wednesday.

### 5. Traceability chain

The system answers every question in the brief through one join path:

```sql
SELECT
  pc.platform, pc.platform_url, pc.published_at,
  r.id                AS render_id,     r.template_code,
  s.code              AS script_code,   s.language, s.version AS script_version,
  cc.code             AS concept_code,  cc.video_family,
  cf.code             AS family_code,
  kc.code             AS card_code,     kcv.version AS card_version,
  mc.code             AS claim_code,    mc.claim_text,
  ms.organisation, ms.title, ms.version AS source_version,
  cr.reviewer_user_id, cr.reviewed_at,
  cp.views, cp.completion_rate,
  cs.reach_score, cs.education_score, cs.service_score
FROM lcos.published_content pc
JOIN lcos.renders            r   ON r.id  = pc.render_id
JOIN lcos.scripts            s   ON s.id  = r.script_id
JOIN lcos.content_concepts   cc  ON cc.id = s.concept_id
JOIN lcos.content_families   cf  ON cf.id = cc.family_id
JOIN lcos.knowledge_cards    kc  ON kc.id = cf.knowledge_card_id
JOIN lcos.knowledge_card_versions kcv ON kcv.id = s.knowledge_card_version_id
JOIN lcos.script_claims      sc  ON sc.script_id = s.id
JOIN lcos.medical_claims     mc  ON mc.id = sc.claim_id
JOIN lcos.claim_sources      cls ON cls.claim_id = mc.id
JOIN lcos.medical_sources    ms  ON ms.id = cls.source_id
LEFT JOIN lcos.clinical_reviews cr ON cr.script_id = s.id AND cr.decision = 'APPROVED'
LEFT JOIN lcos.content_performance cp ON cp.published_content_id = pc.id
LEFT JOIN lcos.content_scores      cs ON cs.published_content_id = pc.id
WHERE pc.id = $1;
```

Materialised as the view `lcos.v_content_lineage` in the schema file.

### 6. Indexing strategy

| Pattern | Index |
|---|---|
| Approval queues | Partial b-tree on `status` where status in review states, on `knowledge_cards`, `scripts`, `renders`, `review_tasks` |
| Semantic search | HNSW on `audience_questions.embedding` (`vector_cosine_ops`, m=16, ef_construction=64) |
| Full text on questions | GIN on `to_tsvector('simple', sanitized_text)`, `simple` because Amharic has no Postgres stemmer |
| Classification filters | GIN on `question_classifications.raw_output` JSONB |
| Demand time series | b-tree on `(topic_id, captured_at DESC)` |
| Dedup | unique on `audience_questions.source_hash` |
| Coverage joins | b-tree on `content_families.knowledge_card_id`, `published_content.published_at DESC` |
| Audit reads | b-tree on `(object_type, object_id, occurred_at DESC)` |
| Cost rollups | b-tree on `ai_invocations.(object_type, object_id)` and `(occurred_at)` |

Amharic full-text search uses the `simple` configuration plus trigram (`pg_trgm`) indexes, because no Amharic stemmer ships with Postgres. Semantic search through embeddings carries the real load for Amharic; trigram is the fallback for exact phrase lookup.

### 7. Retention

| Data | Retention | Basis |
|---|---|---|
| `audience_questions` sanitized text | 24 months, then aggregate and purge text | Trend analysis needs 2 seasons. Text beyond that has no value. |
| `question_classifications` | same as parent | |
| Embeddings | same as parent | |
| Quarantined questions | 14 days, then purge if not redacted | Minimise holding of possibly-identifying text |
| `knowledge_cards` and versions | Indefinite | Regulatory and evidential |
| `clinical_reviews`, `language_reviews` | Indefinite | Accountability |
| `audit_log` | Indefinite | |
| `renders` files | 24 months in R2, then cold storage | Storage cost |
| `content_performance` | Indefinite, daily rows rolled to weekly after 180 days | |
| `ai_invocations` | 24 months | Cost analysis |
| `workflow_events` | 12 months, dead letters indefinite | |
