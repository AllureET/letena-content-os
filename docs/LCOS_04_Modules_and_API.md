# Letena Content OS
## D. Application Module Structure and API Design

Version 1.0 | 11 August 2026

---

### 1. Repository layout

Monorepo, pnpm workspaces, in `AllureET/letena-content-os`.

```
letena-content-os/
├─ apps/
│  ├─ api/                     # Fastify service, the only writer to Postgres
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ plugins/           # auth, rbac, audit, errors, rate-limit, openapi
│  │  │  ├─ modules/
│  │  │  │  ├─ identity/       # users, roles, sessions, TOTP
│  │  │  │  ├─ knowledge/      # sources, claims, cards, versions, expiry
│  │  │  │  ├─ language/       # terminology, translations, language review
│  │  │  │  ├─ demand/         # ingest, de-id, classification, clusters, scoring
│  │  │  │  ├─ content/        # families, concepts, scripts, validation, findings
│  │  │  │  ├─ production/     # assets, templates, jobs, renders, routing
│  │  │  │  ├─ governance/     # review tasks, clinical and language reviews
│  │  │  │  ├─ distribution/   # platform accounts, publishing, published content
│  │  │  │  ├─ analytics/      # performance, scores, experiments, coverage
│  │  │  │  └─ platform/       # settings, prompts, workflow events, audit
│  │  │  ├─ agents/            # Agent Gateway: prompt loading, schema, cost, PII guard
│  │  │  ├─ workflows/         # outbound webhook dispatch to n8n, event bus
│  │  │  └─ state/             # state machine definitions and transition guards
│  │  └─ test/
│  ├─ web/                     # React SPA, 25 screens
│  └─ worker/                  # BullMQ processors
├─ packages/
│  ├─ db/                      # Prisma schema, migrations, seed
│  ├─ contracts/               # Zod schemas shared by api, web, worker, n8n
│  ├─ agent-schemas/           # JSON Schema files for every AI response
│  ├─ scoring/                 # priority, coverage and performance formulas, pure functions
│  └─ deid/                    # de-identification passes, pure and unit tested
├─ n8n/
│  ├─ workflows/               # exported JSON, one file per WF, version controlled
│  └─ README.md
├─ infra/
│  ├─ docker-compose.yml
│  ├─ docker-compose.prod.yml
│  └─ caddy/Caddyfile
└─ docs/                       # this document set
```

Rule: `packages/scoring` and `packages/deid` contain no I/O. Every formula and every redaction rule is a pure function with a unit test and a fixture file. These are the two places where a silent regression would be most expensive and least visible.

### 2. Module responsibilities and boundaries

| Module | Owns | May write | Must not |
|---|---|---|---|
| `identity` | users, roles, permissions, sessions | its own tables | evaluate business rules |
| `knowledge` | sources, claims, cards, versions, expiry cascade | knowledge tables, `review_tasks` | write content or production tables |
| `language` | terminology, translations, language reviews | language tables, `review_tasks` | change medical meaning fields |
| `demand` | ingest, de-id, classification, clusters, priority, coverage | demand tables | read any identified data |
| `content` | families, concepts, scripts, versions, claim mapping, findings | content tables, `review_tasks`, `production_jobs` on approval | approve anything |
| `production` | assets, templates, routing, jobs, renders | production tables, `publishing_jobs` on final approval | publish |
| `governance` | review tasks and the two review tables, all approval transitions | review tables plus the `status` column of the object under review | create content |
| `distribution` | accounts, publishing jobs, published content | distribution tables | render |
| `analytics` | performance, scores, experiments | analytics tables | mutate content |
| `platform` | settings, prompts, workflow events, audit | platform tables | anything domain specific |

Cross-module writes go through a service call, never a direct Prisma call into another module's tables. The one exception is `governance`, which by design owns the `status` transition of objects in other modules, because approval is a governance concern and centralising it is what makes the RBAC check impossible to bypass.

### 3. State transition engine

Every status change goes through one function:

```ts
// apps/api/src/state/transition.ts
export async function transition<T extends GovernedObject>(opts: {
  object: T;
  to: StatusOf<T>;
  actor: Actor;
  reason?: string;
  contentSha256?: string;
  tx: PrismaTransaction;
}): Promise<T>
```

It performs, in order:

1. Look up the transition in the machine definition for the object type. Unknown transition returns `409 INVALID_TRANSITION`.
2. Check the actor holds the permission named on the transition. Missing returns `403 FORBIDDEN`.
3. Run every guard function attached to the transition. Failure returns `422 GUARD_FAILED` with the guard name and a human message.
4. Verify `contentSha256` matches the stored hash when the transition requires it. Mismatch returns `409 CONTENT_CHANGED`.
5. Apply the update.
6. Insert an `audit_log` row with `from_state`, `to_state`, actor, reason and diff.
7. Emit the domain event to the outbound webhook queue.

Machine definitions live as data:

```ts
export const scriptMachine: Machine<ScriptStatus> = {
  DRAFT: {
    VALIDATING:       { permission: 'script.write',  guards: ['hasCurrentVersion', 'cardIsApproved'] },
    NEEDS_KNOWLEDGE:  { permission: 'script.write',  guards: ['hasNeedsKnowledgeNote'] },
  },
  VALIDATING: {
    VALIDATED:        { permission: 'automation',    guards: ['allClaimsSupported', 'noBlockerFindings'] },
    VALIDATION_FAILED:{ permission: 'automation' },
  },
  VALIDATED: {
    LOCALIZING:       { permission: 'script.write',  guards: ['targetLanguageConfigured'] },
    CLINICAL_REVIEW:  { permission: 'script.write',  guards: ['riskTierAtLeast3'] },
    APPROVED:         { permission: 'script.approve_editorial',
                        guards: ['riskTierAtMost2', 'validationPassed', 'reviewerIsNotAuthor'],
                        requiresContentHash: true },
  },
  LANGUAGE_REVIEW: {
    CLINICAL_REVIEW:  { permission: 'script.approve_language', guards: ['riskTierAtLeast3'] },
    APPROVED:         { permission: 'script.approve_language',
                        guards: ['riskTierAtMost2', 'meaningPreserved'], requiresContentHash: true },
    DRAFT:            { permission: 'script.approve_language' },
  },
  CLINICAL_REVIEW: {
    APPROVED:         { permission: 'script.approve_clinical',
                        guards: ['reviewerIsClinical', 'reviewerIsNotAuthor', 'tier4RequiresDirector',
                                 'validationPassed', 'cardIsApproved'],
                        requiresContentHash: true },
    DRAFT:            { permission: 'script.approve_clinical' },
    REJECTED:         { permission: 'script.approve_clinical', guards: ['hasRejectionReason'] },
  },
  APPROVED:   { SUPERSEDED: { permission: 'script.write' } },
  // terminal
  REJECTED: {}, SUPERSEDED: {},
  VALIDATION_FAILED: { DRAFT: { permission: 'script.write' } },
  NEEDS_KNOWLEDGE:   { DRAFT: { permission: 'script.write', guards: ['cardIsApproved'] } },
  LOCALIZING:        { LANGUAGE_REVIEW: { permission: 'automation' } },
};
```

Guards are named, individually unit tested, and reused across machines. `reviewerIsNotAuthor` alone closes the most common governance hole in review systems.

### 4. API conventions

- Base path `/api/v1`. Versioned by path, breaking changes only in a new version.
- JSON only. `application/json` in and out.
- Authentication: `Authorization: Bearer <jwt>` for humans, `Bearer svc_<token>` for machines.
- Idempotency: every POST that creates a costly object accepts `Idempotency-Key`. Replays return the original response.
- Pagination: cursor based. `?limit=50&cursor=<opaque>`, response carries `next_cursor`.
- Filtering: explicit named query parameters, no generic query language.
- Errors: RFC 9457 problem details.

```json
{
  "type": "https://os.letena.et/errors/guard-failed",
  "title": "Guard failed",
  "status": 422,
  "detail": "Script cannot be approved: claim EC-CLAIM-0042 has verdict UNSUPPORTED.",
  "instance": "/api/v1/scripts/scr_01J.../transition",
  "code": "GUARD_FAILED",
  "guard": "allClaimsSupported",
  "request_id": "req_01J...",
  "findings": [
    { "code": "UNSUPPORTED_STATEMENT", "severity": "BLOCKER",
      "statement": "It works up to 5 days with the same effectiveness.",
      "explanation": "No approved claim states equal effectiveness across the full window." }
  ]
}
```

Standard codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_TRANSITION`, `GUARD_FAILED`, `CONTENT_CHANGED`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `SPEND_CAP_REACHED`.

### 5. Endpoint catalogue

#### 5.1 Knowledge

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/knowledge/sources` | `knowledge.read` | filter by `status`, `source_type`, `topic_id` |
| POST | `/knowledge/sources` | `source.manage` | |
| POST | `/knowledge/sources/{id}/supersede` | `source.manage` | body `{ superseded_by_id }`, fires the cascade |
| GET | `/knowledge/claims` | `knowledge.read` | filter `status`, `topic_id`, `q` (trigram search) |
| POST | `/knowledge/claims` | `knowledge.draft` | |
| POST | `/knowledge/claims/{id}/sources` | `knowledge.draft` | attach a source with locator and quote |
| POST | `/knowledge/claims/{id}/transition` | varies | `{ to, reason }` |
| GET | `/knowledge/cards` | `knowledge.read` | filter `status`, `topic_id`, `risk_tier`, `expiring_within_days` |
| POST | `/knowledge/cards` | `knowledge.draft` | creates card plus version 1 |
| GET | `/knowledge/cards/{id}` | `knowledge.read` | includes current version, claims, myths, coverage |
| POST | `/knowledge/cards/{id}/versions` | `knowledge.draft` | new version, forces `NEEDS_UPDATE` if card was `APPROVED` |
| POST | `/knowledge/cards/{id}/claims` | `knowledge.draft` | `{ claim_id, is_core }` |
| POST | `/knowledge/cards/{id}/transition` | varies | approval requires `content_sha256` |
| GET | `/knowledge/health` | `knowledge.read` | backs the Knowledge Health screen, reads `v_knowledge_health` |

```http
POST /api/v1/knowledge/cards/44444444-.../transition
Authorization: Bearer <clinician jwt>
Content-Type: application/json

{
  "to": "APPROVED",
  "content_sha256": "9f2c1a...",
  "review_due_months": 6,
  "reason": "Consistent with FMoH National FP Guideline v3 section 7.4."
}
```
```http
HTTP/1.1 200 OK
{
  "id": "44444444-...", "code": "EC-003", "status": "APPROVED",
  "approved_version_id": "55555555-...", "review_due_at": "2027-02-11",
  "reviewed_by": { "id": "1111...", "full_name": "Dr Blen Getahun Kassa" },
  "clinical_review_id": "crv_01J..."
}
```

#### 5.2 Demand

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/ingest/questions` | HMAC or `question.ingest` | single or batch, max 500 per call |
| POST | `/ingest/questions/csv` | `question.ingest` | multipart, for surveys and events |
| GET | `/questions` | `question.read` | filter `status`, `channel`, `topic_id`, `from`, `to`, `q` |
| GET | `/questions/quarantine` | `question.redact` | |
| POST | `/questions/{id}/redact` | `question.redact` | `{ sanitized_text }`, releases to `DEIDENTIFIED` |
| POST | `/questions/{id}/reject` | `question.redact` | purges text immediately |
| GET | `/questions/search` | `question.read` | `?semantic=<text>&k=20`, pgvector nearest neighbour |
| GET | `/clusters` | `question.read` | ordered by `member_count` or `last_seen_at` |
| POST | `/clusters/{id}/split` | `cluster.manage` | `{ question_ids, new_label }` |
| POST | `/clusters/{id}/merge` | `cluster.manage` | `{ target_cluster_id }`, blocked when either is clinically distinct |
| POST | `/clusters/{id}/mark-distinct` | `cluster.manage` | clinician note, freezes auto-merge |
| GET | `/demand/priority` | `question.read` | latest `topic_priority_scores` |
| GET | `/demand/coverage-gaps` | `question.read` | reads `v_coverage_gaps` |
| POST | `/demand/recompute` | `settings.manage` | forces WF05 out of schedule |

#### 5.3 Content

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/content/turn-into-content` | `question.turn_into_content` | the one-button flow, see 5.7 |
| GET | `/content/families` | `concept.read` | |
| POST | `/content/families` | `concept.generate` | `{ knowledge_card_id, primary_segment_id, brief, origin }` |
| POST | `/content/families/{id}/concepts:generate` | `concept.generate` | `{ count, video_families[], temperature }` |
| GET | `/content/concepts` | `concept.read` | filter `status`, `family_id` |
| POST | `/content/concepts/{id}/select` | `concept.select` | |
| POST | `/content/concepts/{id}/reject` | `concept.select` | reason required |
| POST | `/content/concepts/{id}/scripts:generate` | `script.write` | `{ language }` |
| GET | `/content/scripts` | `script.read` | filter `status`, `risk_tier`, `language` |
| GET | `/content/scripts/{id}` | `script.read` | includes current version, claim map, findings |
| PUT | `/content/scripts/{id}/version` | `script.write` | human edit creates a new version |
| POST | `/content/scripts/{id}/validate` | `script.write` | runs WF08 synchronously up to 60s, else returns 202 |
| POST | `/content/scripts/{id}/localize` | `script.write` | `{ target_language }` |
| POST | `/content/scripts/{id}/transition` | varies | |
| GET | `/content/scripts/{id}/lineage` | `script.read` | full claim and source trail |
| GET | `/content/needs-knowledge` | `knowledge.read` | the knowledge backlog generated by blocked scripts |

#### 5.4 Production

| Method | Path | Permission |
|---|---|---|
| GET | `/production/assets` | `asset.read` |
| GET | `/production/assets/search` | `asset.read` (`?semantic=`, `?tags=emotion:calm,city:addis`) |
| POST | `/production/assets` | `asset.manage` (presigned upload, then finalise) |
| POST | `/production/assets/{id}/approve-clinical` | `asset.approve_clinical` |
| GET | `/production/templates` | `production.read` |
| POST | `/production/jobs` | `production.request` |
| GET | `/production/jobs/{id}` | `production.read` |
| POST | `/production/jobs/{id}/retry` | `production.request` |
| GET | `/production/renders/{id}` | `production.read` |
| POST | `/production/renders/{id}/approve` | `production.approve_final` |
| POST | `/production/renders/{id}/reject` | `production.approve_final` |

#### 5.5 Governance

| Method | Path | Permission |
|---|---|---|
| GET | `/reviews/queue` | any review permission, scoped to the caller's roles |
| GET | `/reviews/{id}` | as above, returns the full review context payload |
| POST | `/reviews/{id}/claim` | as above, sets `assigned_to` and `IN_PROGRESS` |
| POST | `/reviews/{id}/decide` | `script.approve_clinical`, `script.approve_language` or `production.approve_final` |
| POST | `/reviews/{id}/escalate` | any review permission |
| GET | `/reviews/workload` | `analytics.read` |

The review context payload is one call because the reviewer must never have to open a second screen:

```json
GET /api/v1/reviews/rvw_01J...
{
  "review": { "id": "rvw_01J...", "type": "CLINICAL_SCRIPT", "risk_tier": "TIER_3",
              "due_at": "2026-08-12T09:00:00Z", "sla_hours": 24 },
  "script": { "code": "SCR-EC003-V02-AM", "language": "AM", "version": 2,
              "hook": "...", "spoken_script": "...", "onscreen_text": [...],
              "cta": "...", "content_sha256": "9f2c1a..." },
  "back_translation": "Emergency pills do not end a pregnancy that has already started...",
  "knowledge_card": { "code": "EC-003", "version": 1,
                      "canonical_answer_en": "...", "prohibited_claims": [...] },
  "claim_map": [
    { "statement": "...", "claim_code": "EC-CLAIM-0042", "verdict": "SUPPORTED",
      "claim_text": "Emergency contraceptive pills do not terminate an established pregnancy.",
      "sources": [{ "code": "FMOH-FP-2023-V3", "organisation": "Federal Ministry of Health",
                    "locator": "Section 7.4" }] }
  ],
  "findings": [],
  "language_qa": { "naturalness_score": 4, "drift_score": 0.06, "terminology_issues": [] },
  "prior_reviews": [{ "reviewer": "Dr Liyu Kibrie", "decision": "CHANGES_REQUESTED",
                      "comment": "Add the 5 day window explicitly.", "reviewed_at": "..." }],
  "video_preview_url": null,
  "actions": ["APPROVE", "APPROVE_WITH_EDITS", "CHANGES_REQUESTED", "REJECT", "ESCALATE"]
}
```

#### 5.6 Distribution and analytics

| Method | Path | Permission |
|---|---|---|
| GET | `/distribution/calendar` | `publish.read` (`?from=&to=`) |
| POST | `/distribution/jobs` | `publish.schedule` |
| POST | `/distribution/jobs/{id}/approve` | `publish.schedule` |
| POST | `/distribution/jobs/{id}/publish-now` | `publish.execute` |
| POST | `/distribution/published/{id}/retract` | `publish.execute` |
| GET | `/analytics/content` | `analytics.read` |
| GET | `/analytics/scores` | `analytics.read` |
| GET | `/analytics/families/{id}` | `analytics.read` (all platform derivatives of one idea) |
| GET | `/analytics/cost` | `analytics.read` |
| POST | `/experiments` | `experiment.manage` |
| POST | `/experiments/{id}/conclude` | `experiment.manage` |

#### 5.7 Turn Into Content

One request, one queued pipeline, one tracking id.

```http
POST /api/v1/content/turn-into-content
{
  "question_id": "aq_01J...",
  "audience_segment_id": "seg_unmarried_urban_women_18_24",
  "concept_count": 4,
  "languages": ["EN", "AM"],
  "video_families": ["V01_QUESTION_EXPLAINER", "V02_CHAT_STORY"],
  "target_publish_from": "2026-08-18"
}
```
```http
HTTP/1.1 202 Accepted
{
  "pipeline_id": "pl_01J...",
  "family_id": "cf_01J...",
  "knowledge_card": { "id": "...", "code": "EC-004", "status": "APPROVED",
                      "match_confidence": 0.91 },
  "risk_tier": "TIER_3",
  "steps": [
    { "step": "match_knowledge",  "status": "SUCCEEDED" },
    { "step": "generate_concepts","status": "STARTED"  },
    { "step": "generate_scripts", "status": "PENDING"  },
    { "step": "validate_claims",  "status": "PENDING"  },
    { "step": "localize",         "status": "PENDING"  },
    { "step": "route_production", "status": "PENDING"  },
    { "step": "queue_review",     "status": "PENDING"  }
  ],
  "poll": "/api/v1/pipelines/pl_01J..."
}
```

When no approved card matches above the confidence threshold, the response is `202` with `knowledge_card: null`, a `knowledge_gap` object, and a created `review_tasks` row of type `KNOWLEDGE_CARD` addressed to the clinical team. Rudy sees "we do not have approved medical knowledge for this yet, the clinical team has been asked" rather than a failure.

### 6. RBAC matrix

Read across: what each role can do to each object class.

| Object | admin | medical_director | consulting_doctor | content_lead | language_editor | intake_coordinator | social_lead | producer | developer |
|---|---|---|---|---|---|---|---|---|---|
| Medical source | CRUD | CRUD | R | R | R | R | R | R | R |
| Medical claim | CRUD | CRUD+approve | CRU+approve | CRU | R | R | R | R | R |
| Knowledge card | CRUD | CRUD+approve | CRU+approve (T1-T2) | CRU | R | R | R | R | R |
| Terminology | CRUD | R | R | R | CRUD+approve | R | R | R | R |
| Question | CRUD | R | R | R | R | CRU+redact | CR | R | R |
| Cluster | CRUD | R | R | CRU | R | CRU | R | R | R |
| Concept | CRUD | R | R | CRUD+select | R | R | R | R | R |
| Script (T1-T2) | CRUD | R+approve | R+approve | CRU+approve | approve language | R | R | R | R |
| Script (T3) | CRUD | approve | approve | CRU | approve language | R | R | R | R |
| Script (T4) | CRUD | approve | R | CRU | approve language | R | R | R | R |
| Asset | CRUD | approve medical | approve medical | R | R | R | R | CRUD | R |
| Template | CRUD | R | R | R | R | R | R | CRUD | CRUD |
| Render | CRUD | approve T4 | R | R | R | R | R | CRU+approve | R |
| Publishing job | CRUD | R | R | CRU | R | R | CRUD+execute | R | R |
| Published content | CRUD | retract | R | R | R | R | CRUD+retract | R | R |
| Experiment | CRUD | R | R | CRUD | R | R | CRUD | R | R |
| Settings | CRUD | R | R | R | R | R | R | R | CRUD |
| Prompts | CRUD | R | R | R | R | R | R | R | CRUD |
| Users and roles | CRUD | R | R | R | R | R | R | R | R |
| Audit log | R | R | R | R | R | R | R | R | R |

The developer column is the important one. A developer can operate the system, change settings and prompts, and manage templates and tokens. A developer cannot approve a claim, a card, a script, a translation or a final render, and cannot alter `knowledge_cards.status` by any route including the API. Changing that requires a role grant, which is itself audited.

### 7. Queue and job architecture

```
API ──enqueue──▶ Redis (BullMQ) ──▶ worker processes
                                     ├─ embed
                                     ├─ render-poll
                                     ├─ publish
                                     ├─ analytics
                                     ├─ asset-generate
                                     ├─ cost-rollup
                                     └─ webhook-dispatch
```

Job envelope, identical across queues:

```ts
type JobEnvelope<T> = {
  jobId: string;            // ULID, also the idempotency key
  queue: QueueName;
  objectType: string;
  objectId: string;
  workflowCode?: string;    // 'WF14'
  executionId?: string;     // n8n execution when triggered from a workflow
  attempt: number;
  payload: T;
  enqueuedBy: { type: 'USER'|'SERVICE'|'SCHEDULE'; id?: string };
  enqueuedAt: string;
};
```

Retry policy by queue:

| Queue | Attempts | Backoff | On final failure |
|---|---|---|---|
| `embed` | 5 | exponential from 2s | mark question `CLASSIFIED` without embedding, log, retry nightly |
| `render-poll` | 60 polls at 15s | fixed | render `TIMED_OUT`, production job `FAILED`, producer queue |
| `publish` | 3 | exponential from 60s | job `FAILED`, dead letter, social lead notified |
| `analytics` | 3 | exponential from 5m | skip this window, log gap, do not impute |
| `asset-generate` | 3 | exponential from 10s | job `ASSETS_PENDING`, producer sources manually |
| `webhook-dispatch` | 8 | exponential from 1s to 1h | dead letter, admin alert |

Every terminal failure writes a `workflow_events` row with `status = 'DEAD_LETTER'`, an `owner_role`, and the full payload needed to replay. The dashboard shows dead letter count and age. Nothing disappears.

Spend caps are enforced at enqueue time. When `ai.daily_spend_cap_usd` or `render.daily_spend_cap_usd` is reached, the API returns `429 SPEND_CAP_REACHED` and the job is held rather than dropped, with a resume-tomorrow flag. Human-triggered work always takes precedence over scheduled generation when the cap is close.

### 8. Rate limits and abuse controls

| Endpoint class | Limit |
|---|---|
| `/ingest/*` | 1000 requests per minute per credential, 500 records per request |
| Generation endpoints (`*:generate`, `/turn-into-content`) | 30 per hour per user, 200 per day per organisation |
| Read endpoints | 600 per minute per user |
| Auth endpoints | 10 per 15 minutes per IP, then exponential lockout |

Generation limits exist because each call spends real money. The limit is a setting, not a constant.

### 9. Testing strategy for the API layer

| Layer | Approach | Coverage target |
|---|---|---|
| Guards and state machines | Unit, table-driven over every transition in every machine including illegal ones | 100 percent of transitions |
| Scoring formulas | Unit with golden fixtures, plus property tests for monotonicity | 100 percent of branches |
| De-identification | Unit over a fixture corpus of 300 Amharic and English question shapes with known identifiers, plus adversarial cases | 100 percent recall on the fixture set is the release gate |
| Agent schema validation | Contract tests against recorded provider responses, plus malformed and truncated payloads | every agent |
| Endpoints | Integration against a real Postgres in CI, per-role permission matrix executed as a test | every endpoint times every role |
| Workflows | End to end from ingest to publish against mocked providers | the happy path plus 12 named failure paths |

The permission matrix test deserves emphasis. It iterates every endpoint against every role and asserts the expected allow or deny. It is the test that catches a developer accidentally gaining clinical approval rights during a refactor.
