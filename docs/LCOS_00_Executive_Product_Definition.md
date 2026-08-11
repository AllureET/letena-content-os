# Letena Content OS
## A. Executive Product Definition

Version 1.0 | 11 August 2026 | Owner: Nate Zewdu | Architect of record: this document

---

### 1. What the system is

Letena Content OS (LCOS) is the operating system for Letena's health education output. It converts anonymized questions from Ethiopian audiences into medically approved, culturally native SRH content across video, carousel, graphic and Telegram formats, in Amharic and English, with every medical statement traceable to an approved claim and an approved source.

It is a governance system with a content factory attached. The governance is the product. The generation is the throughput.

### 2. The single architectural commitment

Medical knowledge and published content are separate objects with separate lifecycles.

| | Medical knowledge | Content |
|---|---|---|
| Object | `knowledge_cards`, `medical_claims` | `content_concepts`, `scripts`, `renders`, `published_content` |
| Owned by | Clinical Lead | Content Lead |
| Changes | Rarely, on evidence review | Constantly, on audience response |
| AI role | Never authors, never edits | Generates, varies, localizes |
| Approval | Clinician sign-off, versioned, expiring | Editorial sign-off within risk tier rules |

AI may repackage an approved claim into a hook, a chat story, a scenario or an Amharic voiceover. AI may not create, extend, soften, sharpen, or infer a medical claim. When a creative concept needs a fact that does not exist as an approved claim, the pipeline stops and returns `NEEDS_KNOWLEDGE` to a human queue. That stop condition is the load-bearing safety control of the whole system.

### 3. Problem statement

Letena publishes 4 to 6 short videos a week and handles roughly 350 to 430 consultations a month. Three failures follow from that shape:

1. **Editorial choice is intuition-led.** Nobody can currently answer "what are Ethiopians actually asking this month, and what have we published against it?" with data. Question volume lives in DM inboxes, Telegram, the consultation tracker and comment threads, and none of it aggregates.
2. **Medical review is a bottleneck and has no memory.** A clinician reviews a script, approves it, and that judgement is discarded. The next script on the same topic starts from zero. There is no reusable approved answer, so review cost scales linearly with content volume.
3. **Content volume is capped by human production time.** One editor, one scriptwriter. Format variation, language variation and platform variation multiply the work by hand.

LCOS attacks all three: demand intelligence solves (1), the knowledge card layer solves (2), template rendering and agent generation solve (3).

### 4. What LCOS is not

- Not a chatbot answering individual users. Individual clinical advice stays in letena.et with a licensed GP. LCOS produces public education only.
- Not a replacement for clinicians. It converts clinician judgement into a reusable, auditable asset.
- Not a generative video toy. Most output is deterministic template rendering. Generative models are used for the parts where variation is cheap and safe.
- Not a system of record for patients. It never holds identity. See section 7.
- Not a general-purpose CMS. letena.et and the WordPress site keep their current jobs.

### 5. Users and their jobs

| Role slug | Person today | Job in LCOS | Screens they live in |
|---|---|---|---|
| `medical_director` | Dr. Blen Getahun Kassa | Approves knowledge cards, sets risk tiers, signs off Tier 3 and Tier 4 content, owns source hierarchy | Clinical Review, Knowledge Library, Claims |
| `consulting_doctor` | Dr. Liyu Kibrie, Dr. Eyerusalem Elias | Drafts and reviews knowledge cards, reviews scripts sampled from Tier 2, handles Tier 3 script approval | Clinical Review, Knowledge Card Detail |
| `content_lead` | Girum Leulseged | Runs the editorial calendar off the coverage gap board, commissions concepts, approves scripts | Coverage Gaps, Content Factory, Script Review |
| `language_editor` | To be appointed | Owns the Amharic terminology database, approves Amharic scripts, resolves back-translation drift | Language Review, Terminology |
| `intake_coordinator` | Rudy (Rediet Afework) | Feeds real anonymized questions in, presses Turn Into Content, watches the question stream | Questions, Question Clusters |
| `social_lead` | Soliana Tegybelu / Content team | Schedules, publishes, tracks platform performance | Publishing Calendar, Analytics |
| `producer` | Etsubdink Wondimu | Manages the asset library, approves renders, handles the B-roll shoot pipeline | Production Queue, Asset Library, Video Review |
| `developer` | Natnael Zerihun, Allure IT | Operates the system. Cannot approve clinical or language content. | System Settings, Audit Log, Observability |
| `admin` | Nate Zewdu | Users, roles, budgets, cost dashboards | All, plus Users and Roles |

Design constraint that overrides convenience: Rudy is the daily operator and is not a developer. If a routine action requires opening n8n, the design is wrong. Clinicians approve in a queue that looks like an inbox. Nobody outside the developer role sees a workflow canvas.

### 6. The loop

```
Real anonymized questions
  -> PII strip and classification
  -> semantic clustering into demand signals
  -> topic priority score and coverage gap
  -> editorial commissioning (human or Turn Into Content)
  -> approved knowledge card + approved claim set
  -> creative concepts (AI, constrained to claim IDs)
  -> English script (AI, claim-mapped)
  -> claim validation (AI, adversarial, no external knowledge)
  -> risk tier routing
  -> Amharic localization + back-translation (AI)
  -> language QA (human for Tier 2 and above)
  -> clinical review (human, mandatory Tier 3 and 4)
  -> asset resolution (library first, generation second)
  -> template render or presenter render
  -> human approval of the finished piece
  -> platform-specific publishing
  -> analytics collection
  -> reach / education / service scoring
  -> new questions generated by the content
  -> back to demand intelligence
```

Every arrow in that loop is a database state transition with an audit row. No arrow is a message in a chat window.

### 7. Privacy model in one paragraph

letena.et remains the system of record for patients and consultations and keeps holding aliases with no PII. LCOS never connects to patient tables. Questions arrive at LCOS through a one-way de-identification gate that strips names, numbers, handles, addresses, clinic and matter identifiers, and free-text identifiers, then stores only sanitized text plus a salted one-way `source_hash` for deduplication. The raw text is never written to the LCOS database. If de-identification confidence falls below threshold, the question is quarantined for human redaction rather than admitted. The content engine therefore cannot leak what it was never given.

### 8. Success measures for version one

The pilot succeeds if, after 30 days:

| Measure | Target |
|---|---|
| Approved knowledge cards live | 20 |
| Claims under version control | 120 or more |
| Generated candidate pieces | 160 |
| Human-selected published pieces | 40 to 60 |
| Median script-to-approved-render time | under 48 hours |
| Clinician minutes per approved piece | under 12 (baseline today is a full script read per piece) |
| Unsupported-claim escapes found in published content | 0 |
| Amharic pieces requiring full human rewrite | under 25 percent |
| Coverage gap board driving the editorial calendar | 80 percent of commissioned pieces trace to a ranked gap |
| Cost per approved published piece | measured and reported, no target in v1 |

The last two matter most. If the calendar is still being set by intuition, the demand intelligence layer has failed regardless of how many videos rendered.

### 9. Non-negotiable system behaviours

The system must never:

1. Publish content containing a medical statement that has no `claim_id` mapping with verdict `SUPPORTED`.
2. Use a knowledge card whose status is not `APPROVED` for a production publishing path.
3. Allow a translation step to change certainty, negation, quantity, time window, or risk level.
4. Present a generated conversation, character or scenario as a real patient case.
5. Present a digital presenter as a physician or imply credentials it does not hold.
6. Publish Tier 4 content without a recorded clinician approval on both the script and the final render.
7. Silently modify an approved knowledge card. Any edit creates a new version and moves status to `NEEDS_UPDATE` until re-approved.
8. Drop a failed job silently. Every failure lands in a dead letter queue with an owner.
9. Expose identifiable consultation data to any AI provider.
10. Let a developer role approve clinical or language content, including via the API.

### 10. Build sequence headline

Four releases. Full detail in document G.

| Release | Weeks | What exists at the end |
|---|---|---|
| R1 Knowledge Spine | 1 to 4 | Postgres, sources, claims, knowledge cards, terminology, clinical review UI, versioning, audit. 20 cards drafted. |
| R2 Demand Intelligence | 5 to 8 | Ingestion, de-identification, classification, embeddings, clustering, priority scoring, coverage gap board. |
| R3 Content Factory | 9 to 14 | Concept and script agents, claim validator, Amharic agent, language QA, risk routing, Creatomate render, review dashboard. |
| R4 Distribution and Learning | 15 to 20 | Publishing to five platforms, analytics collection, three performance scores, experiments, cost observability. |

Pilot runs across weeks 17 to 20 and gates the move from 20 cards to 100.

### 11. Key decisions already made

| Decision | Choice | Reason |
|---|---|---|
| Database | PostgreSQL 16 with pgvector, separate from letena.et MySQL | Clustering, JSONB, partial indexes and vector search are required. letena.et stays untouched on mysqli. |
| Integration with letena.et | Outbound webhook plus signed REST, one direction only | Keeps the PII firewall enforceable at the network layer. |
| Backend | Node.js 20 with TypeScript, Fastify, Prisma | The team's PHP is committed to letena.et. Content OS needs queue workers, streaming AI calls and typed schemas. |
| Orchestration | n8n, queue mode from R3 | Non-developers can inspect runs. Failure states stay visible. |
| Rendering | Creatomate for template video, HeyGen for presenter only | Template rendering is deterministic and cheap. Presenter is a small share of output. |
| Amharic voice | Human recorded for Tier 3 and 4, AI voice permitted for Tier 1 and 2 after a blind listening test | Amharic TTS quality is the weakest link in the chain. |
| Model strategy | Provider-abstracted agent layer, prompt versions stored in DB | Prompts are versioned assets, not code constants. |
| Frontend | React with Vite, one internal app, role-gated | One app avoids the fragmentation that would otherwise put clinicians in three tools. |

### 12. Standing risks

| Risk | Mitigation in design |
|---|---|
| Knowledge cards never get approved and the factory has no fuel | R1 ships before any generation capability. Card drafting is the first sprint, not the last. |
| Amharic output reads as translated English | Terminology database, back-translation review, human language editor with veto, native-Amharic authoring path for high-value cards. |
| Clinicians become the bottleneck again | Claim-level reuse, tiered review, sampling instead of full review at Tier 2, batched approval queue with keyboard workflow. |
| Cost per video is unknown until too late | Cost fields on every workflow event from R3. Cost dashboard in R4. |
| Platform API access denied or revoked | Publishing designed as prepare-then-hand-off, so a manual upload path always exists. TikTok in particular starts as upload-for-review. |
| The system is built and nobody uses it | Rudy's Turn Into Content button and the coverage gap board are R2 and R3 scope, not later. Adoption depends on them. |
