-- 0020: format-aware bodies for every registry format, the three-caption
-- system, wider claim locations, and the nine-stage board with signed gates.
-- Companion to 0019 (the registry itself); the code half lands in the same
-- commit: apps/api/src/formats.mjs (bodyTextOf now walks the generic body
-- and the captions), ai/gateway.mjs (format-conditional writer schema),
-- modules/content.mjs (registry-driven generation, the edit path that
-- resets medical sign-off), modules/pipeline.mjs (board, advance, gates).

SET search_path = lcos, public;

-- ---------------------------------------------------------------------------
-- 1. Script bodies beyond the original four kinds.
--
-- 0018 added carousel_slides / static_graphic / post_text as dedicated
-- columns. Run One adds five more body kinds (ARTICLE, MICROCOPY, PUSH,
-- AUDIO, LIVE) and, rather than a column per kind forever, a single generic
-- `body` jsonb that bodyTextOf() walks recursively, collecting EVERY string
-- leaf. That walk is the safety property: a body shape added later is
-- covered by the content hash, the style lint, the claim validator and the
-- Amharic localizer automatically, with no code change to forget. The
-- 0018 columns stay for the formats already using them.
ALTER TABLE script_versions
  ADD COLUMN IF NOT EXISTS body          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS caption_short text,
  ADD COLUMN IF NOT EXISTS caption_fbtg  text,
  ADD COLUMN IF NOT EXISTS caption_x     text;

COMMENT ON COLUMN script_versions.body IS
  'Format-specific structured body for kinds beyond VIDEO/CAROUSEL/STATIC/POST: sections (ARTICLE), items (MICROCOPY), push (PUSH), segments/pinned_message/cutdown_briefs (LIVE). bodyTextOf() walks every string leaf in here, so anything written here is claim-validated, linted, hashed and localized.';
COMMENT ON COLUMN script_versions.caption_fbtg IS
  'The Facebook/Telegram caption of the three-caption system (ported from letenav2). It teaches even if nobody plays the video, which is exactly why captions are now part of bodyTextOf() and therefore claim-validated.';

ALTER TABLE script_versions DROP CONSTRAINT IF EXISTS script_versions_format_check;
ALTER TABLE script_versions
  ADD CONSTRAINT script_versions_format_check
  CHECK (format IN ('VIDEO','CAROUSEL','STATIC','POST','ARTICLE','MICROCOPY','PUSH','AUDIO','LIVE'));

-- ---------------------------------------------------------------------------
-- 2. Claim locations for the new bodies.
--
-- FOUND WHILE IN HERE, latent since 0018: the zod claim_map schema already
-- accepted SLIDE and POST as locations, but script_claims still carried the
-- original CHECK ('HOOK','SPOKEN','ONSCREEN','CTA','CAPTION'). The first
-- real carousel whose writer honestly mapped a claim to a slide would have
-- crashed the insert on this constraint. Widened to cover every body kind.
ALTER TABLE script_claims DROP CONSTRAINT IF EXISTS script_claims_location_check;
ALTER TABLE script_claims
  ADD CONSTRAINT script_claims_location_check
  CHECK (location IN ('HOOK','SPOKEN','ONSCREEN','CTA','CAPTION',
                      'SLIDE','POST','SECTION','ITEM','SEGMENT','FIELD'));

-- ---------------------------------------------------------------------------
-- 3. Concepts carry the registry format.
--
-- video_family stays (it is the render-routing key and an enum the schema
-- depends on); format_code is the new authoritative identity when present.
-- Legacy concepts have NULL here and keep today's behaviour end to end.
ALTER TABLE content_concepts
  ADD COLUMN IF NOT EXISTS format_code text REFERENCES content_formats(code);
CREATE INDEX IF NOT EXISTS concepts_format_code_idx ON content_concepts (format_code)
  WHERE format_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The nine-stage board, ported from letenav2 lib/content_board.php.
--
-- scripts.stage is the piece's position on the walk; content_formats.
-- stages_applicable says which stages exist for the format (a push
-- notification is never shot or edited, marked not-applicable explicitly).
-- needs_clinical_signoff is the abortion-adjacent flag: set by detection
-- (isAbortionAdjacent over title/hook/card question) OR by a client, and
-- once detection fires it can never be cleared by a client. Enforced in
-- code (modules/content.mjs, modules/pipeline.mjs).
ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'plan',
  ADD COLUMN IF NOT EXISTS needs_clinical_signoff boolean NOT NULL DEFAULT false;
ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_stage_check;
ALTER TABLE scripts
  ADD CONSTRAINT scripts_stage_check
  CHECK (stage IN ('plan','script','medical_review','shoot','edit',
                   'approve','publish','repurpose','measure'));

-- Signed gates: gate name, who signed, when, an optional note. Idempotent
-- per (piece, gate) via the unique constraint; the first signature stands.
-- clinical_signoff is the tenth gate with no matching stage, checked as a
-- side condition at the publish transition (executePublish and the pipeline
-- advance both enforce it). Signer routing is BY ROLE at runtime, never by
-- name: signed_by is whoever held the required permission when they signed.
CREATE TABLE script_gates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id   uuid NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  gate        text NOT NULL CHECK (gate IN
                ('plan','script','medical_review','clinical_signoff','shoot',
                 'edit','approve','publish','repurpose','measure')),
  signed_by   uuid REFERENCES users(id),
  signed_at   timestamptz NOT NULL DEFAULT now(),
  note        text,
  CONSTRAINT script_gates_uk UNIQUE (script_id, gate)
);
COMMENT ON TABLE script_gates IS
  'Signed stage gates, ported from letenav2 content_piece_gate. A piece cannot leave a stage until its gate row exists, and cannot publish without a signed medical_review gate (plus clinical_signoff when abortion-adjacent). Deleting the medical_review row is how an edit to medically meaningful content invalidates the sign-off.';
CREATE INDEX script_gates_script_idx ON script_gates (script_id);
