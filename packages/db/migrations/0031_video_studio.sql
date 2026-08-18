-- 0031: Video Studio, phase 1 (core loop plus automated QC).
--
-- Owner decision, 18 Aug 2026: implement the Allure Autonomous AI Video
-- Studio Playbook v2.0 (uploaded this session) as real LCOS infrastructure,
-- as ITS OWN system: "this is a much more robust system that should
-- operate as its own system outside of these. It can carry many of the
-- same traits, but this should be like the advanced version... So its new
-- but much more." Concretely: a new `studio` schema, separate from `lcos`,
-- so nothing here touches send_it/save_it or the existing one-job
-- Creatomate/Kling render path in production.mjs. Existing content keeps
-- working exactly as it does tonight. Studio shares the same app, the same
-- users/auth/RBAC, and the same provider adapters (kling, veo, gemini,
-- azureSpeech, elevenlabs) as everything else in LCOS; it is a new
-- capability, not a new deployment.
--
-- This migration is PHASE 1 ONLY: "core loop plus automated QC" per the
-- owner's explicit scope choice, not the playbook's full 27 sections.
-- Built tonight: projects, an event log, versioned continuity locks
-- (L0 style / L1 character, environment, prop), a shot manifest, generated
-- candidate assets per shot with automated technical + continuity QC, and
-- an assemble step that concatenates the accepted shots into a final cut.
-- Deliberately NOT built tonight, and not silently faked: the budget
-- ledger and spend-guardrail automation (section 21), the full multi-agent
-- orchestrator with retry-class routing (sections 5, 13, 15), a real
-- timeline/EDL abstraction beyond ordered-concatenation (section 18), and
-- C2PA/provenance embedding (section 19.5). studio.projects.budget_cap_usd
-- and spent_usd exist as plain columns so a later migration can build the
-- guardrail logic on top without a schema change; nothing enforces the cap
-- yet, and the API layer says so rather than pretending it does.

CREATE SCHEMA IF NOT EXISTS studio;
SET search_path = studio, public;

-- ===========================================================================
-- Projects: one per video the studio is producing. state mirrors the
-- playbook's end-to-end state machine (section 4), collapsed to the
-- subset phase 1 actually drives through code: locks and shots are the
-- gates phase 1 enforces; the later states (ANIMATIC_APPROVED onward) are
-- reachable but not yet gated by anything beyond a manual state update.
-- ===========================================================================
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text UNIQUE NOT NULL,
  title            text NOT NULL,
  format           text NOT NULL DEFAULT 'ai_story',
  autonomy_level   text NOT NULL DEFAULT 'A1'
                     CHECK (autonomy_level IN ('A0','A1','A2','A3','A4')),
  state            text NOT NULL DEFAULT 'REQUEST'
                     CHECK (state IN ('REQUEST','INTAKE_VALIDATED','TREATMENT_APPROVED',
                       'SCRIPT_APPROVED','LOCKS_APPROVED','SHOT_MANIFEST_FROZEN',
                       'ANIMATIC_APPROVED','GENERATION_COMPLETE','ROUGH_CUT_VALIDATED',
                       'AUDIO_LOCKED','PICTURE_LOCKED','MASTER_QC_PASSED','DELIVERED')),
  brief            jsonb NOT NULL DEFAULT '{}'::jsonb,
  aspect_ratio     text NOT NULL DEFAULT '9:16',
  fps              integer NOT NULL DEFAULT 30,
  language         text NOT NULL DEFAULT 'am',
  budget_cap_usd   numeric(10,2),
  spent_usd        numeric(10,2) NOT NULL DEFAULT 0,
  final_asset_id   uuid,
  created_by       uuid REFERENCES lcos.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE projects IS
  'One row per Video Studio project. Separate from lcos.scripts/lcos.production_jobs on purpose: this is the advanced, shot-manifest-driven system, not a replacement for the existing one-job render path.';
COMMENT ON COLUMN projects.budget_cap_usd IS
  'Column exists for a later migration''s guardrail logic (playbook section 21). Nothing in phase 1 enforces this cap; do not assume spend stops at it.';

-- ===========================================================================
-- Events: append-only, one row per state transition or material decision.
-- Mirrors playbook section 4's events.jsonl.
-- ===========================================================================
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  from_state   text,
  to_state     text,
  actor_id     uuid REFERENCES lcos.users(id),
  artifact     text,
  note         text
);
CREATE INDEX events_project_idx ON events(project_id, at);

-- ===========================================================================
-- Locks: the continuity bible (playbook section 10). One row per VERSION of
-- one entity; a lock is immutable once approved (playbook 10.8), so a
-- revision is a new row, never an UPDATE to an approved row's data. level
-- follows the playbook's L0-L3 hierarchy; L4 (shot intent) lives on the
-- shot itself, not here, since it is temporary rather than a lock.
-- ===========================================================================
CREATE TABLE locks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  level          text NOT NULL CHECK (level IN ('L0_PROJECT','L1_ENTITY','L2_STATE','L3_SEQUENCE')),
  entity_type    text CHECK (entity_type IN ('STYLE','CHARACTER','ENVIRONMENT','PROP')),
  entity_code    text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_asset_ids uuid[] NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  approved_at    timestamptz,
  approved_by    uuid REFERENCES lcos.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, entity_code, version)
);
CREATE INDEX locks_project_entity_idx ON locks(project_id, entity_code) WHERE is_active;
COMMENT ON TABLE locks IS
  'Versioned continuity locks (playbook 10.1-10.5). Approving a lock is immutable: a change creates version+1 and deactivates the prior version, which STALEs any shot generated against it (see shots.locked_version_ids vs current active versions).';

-- ===========================================================================
-- Shots: the shot manifest (playbook section 11.2). One row per shot;
-- editing after generation starts a NEW version rather than mutating a
-- generated shot's intent out from under its own assets.
-- ===========================================================================
CREATE TABLE shots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_code         text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  order_index       integer NOT NULL,
  status            text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','APPROVED_FOR_RENDER','GENERATING',
                        'NEEDS_REVIEW','ACCEPTED','REJECTED','STALE')),
  duration_target_s numeric(6,2) NOT NULL DEFAULT 5,
  story             jsonb NOT NULL DEFAULT '{}'::jsonb,
  continuity        jsonb NOT NULL DEFAULT '{}'::jsonb,
  camera            jsonb NOT NULL DEFAULT '{}'::jsonb,
  action            jsonb NOT NULL DEFAULT '{}'::jsonb,
  audio             jsonb NOT NULL DEFAULT '{}'::jsonb,
  graphics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  generation        jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance        jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_lock_ids   uuid[] NOT NULL DEFAULT '{}',
  accepted_asset_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, shot_code, version)
);
CREATE INDEX shots_project_order_idx ON shots(project_id, order_index);
COMMENT ON TABLE shots IS
  'Shot manifest, one row per shot per version (playbook 11.2). locked_lock_ids records exactly which lock VERSIONS this shot was generated against, so a later lock revision can be detected as STALE-inducing without guessing.';

-- ===========================================================================
-- Assets: every generated candidate (playbook 22.3's asset manifest), plus
-- the final assembled cut (shot_id NULL, kind FINAL_CUT).
-- ===========================================================================
CREATE TABLE assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id        uuid REFERENCES shots(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('REFERENCE_IMAGE','KEYFRAME','VIDEO','VOICE',
                    'MUSIC','SFX','FINAL_CUT')),
  status         text NOT NULL DEFAULT 'GENERATED'
                    CHECK (status IN ('GENERATED','QC_PASS','QC_PASS_WITH_NOTES','QC_REWORK',
                      'QC_BLOCKED','ACCEPTED','REJECTED')),
  storage_key    text,
  generator      jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_job_code text,
  reference_ids  uuid[] NOT NULL DEFAULT '{}',
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd       numeric(10,4),
  checksum_sha256 text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_shot_idx ON assets(shot_id);
CREATE INDEX assets_project_idx ON assets(project_id);

-- ===========================================================================
-- QC reports: automated technical + continuity checks (playbook 19.1,
-- 19.2), one per asset per check run. disposition follows playbook 19.6.
-- ===========================================================================
CREATE TABLE qc_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  disposition   text NOT NULL CHECK (disposition IN
                  ('PASS','PASS_WITH_NOTES','REWORK','BLOCKED')),
  technical     jsonb NOT NULL DEFAULT '{}'::jsonb,
  continuity    jsonb NOT NULL DEFAULT '{}'::jsonb,
  issues        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qc_reports_asset_idx ON qc_reports(asset_id);
COMMENT ON TABLE qc_reports IS
  'Automated QC only (playbook 19.1 technical via ffprobe, 19.2 continuity via a Gemini vision comparison against the shot''s locked references). This is not human review; ACCEPTED on assets/shots is still a separate, explicit human action.';

ALTER TABLE projects ADD CONSTRAINT projects_final_asset_fk
  FOREIGN KEY (final_asset_id) REFERENCES assets(id);
ALTER TABLE shots ADD CONSTRAINT shots_accepted_asset_fk
  FOREIGN KEY (accepted_asset_id) REFERENCES assets(id);

-- ===========================================================================
-- Permissions. New domain 'studio', granted to the roles that already do
-- production/creative work; admin gets everything via the existing
-- wildcard grant.
-- ===========================================================================
SET search_path = lcos, public;

INSERT INTO permissions (slug, domain, description) VALUES
  ('studio.read',     'studio', 'View Video Studio projects, locks, shots and assets'),
  ('studio.write',    'studio', 'Create and edit Video Studio projects, locks and shots'),
  ('studio.generate',  'studio', 'Trigger generation for a Video Studio shot'),
  ('studio.approve',  'studio', 'Approve a Video Studio lock, shot, or the final assembled cut')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.slug LIKE 'studio.%'
  AND r.slug IN ('producer', 'content_lead', 'developer')
ON CONFLICT DO NOTHING;
