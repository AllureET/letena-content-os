-- =============================================================================
-- LETENA CONTENT OS  |  PostgreSQL 16 schema
-- File: LCOS_03_schema.sql   Version 1.0   11 August 2026
-- Target: PostgreSQL 16 with pgvector >= 0.7
-- Apply order: this file is idempotent-safe on a fresh database only.
-- Production changes go through Prisma migrations, never by editing this file.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE SCHEMA IF NOT EXISTS lcos;
SET search_path = lcos, public;

-- =============================================================================
-- SECTION 0.  ENUMERATED TYPES
-- =============================================================================

CREATE TYPE lifecycle_status AS ENUM (
  'DRAFT', 'IN_REVIEW', 'APPROVED', 'NEEDS_UPDATE', 'RETIRED'
);

CREATE TYPE source_type AS ENUM (
  'ETHIOPIAN_NATIONAL_GUIDELINE',   -- FMoH and national programme guidance
  'ETHIOPIAN_PROTOCOL',             -- facility or programme protocol endorsed nationally
  'WHO_GUIDELINE',
  'UN_AGENCY',                      -- UNFPA, UNAIDS, UNICEF
  'PROFESSIONAL_BODY',              -- ESOG, FIGO, ACOG and equivalents
  'PEER_REVIEWED',
  'NGO_TECHNICAL',
  'INTERNAL_PROTOCOL'               -- Letena clinical protocol, lowest precedence
);

CREATE TYPE source_status AS ENUM (
  'ACTIVE', 'SUPERSEDED', 'WITHDRAWN', 'UNDER_REVIEW'
);

CREATE TYPE risk_tier AS ENUM ('TIER_1', 'TIER_2', 'TIER_3', 'TIER_4');

CREATE TYPE content_language AS ENUM ('EN', 'AM', 'OM', 'TI');

CREATE TYPE ingest_channel AS ENUM (
  'WEBSITE', 'TELEGRAM', 'WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'TIKTOK_COMMENT',
  'YOUTUBE_COMMENT', 'PHONE_INTAKE', 'HOTLINE', 'SURVEY', 'UNIVERSITY_EVENT',
  'COMMUNITY_EVENT', 'ABEBA_APP', 'MANUAL_ENTRY', 'OTHER'
);

CREATE TYPE question_status AS ENUM (
  'PENDING_DEID', 'QUARANTINED', 'DEIDENTIFIED', 'CLASSIFIED',
  'CLUSTERED', 'ARCHIVED', 'REJECTED', 'PURGED'
);

CREATE TYPE question_intent AS ENUM (
  'FACT_SEEKING', 'REASSURANCE_SEEKING', 'MYTH_CHECK', 'SYMPTOM_CONCERN',
  'METHOD_CHOICE', 'ACCESS_QUESTION', 'RELATIONSHIP_CONTEXT',
  'URGENT_HELP', 'SERVICE_REQUEST', 'OTHER'
);

CREATE TYPE clinical_risk AS ENUM ('NONE', 'LOW', 'MODERATE', 'HIGH', 'EMERGENCY');

CREATE TYPE video_family AS ENUM (
  'V01_QUESTION_EXPLAINER',
  'V02_CHAT_STORY',
  'V03_ILLUSTRATED_SCENARIO',
  'V04_MEDICAL_VISUAL_EXPLAINER',
  'V05_DIGITAL_PRESENTER',
  'V06_REAL_ETHIOPIA_HYBRID',
  'C01_CAROUSEL',
  'C02_STATIC_GRAPHIC',
  'C03_TELEGRAM_POST'
);

CREATE TYPE concept_status AS ENUM (
  'PROPOSED', 'SELECTED', 'REJECTED', 'SCRIPTED', 'ARCHIVED'
);

CREATE TYPE script_status AS ENUM (
  'DRAFT', 'NEEDS_KNOWLEDGE', 'VALIDATING', 'VALIDATION_FAILED', 'VALIDATED',
  'LOCALIZING', 'LANGUAGE_REVIEW', 'CLINICAL_REVIEW', 'APPROVED',
  'REJECTED', 'SUPERSEDED'
);

CREATE TYPE validation_verdict AS ENUM (
  'SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'AMBIGUOUS'
);

CREATE TYPE finding_code AS ENUM (
  'UNSUPPORTED_STATEMENT', 'CONTRADICTS_CLAIM', 'MISSING_SAFETY_CONTEXT',
  'MISSING_REFERRAL', 'OVERSTATEMENT', 'CERTAINTY_INFLATION',
  'CAUSAL_OVERREACH', 'NUMBER_ALTERED', 'TIME_WINDOW_ALTERED',
  'NEGATION_ERROR', 'MEANING_LOST_IN_SIMPLIFICATION', 'CTA_CONTRADICTION',
  'FABRICATED_STATISTIC', 'FABRICATED_TESTIMONIAL', 'IMPLIED_CREDENTIALS',
  'PROHIBITED_CLAIM', 'VALIDATOR_UNAVAILABLE',
  'TERMINOLOGY_VIOLATION', 'REGISTER_MISMATCH', 'AMBIGUOUS_AMHARIC',
  'BACK_TRANSLATION_DRIFT', 'COMPREHENSION_RISK', 'JUDGEMENTAL_TONE',
  'UNTRANSLATED_TERM'
);
COMMENT ON TYPE finding_code IS
  'Union of every code any QA agent or deterministic overlay may raise. The agent '
  'JSON schemas in LCOS_06 must never contain a code absent from this list.';

CREATE TYPE finding_severity AS ENUM ('BLOCKER', 'MAJOR', 'MINOR', 'INFO');

CREATE TYPE review_type AS ENUM (
  'EDITORIAL', 'CLINICAL_SCRIPT', 'CLINICAL_FINAL', 'LANGUAGE',
  'KNOWLEDGE_CARD', 'TERMINOLOGY', 'ASSET'
);

CREATE TYPE review_status AS ENUM (
  'OPEN', 'IN_PROGRESS', 'COMPLETED', 'ESCALATED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE review_decision AS ENUM (
  'APPROVED', 'APPROVED_WITH_EDITS', 'CHANGES_REQUESTED', 'REJECTED', 'ESCALATED'
);

CREATE TYPE asset_kind AS ENUM (
  'VIDEO', 'IMAGE_PHOTO', 'ILLUSTRATION', 'MEDICAL_ILLUSTRATION', 'ICON',
  'AUDIO_VOICEOVER', 'AUDIO_MUSIC', 'AUDIO_SFX', 'SUBTITLE', 'LOGO', 'FONT', 'LOTTIE'
);

CREATE TYPE asset_origin AS ENUM (
  'SHOT_IN_HOUSE', 'LICENSED_STOCK', 'AI_GENERATED', 'PARTNER_SUPPLIED',
  'USER_SUBMITTED', 'PUBLIC_DOMAIN'
);

CREATE TYPE production_status AS ENUM (
  'QUEUED', 'ASSETS_PENDING', 'VOICE_PENDING', 'RENDERING',
  'RENDERED', 'FAILED', 'CANCELLED'
);

CREATE TYPE render_engine AS ENUM (
  'CREATOMATE', 'HEYGEN', 'FFMPEG_LOCAL', 'MANUAL_UPLOAD'
);

CREATE TYPE render_status AS ENUM (
  'PENDING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'
);

CREATE TYPE publish_platform AS ENUM (
  'TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'TELEGRAM',
  'WEBSITE', 'LINKEDIN', 'X'
);

CREATE TYPE publish_status AS ENUM (
  'DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED',
  'REJECTED', 'CANCELLED'
);

CREATE TYPE published_state AS ENUM ('LIVE', 'RETRACTED', 'DELETED_BY_PLATFORM', 'ARCHIVED');

CREATE TYPE workflow_status AS ENUM (
  'STARTED', 'SUCCEEDED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED', 'SKIPPED'
);

CREATE TYPE experiment_status AS ENUM (
  'DESIGNED', 'RUNNING', 'ANALYSING', 'CONCLUDED', 'ABANDONED'
);

CREATE TYPE ai_provider AS ENUM ('OPENAI', 'ANTHROPIC', 'GOOGLE', 'LOCAL', 'OTHER');

-- =============================================================================
-- SECTION 1.  PLATFORM: SETTINGS, IDENTITY, PERMISSIONS
-- =============================================================================

CREATE TABLE settings (
  key             text PRIMARY KEY,
  value           jsonb        NOT NULL,
  description     text,
  is_secret       boolean      NOT NULL DEFAULT false,
  updated_by      uuid,
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
COMMENT ON TABLE settings IS
  'Runtime configuration. Scoring weights, thresholds, model selection, cost rates. '
  'Changing a scoring weight must not require a deploy.';

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL,
  full_name          text        NOT NULL,
  display_name       text,
  password_hash      text,
  totp_secret        text,
  totp_enabled       boolean     NOT NULL DEFAULT false,
  preferred_language content_language NOT NULL DEFAULT 'EN',
  is_active          boolean     NOT NULL DEFAULT true,
  is_service_account boolean     NOT NULL DEFAULT false,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_shape CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX users_email_lower_uk ON users (lower(email));

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  description  text,
  is_clinical  boolean     NOT NULL DEFAULT false,
  is_system    boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN roles.slug IS
  'Role slugs match the letena.et convention so staff changes are data changes.';

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  domain      text NOT NULL,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

ALTER TABLE settings
  ADD CONSTRAINT settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id);

-- =============================================================================
-- SECTION 2.  KNOWLEDGE DOMAIN
-- =============================================================================

CREATE TABLE topics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text        NOT NULL UNIQUE,          -- 'EC', 'CON', 'PREG'
  name_en        text        NOT NULL,
  name_am        text,
  parent_id      uuid REFERENCES topics(id),
  default_risk_tier risk_tier NOT NULL DEFAULT 'TIER_2',
  strategic_weight numeric(4,2) NOT NULL DEFAULT 1.00
                   CHECK (strategic_weight BETWEEN 0 AND 5),
  clinical_weight  numeric(4,2) NOT NULL DEFAULT 1.00
                   CHECK (clinical_weight BETWEEN 0 AND 5),
  is_active      boolean     NOT NULL DEFAULT true,
  sort_order     integer     NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN topics.strategic_weight IS
  'Editorial priority multiplier set by the Content Lead. Feeds the demand score.';
COMMENT ON COLUMN topics.clinical_weight IS
  'Clinical importance multiplier set by the Medical Director. A low-volume topic '
  'with high clinical weight still surfaces on the coverage board.';

CREATE TABLE medical_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text        NOT NULL UNIQUE,        -- 'FMOH-FP-2023-V3'
  organisation     text        NOT NULL,
  title            text        NOT NULL,
  source_type      source_type NOT NULL,
  jurisdiction     text        NOT NULL DEFAULT 'ET',  -- ISO country or 'GLOBAL'
  precedence       smallint    NOT NULL,               -- 1 = highest authority
  version          text,
  publication_date date,
  effective_from   date,
  effective_to     date,
  url              text,
  storage_key      text,                                -- r2://.../sources/...
  status           source_status NOT NULL DEFAULT 'ACTIVE',
  superseded_by_id uuid REFERENCES medical_sources(id),
  topics_covered   uuid[]      NOT NULL DEFAULT '{}',
  notes            text,
  added_by         uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_precedence_range CHECK (precedence BETWEEN 1 AND 10),
  CONSTRAINT sources_superseded_requires_status
    CHECK (superseded_by_id IS NULL OR status = 'SUPERSEDED'),
  CONSTRAINT sources_effective_order
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
COMMENT ON COLUMN medical_sources.precedence IS
  'Evidence hierarchy, controlled by the clinical team. Ethiopian national guidance '
  'is 1. No automated process may reorder precedence.';

CREATE INDEX medical_sources_status_idx ON medical_sources (status)
  WHERE status = 'ACTIVE';
CREATE INDEX medical_sources_type_idx ON medical_sources (source_type, precedence);

CREATE TABLE medical_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text        NOT NULL UNIQUE,      -- 'EC-CLAIM-0042'
  topic_id           uuid        NOT NULL REFERENCES topics(id),
  claim_text_en      text        NOT NULL,
  claim_text_am      text,
  claim_type         text        NOT NULL DEFAULT 'FACT'
                     CHECK (claim_type IN ('FACT','MYTH_CORRECTION','SAFETY_WARNING',
                                           'REFERRAL_TRIGGER','TIME_WINDOW','QUANTITY',
                                           'CONTRAINDICATION','PROHIBITION')),
  certainty          text        NOT NULL DEFAULT 'ESTABLISHED'
                     CHECK (certainty IN ('ESTABLISHED','LIKELY','UNCERTAIN','CONTEXT_DEPENDENT')),
  risk_tier          risk_tier   NOT NULL DEFAULT 'TIER_2',
  status             lifecycle_status NOT NULL DEFAULT 'DRAFT',
  supersedes_claim_id uuid REFERENCES medical_claims(id),
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  review_due_at      date,
  retired_reason     text,
  notes              text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claims_approved_requires_reviewer
    CHECK (status <> 'APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
           AND review_due_at IS NOT NULL)),
  CONSTRAINT claims_retired_requires_reason
    CHECK (status <> 'RETIRED' OR retired_reason IS NOT NULL)
);
COMMENT ON TABLE medical_claims IS
  'The atomic unit of approved medical truth. Claim text is immutable once APPROVED; '
  'corrections create a new claim with supersedes_claim_id set.';

CREATE INDEX medical_claims_topic_status_idx ON medical_claims (topic_id, status);
CREATE INDEX medical_claims_review_due_idx ON medical_claims (review_due_at)
  WHERE status = 'APPROVED';
CREATE INDEX medical_claims_text_trgm_idx ON medical_claims
  USING gin (claim_text_en gin_trgm_ops);

CREATE TABLE claim_sources (
  claim_id      uuid NOT NULL REFERENCES medical_claims(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES medical_sources(id) ON DELETE RESTRICT,
  locator       text,                    -- 'Section 4.2, page 31'
  quote         text,                    -- verbatim supporting text
  is_primary    boolean NOT NULL DEFAULT false,
  added_by      uuid REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, source_id)
);
CREATE UNIQUE INDEX claim_sources_one_primary_idx
  ON claim_sources (claim_id) WHERE is_primary;

CREATE TABLE knowledge_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE,     -- 'EC-001'
  topic_id            uuid        NOT NULL REFERENCES topics(id),
  canonical_question_en text      NOT NULL,
  canonical_question_am text,
  status              lifecycle_status NOT NULL DEFAULT 'DRAFT',
  risk_tier           risk_tier   NOT NULL DEFAULT 'TIER_2',
  current_version_id  uuid,                            -- FK added after versions table
  approved_version_id uuid,
  audience_segment_ids uuid[]     NOT NULL DEFAULT '{}',
  min_age             smallint    CHECK (min_age IS NULL OR min_age BETWEEN 10 AND 60),
  am_approved         boolean     NOT NULL DEFAULT false,
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  review_due_at       date,
  retired_reason      text,
  owner_user_id       uuid REFERENCES users(id),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cards_approved_requires_review
    CHECK (status <> 'APPROVED' OR (approved_version_id IS NOT NULL
           AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
           AND review_due_at IS NOT NULL)),
  CONSTRAINT cards_retired_requires_reason
    CHECK (status <> 'RETIRED' OR retired_reason IS NOT NULL)
);

CREATE TABLE knowledge_card_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id             uuid        NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
  version             integer     NOT NULL,
  canonical_answer_en text        NOT NULL,
  canonical_answer_am text,
  key_points_en       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  key_points_am       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  prohibited_claims   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  referral_conditions jsonb       NOT NULL DEFAULT '[]'::jsonb,
  urgent_conditions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  approved_ctas       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  age_considerations  text,
  cultural_notes      text,
  change_summary      text,
  content_sha256      text        NOT NULL,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_versions_uk UNIQUE (card_id, version),
  CONSTRAINT card_versions_positive CHECK (version >= 1)
);
COMMENT ON COLUMN knowledge_card_versions.prohibited_claims IS
  'Statements that must never appear in content on this card, with the reason. '
  'The claim validator treats a match here as a BLOCKER regardless of other support.';

ALTER TABLE knowledge_cards
  ADD CONSTRAINT cards_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES knowledge_card_versions(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT cards_approved_version_fk
    FOREIGN KEY (approved_version_id) REFERENCES knowledge_card_versions(id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX knowledge_cards_status_idx ON knowledge_cards (status);
CREATE INDEX knowledge_cards_review_queue_idx ON knowledge_cards (updated_at)
  WHERE status = 'IN_REVIEW';
CREATE INDEX knowledge_cards_expiry_idx ON knowledge_cards (review_due_at)
  WHERE status = 'APPROVED';
CREATE INDEX knowledge_cards_topic_idx ON knowledge_cards (topic_id, status);
CREATE INDEX knowledge_cards_segments_idx ON knowledge_cards USING gin (audience_segment_ids);

CREATE TABLE knowledge_card_claims (
  card_id     uuid NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
  claim_id    uuid NOT NULL REFERENCES medical_claims(id) ON DELETE RESTRICT,
  is_core     boolean NOT NULL DEFAULT true,
  sort_order  smallint NOT NULL DEFAULT 10,
  added_by    uuid REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, claim_id)
);
COMMENT ON COLUMN knowledge_card_claims.is_core IS
  'Core claims must appear in any content generated from this card. Non-core claims '
  'are available to the writer and optional.';

CREATE TABLE knowledge_card_myths (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
  myth_en     text NOT NULL,
  myth_am     text,
  correction_claim_id uuid REFERENCES medical_claims(id),
  prevalence_note text,
  sort_order  smallint NOT NULL DEFAULT 10,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_card_myths_card_idx ON knowledge_card_myths (card_id);

-- ---------------------------------------------------------------------------
-- Terminology and translation
-- ---------------------------------------------------------------------------

CREATE TABLE terminology (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_en               text        NOT NULL,
  formal_am             text,
  conversational_am     text,
  youth_am              text,
  transliteration       text,
  preferred_am          text        NOT NULL,
  acceptable_am         text[]      NOT NULL DEFAULT '{}',
  avoid_am              text[]      NOT NULL DEFAULT '{}',
  avoid_reason          text,
  clinical_context      text,
  topic_id              uuid REFERENCES topics(id),
  register              text        NOT NULL DEFAULT 'GENERAL'
                        CHECK (register IN ('CLINICAL','GENERAL','YOUTH','ELDER','MIXED')),
  status                lifecycle_status NOT NULL DEFAULT 'DRAFT',
  reviewed_by           uuid REFERENCES users(id),
  reviewed_at           timestamptz,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terminology_term_uk UNIQUE (term_en, register)
);
CREATE INDEX terminology_status_idx ON terminology (status);
CREATE INDEX terminology_en_trgm_idx ON terminology USING gin (term_en gin_trgm_ops);
CREATE INDEX terminology_am_trgm_idx ON terminology USING gin (preferred_am gin_trgm_ops);

CREATE TABLE terminology_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminology_id uuid NOT NULL REFERENCES terminology(id) ON DELETE CASCADE,
  reviewer_id    uuid NOT NULL REFERENCES users(id),
  decision       review_decision NOT NULL,
  comment        text,
  reviewed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE translations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type       text        NOT NULL
                    CHECK (object_type IN ('KNOWLEDGE_CARD_VERSION','MEDICAL_CLAIM',
                                           'SCRIPT','CAPTION','UI_STRING')),
  object_id         uuid        NOT NULL,
  language          content_language NOT NULL,
  source_language   content_language NOT NULL DEFAULT 'EN',
  translated_text   text        NOT NULL,
  back_translation  text,
  drift_score       numeric(4,3) CHECK (drift_score BETWEEN 0 AND 1),
  terminology_used  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  uncertainties     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status            lifecycle_status NOT NULL DEFAULT 'DRAFT',
  produced_by_agent text,
  reviewed_by       uuid REFERENCES users(id),
  reviewed_at       timestamptz,
  content_sha256    text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT translations_uk UNIQUE (object_type, object_id, language)
);
CREATE INDEX translations_object_idx ON translations (object_type, object_id);
CREATE INDEX translations_review_queue_idx ON translations (created_at)
  WHERE status = 'IN_REVIEW';
COMMENT ON COLUMN translations.drift_score IS
  'Semantic distance between the source text and the back-translation, 0 is identical. '
  'Computed from embeddings. Above the configured threshold forces human review.';

-- =============================================================================
-- SECTION 3.  DEMAND DOMAIN
-- =============================================================================

CREATE TABLE audience_segments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text        NOT NULL UNIQUE,
  name_en              text        NOT NULL,
  name_am              text,
  age_min              smallint,
  age_max              smallint,
  gender               text CHECK (gender IN ('FEMALE','MALE','ANY')),
  relationship_context text,
  education_context    text,
  geographic_context   text,
  language_tendency    content_language NOT NULL DEFAULT 'AM',
  typical_concerns     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  common_misconceptions jsonb      NOT NULL DEFAULT '[]'::jsonb,
  communication_style  text,
  tone_guidance        text        NOT NULL,
  sensitivity_notes    text,
  terms_to_avoid       text[]      NOT NULL DEFAULT '{}',
  preferred_platforms  publish_platform[] NOT NULL DEFAULT '{}',
  performing_patterns  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT segments_age_order CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min)
);

CREATE TABLE ingest_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref  text UNIQUE,
  channel       ingest_channel NOT NULL,
  submitted_by  uuid REFERENCES users(id),
  source_system text        NOT NULL DEFAULT 'letena.et',
  record_count  integer     NOT NULL DEFAULT 0,
  accepted_count integer    NOT NULL DEFAULT 0,
  quarantined_count integer NOT NULL DEFAULT 0,
  rejected_count integer    NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audience_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid REFERENCES ingest_batches(id),
  channel           ingest_channel NOT NULL,
  source_hash       text        NOT NULL,
  sanitized_text    text        NOT NULL,
  language          content_language,
  is_code_mixed     boolean     NOT NULL DEFAULT false,
  status            question_status NOT NULL DEFAULT 'PENDING_DEID',
  deid_confidence   numeric(4,3) CHECK (deid_confidence BETWEEN 0 AND 1),
  deid_redactions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  quarantine_reason text,
  segment_hint      uuid REFERENCES audience_segments(id),
  embedding         vector(1536),
  captured_at       timestamptz NOT NULL,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  purge_after       date        NOT NULL DEFAULT ((now() + interval '24 months')::date),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT questions_source_hash_uk UNIQUE (source_hash),
  CONSTRAINT questions_text_length CHECK (char_length(sanitized_text) BETWEEN 3 AND 4000)
);
COMMENT ON TABLE audience_questions IS
  'De-identified only. There is deliberately no raw_text column. Raw text never '
  'reaches this database. deid_redactions records the span types removed, never the values.';

CREATE INDEX questions_status_idx ON audience_questions (status);
CREATE INDEX questions_captured_idx ON audience_questions (captured_at DESC);
CREATE INDEX questions_channel_idx ON audience_questions (channel, captured_at DESC);
CREATE INDEX questions_purge_idx ON audience_questions (purge_after);
CREATE INDEX questions_text_trgm_idx ON audience_questions
  USING gin (sanitized_text gin_trgm_ops);
CREATE INDEX questions_embedding_idx ON audience_questions
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE question_classifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id         uuid        NOT NULL REFERENCES audience_questions(id) ON DELETE CASCADE,
  topic_id            uuid REFERENCES topics(id),
  subtopic            text,
  intent              question_intent NOT NULL,
  is_myth             boolean     NOT NULL DEFAULT false,
  myth_text           text,
  fear_expressed      text,
  urgency             clinical_risk NOT NULL DEFAULT 'NONE',
  clinical_risk       clinical_risk NOT NULL DEFAULT 'NONE',
  audience_segment_id uuid REFERENCES audience_segments(id),
  knowledge_card_id   uuid REFERENCES knowledge_cards(id),
  match_confidence    numeric(4,3) CHECK (match_confidence BETWEEN 0 AND 1),
  content_value       smallint    CHECK (content_value BETWEEN 1 AND 5),
  content_opportunity text,
  referral_relevant   boolean     NOT NULL DEFAULT false,
  sentiment           text CHECK (sentiment IN ('ANXIOUS','NEUTRAL','FRUSTRATED','ASHAMED','CURIOUS','DISTRESSED')),
  agent_run_id        uuid,
  prompt_version      text,
  raw_output          jsonb       NOT NULL,
  classified_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classifications_question_uk UNIQUE (question_id)
);
CREATE INDEX classifications_topic_idx ON question_classifications (topic_id);
CREATE INDEX classifications_card_idx ON question_classifications (knowledge_card_id);
CREATE INDEX classifications_unmatched_idx ON question_classifications (classified_at)
  WHERE knowledge_card_id IS NULL;
CREATE INDEX classifications_raw_gin_idx ON question_classifications USING gin (raw_output);

CREATE TABLE question_clusters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text        NOT NULL UNIQUE,
  label_en           text        NOT NULL,
  label_am           text,
  representative_question text   NOT NULL,
  topic_id           uuid REFERENCES topics(id),
  knowledge_card_id  uuid REFERENCES knowledge_cards(id),
  centroid           vector(1536),
  member_count       integer     NOT NULL DEFAULT 0,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  clinically_distinct_note text,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN question_clusters.clinically_distinct_note IS
  'Set by a clinician when semantically similar questions require different answers. '
  'Blocks the clustering job from merging this cluster with its neighbours.';

CREATE INDEX clusters_topic_idx ON question_clusters (topic_id);
CREATE INDEX clusters_last_seen_idx ON question_clusters (last_seen_at DESC);
CREATE INDEX clusters_centroid_idx ON question_clusters
  USING hnsw (centroid vector_cosine_ops);

CREATE TABLE question_cluster_members (
  cluster_id   uuid NOT NULL REFERENCES question_clusters(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES audience_questions(id) ON DELETE CASCADE,
  similarity   numeric(5,4) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  relation     text NOT NULL DEFAULT 'PARAPHRASE'
               CHECK (relation IN ('DUPLICATE','PARAPHRASE','RELATED')),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, question_id)
);
CREATE INDEX cluster_members_question_idx ON question_cluster_members (question_id);

CREATE TABLE topic_priority_scores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_for        date        NOT NULL,
  topic_id            uuid        NOT NULL REFERENCES topics(id),
  knowledge_card_id   uuid REFERENCES knowledge_cards(id),
  audience_segment_id uuid REFERENCES audience_segments(id),
  question_count_30d  integer     NOT NULL DEFAULT 0,
  question_count_prev_30d integer NOT NULL DEFAULT 0,
  growth_rate         numeric(6,3) NOT NULL DEFAULT 0,
  unanswered_rate     numeric(5,4) NOT NULL DEFAULT 0,
  content_count_90d   integer     NOT NULL DEFAULT 0,
  coverage_ratio      numeric(6,3) NOT NULL DEFAULT 0,
  engagement_index    numeric(6,3) NOT NULL DEFAULT 0,
  education_index     numeric(6,3) NOT NULL DEFAULT 0,
  service_index       numeric(6,3) NOT NULL DEFAULT 0,
  clinical_weight     numeric(4,2) NOT NULL DEFAULT 1,
  strategic_weight    numeric(4,2) NOT NULL DEFAULT 1,
  seasonal_factor     numeric(4,2) NOT NULL DEFAULT 1,
  priority_score      numeric(8,3) NOT NULL,
  gap_flag            boolean     NOT NULL DEFAULT false,
  formula_version     text        NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topic_priority_uk UNIQUE (computed_for, topic_id, knowledge_card_id, audience_segment_id)
);
CREATE INDEX topic_priority_rank_idx ON topic_priority_scores (computed_for, priority_score DESC);
CREATE INDEX topic_priority_gap_idx ON topic_priority_scores (computed_for)
  WHERE gap_flag;

CREATE TABLE coverage_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_for       date        NOT NULL,
  knowledge_card_id  uuid REFERENCES knowledge_cards(id),
  topic_id           uuid        NOT NULL REFERENCES topics(id),
  has_approved_card  boolean     NOT NULL DEFAULT false,
  card_expires_in_days integer,
  content_pieces_90d integer     NOT NULL DEFAULT 0,
  content_pieces_am_90d integer  NOT NULL DEFAULT 0,
  formats_covered    video_family[] NOT NULL DEFAULT '{}',
  segments_covered   uuid[]      NOT NULL DEFAULT '{}',
  demand_rank        integer,
  coverage_state     text        NOT NULL
                     CHECK (coverage_state IN ('NO_KNOWLEDGE','KNOWLEDGE_NO_CONTENT',
                                               'UNDER_COVERED','ADEQUATE','SATURATED','STALE')),
  computed_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coverage_snapshot_uk UNIQUE (computed_for, topic_id, knowledge_card_id)
);
CREATE INDEX coverage_state_idx ON coverage_snapshots (computed_for, coverage_state);

-- =============================================================================
-- SECTION 4.  CONTENT DOMAIN
-- =============================================================================

CREATE TABLE content_families (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE,     -- 'CF-2026-08-EC003-01'
  title               text        NOT NULL,
  knowledge_card_id   uuid        NOT NULL REFERENCES knowledge_cards(id) ON DELETE RESTRICT,
  knowledge_card_version_id uuid  NOT NULL REFERENCES knowledge_card_versions(id),
  primary_segment_id  uuid        NOT NULL REFERENCES audience_segments(id),
  risk_tier           risk_tier   NOT NULL,
  origin              text        NOT NULL DEFAULT 'PLANNED'
                      CHECK (origin IN ('PLANNED','TURN_INTO_CONTENT','EXPERIMENT',
                                        'GAP_BOARD','CAMPAIGN','REFRESH')),
  origin_question_id  uuid REFERENCES audience_questions(id),
  origin_cluster_id   uuid REFERENCES question_clusters(id),
  campaign_ref        text,
  brief               text,
  target_publish_from date,
  target_publish_to   date,
  is_active           boolean     NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE content_families IS
  'One educational idea. Every concept, script, render and platform post derived from '
  'it shares this id, which is how analytics knows five posts are one idea.';

CREATE INDEX content_families_card_idx ON content_families (knowledge_card_id);
CREATE INDEX content_families_origin_idx ON content_families (origin, created_at DESC);

CREATE TABLE content_concepts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE,
  family_id           uuid        NOT NULL REFERENCES content_families(id) ON DELETE CASCADE,
  video_family        video_family NOT NULL,
  title               text        NOT NULL,
  hook_line           text        NOT NULL,
  premise             text        NOT NULL,
  treatment           text        NOT NULL,
  perspective         text,
  characters          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  target_duration_s   smallint    NOT NULL DEFAULT 30
                      CHECK (target_duration_s BETWEEN 6 AND 600),
  target_platforms    publish_platform[] NOT NULL DEFAULT '{}',
  claim_ids_referenced uuid[]     NOT NULL DEFAULT '{}',
  cta_intent          text,
  status              concept_status NOT NULL DEFAULT 'PROPOSED',
  selection_note      text,
  why_this_works      text,
  novelty_note        text,
  novelty_score       numeric(4,3),
  agent_run_id        uuid,
  prompt_version      text,
  selected_by         uuid REFERENCES users(id),
  selected_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concepts_family_idx ON content_concepts (family_id, status);
CREATE INDEX concepts_selection_queue_idx ON content_concepts (created_at)
  WHERE status = 'PROPOSED';

CREATE TABLE scripts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE,
  concept_id          uuid        NOT NULL REFERENCES content_concepts(id) ON DELETE CASCADE,
  family_id           uuid        NOT NULL REFERENCES content_families(id),
  knowledge_card_version_id uuid  NOT NULL REFERENCES knowledge_card_versions(id),
  language            content_language NOT NULL,
  parent_script_id    uuid REFERENCES scripts(id),   -- set on localized derivatives
  status              script_status NOT NULL DEFAULT 'DRAFT',
  risk_tier           risk_tier   NOT NULL,
  current_version     integer     NOT NULL DEFAULT 1,
  approved_version    integer,
  validation_result   text CHECK (validation_result IN ('PASS','FAIL','NOT_RUN')),
  validation_run_at   timestamptz,
  needs_knowledge_note text,
  content_sha256      text,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  rejected_reason     text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scripts_approved_requires_pass
    CHECK (status <> 'APPROVED' OR (validation_result = 'PASS'
           AND approved_by IS NOT NULL AND approved_version IS NOT NULL)),
  CONSTRAINT scripts_localized_has_parent
    CHECK (language = 'EN' OR parent_script_id IS NOT NULL OR status = 'DRAFT')
);
CREATE INDEX scripts_status_idx ON scripts (status);
CREATE INDEX scripts_family_idx ON scripts (family_id, language);
CREATE INDEX scripts_review_queue_idx ON scripts (risk_tier, updated_at)
  WHERE status IN ('CLINICAL_REVIEW','LANGUAGE_REVIEW');
CREATE INDEX scripts_needs_knowledge_idx ON scripts (created_at)
  WHERE status = 'NEEDS_KNOWLEDGE';

CREATE TABLE script_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id       uuid        NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version         integer     NOT NULL,
  hook            text        NOT NULL,
  spoken_script   text        NOT NULL,
  onscreen_text   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  scene_plan      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cta             text        NOT NULL,
  caption         text,
  hashtags        text[]      NOT NULL DEFAULT '{}',
  platform_variants jsonb     NOT NULL DEFAULT '{}'::jsonb,
  estimated_duration_s numeric(6,2),
  word_count      integer,
  change_summary  text,
  authored_by     text        NOT NULL DEFAULT 'AGENT'
                  CHECK (authored_by IN ('AGENT','HUMAN','AGENT_HUMAN_EDITED')),
  agent_run_id    uuid,
  prompt_version  text,
  content_sha256  text        NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_versions_uk UNIQUE (script_id, version)
);

CREATE TABLE script_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id       uuid        NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  script_version  integer     NOT NULL,
  claim_id        uuid        NOT NULL REFERENCES medical_claims(id) ON DELETE RESTRICT,
  statement       text        NOT NULL,
  location        text        NOT NULL
                  CHECK (location IN ('HOOK','SPOKEN','ONSCREEN','CTA','CAPTION')),
  char_start      integer,
  char_end        integer,
  verdict         validation_verdict,
  verdict_reason  text,
  validated_at    timestamptz,
  agent_run_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE script_claims IS
  'Every medically meaningful statement in a script maps to exactly one approved claim. '
  'A statement with no mapping cannot exist here, which is what makes the validator '
  'output structurally complete.';

CREATE INDEX script_claims_script_idx ON script_claims (script_id, script_version);
CREATE INDEX script_claims_claim_idx ON script_claims (claim_id);
CREATE INDEX script_claims_failed_idx ON script_claims (script_id)
  WHERE verdict IN ('UNSUPPORTED','CONTRADICTED','AMBIGUOUS');

CREATE TABLE script_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id       uuid        NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  script_version  integer     NOT NULL,
  code            finding_code NOT NULL,
  severity        finding_severity NOT NULL,
  statement       text,
  explanation     text        NOT NULL,
  suggested_fix   text,
  raised_by       text        NOT NULL DEFAULT 'CLAIM_VALIDATOR',
  agent_run_id    uuid,
  resolved        boolean     NOT NULL DEFAULT false,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX script_findings_open_idx ON script_findings (script_id)
  WHERE NOT resolved;

-- =============================================================================
-- SECTION 5.  PRODUCTION DOMAIN
-- =============================================================================

CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,
  kind              asset_kind  NOT NULL,
  origin            asset_origin NOT NULL,
  title             text        NOT NULL,
  description       text,
  storage_key       text        NOT NULL,
  preview_key       text,
  mime_type         text        NOT NULL,
  bytes             bigint,
  width             integer,
  height            integer,
  duration_s        numeric(8,2),
  orientation       text CHECK (orientation IN ('PORTRAIT','LANDSCAPE','SQUARE','AUDIO','NA')),
  quality_rating    smallint CHECK (quality_rating BETWEEN 1 AND 5),
  language          content_language,
  country           text        NOT NULL DEFAULT 'ET',
  city              text,
  environment       text,
  people_present    boolean     NOT NULL DEFAULT false,
  people_consent_ref text,
  consent_expires_on date,
  licence           text        NOT NULL DEFAULT 'OWNED',
  licence_expires_on date,
  usage_restrictions text,
  is_ai_generated   boolean     NOT NULL DEFAULT false,
  ai_generation_meta jsonb,
  clinically_approved boolean   NOT NULL DEFAULT false,
  clinically_approved_by uuid REFERENCES users(id),
  clinically_approved_at timestamptz,
  topic_ids         uuid[]      NOT NULL DEFAULT '{}',
  embedding         vector(1536),
  is_active         boolean     NOT NULL DEFAULT true,
  uploaded_by       uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_people_need_consent
    CHECK (NOT people_present OR people_consent_ref IS NOT NULL),
  CONSTRAINT assets_medical_illustration_needs_approval
    CHECK (kind <> 'MEDICAL_ILLUSTRATION' OR clinically_approved OR NOT is_active)
);
COMMENT ON CONSTRAINT assets_medical_illustration_needs_approval ON assets IS
  'Anatomy and medical diagrams cannot be used in production without clinical sign-off, '
  'which closes the generative-anatomy risk.';

CREATE INDEX assets_kind_idx ON assets (kind, is_active);
CREATE INDEX assets_topics_idx ON assets USING gin (topic_ids);
CREATE INDEX assets_licence_expiry_idx ON assets (licence_expires_on)
  WHERE licence_expires_on IS NOT NULL;
CREATE INDEX assets_consent_expiry_idx ON assets (consent_expires_on)
  WHERE consent_expires_on IS NOT NULL;
CREATE INDEX assets_embedding_idx ON assets USING hnsw (embedding vector_cosine_ops);

CREATE TABLE asset_tags (
  asset_id   uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  namespace  text NOT NULL,           -- 'emotion', 'activity', 'medical_object', 'age'
  value      text NOT NULL,
  confidence numeric(4,3),
  tagged_by  text NOT NULL DEFAULT 'HUMAN' CHECK (tagged_by IN ('HUMAN','AGENT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, namespace, value)
);
CREATE INDEX asset_tags_lookup_idx ON asset_tags (namespace, value);

CREATE TABLE video_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,     -- 'LETENA_QA_30S_V1'
  name              text        NOT NULL,
  engine            render_engine NOT NULL DEFAULT 'CREATOMATE',
  external_template_id text,
  video_family      video_family NOT NULL,
  aspect_ratio      text        NOT NULL DEFAULT '9:16',
  width             integer     NOT NULL DEFAULT 1080,
  height            integer     NOT NULL DEFAULT 1920,
  min_duration_s    smallint    NOT NULL DEFAULT 15,
  max_duration_s    smallint    NOT NULL DEFAULT 60,
  scene_count       smallint    NOT NULL DEFAULT 3,
  supports_languages content_language[] NOT NULL DEFAULT '{EN,AM}',
  version           integer     NOT NULL DEFAULT 1,
  status            lifecycle_status NOT NULL DEFAULT 'DRAFT',
  preview_key       text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_code_version_uk UNIQUE (code, version)
);

CREATE TABLE template_variables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES video_templates(id) ON DELETE CASCADE,
  name          text NOT NULL,
  data_type     text NOT NULL CHECK (data_type IN ('TEXT','ASSET','AUDIO','COLOR','NUMBER','BOOLEAN')),
  is_required   boolean NOT NULL DEFAULT true,
  max_length    integer,
  default_value text,
  maps_to       text,          -- 'script.hook', 'scene_plan[0].asset_id'
  description   text,
  sort_order    smallint NOT NULL DEFAULT 10,
  CONSTRAINT template_variables_uk UNIQUE (template_id, name)
);

CREATE TABLE production_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,
  script_id         uuid        NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
  family_id         uuid        NOT NULL REFERENCES content_families(id),
  template_id       uuid REFERENCES video_templates(id),
  engine            render_engine NOT NULL,
  status            production_status NOT NULL DEFAULT 'QUEUED',
  priority          smallint    NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
  routing_reason    text,
  asset_plan        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  missing_assets    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  voice_source      text        NOT NULL DEFAULT 'HUMAN'
                    CHECK (voice_source IN ('HUMAN','AI_TTS','NONE')),
  voice_asset_id    uuid REFERENCES assets(id),
  estimated_cost_usd numeric(10,4),
  actual_cost_usd   numeric(10,4),
  attempts          smallint    NOT NULL DEFAULT 0,
  last_error        text,
  requested_by      uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX production_jobs_status_idx ON production_jobs (status, priority DESC, created_at);
CREATE INDEX production_jobs_script_idx ON production_jobs (script_id);

CREATE TABLE renders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_job_id uuid        NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  script_id         uuid        NOT NULL REFERENCES scripts(id),
  template_id       uuid REFERENCES video_templates(id),
  template_code     text,
  template_version  integer,
  engine            render_engine NOT NULL,
  external_render_id text,
  status            render_status NOT NULL DEFAULT 'PENDING',
  variant_label     text,                       -- 'tiktok', 'ig_reel', 'yt_short'
  aspect_ratio      text        NOT NULL DEFAULT '9:16',
  duration_s        numeric(8,2),
  storage_key       text,
  preview_key       text,
  subtitle_key      text,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  provider_response jsonb,
  cost_usd          numeric(10,4),
  attempts          smallint    NOT NULL DEFAULT 0,
  error_code        text,
  error_detail      text,
  submitted_at      timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX renders_status_idx ON renders (status, submitted_at);
CREATE INDEX renders_job_idx ON renders (production_job_id);
CREATE INDEX renders_review_queue_idx ON renders (completed_at)
  WHERE status = 'SUCCEEDED';

-- =============================================================================
-- SECTION 6.  GOVERNANCE DOMAIN
-- =============================================================================

CREATE TABLE review_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_type       review_type NOT NULL,
  object_type       text        NOT NULL
                    CHECK (object_type IN ('KNOWLEDGE_CARD','MEDICAL_CLAIM','SCRIPT',
                                           'TRANSLATION','RENDER','TERMINOLOGY','ASSET')),
  object_id         uuid        NOT NULL,
  object_version    integer,
  content_sha256    text,
  risk_tier         risk_tier,
  status            review_status NOT NULL DEFAULT 'OPEN',
  required_role_id  uuid REFERENCES roles(id),
  assigned_to       uuid REFERENCES users(id),
  due_at            timestamptz,
  sla_hours         smallint    NOT NULL DEFAULT 24,
  escalated_to      uuid REFERENCES users(id),
  escalated_at      timestamptz,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_tasks_queue_idx ON review_tasks (review_type, status, due_at)
  WHERE status IN ('OPEN','IN_PROGRESS');
CREATE INDEX review_tasks_object_idx ON review_tasks (object_type, object_id);
CREATE INDEX review_tasks_assignee_idx ON review_tasks (assigned_to, status);

CREATE TABLE clinical_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_task_id    uuid REFERENCES review_tasks(id) ON DELETE SET NULL,
  object_type       text        NOT NULL
                    CHECK (object_type IN ('KNOWLEDGE_CARD','MEDICAL_CLAIM','SCRIPT','RENDER','ASSET')),
  object_id         uuid        NOT NULL,
  object_version    integer,
  script_id         uuid REFERENCES scripts(id),
  render_id         uuid REFERENCES renders(id),
  knowledge_card_id uuid REFERENCES knowledge_cards(id),
  reviewer_user_id  uuid        NOT NULL REFERENCES users(id),
  reviewer_role     text        NOT NULL,
  decision          review_decision NOT NULL,
  risk_tier_at_review risk_tier NOT NULL,
  comment           text,
  edits_applied     jsonb,
  second_reader_id  uuid REFERENCES users(id),
  content_sha256    text        NOT NULL,
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinical_reviews_rejection_needs_comment
    CHECK (decision NOT IN ('CHANGES_REQUESTED','REJECTED') OR comment IS NOT NULL)
);
CREATE INDEX clinical_reviews_object_idx ON clinical_reviews (object_type, object_id, reviewed_at DESC);
CREATE INDEX clinical_reviews_reviewer_idx ON clinical_reviews (reviewer_user_id, reviewed_at DESC);

CREATE TABLE language_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_task_id    uuid REFERENCES review_tasks(id) ON DELETE SET NULL,
  object_type       text        NOT NULL
                    CHECK (object_type IN ('SCRIPT','TRANSLATION','TERMINOLOGY','KNOWLEDGE_CARD')),
  object_id         uuid        NOT NULL,
  object_version    integer,
  script_id         uuid REFERENCES scripts(id),
  translation_id    uuid REFERENCES translations(id),
  reviewer_user_id  uuid        NOT NULL REFERENCES users(id),
  language          content_language NOT NULL,
  decision          review_decision NOT NULL,
  naturalness_score smallint CHECK (naturalness_score BETWEEN 1 AND 5),
  register_correct  boolean,
  meaning_preserved boolean,
  terminology_issues jsonb      NOT NULL DEFAULT '[]'::jsonb,
  corrected_text    text,
  comment           text,
  content_sha256    text        NOT NULL,
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT language_reviews_meaning_gate
    CHECK (decision <> 'APPROVED' OR meaning_preserved IS TRUE)
);
CREATE INDEX language_reviews_object_idx ON language_reviews (object_type, object_id, reviewed_at DESC);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  actor_type    text        NOT NULL DEFAULT 'USER'
                CHECK (actor_type IN ('USER','SERVICE','AGENT','SYSTEM')),
  actor_label   text,
  action        text        NOT NULL,        -- 'knowledge_card.approve'
  object_type   text        NOT NULL,
  object_id     uuid,
  object_code   text,
  from_state    text,
  to_state      text,
  request_id    text,
  ip_address    inet,
  user_agent    text,
  diff          jsonb,
  reason        text
);
CREATE INDEX audit_log_object_idx ON audit_log (object_type, object_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC);
COMMENT ON TABLE audit_log IS
  'Append only. The application database role holds INSERT and SELECT only. '
  'No UPDATE or DELETE grant exists.';

-- =============================================================================
-- SECTION 7.  DISTRIBUTION AND LEARNING
-- =============================================================================

CREATE TABLE platform_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform          publish_platform NOT NULL,
  handle            text        NOT NULL,
  display_name      text,
  external_account_id text,
  credential_ref    text        NOT NULL,     -- pointer to the secret store, never the secret
  token_expires_at  timestamptz,
  scopes            text[]      NOT NULL DEFAULT '{}',
  is_primary        boolean     NOT NULL DEFAULT false,
  is_active         boolean     NOT NULL DEFAULT true,
  supports_direct_publish boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_accounts_uk UNIQUE (platform, handle)
);
COMMENT ON COLUMN platform_accounts.supports_direct_publish IS
  'False forces the prepare-and-hand-off path, which is how TikTok starts before '
  'Content Posting API approval.';

CREATE TABLE publishing_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,
  render_id         uuid        NOT NULL REFERENCES renders(id) ON DELETE RESTRICT,
  family_id         uuid        NOT NULL REFERENCES content_families(id),
  platform          publish_platform NOT NULL,
  platform_account_id uuid      NOT NULL REFERENCES platform_accounts(id),
  status            publish_status NOT NULL DEFAULT 'DRAFT',
  scheduled_for     timestamptz,
  title             text,
  caption           text,
  hashtags          text[]      NOT NULL DEFAULT '{}',
  first_comment     text,
  thumbnail_asset_id uuid REFERENCES assets(id),
  comments_enabled  boolean     NOT NULL DEFAULT true,
  moderation_plan   text,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  provider_response jsonb,
  attempts          smallint    NOT NULL DEFAULT 0,
  error_code        text,
  error_detail      text,
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publishing_scheduled_requires_approval
    CHECK (status = 'DRAFT' OR approved_by IS NOT NULL)
);
CREATE INDEX publishing_jobs_due_idx ON publishing_jobs (scheduled_for)
  WHERE status = 'SCHEDULED';
CREATE INDEX publishing_jobs_family_idx ON publishing_jobs (family_id);

CREATE TABLE published_content (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publishing_job_id   uuid        NOT NULL UNIQUE REFERENCES publishing_jobs(id),
  render_id           uuid        NOT NULL REFERENCES renders(id),
  family_id           uuid        NOT NULL REFERENCES content_families(id),
  script_id           uuid        NOT NULL REFERENCES scripts(id),
  knowledge_card_id   uuid        NOT NULL REFERENCES knowledge_cards(id),
  knowledge_card_version_id uuid  NOT NULL REFERENCES knowledge_card_versions(id),
  script_version      integer     NOT NULL,
  template_code       text,
  template_version    integer,
  platform            publish_platform NOT NULL,
  platform_account_id uuid        NOT NULL REFERENCES platform_accounts(id),
  platform_post_id    text,
  platform_url        text,
  language            content_language NOT NULL,
  video_family        video_family NOT NULL,
  audience_segment_id uuid        NOT NULL REFERENCES audience_segments(id),
  risk_tier           risk_tier   NOT NULL,
  duration_s          numeric(8,2),
  state               published_state NOT NULL DEFAULT 'LIVE',
  retracted_reason    text,
  published_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_platform_post_uk UNIQUE (platform, platform_post_id)
);
CREATE INDEX published_family_idx ON published_content (family_id);
CREATE INDEX published_card_idx ON published_content (knowledge_card_id, published_at DESC);
CREATE INDEX published_at_idx ON published_content (published_at DESC);
CREATE INDEX published_segment_idx ON published_content (audience_segment_id, published_at DESC);

CREATE TABLE content_performance (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_content_id  uuid        NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
  metric_date           date        NOT NULL,
  granularity           text        NOT NULL DEFAULT 'DAILY'
                        CHECK (granularity IN ('DAILY','WEEKLY','LIFETIME')),
  views                 bigint,
  reach                 bigint,
  impressions           bigint,
  views_3s              bigint,
  views_10s             bigint,
  avg_watch_time_s      numeric(8,2),
  completion_rate       numeric(5,4),
  likes                 bigint,
  comments              bigint,
  shares                bigint,
  saves                 bigint,
  profile_visits        bigint,
  link_clicks           bigint,
  follows               bigint,
  dm_initiated          bigint,
  questions_attributed  integer     NOT NULL DEFAULT 0,
  consultations_attributed integer  NOT NULL DEFAULT 0,
  referrals_attributed  integer     NOT NULL DEFAULT 0,
  metrics_available     text[]      NOT NULL DEFAULT '{}',
  raw_payload           jsonb,
  collected_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_performance_uk UNIQUE (published_content_id, metric_date, granularity)
);
COMMENT ON COLUMN content_performance.metrics_available IS
  'Explicit list of which metrics this platform actually returned. NULL means not '
  'supplied. Nothing is ever imputed or estimated.';

CREATE INDEX content_performance_date_idx ON content_performance (metric_date DESC);

CREATE TABLE content_scores (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_content_id uuid        NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
  computed_for         date        NOT NULL,
  window_days          smallint    NOT NULL DEFAULT 28,
  reach_score          numeric(6,2),
  education_score      numeric(6,2),
  service_score        numeric(6,2),
  composite_score      numeric(6,2),
  reach_inputs         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  education_inputs     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  service_inputs       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  confidence           text        NOT NULL DEFAULT 'FULL'
                       CHECK (confidence IN ('FULL','PARTIAL','LOW')),
  formula_version      text        NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_scores_uk UNIQUE (published_content_id, computed_for, window_days)
);
CREATE INDEX content_scores_rank_idx ON content_scores (computed_for, composite_score DESC);

CREATE TABLE experiments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,
  title             text        NOT NULL,
  hypothesis        text        NOT NULL,
  variable_tested   text        NOT NULL
                    CHECK (variable_tested IN ('HOOK','FORMAT','LANGUAGE','DURATION',
                                               'CTA','AUDIENCE_FRAMING','THUMBNAIL',
                                               'POSTING_TIME','CAPTION_LENGTH')),
  family_id         uuid REFERENCES content_families(id),
  knowledge_card_id uuid REFERENCES knowledge_cards(id),
  platform          publish_platform,
  primary_metric    text        NOT NULL,
  secondary_metrics text[]      NOT NULL DEFAULT '{}',
  minimum_sample    integer     NOT NULL DEFAULT 1000,
  status            experiment_status NOT NULL DEFAULT 'DESIGNED',
  start_date        date,
  end_date          date,
  winner_variant_id uuid,
  confidence_note   text,
  conclusion        text,
  owner_user_id     uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT experiments_date_order CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE experiment_variants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id        uuid        NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  label                text        NOT NULL,
  is_control           boolean     NOT NULL DEFAULT false,
  description          text        NOT NULL,
  published_content_id uuid REFERENCES published_content(id),
  script_id            uuid REFERENCES scripts(id),
  render_id            uuid REFERENCES renders(id),
  primary_metric_value numeric(14,4),
  sample_size          bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT experiment_variants_uk UNIQUE (experiment_id, label)
);
CREATE UNIQUE INDEX experiment_one_control_idx
  ON experiment_variants (experiment_id) WHERE is_control;

ALTER TABLE experiments
  ADD CONSTRAINT experiments_winner_fk
    FOREIGN KEY (winner_variant_id) REFERENCES experiment_variants(id);

-- =============================================================================
-- SECTION 8.  AI AND WORKFLOW OBSERVABILITY
-- =============================================================================

CREATE TABLE ai_prompts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key      text        NOT NULL,        -- 'creative_director'
  version         text        NOT NULL,        -- '1.3.0'
  agent_name      text        NOT NULL,
  system_prompt   text        NOT NULL,
  user_template   text        NOT NULL,
  output_schema   jsonb       NOT NULL,
  default_provider ai_provider NOT NULL DEFAULT 'OPENAI',
  default_model   text        NOT NULL,
  temperature     numeric(3,2) NOT NULL DEFAULT 0.7,
  max_output_tokens integer   NOT NULL DEFAULT 4000,
  is_active       boolean     NOT NULL DEFAULT false,
  changelog       text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_prompts_uk UNIQUE (prompt_key, version)
);
CREATE UNIQUE INDEX ai_prompts_one_active_idx
  ON ai_prompts (prompt_key) WHERE is_active;

CREATE TABLE ai_invocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name        text        NOT NULL,
  prompt_key        text        NOT NULL,
  prompt_version    text        NOT NULL,
  provider          ai_provider NOT NULL,
  model             text        NOT NULL,
  object_type       text,
  object_id         uuid,
  workflow_code     text,
  execution_id      text,
  input_tokens      integer,
  output_tokens     integer,
  reasoning_tokens  integer,
  latency_ms        integer,
  cost_usd          numeric(10,6),
  schema_valid      boolean     NOT NULL DEFAULT true,
  repair_attempts   smallint    NOT NULL DEFAULT 0,
  outcome           text        NOT NULL DEFAULT 'SUCCESS'
                    CHECK (outcome IN ('SUCCESS','SCHEMA_FAIL','PROVIDER_ERROR',
                                       'TIMEOUT','REFUSED','BLOCKED_PII')),
  error_detail      text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_invocations_object_idx ON ai_invocations (object_type, object_id);
CREATE INDEX ai_invocations_cost_idx ON ai_invocations (occurred_at DESC);
CREATE INDEX ai_invocations_agent_idx ON ai_invocations (agent_name, occurred_at DESC);

CREATE TABLE workflow_events (
  id              bigserial PRIMARY KEY,
  workflow_code   text        NOT NULL,        -- 'WF07'
  workflow_name   text,
  execution_id    text,
  parent_execution_id text,
  object_type     text,
  object_id       uuid,
  object_code     text,
  status          workflow_status NOT NULL,
  step            text,
  attempt         smallint    NOT NULL DEFAULT 1,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     integer,
  error_code      text,
  error_detail    text,
  payload         jsonb,
  next_workflow   text,
  owner_role      text,
  resolved        boolean     NOT NULL DEFAULT false,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz
);
CREATE INDEX workflow_events_code_idx ON workflow_events (workflow_code, started_at DESC);
CREATE INDEX workflow_events_object_idx ON workflow_events (object_type, object_id);
CREATE INDEX workflow_events_dead_letter_idx ON workflow_events (started_at)
  WHERE status = 'DEAD_LETTER' AND NOT resolved;

-- =============================================================================
-- SECTION 9.  TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'lcos' AND c.relkind = 'r' AND a.attname = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON lcos.%I
       FOR EACH ROW EXECUTE FUNCTION lcos.touch_updated_at()', t, t);
  END LOOP;
END $$;

-- Cascade: superseding a source invalidates the claims and cards that rely on it.
CREATE OR REPLACE FUNCTION cascade_source_supersession() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'SUPERSEDED' AND OLD.status <> 'SUPERSEDED' THEN
    UPDATE lcos.medical_claims mc
       SET status = 'NEEDS_UPDATE', updated_at = now()
     WHERE mc.status = 'APPROVED'
       AND EXISTS (SELECT 1 FROM lcos.claim_sources cs
                    WHERE cs.claim_id = mc.id AND cs.source_id = NEW.id);

    UPDATE lcos.knowledge_cards kc
       SET status = 'NEEDS_UPDATE', updated_at = now()
     WHERE kc.status = 'APPROVED'
       AND EXISTS (SELECT 1 FROM lcos.knowledge_card_claims kcc
                     JOIN lcos.medical_claims mc2 ON mc2.id = kcc.claim_id
                     JOIN lcos.claim_sources cs2 ON cs2.claim_id = mc2.id
                    WHERE kcc.card_id = kc.id AND cs2.source_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER medical_sources_supersede
  AFTER UPDATE ON medical_sources
  FOR EACH ROW EXECUTE FUNCTION cascade_source_supersession();

-- Cascade: retiring or expiring a card freezes content built on it.
CREATE OR REPLACE FUNCTION cascade_card_invalidation() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('RETIRED','NEEDS_UPDATE') AND OLD.status = 'APPROVED' THEN
    UPDATE lcos.publishing_jobs pj
       SET status = 'CANCELLED', error_code = 'KNOWLEDGE_INVALIDATED', updated_at = now()
     WHERE pj.status = 'SCHEDULED'
       AND pj.family_id IN (SELECT id FROM lcos.content_families WHERE knowledge_card_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_cards_invalidate
  AFTER UPDATE ON knowledge_cards
  FOR EACH ROW EXECUTE FUNCTION cascade_card_invalidation();

-- Cluster member count stays accurate without an application-side counter.
CREATE OR REPLACE FUNCTION sync_cluster_counts() RETURNS trigger AS $$
DECLARE cid uuid;
BEGIN
  cid := COALESCE(NEW.cluster_id, OLD.cluster_id);
  UPDATE lcos.question_clusters c
     SET member_count = (SELECT count(*) FROM lcos.question_cluster_members m
                          WHERE m.cluster_id = cid),
         last_seen_at = GREATEST(c.last_seen_at, now()),
         updated_at   = now()
   WHERE c.id = cid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cluster_members_count
  AFTER INSERT OR DELETE ON question_cluster_members
  FOR EACH ROW EXECUTE FUNCTION sync_cluster_counts();

-- =============================================================================
-- SECTION 10.  VIEWS
-- =============================================================================

CREATE VIEW v_content_lineage AS
SELECT
  pc.id                       AS published_content_id,
  pc.platform,
  pc.platform_url,
  pc.published_at,
  pc.language,
  pc.video_family,
  pc.risk_tier,
  cf.code                     AS family_code,
  kc.code                     AS card_code,
  kcv.version                 AS card_version,
  s.code                      AS script_code,
  pc.script_version,
  pc.template_code,
  pc.template_version,
  seg.slug                    AS audience_segment,
  (SELECT count(*) FROM script_claims sc
    WHERE sc.script_id = s.id AND sc.script_version = pc.script_version) AS claim_count,
  (SELECT array_agg(mc.code ORDER BY mc.code)
     FROM script_claims sc JOIN medical_claims mc ON mc.id = sc.claim_id
    WHERE sc.script_id = s.id AND sc.script_version = pc.script_version) AS claim_codes,
  cr.reviewer_user_id         AS clinical_reviewer_id,
  cr.reviewed_at              AS clinically_reviewed_at
FROM published_content pc
JOIN content_families cf          ON cf.id  = pc.family_id
JOIN knowledge_cards kc           ON kc.id  = pc.knowledge_card_id
JOIN knowledge_card_versions kcv  ON kcv.id = pc.knowledge_card_version_id
JOIN scripts s                    ON s.id   = pc.script_id
JOIN audience_segments seg        ON seg.id = pc.audience_segment_id
LEFT JOIN LATERAL (
  SELECT reviewer_user_id, reviewed_at
    FROM clinical_reviews c
   WHERE c.script_id = pc.script_id AND c.decision IN ('APPROVED','APPROVED_WITH_EDITS')
   ORDER BY reviewed_at DESC LIMIT 1
) cr ON true;

CREATE VIEW v_coverage_gaps AS
SELECT
  t.code                      AS topic_code,
  t.name_en                   AS topic_name,
  kc.code                     AS card_code,
  kc.canonical_question_en,
  kc.status                   AS card_status,
  tps.question_count_30d,
  tps.growth_rate,
  tps.content_count_90d,
  tps.priority_score,
  cs.coverage_state,
  cs.card_expires_in_days
FROM topic_priority_scores tps
JOIN topics t                   ON t.id = tps.topic_id
LEFT JOIN knowledge_cards kc    ON kc.id = tps.knowledge_card_id
LEFT JOIN coverage_snapshots cs ON cs.computed_for = tps.computed_for
                               AND cs.topic_id = tps.topic_id
                               AND cs.knowledge_card_id IS NOT DISTINCT FROM tps.knowledge_card_id
WHERE tps.computed_for = (SELECT max(computed_for) FROM topic_priority_scores)
  AND (tps.gap_flag OR cs.coverage_state IN ('NO_KNOWLEDGE','KNOWLEDGE_NO_CONTENT','UNDER_COVERED','STALE'))
ORDER BY tps.priority_score DESC;

CREATE VIEW v_review_workload AS
SELECT
  rt.review_type,
  rt.risk_tier,
  count(*) FILTER (WHERE rt.status = 'OPEN')                       AS open_count,
  count(*) FILTER (WHERE rt.status = 'IN_PROGRESS')                AS in_progress_count,
  count(*) FILTER (WHERE rt.status IN ('OPEN','IN_PROGRESS')
                     AND rt.due_at < now())                        AS overdue_count,
  min(rt.due_at) FILTER (WHERE rt.status IN ('OPEN','IN_PROGRESS')) AS next_due_at
FROM review_tasks rt
GROUP BY rt.review_type, rt.risk_tier;

CREATE VIEW v_knowledge_health AS
SELECT
  kc.code,
  kc.canonical_question_en,
  t.code                                        AS topic_code,
  kc.status,
  kc.risk_tier,
  kc.am_approved,
  kc.review_due_at,
  (kc.review_due_at - CURRENT_DATE)             AS days_to_review,
  (SELECT count(*) FROM knowledge_card_claims kcc WHERE kcc.card_id = kc.id) AS claim_count,
  (SELECT count(*) FROM content_families cf WHERE cf.knowledge_card_id = kc.id) AS family_count,
  (SELECT count(*) FROM published_content pc
    WHERE pc.knowledge_card_id = kc.id AND pc.published_at > now() - interval '90 days') AS published_90d
FROM knowledge_cards kc
JOIN topics t ON t.id = kc.topic_id
WHERE kc.status <> 'RETIRED';

CREATE VIEW v_cost_per_piece AS
SELECT
  cf.code                                    AS family_code,
  kc.code                                    AS card_code,
  count(DISTINCT pc.id)                      AS published_pieces,
  COALESCE(sum(DISTINCT r.cost_usd), 0)      AS render_cost_usd,
  COALESCE((SELECT sum(ai.cost_usd) FROM ai_invocations ai
             WHERE ai.object_type = 'CONTENT_FAMILY' AND ai.object_id = cf.id), 0) AS ai_cost_usd,
  COALESCE(sum(cp.views), 0)                 AS total_views
FROM content_families cf
JOIN knowledge_cards kc              ON kc.id = cf.knowledge_card_id
LEFT JOIN published_content pc       ON pc.family_id = cf.id
LEFT JOIN renders r                  ON r.id = pc.render_id
LEFT JOIN content_performance cp     ON cp.published_content_id = pc.id
                                    AND cp.granularity = 'LIFETIME'
GROUP BY cf.code, kc.code, cf.id;

-- =============================================================================
-- SECTION 11.  SEED DATA
-- =============================================================================

INSERT INTO roles (slug, name, is_clinical, is_system) VALUES
  ('admin',              'Administrator',        false, true),
  ('medical_director',   'Medical Director',     true,  false),
  ('consulting_doctor',  'Consulting Doctor',    true,  false),
  ('content_lead',       'Content Lead',         false, false),
  ('language_editor',    'Amharic Language Editor', false, false),
  ('intake_coordinator', 'Intake Coordinator',   false, false),
  ('social_lead',        'Social and Community Lead', false, false),
  ('producer',           'Production Manager',   false, false),
  ('developer',          'Developer',            false, false),
  ('automation',         'Automation Service',   false, true),
  ('viewer',             'Read Only',            false, false);

INSERT INTO permissions (slug, domain, description) VALUES
  ('knowledge.read',        'knowledge', 'View knowledge cards, claims and sources'),
  ('knowledge.draft',       'knowledge', 'Create and edit draft cards and claims'),
  ('knowledge.submit',      'knowledge', 'Submit a card or claim for clinical review'),
  ('knowledge.approve',     'knowledge', 'Approve a knowledge card or claim'),
  ('knowledge.retire',      'knowledge', 'Retire a card or claim'),
  ('source.manage',         'knowledge', 'Add, supersede and reorder medical sources'),
  ('terminology.read',      'language',  'View the terminology database'),
  ('terminology.manage',    'language',  'Create and edit terminology entries'),
  ('terminology.approve',   'language',  'Approve terminology entries'),
  ('question.read',         'demand',    'View de-identified questions and clusters'),
  ('question.ingest',       'demand',    'Submit questions through the API or CSV'),
  ('question.redact',       'demand',    'Resolve quarantined questions'),
  ('question.turn_into_content', 'demand', 'Trigger the Turn Into Content flow'),
  ('cluster.manage',        'demand',    'Split, merge and label clusters'),
  ('concept.read',          'content',   'View creative concepts'),
  ('concept.generate',      'content',   'Run the concept generator'),
  ('concept.select',        'content',   'Select or reject a concept'),
  ('script.read',           'content',   'View scripts'),
  ('script.write',          'content',   'Create and edit scripts'),
  ('script.approve_editorial','content', 'Editorial approval of a Tier 1 or 2 script'),
  ('script.approve_clinical','content',  'Clinical approval of a Tier 3 or 4 script'),
  ('script.approve_language','content',  'Language approval of a localized script'),
  ('production.read',       'production','View production jobs and renders'),
  ('production.request',    'production','Request a render'),
  ('production.approve_final','production','Approve a finished render'),
  ('asset.read',            'production','View the asset library'),
  ('asset.manage',          'production','Upload, tag and retire assets'),
  ('asset.approve_clinical','production','Clinically approve a medical illustration'),
  ('template.manage',       'production','Create and edit video templates'),
  ('publish.read',          'distribution','View the publishing calendar'),
  ('publish.schedule',      'distribution','Schedule a publishing job'),
  ('publish.execute',       'distribution','Publish or retract content'),
  ('platform_account.manage','distribution','Manage platform accounts and tokens'),
  ('analytics.read',        'analytics', 'View analytics and scores'),
  ('experiment.manage',     'analytics', 'Create and conclude experiments'),
  ('settings.read',         'platform',  'View system settings'),
  ('settings.manage',       'platform',  'Change system settings and scoring weights'),
  ('prompt.manage',         'platform',  'Create and activate AI prompt versions'),
  ('user.manage',           'platform',  'Manage users and role assignments'),
  ('audit.read',            'platform',  'Read the audit log'),
  ('workflow.operate',      'platform',  'Retry, cancel and resolve workflow events');

-- Role to permission grants. The developer role deliberately holds no approval rights.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE (r.slug = 'admin')
   OR (r.slug = 'medical_director'    AND p.slug NOT IN (
        'user.manage','settings.manage','prompt.manage','platform_account.manage',
        'workflow.operate','publish.execute'))
   OR (r.slug = 'consulting_doctor'   AND p.slug IN (
        'knowledge.read','knowledge.draft','knowledge.submit','knowledge.approve',
        'question.read','concept.read','script.read','script.approve_clinical',
        'asset.approve_clinical','analytics.read','terminology.read','production.read'))
   OR (r.slug = 'content_lead'        AND p.slug IN (
        'knowledge.read','knowledge.draft','knowledge.submit','question.read',
        'question.turn_into_content','cluster.manage','concept.read','concept.generate',
        'concept.select','script.read','script.write','script.approve_editorial',
        'production.read','production.request','asset.read','publish.read',
        'publish.schedule','analytics.read','experiment.manage','terminology.read'))
   OR (r.slug = 'language_editor'     AND p.slug IN (
        'knowledge.read','terminology.read','terminology.manage','terminology.approve',
        'script.read','script.approve_language','question.read','analytics.read'))
   OR (r.slug = 'intake_coordinator'  AND p.slug IN (
        'question.read','question.ingest','question.redact','question.turn_into_content',
        'cluster.manage','knowledge.read','concept.read','script.read','publish.read',
        'analytics.read'))
   OR (r.slug = 'social_lead'         AND p.slug IN (
        'publish.read','publish.schedule','publish.execute','analytics.read',
        'experiment.manage','script.read','production.read','question.read',
        'question.ingest','knowledge.read'))
   OR (r.slug = 'producer'            AND p.slug IN (
        'production.read','production.request','production.approve_final','asset.read',
        'asset.manage','template.manage','script.read','publish.read','analytics.read'))
   OR (r.slug = 'developer'           AND p.slug IN (
        'knowledge.read','question.read','concept.read','script.read','production.read',
        'asset.read','publish.read','analytics.read','settings.read','settings.manage',
        'prompt.manage','audit.read','workflow.operate','template.manage',
        'platform_account.manage'))
   OR (r.slug = 'automation'          AND p.slug IN (
        'knowledge.read','question.ingest','question.read','concept.generate',
        'script.write','production.request','publish.execute','analytics.read'))
   OR (r.slug = 'viewer'              AND p.slug IN (
        'knowledge.read','question.read','concept.read','script.read','production.read',
        'asset.read','publish.read','analytics.read'));

INSERT INTO settings (key, value, description) VALUES
  ('deid.confidence_threshold',      '0.85',  'Below this, quarantine the question'),
  ('cluster.similarity_threshold',   '0.86',  'Cosine similarity for cluster membership'),
  ('cluster.duplicate_threshold',    '0.97',  'Above this a question is a literal duplicate'),
  ('translation.drift_threshold',    '0.12',  'Back-translation drift forcing human review'),
  ('priority.formula_version',       '"v1"',  'Active topic priority formula'),
  ('priority.weights',
     '{"volume":0.28,"growth":0.20,"unanswered":0.14,"coverage_gap":0.18,"clinical":0.12,"strategic":0.08}',
     'Topic priority weights, must sum to 1'),
  ('scores.formula_version',         '"v1"',  'Active performance score formula'),
  ('review.sla_hours',
     '{"TIER_1":72,"TIER_2":48,"TIER_3":24,"TIER_4":8}',
     'Review SLA per risk tier'),
  ('review.sampling_rate',
     '{"TIER_1":0.10,"TIER_2":0.25,"TIER_3":1.0,"TIER_4":1.0}',
     'Share of scripts routed to clinical review by tier'),
  ('knowledge.review_interval_months',
     '{"TIER_1":24,"TIER_2":18,"TIER_3":12,"TIER_4":6}',
     'Default review_due_at interval on approval'),
  ('ai.default_provider',            '"OPENAI"', 'Default model provider'),
  ('ai.daily_spend_cap_usd',         '40',    'Hard stop for AI spend per day'),
  ('render.daily_spend_cap_usd',     '60',    'Hard stop for render spend per day'),
  ('voice.ai_allowed_tiers',         '["TIER_1","TIER_2"]', 'Tiers permitted to use AI Amharic voice'),
  ('planner.auto_commission',        'false', 'WF05 auto-creates content families from the gap board'),
  ('language.auto_pass_enabled',     'false', 'WF10 may skip the human language editor'),
  ('language.approved_loanwords',    '["HIV","PrEP","PEP","HPV","IUD"]',
     'English terms permitted to remain in Amharic copy'),
  ('attribution.window_hours',       '72', 'Question attribution window after a post'),
  ('validator.false_blocker_ceiling','0.10', 'Above this the validator prompt is reviewed');

INSERT INTO topics (code, name_en, name_am, default_risk_tier, clinical_weight, strategic_weight, sort_order) VALUES
  ('EC',   'Emergency contraception', 'የአስቸኳይ ጊዜ የእርግዝና መከላከያ', 'TIER_3', 2.00, 2.00, 10),
  ('CON',  'Contraception',           'የእርግዝና መከላከያ',            'TIER_2', 1.80, 2.00, 20),
  ('PREG', 'Pregnancy',               'እርግዝና',                    'TIER_3', 1.80, 1.60, 30),
  ('MEN',  'Menstruation',            'የወር አበባ',                  'TIER_2', 1.20, 1.60, 40),
  ('STI',  'Sexually transmitted infections', 'በግብረ ሥጋ ግንኙነት የሚተላለፉ በሽታዎች', 'TIER_3', 1.80, 1.40, 50),
  ('HIV',  'HIV',                     'ኤች አይ ቪ',                  'TIER_3', 2.00, 1.40, 60),
  ('FERT', 'Fertility',               'የመውለድ አቅም',                'TIER_2', 1.40, 1.20, 70),
  ('SEX',  'Sexual health and consent','የግብረ ሥጋ ጤናና ፈቃደኝነት',     'TIER_3', 1.60, 1.40, 80),
  ('MAT',  'Maternal health',         'የእናቶች ጤና',                 'TIER_3', 1.80, 1.20, 90),
  ('POST', 'Postpartum',              'ከወሊድ በኋላ',                 'TIER_3', 1.60, 1.20, 100),
  ('HPV',  'HPV and cervical cancer', 'ኤችፒቪ',                     'TIER_2', 1.60, 1.00, 110),
  ('YTH',  'Youth and puberty',       'ጉርምስና',                    'TIER_1', 1.00, 1.20, 120),
  ('SAFE', 'Urgent care and safety',  'አስቸኳይ እርዳታ',               'TIER_4', 2.50, 1.60, 130);

INSERT INTO audience_segments
  (slug, name_en, age_min, age_max, gender, relationship_context, language_tendency,
   tone_guidance, preferred_platforms) VALUES
  ('university_women_18_24','University women', 18, 24, 'FEMALE','Mostly unmarried','AM',
   'Peer to peer, private, practical. Assume she is reading this alone and does not want to be seen reading it.',
   '{TIKTOK,INSTAGRAM,TELEGRAM}'),
  ('university_men_18_24','University men', 18, 24, 'MALE','Mostly unmarried','AM',
   'Direct, factual, no lecturing. Address responsibility without shaming.',
   '{TIKTOK,YOUTUBE,TELEGRAM}'),
  ('unmarried_urban_women_18_24','Unmarried urban women', 18, 24, 'FEMALE','Unmarried','AM',
   'Warm, discreet, non-judgmental. Privacy is the first thing to establish.',
   '{TIKTOK,INSTAGRAM,TELEGRAM}'),
  ('unmarried_urban_men_18_24','Unmarried urban men', 18, 24, 'MALE','Unmarried','AM',
   'Plain and practical. Avoid moralising.',
   '{TIKTOK,FACEBOOK,YOUTUBE}'),
  ('married_women_20_35','Married women', 20, 35, 'FEMALE','Married','AM',
   'Respectful, family-aware, spacing and planning framed positively.',
   '{FACEBOOK,TELEGRAM,INSTAGRAM}'),
  ('married_men_20_35','Married men', 20, 35, 'MALE','Married','AM',
   'Partner-supportive framing. Shared decisions.',
   '{FACEBOOK,YOUTUBE,TELEGRAM}'),
  ('diaspora_women_gulf','Ethiopian women working in Gulf countries', 20, 40, 'FEMALE','Varied','AM',
   'Isolation-aware. Assume limited service access and limited privacy. Telegram first.',
   '{TELEGRAM,TIKTOK,FACEBOOK}'),
  ('urban_young_professionals','Urban young professionals', 24, 34, 'ANY','Varied','AM',
   'Time-poor, evidence-forward, slightly more English tolerance.',
   '{INSTAGRAM,LINKEDIN,YOUTUBE}'),
  ('peri_urban_youth','Peri-urban youth', 16, 24, 'ANY','Mostly unmarried','AM',
   'Simple language, low data assumption, strong visual carry.',
   '{TIKTOK,FACEBOOK}'),
  ('first_time_contraceptive_users','First-time contraceptive users', 18, 30, 'FEMALE','Varied','AM',
   'Step-by-step, anxiety-reducing, method-neutral.',
   '{TIKTOK,TELEGRAM,INSTAGRAM}'),
  ('pregnant_women','Pregnant women', 18, 40, 'FEMALE','Varied','AM',
   'Calm, warning-sign literate, always route to antenatal care.',
   '{FACEBOOK,TELEGRAM}'),
  ('postpartum_women','Postpartum women', 18, 40, 'FEMALE','Varied','AM',
   'Recovery-aware, sleep-deprived reader, short sentences.',
   '{FACEBOOK,TELEGRAM}'),
  ('couples','Couples', 20, 40, 'ANY','Partnered','AM',
   'Shared responsibility. Never assign blame to one partner.',
   '{FACEBOOK,YOUTUBE}'),
  ('parents_caregivers','Parents and caregivers', 30, 55, 'ANY','Parenting','AM',
   'Support them to talk to their children. Reduce their fear of the conversation.',
   '{FACEBOOK,YOUTUBE,TELEGRAM}'),
  ('general_public','General public', NULL, NULL, 'ANY','Any','AM',
   'Clear, neutral, broadly accessible.',
   '{TIKTOK,FACEBOOK,INSTAGRAM,YOUTUBE,TELEGRAM}');

-- =============================================================================
-- SECTION 12.  DATABASE ROLES AND GRANTS
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lcos_app') THEN
    CREATE ROLE lcos_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lcos_readonly') THEN
    CREATE ROLE lcos_readonly LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA lcos TO lcos_app, lcos_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA lcos TO lcos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lcos TO lcos_app;
GRANT SELECT ON ALL TABLES IN SCHEMA lcos TO lcos_readonly;

-- The audit log is append only for the application role.
REVOKE UPDATE, DELETE ON audit_log FROM lcos_app;
REVOKE UPDATE, DELETE ON clinical_reviews FROM lcos_app;
REVOKE UPDATE, DELETE ON language_reviews FROM lcos_app;
REVOKE DELETE ON knowledge_card_versions FROM lcos_app;
REVOKE DELETE ON script_versions FROM lcos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA lcos
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lcos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA lcos
  GRANT SELECT ON TABLES TO lcos_readonly;

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================
