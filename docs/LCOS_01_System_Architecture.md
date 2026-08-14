# Letena Content OS
## B. System Architecture

Version 1.0 | 11 August 2026

---

### 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZONE A: IDENTIFIED DATA (existing, untouched)                                │
│                                                                              │
│  letena.et  (PHP 8 / mysqli / MySQL, Plesk)                                  │
│   ├─ patients, matters, consultations, follow-ups, referrals                 │
│   ├─ WhatsApp / Telegram / Messenger / Instagram webhooks                    │
│   └─ Abeba app backend                                                       │
└───────────────────────────┬──────────────────────────────────────────────────┘
                            │  ONE-WAY GATE
                            │  POST /ingest/questions  (HMAC signed)
                            │  payload: sanitized_text, channel, segment_hint,
                            │           source_hash, captured_at
                            │  NEVER: patient_id, matter_id, alias, phone, name
                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZONE B: DE-IDENTIFIED CONTENT INTELLIGENCE (new)                             │
│                                                                              │
│  ┌────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐    │
│  │ Ingestion Edge │──▶│ De-ID Service    │──▶│ Quarantine queue (human) │    │
│  │ (Fastify)      │   │ regex+NER+LLM    │   └──────────────────────────┘    │
│  └────────────────┘   └────────┬─────────┘                                   │
│                                ▼                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │ PostgreSQL 16 + pgvector          (single source of truth for LCOS)   │   │
│  │  knowledge · demand · content · production · distribution · analytics │   │
│  └───────────┬──────────────────────────────────┬────────────────────────┘   │
│              │                                  │                            │
│  ┌───────────▼──────────┐          ┌────────────▼───────────┐                │
│  │ LCOS API (Node/TS)   │◀────────▶│ n8n (queue mode)       │                │
│  │ Fastify + Prisma     │  webhook │ WF01..WF20             │                │
│  │ RBAC · audit · state │  + REST  │ Redis queue, N workers │                │
│  └───────────┬──────────┘          └────────────┬───────────┘                │
│              │                                  │                            │
│  ┌───────────▼──────────┐          ┌────────────▼───────────┐                │
│  │ LCOS Web App (React) │          │ Agent Gateway (Node)   │                │
│  │ 25 screens, role-gated│         │ model routing, prompt  │                │
│  └──────────────────────┘          │ versions, JSON schema  │                │
│                                    │ validation, cost meter │                │
│                                    └────────────┬───────────┘                │
│                                                 │                            │
│  ┌──────────────────────────────────────────────▼───────────────────────┐    │
│  │ BullMQ workers (Redis): render-poll, publish, analytics, embed, cost │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Object storage: Cloudflare R2  (assets, renders, voiceovers, source PDFs)   │
└───────────────────────────┬──────────────────────────────────────────────────┘
                            │
                            ▼  outbound only
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZONE C: EXTERNAL SERVICES                                                    │
│  Anthropic  ·  embeddings  ·  Creatomate  ·  HeyGen  ·  ElevenLabs           │
│  Meta Graph API  ·  TikTok Content Posting  ·  YouTube Data v3  ·  Telegram  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2. Zone rules

These are enforced, not advisory.

| Rule | Enforcement point |
|---|---|
| No identifier crosses A to B | Ingestion edge rejects payloads containing forbidden keys. Schema validation with `additionalProperties: false`. |
| No LCOS service holds a MySQL credential for letena.et | Network policy plus separate secret stores. There is no read path. |
| No raw question text is persisted in Zone B | De-ID runs in memory. `audience_questions.raw_text` does not exist as a column. |
| Zone C never receives an identifier | All AI calls take sanitized text only. Payload assertion runs in the Agent Gateway before dispatch. |
| Zone C failures never lose work | Every external call is wrapped in a job with retry, backoff and a dead letter row. |

### 3. Why PostgreSQL alongside the existing MySQL

letena.et runs on raw mysqli against MySQL and stays that way. LCOS needs four things MySQL on that host will not give comfortably:

1. `pgvector` for question embeddings and semantic clustering.
2. Rich `JSONB` with GIN indexing for classification output, scene plans and platform metadata.
3. Partial and expression indexes for the approval queues (`WHERE status = 'IN_REVIEW'`).
4. Range types and window functions for demand growth scoring.

Two databases with a signed one-way interface is also the cleanest way to make the privacy boundary real rather than a code convention.

### 4. Services

#### 4.1 LCOS API (`lcos-api`)
Node.js 20, TypeScript, Fastify, Prisma, Zod. Responsibilities:

- REST API for the web app and for n8n.
- The only writer to Postgres. n8n never holds database credentials in production. n8n calls the API. This keeps state transitions, RBAC and audit in one place.
- State machine enforcement. A transition that is not in the allowed map returns 409.
- Audit logging on every mutating call.
- Signed webhook dispatch to n8n on domain events.

Why n8n does not write directly to Postgres: an n8n node with a Postgres credential can bypass every guardrail in this document. Making the API the sole writer means the claim validator cannot be skipped by editing a workflow.

#### 4.2 Agent Gateway (`lcos-agents`)
A thin service inside the API process (separate module, separate route prefix) that owns all LLM traffic.

- Loads the prompt template by `prompt_key` and `version` from `ai_prompts`.
- Renders the prompt with a typed context object.
- Enforces provider-side structured output (JSON schema mode) and validates the response with Zod. One repair retry on schema failure, then hard fail.
- Asserts no forbidden pattern is present in the outbound payload (phone shapes, `@handle`, `matter_id`, long digit strings).
- Records tokens, latency, model, prompt version and computed cost into `ai_invocations`.
- Provider abstraction: `anthropic`, `local` (mock). OpenAI support was removed 14 Aug 2026 -- the org has no OpenAI key. Selected via the `LCOS_AI_PROVIDER` credential, overridable per invocation.

#### 4.3 De-identification Service
Runs as a module in the API, invoked synchronously at ingest.

Three passes, in order:
1. **Deterministic**: Ethiopian phone formats (`+251`, `09`, `07` plus 8 digits), email, URL, `@handle`, Telegram usernames, national ID patterns, letena.et matter and patient ID formats, long digit runs.
2. **Named entity**: an Amharic and English capable NER pass for person names, clinic names, university names when combined with a person name, and place names at sub-city granularity.
3. **LLM sweep**: an agent asked only to find residual identifiers and return spans. It never rewrites text. The service applies the redactions.

Output carries `deid_confidence` 0 to 1. Below the configured threshold (default 0.85) the record goes to `QUARANTINED` and appears in a human redaction queue. Redaction replaces spans with typed placeholders (`[NAME]`, `[PHONE]`, `[PLACE]`) so downstream classification retains sentence structure.

#### 4.4 n8n
Orchestration only. Twenty workflows, described in document E. From R3 it runs in queue mode:

```
n8n-main      (UI + webhook receiver)
n8n-worker×2  (execution)
Redis         (queue)
PostgreSQL    (n8n's own execution store, separate database from lcos)
```

n8n's execution database is separate from the LCOS application database. Sharing them creates a backup and restore hazard.

#### 4.5 Workers (BullMQ over Redis)
Long-running or polled work does not belong in n8n executions:

| Queue | Job | Concurrency | Retry |
|---|---|---|---|
| `embed` | Generate and store question embeddings | 8 | 5, exponential |
| `render-poll` | Poll Creatomate and HeyGen render status | 4 | 60 polls, 15s interval, then fail |
| `publish` | Execute a publishing job against a platform API | 2 | 3, exponential, then dead letter |
| `analytics` | Pull platform metrics for published content | 2 | 3 |
| `asset-generate` | Image generation and voiceover synthesis | 4 | 3 |
| `cost-rollup` | Nightly cost aggregation per content family | 1 | 3 |
| `dead-letter` | Terminal failures, human owned | n/a | none |

#### 4.6 Web app (`lcos-web`)
React 18, Vite, TanStack Query, Tailwind, shadcn/ui. Single SPA, role-gated routes, 25 screens (document in part 2 of the specification). Amharic UI strings supported through the existing `am-ET.json` pattern already used in the Abeba app so the two products share terminology.

### 5. Storage layout (Cloudflare R2)

```
r2://letena-lcos/
  sources/{source_id}/{version}/{filename}.pdf        # medical source documents, immutable
  assets/raw/{asset_id}/{filename}                    # uploaded and shot footage
  assets/derived/{asset_id}/{variant}.{ext}           # proxies, thumbnails, 9:16 crops
  voice/{script_id}/{lang}/{take}.wav                 # human and AI voiceovers
  renders/{render_id}/{platform}.mp4                  # finished renders
  renders/{render_id}/preview.mp4                     # low-bitrate review proxy
  exports/{published_content_id}/                     # exactly what was sent to a platform
```

Rules: objects are immutable. A new version writes a new key. Lifecycle policy moves `assets/derived` older than 400 days to infrequent access. Nothing in R2 is public; the web app uses presigned URLs with a 15 minute expiry.

### 6. Integration contracts

#### 6.1 letena.et to LCOS: question ingest

```
POST https://os.letena.et/api/v1/ingest/questions
X-Letena-Signature: sha256=<hmac of raw body with shared secret>
X-Letena-Timestamp: <unix seconds, 300s tolerance>
Content-Type: application/json

{
  "channel": "telegram",              // enum, see ingest_channel
  "captured_at": "2026-08-11T09:14:00Z",
  "source_hash": "b3f1...",           // sha256(salt + original_message_id), for dedup only
  "text": "ፖስትፒል ደጋግሜ ወስጃለሁ። ልጅ መውለድ አልችልም?",
  "language_hint": "am",
  "segment_hint": "unmarried_urban_women_18_24",   // optional, never derived from PII
  "batch_id": "2026-08-11-telegram-01"
}
```

Response `202 Accepted`:
```json
{ "question_id": "aq_01J...", "status": "PENDING_DEID", "duplicate_of": null }
```

Rejections: `422` when a forbidden key is present, `409` when `source_hash` already exists, `401` on signature failure.

The same endpoint accepts a CSV upload path for surveys, university activations and hotline logs, which are the streams that do not flow through letena.et at all.

#### 6.2 LCOS to n8n
Domain events are pushed as signed webhooks:

```
POST {n8n_base}/webhook/lcos/{event_name}
X-LCOS-Signature: sha256=...
{ "event": "script.created", "object_id": "scr_...", "version": 3, "occurred_at": "..." }
```

Events: `question.deidentified`, `question.classified`, `cluster.updated`, `concept.created`, `script.created`, `script.validated`, `script.localized`, `review.completed`, `render.requested`, `render.completed`, `publish.requested`, `publish.completed`, `knowledge_card.expiring`.

#### 6.3 n8n to LCOS
n8n calls back with a service token scoped to `role=automation`, which can transition machine-owned states and can never perform `APPROVE_CLINICAL` or `APPROVE_LANGUAGE`.

```
PATCH /api/v1/scripts/{id}/validation
Authorization: Bearer svc_...
{ "result": "FAIL", "findings": [...], "agent_run_id": "air_..." }
```

### 7. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Host | Docker Compose on developer machine | Hetzner CPX31 or equivalent, 4 vCPU 8GB | Hetzner CCX23 or equivalent, 8 vCPU 32GB, plus managed Postgres |
| Postgres | container, seeded fixture data | restored weekly from production with knowledge tables intact and demand tables synthetic | managed, PITR, daily snapshot, 30 day retention |
| n8n | single instance | single instance | queue mode, main + 2 workers |
| AI providers | live keys, low spend cap | live keys, spend cap 50 USD per day | live keys, spend cap configured in `settings` |
| Creatomate | test template, watermark | live template, watermark | live |
| HeyGen | disabled | 1 test avatar | live |
| Publishing | mocked adapters | sandbox and private accounts | live accounts |
| Data | no real questions | synthetic questions only | real anonymized questions |

Staging never receives real audience questions. Synthetic question sets are generated from the pilot corpus with all text regenerated, so shape is preserved and content is not.

### 8. Deployment

Docker Compose on a single host for R1 through R3, moving to a small Kubernetes or Docker Swarm setup only if worker scaling demands it. The team is small; container orchestration complexity is not justified in year one.

```yaml
services:
  lcos-api:        # 2 replicas behind Caddy
  lcos-web:        # static, served by Caddy
  lcos-worker:     # BullMQ, 2 replicas
  n8n-main:
  n8n-worker:      # 2 replicas
  redis:
  postgres:        # managed in production, container in dev/staging
  caddy:           # TLS, reverse proxy
```

CI on GitHub Actions in `AllureET/letena-content-os`: lint, typecheck, unit tests, Prisma migration dry run against a throwaway Postgres, build images, push to registry, deploy to staging on merge to `main`, deploy to production on a tagged release with manual approval.

Database migrations run as a separate job before the API rolls. Migrations are forward-only. Any migration touching an approved knowledge table requires a second reviewer on the pull request, enforced by CODEOWNERS.

### 9. Observability

| Concern | Tool | Detail |
|---|---|---|
| Application logs | Pino to stdout, shipped to Loki | Structured, every line carries `request_id`, `actor_id`, `object_id` |
| Workflow runs | `workflow_events` table plus n8n's own execution log | The table is the durable record; n8n's log is a convenience |
| AI spend | `ai_invocations` table | tokens in, tokens out, model, prompt version, computed USD, agent, object |
| Render spend | `renders.cost_usd` | Creatomate and HeyGen billing units mapped to USD in `settings` |
| Errors | Sentry | Front end and API |
| Uptime | Better Stack or equivalent | `/healthz` on API, `/healthz` on n8n, Postgres connection check |
| Dead letters | `workflow_events` with `status = 'DEAD_LETTER'` plus a dashboard tile | Zero is the expected steady state. Anything above zero has an owner and an age. |

Derived cost metrics available from R4: cost per generated concept, per approved script, per approved render, per published piece, per 1000 views, per question generated, per attributed consultation.

### 10. Security model

| Control | Implementation |
|---|---|
| Authentication | Email plus TOTP for all roles. No password-only accounts. Sessions 12 hours, refresh 30 days, revocable. |
| Authorization | Role-based, enforced in the API layer per endpoint and per state transition. Permission checks are table-driven, not hardcoded conditionals. |
| Approval integrity | `clinical_reviews` and `language_reviews` rows carry `reviewer_user_id`, `reviewed_at`, and a hash of the exact content reviewed. If content changes after approval, the hash mismatch invalidates the approval automatically. |
| Developer restriction | The `developer` role has no clinical or language approval permission and no ability to update `knowledge_cards.status`. Database superuser access is separate, logged, and used only for migrations. |
| Secrets | Doppler or SOPS-encrypted env files. No secrets in n8n workflow JSON; n8n uses its own credential store referencing environment variables. |
| Audit | Append-only `audit_log`, no update or delete grant for the application role. Retained indefinitely. |
| Transport | TLS everywhere. HMAC on all machine-to-machine calls. Timestamp tolerance to block replay. |
| Data residency | Postgres and R2 in the EU region. AI providers receive de-identified text only. Provider data retention set to zero where the provider supports it. |
| Backup | Postgres PITR plus nightly logical dump to R2, encrypted, 30 day retention, restore tested monthly. |

### 11. Failure posture

The system fails closed on anything medical and fails open on anything cosmetic.

| Failure | Behaviour |
|---|---|
| AI returns invalid JSON twice | Job fails, object stays in prior state, dead letter row, human queue |
| Claim validator returns FAIL | Script blocked, cannot transition to `READY_FOR_REVIEW`, findings shown to the writer |
| Claim validator itself errors | Treated as FAIL. There is no fallback that skips validation. |
| Amharic agent returns `HUMAN_LANGUAGE_REVIEW` | Script routed to language editor, no automatic retry |
| Knowledge card expires mid-pipeline | All in-flight content on that card is frozen at its current state and flagged. Nothing publishes. |
| Creatomate render fails | 3 retries, then producer queue with the exact template payload attached |
| HeyGen fails | Falls back to the template render path with an offer to substitute the presenter scene, producer decides |
| Platform token expired | Publishing job pauses, admin notified, queue holds rather than dropping |
| Platform rejects upload | `published_content.status = 'REJECTED'` with the platform's reason stored verbatim, social lead queue |
| Postgres unavailable | API returns 503, n8n retries with backoff, no state is inferred |
