# Letena Content OS
## E. n8n Workflow Architecture and Node Maps

Version 1.0 | 11 August 2026

---

### 0. Rules that apply to all twenty workflows

1. **n8n never holds a database credential.** Every read and write goes through the LCOS API with a service token holding the `automation` role. This is what makes the guardrails unskippable.
2. **Every workflow opens with a Log Start node and closes with a Log Finish node**, both writing to `POST /api/v1/platform/workflow-events`. Start writes `STARTED`, finish writes `SUCCEEDED` or `FAILED` with duration and error.
3. **Every workflow has an Error Trigger sibling** routing to WF20.
4. **Every AI call goes to the Agent Gateway**, never to a provider directly from n8n. The gateway owns prompt version, schema validation, PII assertion and cost recording.
5. **Idempotency**: every API-mutating call sends `Idempotency-Key: {{$execution.id}}-{{$itemIndex}}-{{step}}`.
6. **Batch size 20** on all item loops, to keep executions readable and retries cheap.
7. **No workflow approves anything.** Approval endpoints reject the `automation` role.

Naming: `WF07_Script_Generator`. Files live in `n8n/workflows/WF07_Script_Generator.json` and are exported on every change so the workflows are version controlled with the code.

---

## WF01 Ingest Questions

| Field | Value |
|---|---|
| Trigger | Webhook `POST /webhook/lcos/ingest` plus Cron every 15 minutes for the CSV drop folder |
| Inputs | Batch of raw question records from letena.et, Telegram export, survey CSV |
| Purpose | Get raw text into the de-identification pipeline without ever persisting it |
| Next | WF02 |

**Node map**

```
1  Webhook / Cron
2  Log Start                      → POST /platform/workflow-events
3  Switch: source type            → letena.et | csv | manual
4  Function: normalise envelope   → { channel, captured_at, source_hash, text, language_hint }
5  Function: assert no forbidden keys
     forbidden = patient_id, matter_id, alias, phone, name, email, telegram_id, msisdn
     any present → throw ForbiddenFieldError (goes to WF20, batch rejected whole)
6  Split In Batches (20)
7  HTTP: POST /api/v1/ingest/questions
8  IF response.status = 409 (duplicate) → NoOp, count
9  Function: accumulate counts
10 HTTP: PATCH /api/v1/ingest/batches/{id}  { record_count, accepted_count, ... }
11 Log Finish
```

**Validation**: envelope schema, `captured_at` within the last 400 days and not in the future, `text` length 3 to 4000, `source_hash` present and 64 hex chars.

**Errors**: `ForbiddenFieldError` fails the entire batch deliberately, because a leak of one record means the exporting job is misconfigured and the rest are suspect. `422` on a single record quarantines that record only.

**Retries**: 3, exponential from 30s. Dead letter carries `batch_id` and the count of records not yet accepted, never the text.

**Human checkpoint**: none.

---

## WF02 De-identify Questions

| Field | Value |
|---|---|
| Trigger | Webhook `question.created` from the API, plus Cron every 5 minutes sweeping `status = PENDING_DEID` |
| Purpose | Strip identifiers, score confidence, quarantine what is uncertain |
| Next | WF03 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /questions?status=PENDING_DEID&limit=100
4  Split In Batches (20)
5  Function: pass 1 deterministic redaction        (packages/deid, mirrored in n8n as a shared function)
6  HTTP: POST /agents/deid-ner        → span list
7  Function: apply spans, recompute text
8  HTTP: POST /agents/deid-sweep      → residual identifier spans, agent LEAK_SWEEP
9  Function: apply, compute deid_confidence
       confidence = 1 - (0.4·residual_found + 0.3·ner_low_conf + 0.3·ambiguous_place)
10 IF confidence >= settings.deid.confidence_threshold
     TRUE  → HTTP PATCH /questions/{id} { sanitized_text, deid_confidence,
                                          deid_redactions, status: 'DEIDENTIFIED' }
     FALSE → HTTP PATCH /questions/{id} { status: 'QUARANTINED', quarantine_reason }
             → Notify: Telegram to intake_coordinator, batched hourly
11 Log Finish
```

**Expected structured output** from `LEAK_SWEEP`:

```json
{ "spans": [ { "start": 14, "end": 27, "type": "PERSON", "confidence": 0.93 } ],
  "residual_risk": "LOW", "notes": "" }
```

**Validation**: the agent may only return spans. If the response contains a `rewritten_text` field, the response is rejected and the invocation is marked `SCHEMA_FAIL`. The agent is never allowed to author replacement text, because an agent that rewrites can also invent.

**Errors**: agent failure twice sends the question to `QUARANTINED` with reason `DEID_AGENT_UNAVAILABLE`. Failing open here would be a privacy incident, so it fails closed.

**Human checkpoint**: the quarantine queue, owned by `intake_coordinator`, SLA 48 hours, purge at 14 days if untouched.

---

## WF03 Classify Questions

| Field | Value |
|---|---|
| Trigger | Webhook `question.deidentified`, plus Cron every 10 minutes |
| Purpose | Assign topic, intent, urgency, audience, risk, and the best matching knowledge card |
| Next | WF04 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /questions?status=DEIDENTIFIED&limit=100
4  HTTP: GET /knowledge/cards?status=APPROVED&fields=id,code,canonical_question_en,topic_id
     (cached 15 min in workflow static data)
5  HTTP: GET /demand/segments
6  Split In Batches (20)
7  HTTP: POST /agents/question-classifier   (schema QUESTION_CLASSIFICATION_V1)
8  Function: validate enums against the fetched card and topic lists
     unknown topic or card id → set to null, add note, do not invent
9  HTTP: POST /api/v1/questions/{id}/classification
10 IF urgency IN ('HIGH','EMERGENCY')
     → HTTP POST /platform/alerts  { channel: 'telegram', role: 'medical_director' }
       Note: this is a content-signal alert only. The individual is served by
       letena.et, which already handled the clinical response.
11 HTTP: enqueue embed job  POST /questions/{id}/embed
12 Log Finish
```

**Human checkpoint**: none in the flow. A weekly sample of 30 classifications is reviewed by the content lead, tracked as an accuracy metric.

**Errors**: schema failure retried once with a repair prompt, then the question stays `DEIDENTIFIED` and is picked up on the next sweep. Three consecutive failures on the same question moves it to a manual classification queue.

---

## WF04 Cluster Demand

| Field | Value |
|---|---|
| Trigger | Cron hourly at :05 |
| Purpose | Group semantically similar questions without merging clinically different ones |
| Next | WF05 |

**Node map**

```
1  Cron
2  Log Start
3  HTTP: GET /questions?status=CLASSIFIED&has_embedding=true&limit=500
4  Loop per question:
   4a HTTP: GET /clusters/nearest?embedding_ref={id}&k=5
   4b IF top similarity >= settings.cluster.duplicate_threshold (0.97)
        → assign relation DUPLICATE
      ELSE IF top similarity >= settings.cluster.similarity_threshold (0.86)
        → guard: candidate cluster and question must share topic_id
          AND candidate cluster is not marked clinically_distinct against this topic
          AND question's knowledge_card_id is null or equal to cluster's
          → assign relation PARAPHRASE
      ELSE → mark for new cluster
5  Group unassigned by topic_id
6  IF group size >= 3
     → HTTP POST /agents/cluster-labeller  (schema CLUSTER_LABEL_V1)
     → HTTP POST /clusters  { label_en, label_am, representative_question, topic_id, members }
   ELSE leave unclustered, they will accumulate
7  HTTP: POST /clusters/recompute-centroids
8  HTTP: PATCH /questions/bulk  { status: 'CLUSTERED' }
9  Log Finish
```

**The over-clustering guard is the point of this workflow.** "Can I get pregnant during my period?" and "Can I get pregnant right after my period?" sit close in embedding space and have different answers. The topic and card guard, plus the clinician's `clinically_distinct_note`, keep them apart. When a clinician splits a cluster, the split is recorded and the pair is added to a negative-pairs fixture used to tune the threshold.

**Human checkpoint**: cluster review screen, `content_lead` and `intake_coordinator` can split, merge and relabel at any time.

---

## WF05 Topic Priority and Content Planner

| Field | Value |
|---|---|
| Trigger | Cron daily 04:00 EAT, plus manual `POST /demand/recompute` |
| Purpose | Produce the ranked demand board and the coverage gap board |
| Next | WF06 for the top N gaps, when auto-commissioning is enabled |

**Node map**

```
1  Cron
2  Log Start
3  HTTP: GET /platform/settings?keys=priority.weights,priority.formula_version
4  HTTP: GET /demand/aggregate?window=30d       → per topic and card:
       question_count_30d, question_count_prev_30d, unanswered_count,
       content_count_90d, engagement_index, education_index, service_index
5  Function: compute priority_score  (packages/scoring, pure)
6  Function: compute coverage_state
7  HTTP: POST /demand/priority-scores:bulk
8  HTTP: POST /demand/coverage-snapshots:bulk
9  IF settings.planner.auto_commission = true
     → Filter: top 5 rows where gap_flag AND has_approved_card
     → HTTP POST /content/families  (origin GAP_BOARD)
     → trigger WF06
   ELSE
     → HTTP POST /platform/notifications  { role: 'content_lead',
         message: 'Coverage board updated. N new gaps.' }
10 Log Finish
```

**Priority formula, version v1**

```
volume_n      = ln(1 + questions_30d) / ln(1 + max_questions_30d_across_topics)
growth_n      = clamp((questions_30d - questions_prev_30d) / max(questions_prev_30d, 5), -1, 2) / 2
unanswered_n  = unanswered_30d / max(questions_30d, 1)
coverage_gap  = 1 - min(content_pieces_90d / target_pieces_for_demand, 1)
                where target_pieces_for_demand = ceil(questions_30d / 25)
clinical_n    = clinical_weight / 2.5
strategic_n   = strategic_weight / 2.0

priority_score = 100 × seasonal_factor × (
    0.28·volume_n + 0.20·growth_n + 0.14·unanswered_n +
    0.18·coverage_gap + 0.12·clinical_n + 0.08·strategic_n )

gap_flag = (coverage_gap >= 0.6) AND (volume_n >= 0.35)
```

Weights live in `settings.priority.weights` and must sum to 1, asserted at load. `seasonal_factor` defaults to 1 and is set manually for known periods, for example university intake weeks and Ethiopian holidays where question volume shifts.

**Coverage states**

| State | Condition |
|---|---|
| `NO_KNOWLEDGE` | demand exists, no knowledge card at all |
| `KNOWLEDGE_NO_CONTENT` | approved card, 0 published pieces in 90 days |
| `UNDER_COVERED` | `content_pieces_90d < target_pieces_for_demand` |
| `ADEQUATE` | within 1 piece of target |
| `SATURATED` | more than 2× target with declining engagement |
| `STALE` | card `review_due_at` within 30 days, or all content older than 180 days |

**Human checkpoint**: the coverage gap board is a screen, not an automation. Auto-commission is off by default in the pilot.

---

## WF06 Concept Generator

| Field | Value |
|---|---|
| Trigger | Webhook `family.created`, or `POST /content/families/{id}/concepts:generate` |
| Purpose | Turn one approved knowledge card plus one audience into several distinct creative treatments |
| Next | WF07 for selected concepts |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/families/{id}                     → card_id, segment_id, brief, risk_tier
4  Guard: card.status = 'APPROVED'  else fail with KNOWLEDGE_NOT_APPROVED
5  HTTP: GET /knowledge/cards/{card_id}?include=claims,myths,version
6  HTTP: GET /demand/segments/{segment_id}
7  HTTP: GET /demand/clusters?knowledge_card_id={card_id}&limit=10   → real question phrasings
8  HTTP: GET /analytics/patterns?segment_id=&topic_id=&window=180d   → what performed
9  HTTP: POST /agents/creative-director   (schema CREATIVE_CONCEPTS_V1)
10 Function: post-validate
      - every claim_id_referenced exists in the card's claim set
      - no concept duplicates an existing concept hook within the family (trigram > 0.8)
      - video_family is in the allowed list for this risk tier
        (V05 digital presenter is blocked at TIER_4)
11 HTTP: POST /content/concepts:bulk   status PROPOSED
12 HTTP: POST /platform/notifications  { role: 'content_lead' }
13 Log Finish
```

**Human checkpoint**: concept selection. Nothing proceeds to scripting until a human selects. This is deliberate: it is the cheapest place to exercise editorial judgement.

**Errors**: a concept referencing an unknown claim id is dropped, not repaired, and logged as `AGENT_HALLUCINATED_CLAIM_REF` with the agent and prompt version. Three such events in a week trigger a prompt review task.

---

## WF07 Script Generator

| Field | Value |
|---|---|
| Trigger | Webhook `concept.selected`, or `POST /content/concepts/{id}/scripts:generate` |
| Purpose | Produce a claim-mapped English script |
| Next | WF08 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/concepts/{id}?include=family,card,segment
4  Guard: card.status = 'APPROVED' AND concept.status = 'SELECTED'
5  HTTP: GET /knowledge/cards/{card_id}/claims?status=APPROVED
       → APPROVED_CLAIMS block: id, code, claim_text_en, certainty, claim_type
6  HTTP: GET /production/templates?video_family={vf}&status=APPROVED
       → duration and scene constraints so the script fits what can actually be rendered
7  HTTP: POST /agents/script-writer   (schema SCRIPT_V1)
8  IF response.result = 'NEEDS_KNOWLEDGE'
     → HTTP POST /content/scripts { status: 'NEEDS_KNOWLEDGE', needs_knowledge_note }
     → HTTP POST /reviews  { type: 'KNOWLEDGE_CARD', object: card, note }
     → notify medical_director
     → END
9  Function: structural checks
      - estimated duration within template min and max
      - hook <= 90 characters
      - every claim_map entry references a claim from step 5
      - claim_map covers every sentence flagged medically meaningful by the agent
10 HTTP: POST /content/scripts        → creates script + version 1
11 HTTP: POST /content/scripts/{id}/claims:bulk   → script_claims rows, verdict null
12 HTTP: POST /content/scripts/{id}/transition { to: 'VALIDATING' }
13 Log Finish → triggers WF08
```

**Human checkpoint**: none. The script goes straight to validation, which is where the real gate is.

---

## WF08 Claim Validator

| Field | Value |
|---|---|
| Trigger | Webhook `script.created` and `script.version_created` |
| Purpose | Decide whether every medically meaningful statement is supported by the supplied approved claims, using nothing else |
| Next | WF09 on pass with a target language, WF11 on pass in English only, back to the writer on fail |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/scripts/{id}?include=current_version,claim_map
4  HTTP: GET /knowledge/cards/{card_id}/claims?status=APPROVED
5  HTTP: GET /knowledge/cards/{card_id}/version/{v}?fields=prohibited_claims,referral_conditions,urgent_conditions
6  HTTP: POST /agents/claim-validator   (schema CLAIM_VALIDATION_V1)
       temperature 0, no web tools, no other context
7  Function: deterministic overlay checks (not left to the model)
      - prohibited_claims trigram match against the script text     → BLOCKER
      - risk_tier 4 and no referral_conditions phrase present       → MISSING_REFERRAL, BLOCKER
      - numeric token set in script ⊄ numeric token set in claims   → NUMBER_ALTERED, BLOCKER
      - time expressions in script not present in claims            → TIME_WINDOW_ALTERED, BLOCKER
      - certainty markers ("always", "never", "guaranteed", "100%")
        where the supporting claim certainty is not ESTABLISHED     → CERTAINTY_INFLATION, MAJOR
8  Function: compute overall
      overall = FAIL if any statement verdict in (UNSUPPORTED, CONTRADICTED, AMBIGUOUS)
                or any finding severity = BLOCKER
                else PASS
9  HTTP: PATCH /content/scripts/{id}/validation  { result, statements[], findings[] }
10 IF FAIL
     → HTTP POST /content/scripts/{id}/transition { to: 'VALIDATION_FAILED' }
     → notify content_lead with the findings
     → END
   IF PASS
     → HTTP POST /content/scripts/{id}/transition { to: 'VALIDATED' }
     → IF target languages include AM → trigger WF09
       ELSE → trigger WF11
11 Log Finish
```

**Why step 7 exists**: an LLM validator will sometimes accept a number it half-recognises. Numbers, time windows, negation and prohibited phrases are checkable deterministically, so they are checked deterministically. The model handles semantics; code handles arithmetic and lists.

**Errors**: validator error is treated as `FAIL` with finding `VALIDATOR_UNAVAILABLE`. There is no path that skips validation.

---

## WF09 Amharic Localization

| Field | Value |
|---|---|
| Trigger | Webhook `script.validated` with a non-English target |
| Purpose | Produce natural spoken Amharic that preserves medical meaning exactly |
| Next | WF10 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/scripts/{id}?include=current_version,claim_map
4  HTTP: GET /language/terminology?status=APPROVED&topic_id={t}&register={segment.register}
5  HTTP: GET /knowledge/cards/{card_id}?fields=canonical_answer_am,claims.claim_text_am
       (where an approved Amharic version of the knowledge exists, translate from it,
        not from the English script. This is the difference between Amharic-native
        knowledge and translated English.)
6  HTTP: POST /agents/amharic-localizer   (schema AMHARIC_LOCALIZATION_V1)
7  IF response.result = 'HUMAN_LANGUAGE_REVIEW'
     → create script (AM) in status LANGUAGE_REVIEW with the partial output and the reason
     → notify language_editor
     → END
8  HTTP: POST /agents/back-translator     (schema BACK_TRANSLATION_V1)
       separate agent, separate context, does not see the English source
9  HTTP: POST /agents/embed  ×2  (English source, back-translation)
10 Function: drift_score = 1 - cosine(source_embedding, back_translation_embedding)
11 HTTP: POST /content/scripts  { language: 'AM', parent_script_id, status: 'LOCALIZING' }
12 HTTP: POST /translations { object_type: 'SCRIPT', back_translation, drift_score,
                              terminology_used, uncertainties }
13 HTTP: POST /content/scripts/{am_id}/transition { to: 'LANGUAGE_REVIEW' }
14 Log Finish → triggers WF10
```

**The back-translator not seeing the English source is deliberate.** A back-translator with the original in context will reproduce the original rather than reveal drift.

---

## WF10 Language QA

| Field | Value |
|---|---|
| Trigger | Webhook `script.localized` |
| Purpose | Automated language checks, then route to the human language editor |
| Next | WF11 on approval for Tier 1 and 2, WF15 for Tier 3 and 4 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/scripts/{am_id}?include=version,translation,claim_map
4  Function: deterministic checks
      - every approved terminology "avoid" string absent          → TERMINOLOGY_VIOLATION
      - every core claim's Amharic key phrase present             → MEANING_LOST
      - numerals and time expressions match the English exactly   → NUMBER_ALTERED
      - negation particles preserved (አይ, አል, የለም patterns vs the English negation count)
      - script contains no untranslated Latin-script medical terms
        unless the term is on the approved loanword list
5  HTTP: POST /agents/language-qa   (schema LANGUAGE_QA_V1)
      naturalness, register fit, ambiguity, youth comprehension
6  Function: gate
      IF drift_score > settings.translation.drift_threshold (0.12) → force human
      IF any BLOCKER finding → force human
      IF naturalness_score < 4 → force human
      ELSE IF risk_tier IN (TIER_1, TIER_2) AND all clean → eligible for auto-pass
        (auto-pass is disabled during the pilot; every Amharic script sees the editor)
7  HTTP: POST /reviews { type: 'LANGUAGE', object: script, sla from settings }
8  Wait for `review.completed` webhook
9  Switch on decision
     APPROVED / APPROVED_WITH_EDITS →
        IF risk_tier >= TIER_3 → transition CLINICAL_REVIEW, trigger WF15
        ELSE                   → transition APPROVED, trigger WF11
     CHANGES_REQUESTED → transition DRAFT, notify content_lead
     REJECTED          → transition REJECTED
10 Log Finish
```

**Human checkpoint**: the language editor, always, for the whole pilot. Auto-pass is a setting to be earned by measured agreement between the agent and the editor over at least 100 scripts.

---

## WF11 Production Router

| Field | Value |
|---|---|
| Trigger | Webhook `script.approved` |
| Purpose | Decide how this piece gets made, and prove the assets exist before spending money |
| Next | WF12 when assets are missing, WF13 for presenter, WF14 otherwise |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /content/scripts/{id}?include=version,concept,family,segment
4  Function: choose engine and template
      SUPERSEDED 19 Aug 2026 -- see the note at the top of WF13 and WF14.
      This CREATOMATE/HEYGEN routing table is retired; video production now
      runs through Video Studio (Kling/Veo), not through this router.
      V01 QUESTION_EXPLAINER      → CREATOMATE  LETENA_QA_30S_V1
      V02 CHAT_STORY              → CREATOMATE  LETENA_CHAT_35S_V1
      V03 ILLUSTRATED_SCENARIO    → CREATOMATE  LETENA_STORY_40S_V1  (needs illustrations)
      V04 MEDICAL_VISUAL_EXPLAINER→ CREATOMATE  LETENA_MEDVIS_45S_V1 (approved assets only)
      V05 DIGITAL_PRESENTER       → HEYGEN      LETENA_PRESENTER_V1
      V06 REAL_ETHIOPIA_HYBRID    → CREATOMATE  LETENA_BROLL_30S_V1  (library B-roll)
5  Function: score the route against constraints
      budget remaining today, asset availability, language, presenter availability,
      risk tier (V05 blocked at TIER_4), turnaround priority, target platforms,
      required duration, asset rights and consent expiry
      → if the first choice fails a constraint, fall back per the table below
6  Loop scene_plan:
      HTTP: GET /production/assets/search  (semantic + tag filter + rights valid)
      IF hit above threshold → bind asset_id
      ELSE → add to missing_assets
7  IF missing_assets not empty
     → HTTP POST /production/jobs { status: 'ASSETS_PENDING', missing_assets }
     → trigger WF12
   ELSE
     → HTTP POST /production/jobs { status: 'QUEUED' | 'VOICE_PENDING' }
8  Voice decision
      risk_tier IN settings.voice.ai_allowed_tiers AND language = AM → AI_TTS permitted
      else HUMAN → create a voice recording task for the producer
9  Trigger WF13 (presenter) or WF14 (render)
10 Log Finish
```

**Fallback table**

| First choice unavailable | Fallback | Recorded as |
|---|---|---|
| HeyGen presenter | V01 template render, presenter scene replaced by typography | `ROUTE_FALLBACK_PRESENTER` |
| Missing medical illustration | job holds at `ASSETS_PENDING`, no generative substitute | `BLOCKED_MEDICAL_ASSET` |
| Missing B-roll | licensed stock search, then generic typography scene | `ROUTE_FALLBACK_BROLL` |
| Render budget exhausted | job holds, resumes next day, priority preserved | `SPEND_CAP_HOLD` |
| Human voice not recorded within SLA | Tier 1 and 2 fall back to AI voice, Tier 3 and 4 hold | `VOICE_FALLBACK` |

---

## WF12 Asset Retrieval and Generation

| Field | Value |
|---|---|
| Trigger | Webhook `production_job.assets_pending` |
| Purpose | Find, license or generate the missing assets, with medical illustration held to a human gate |
| Next | WF13 or WF14 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /production/jobs/{id}
4  Loop missing_assets:
   4a Switch on asset requirement type
      PHOTO / BROLL         → semantic search library → stock API → generate
      ILLUSTRATION (non-medical) → library → generate (image model)
      MEDICAL_ILLUSTRATION  → library only. Never generated. If absent:
                              create review_task type ASSET for a clinician-commissioned
                              illustration, hold the job, notify producer. END for this item.
      ICON / UI             → library
      MUSIC / SFX           → licensed library
   4b IF generating:
        HTTP POST /agents/asset-prompt-writer  (schema ASSET_PROMPT_V1)
          constraints: Ethiopian context, modest and realistic depiction, no anatomy,
          no text in image, no identifiable real person, no clinical procedure depiction
        HTTP POST image provider
        HTTP POST /production/assets  { is_ai_generated: true, ai_generation_meta,
                                        clinically_approved: false }
   4c HTTP POST /agents/asset-tagger → tags, then POST /production/assets/{id}/tags
5  IF all assets bound → PATCH /production/jobs/{id} { status: 'QUEUED', asset_plan }
   ELSE → hold, notify producer
6  Log Finish
```

**The medical illustration rule is absolute.** No generative model produces anatomy, cycle diagrams, device placement, or procedure imagery for this system. Those come from a commissioned, clinically approved library. The database enforces it with `assets_medical_illustration_needs_approval`.

---

## WF13 Presenter Generation

> **SUPERSEDED 19 Aug 2026 (Nate's decision).** HeyGen and Creatomate are
> retired from LCOS entirely -- not paused, not disabled, removed from the
> codebase (adapters, ROUTE table, credential fields). This workflow is kept
> below as historical design record only; it does not run and nothing in the
> live system calls HeyGen anymore. Video production now runs through Video
> Studio (`apps/api/src/modules/studio.mjs`): continuity-locked characters
> generated with Kling/Veo, assembled with ffmpeg. Every format's job inside
> LCOS itself is now writing the script -- Amharic and English, with a human
> reviewing and editing the Amharic -- and tracking it through approval.
> Actual production happens either through a Video Studio project or a real
> shoot by the team, both outside this workflow.

| Field | Value |
|---|---|
| Trigger | Webhook `production_job.presenter_required` |
| Purpose | Produce a digital presenter scene with correct Amharic audio |
| Next | WF14 |

**Node map**

```
1  Trigger
2  Log Start
3  Guard: risk_tier != TIER_4  else fail ROUTE_NOT_PERMITTED
4  HTTP: GET /production/jobs/{id}?include=script,version,voice
5  Audio branch
     IF voice_source = HUMAN
        → require voice_asset_id present, else hold and notify producer
        → download presigned URL
     IF voice_source = AI_TTS
        → HTTP POST TTS provider with the Amharic spoken script
        → store as an asset, kind AUDIO_VOICEOVER, is_ai_generated true
6  HTTP: POST HeyGen /v2/video/generate
     { avatar_id, audio_url, background, dimension 1080×1920, caption false }
     Presenter identity fixed to the consenting Letena health educator avatar.
     Title card always reads "Letena Health Educator". Never a clinical title.
7  HTTP: POST /production/renders { engine: 'HEYGEN', external_render_id, status: 'SUBMITTED' }
8  Enqueue render-poll job
9  Log Finish
```

**Guardrails encoded here**: no avatar may be labelled Doctor, no avatar may appear in a white coat or clinical setting, and the presenter scene always carries the educator label overlay from the template. These are template properties, not per-video choices.

---

## WF14 Video Rendering

> **SUPERSEDED 19 Aug 2026 (Nate's decision).** HeyGen and Creatomate are
> retired from LCOS entirely -- not paused, not disabled, removed from the
> codebase (adapters, ROUTE table, credential fields). This workflow is kept
> below as historical design record only; it does not run and nothing in the
> live system calls Creatomate anymore. Video production now runs through
> Video Studio (`apps/api/src/modules/studio.mjs`): continuity-locked
> characters generated with Kling/Veo, assembled with ffmpeg. Every format's
> job inside LCOS itself is now writing the script -- Amharic and English,
> with a human reviewing and editing the Amharic -- and tracking it through
> approval. Actual production happens either through a Video Studio project
> or a real shoot by the team, both outside this workflow.

| Field | Value |
|---|---|
| Trigger | Webhook `production_job.queued` |
| Purpose | Turn an approved script and a bound asset plan into finished files, one per platform variant |
| Next | WF15 |

**Node map**

```
1  Trigger
2  Log Start
3  HTTP: GET /production/jobs/{id}?include=script,version,template,asset_plan,voice
4  Function: build the modification payload from template_variables mapping
      Question_Text   ← script.hook
      Answer_Text     ← script.onscreen_text[0]
      Scene_1..N      ← asset_plan[i].presigned_url
      Voiceover       ← voice asset presigned url
      Subtitle_Track  ← generated SRT from spoken script timings
      CTA_Text        ← script.cta
      Logo, Progress_Bar, Music, End_Card ← brand constants from settings
5  Function: assert every required template variable is bound, else fail PAYLOAD_INCOMPLETE
6  Loop target platform variants (9:16 primary, 1:1 and 16:9 where required):
     HTTP POST Creatomate /v1/renders
     HTTP POST /production/renders { engine, external_render_id, variant_label, payload }
7  Enqueue render-poll jobs
8  On poll success (worker, not n8n):
     download → upload to R2 → PATCH /production/renders/{id}
       { status: 'SUCCEEDED', storage_key, preview_key, duration_s, cost_usd }
     → POST /reviews { type: 'CLINICAL_FINAL' if tier 4 else 'EDITORIAL', object: render }
9  On poll failure: attempts < 3 → resubmit; else render FAILED, job FAILED, producer queue
10 Log Finish → triggers WF15
```

**Cost control**: the payload is validated before submission because a failed render still costs money. Every render records `cost_usd` from the provider's billing unit mapped through `settings`.

---

## WF15 Human Approval

| Field | Value |
|---|---|
| Trigger | Webhook `render.completed`, `script.needs_review` |
| Purpose | Get the right human in front of the right artefact with everything they need in one screen |
| Next | WF16 on approval |

**Node map**

```
1  Trigger
2  Log Start
3  Function: determine reviewer role
      Tier 1, 2 final render → producer or content_lead   (EDITORIAL)
      Tier 3   script        → consulting_doctor          (CLINICAL_SCRIPT)
      Tier 4   script        → medical_director           (CLINICAL_SCRIPT)
      Tier 4   final render  → medical_director           (CLINICAL_FINAL)
      Any AM script          → language_editor            (LANGUAGE)
      GBV or sexual assault topic → medical_director plus a named second reader
4  HTTP: POST /reviews  { type, object, required_role_id, due_at from settings.review.sla_hours,
                          content_sha256 }
5  HTTP: POST /platform/notifications
      Telegram to the role's group, email digest at 08:00 and 15:00 EAT
6  Wait for `review.completed`
7  Switch on decision
     APPROVED            → transition object, trigger WF16
     APPROVED_WITH_EDITS → apply edits as a new version, re-run WF08, then WF16
     CHANGES_REQUESTED   → transition DRAFT, notify author, END
     REJECTED            → transition REJECTED, END
     ESCALATED           → reassign to medical_director, reset SLA, notify
8  Cron sibling: every hour, escalate reviews past due_at
      Tier 4 overdue by 4 hours → escalate to medical_director and notify admin
9  Log Finish
```

**Sampling**: a scheduled sibling picks `settings.review.sampling_rate` of Tier 1 and Tier 2 approved scripts weekly and creates retrospective `CLINICAL_SCRIPT` review tasks. Findings from sampling feed prompt and knowledge card improvements. Sampling failures above 5 percent in a month automatically raise the tier's review requirement until the next clinical review meeting.

---

## WF16 Publishing

| Field | Value |
|---|---|
| Trigger | Cron every 5 minutes for due jobs, plus webhook `publish.requested` |
| Purpose | Get the right file to the right platform with the right copy, or hand it off cleanly |
| Next | WF17 |

**Node map**

```
1  Cron / Webhook
2  Log Start
3  HTTP: GET /distribution/jobs?status=SCHEDULED&due_before=now
4  Per job, guards in order:
     a render final review APPROVED
     b knowledge card still APPROVED at this moment
     c platform account token valid and not expiring within 10 minutes
     d content_sha256 of the render matches the approved hash
     any guard fails → PATCH job { status: 'CANCELLED' | 'FAILED' }, notify, next job
5  Switch on platform
   TIKTOK
     IF account.supports_direct_publish
       → POST /v2/post/publish/video/init  → chunked upload → publish
     ELSE
       → upload as inbox draft, notify social_lead to complete in the app
   INSTAGRAM  → POST /{ig_user_id}/media (REELS, video_url, caption) → media_publish
   FACEBOOK   → POST /{page_id}/videos (or reels endpoint) with caption
   YOUTUBE    → videos.insert resumable upload, snippet with search-oriented title,
                description, tags, category 26, madeForKids false
   TELEGRAM   → sendVideo to the channel with the long-form caption, then pin when flagged
   WEBSITE    → POST to the letena.et content endpoint
6  On success:
     HTTP POST /distribution/published  { platform_post_id, platform_url, published_at, ... }
7  On platform rejection:
     PATCH job { status: 'REJECTED', error_detail: verbatim platform reason }
     notify social_lead, do not retry automatically
8  On transient error: retry 3 with backoff, then FAILED and dead letter
9  Log Finish → schedules WF17 collection at +1h, +24h, +7d, +28d
```

**Platform copy differences** are held on the publishing job, generated from the script's `platform_variants`:

| Platform | Treatment |
|---|---|
| TikTok | fastest hook, caption under 120 characters, 3 to 5 hashtags, comment moderation on for Tier 3 and 4 |
| Instagram Reels | polished cover frame required, caption up to 300 characters, saved-post CTA |
| Facebook Reels | slightly longer caption with context, link to Telegram |
| YouTube Shorts | search-oriented title, full description with the canonical question and the CTA, chapters not applicable |
| Telegram | video plus the long explanatory text, the full CTA and the booking link |

All of them carry the same `family_id`, which is how analytics knows they are one idea.

---

## WF17 Analytics Collection

| Field | Value |
|---|---|
| Trigger | Cron at 03:00 EAT daily, plus the scheduled per-post collections from WF16 |
| Purpose | Pull whatever each platform actually gives, and record honestly what it did not |
| Next | WF18 |

**Node map**

```
1  Cron
2  Log Start
3  HTTP: GET /distribution/published?state=LIVE&published_after=now-90d
4  Group by platform, batch per API limits
5  Switch on platform
   INSTAGRAM / FACEBOOK → GET /{media_id}/insights?metric=...
   TIKTOK               → GET /v2/research or business account video list metrics
   YOUTUBE              → youtubeAnalytics.reports.query
   TELEGRAM             → getMessageStats via the channel, views and forwards only
6  Function: map to the canonical metric set, set metrics_available to exactly
     what came back. Absent metrics stay NULL. Nothing is estimated, inferred or
     back-filled from another platform.
7  HTTP: POST /analytics/performance:bulk
8  Attribution join:
     questions_attributed      ← audience_questions where channel and captured_at fall
                                 within the attribution window of this post and the
                                 classified topic matches (window default 72 hours,
                                 configurable, recorded as a heuristic, not a claim)
     consultations_attributed  ← counts supplied by letena.et through a daily aggregate
                                 endpoint returning numbers only, never records
     referrals_attributed      ← same aggregate feed
9  Log Finish → triggers WF18 weekly only
```

**Honesty rule**: `metrics_available` exists so that a dashboard can say "TikTok did not return average watch time for this post" instead of showing a zero that reads as a failure.

---

## WF18 Learning and Recommendations

| Field | Value |
|---|---|
| Trigger | Cron Sunday 05:00 EAT |
| Purpose | Compute the three scores, find what worked, and write next week's recommendations |
| Next | feeds WF05 and the editorial meeting |

**Node map**

```
1  Cron
2  Log Start
3  HTTP: GET /analytics/performance?window=28d&granularity=LIFETIME
4  Function: compute the three scores (packages/scoring)
5  HTTP: POST /analytics/scores:bulk
6  HTTP: GET /analytics/scores?window=28d&order=composite_score desc&limit=50
7  HTTP: GET /demand/coverage-gaps
8  HTTP: POST /agents/editorial-analyst  (schema EDITORIAL_RECOMMENDATIONS_V1)
     inputs: top and bottom performers with their format, hook, language, segment,
     duration and topic; the coverage board; open knowledge gaps; running experiments
9  HTTP: POST /platform/reports { type: 'WEEKLY_CONTENT_INTELLIGENCE' }
10 Notify content_lead, medical_director, admin with the report link
11 Log Finish
```

**Score formulas, version v1**

```
REACH SCORE (0-100), normalised within platform and against this account's own
trailing 90-day distribution, because cross-platform absolute numbers are not comparable.

  reach_score = 100 × ( 0.30·pct(views)
                      + 0.25·pct(completion_rate)
                      + 0.20·pct(shares_per_1k_views)
                      + 0.15·pct(saves_per_1k_views)
                      + 0.10·pct(avg_watch_time) )
  where pct(x) is the percentile of x within the same platform and video_family
  over the trailing 90 days. Fewer than 10 comparable posts sets confidence = LOW.

EDUCATION SCORE (0-100)

  demand_match   = normalised priority_score of the knowledge card at publish time
  gap_fill       = 1 if coverage_state was NO_KNOWLEDGE or KNOWLEDGE_NO_CONTENT else
                   0.6 if UNDER_COVERED else 0.2
  myth_correction= 1 if the card carries a linked myth and the script addresses it else 0
  comprehension  = 1 - (confused_comment_rate), from comment classification,
                   NULL when comments are disabled
  depth          = min(avg_watch_time / spoken_duration, 1)

  education_score = 100 × ( 0.30·demand_match + 0.25·gap_fill + 0.15·myth_correction
                          + 0.15·coalesce(comprehension, 0.5) + 0.15·depth )

SERVICE SCORE (0-100)

  q_rate  = questions_attributed / views × 1000
  c_rate  = consultations_attributed / views × 1000
  r_rate  = referrals_attributed / views × 1000
  clicks  = link_clicks / views × 1000

  service_score = 100 × ( 0.40·pct(c_rate) + 0.25·pct(q_rate)
                        + 0.20·pct(r_rate) + 0.15·pct(clicks) )
  confidence = LOW when consultations_attributed is unavailable for the window.

COMPOSITE = 0.25·reach + 0.40·education + 0.35·service
```

The composite deliberately underweights reach. A video with a million views on a topic nobody asked about, that produced no questions and no consultations, scores below a video with 40,000 views that filled a real gap and produced 12 consultations. That weighting is the editorial policy expressed as arithmetic, and it lives in `settings` so the team can argue with it and change it.

---

## WF19 Knowledge Review and Expiration

| Field | Value |
|---|---|
| Trigger | Cron daily 06:00 EAT |
| Purpose | Keep approved knowledge current and stop stale guidance reaching air |
| Next | WF15 for the review tasks it creates |

**Node map**

```
1  Cron
2  Log Start
3  HTTP: GET /knowledge/cards?status=APPROVED&expiring_within_days=60
4  Bucket: 60 days, 30 days, 7 days, expired
5  For 30 days and closer → POST /reviews { type: 'KNOWLEDGE_CARD', role: clinical }
6  For expired → POST /knowledge/cards/{id}/transition { to: 'NEEDS_UPDATE',
                    reason: 'review_due_at passed' }
     the database trigger cancels scheduled publishing jobs on that card
     in-flight scripts on that card are flagged, not deleted
7  HTTP: GET /knowledge/claims?status=APPROVED&expiring_within_days=30 → same treatment
8  HTTP: GET /knowledge/sources?status=ACTIVE  → check for a newer version
     Manual step: the clinical team confirms. No automated source replacement.
9  HTTP: GET /production/assets?consent_expiring_within_days=60
     and ?licence_expiring_within_days=60  → producer queue
10 HTTP: POST /platform/reports { type: 'KNOWLEDGE_HEALTH' } → medical_director digest
11 Log Finish
```

---

## WF20 Error, Retry and Dead Letter Handling

| Field | Value |
|---|---|
| Trigger | n8n Error Trigger from all nineteen workflows, plus webhook `job.dead_letter` |
| Purpose | Nothing fails silently, everything failed has an owner |
| Next | terminal |

**Node map**

```
1  Error Trigger
2  Function: classify the error
     TRANSIENT   → 5xx, timeout, rate limit, connection reset
     CONTRACT    → schema validation failure, unexpected provider shape
     GUARD       → business rule refused the transition
     DATA        → missing required object, broken reference
     PRIVACY     → forbidden field, de-identification failure
     BUDGET      → spend cap reached
3  Switch
   TRANSIENT → IF attempt < policy.max → Wait(backoff) → re-invoke the source workflow
               ELSE → dead letter
   CONTRACT  → dead letter immediately, attach the raw response, notify developer
   GUARD     → not an error. Log as SKIPPED with the guard name, notify the owning role.
   DATA      → dead letter, notify developer
   PRIVACY   → dead letter, notify admin and medical_director within 5 minutes,
               quarantine the affected batch, no retry
   BUDGET    → hold the job with a resume flag, notify admin, no dead letter
4  HTTP: POST /platform/workflow-events { status: 'DEAD_LETTER', owner_role, payload }
5  Notify by severity
     PRIVACY, TIER_4 blocking → Telegram immediate to admin and medical_director
     everything else          → hourly digest to the owning role
6  Dashboard tile: open dead letters by age and owner. Target steady state is zero.
```

**Replay**: `POST /platform/workflow-events/{id}/replay` re-invokes the source workflow with the stored payload, increments `attempt`, and links the new execution to the original. Replay requires `workflow.operate`.

---

### 21. Workflow dependency graph

```
WF01 ─▶ WF02 ─▶ WF03 ─▶ WF04 ─▶ WF05 ─┐
                                       │ (gap board, human decision)
                                       ▼
                    WF06 ─▶ WF07 ─▶ WF08 ─┬─▶ WF09 ─▶ WF10 ─┐
                              ▲            │                 │
                              │            └─────────────────┤
                              │                              ▼
                              │                            WF11 ─┬─▶ WF12 ─┐
                              │                                  ├─▶ WF13 ─┤
                              │                                  └─────────┴─▶ WF14
                              │                                                  │
                              └──── (edits) ──── WF15 ◀───────────────────────────┘
                                                   │
                                                   ▼
                                                 WF16 ─▶ WF17 ─▶ WF18 ─▶ (back to WF05)

WF19 runs independently daily and can freeze anything in the chain.
WF20 receives from all.
```

### 22. Schedule summary

| Workflow | Cadence |
|---|---|
| WF01 | webhook plus every 15 minutes |
| WF02 | webhook plus every 5 minutes |
| WF03 | webhook plus every 10 minutes |
| WF04 | hourly at :05 |
| WF05 | daily 04:00 EAT |
| WF06, WF07, WF08, WF09, WF10, WF11, WF12, WF13, WF14 | event driven |
| WF15 | event driven plus hourly escalation sweep |
| WF16 | every 5 minutes for due jobs |
| WF17 | daily 03:00 EAT plus per-post at +1h, +24h, +7d, +28d |
| WF18 | Sunday 05:00 EAT |
| WF19 | daily 06:00 EAT |
| WF20 | on error |
