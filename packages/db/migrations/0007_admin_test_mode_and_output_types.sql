-- 0007: admin test-mode override for the doctor-approval gate, plus a
-- data-driven output-types list for flexible generation scope.
--
-- Owner asks (Nate, Aug 2026):
--   1. "I want to be able to test the system out and build some test content
--      without waiting for dr approval... place override options in
--      settings for me as admin." A settings key, OFF by default (the real
--      gate stays enforced for everyone else), flippable only by the admin
--      role. When it is ON, generation from a not-yet-approved card is
--      allowed for admins and the resulting rows are permanently tagged
--      is_test_content so nobody mistakes test output for doctor-approved
--      real output.
--   2. "It's currently set to 4 diff outputs... How about if I just want to
--      output 1 kind in 1 specific topic." The list of output kinds a
--      generation request can ask for becomes a table, not a hardcoded
--      array in the generation code, so a new kind is a row, not a deploy.
SET search_path = lcos, public;

INSERT INTO settings (key, value, description, is_secret) VALUES
  ('approval.override', to_jsonb('OFF'::text),
   'OFF | ADMIN_TEST_MODE. OFF (default) enforces the normal rule: content '
   'generation only reads APPROVED knowledge cards. ADMIN_TEST_MODE lets an '
   'admin generate/test content from a card that is still IN_REVIEW/DRAFT; '
   'everything produced that way is marked is_test_content and logged.',
   false)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE content_families ADD COLUMN IF NOT EXISTS is_test_content boolean NOT NULL DEFAULT false;
ALTER TABLE scripts          ADD COLUMN IF NOT EXISTS is_test_content boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN content_families.is_test_content IS
  'true when this family was generated under approval.override=ADMIN_TEST_MODE from a card that was not yet doctor-approved. Never eligible for the normal publish/review flow to be mistaken for real content.';
COMMENT ON COLUMN scripts.is_test_content IS
  'true when this script was generated under approval.override=ADMIN_TEST_MODE. Carried from the parent content_families row at creation.';

CREATE INDEX IF NOT EXISTS content_families_test_idx ON content_families (is_test_content) WHERE is_test_content;
CREATE INDEX IF NOT EXISTS scripts_test_idx ON scripts (is_test_content) WHERE is_test_content;

-- Data-driven catalogue of generation output kinds. video_family reuses the
-- existing production-routing enum (adding a kind that reuses an existing
-- render engine is a data row; a genuinely new render engine is still a
-- migration + adapter, same as today). code is what callers pass in
-- POST /content/generate output_types.
CREATE TABLE content_output_types (
  code          text PRIMARY KEY,
  label         text NOT NULL,
  platform      text,
  video_family  video_family NOT NULL,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE content_output_types IS
  'Catalogue of generation output kinds a POST /content/generate request may ask for by code, so the set is data (add a row) not a hardcoded array in the pipeline.';

INSERT INTO content_output_types (code, label, platform, video_family, description, sort_order) VALUES
  ('reel_question_explainer', 'Question explainer reel',   'TIKTOK',    'V01_QUESTION_EXPLAINER',
   'Typography-led vertical explainer: hook question, direct answer, CTA end card.', 10),
  ('reel_chat_story',         'Chat story reel',           'TIKTOK',    'V02_CHAT_STORY',
   'WhatsApp-style bubble chat between a fictional worried peer and Letena.', 20),
  ('reel_illustrated_scenario','Illustrated scenario reel','INSTAGRAM', 'V03_ILLUSTRATED_SCENARIO',
   'Short illustrated scenario built around the question.', 30),
  ('reel_medical_visual',     'Medical visual explainer',  'INSTAGRAM', 'V04_MEDICAL_VISUAL_EXPLAINER',
   'Library-only clinically approved visuals explaining the mechanism.', 40),
  ('reel_digital_presenter',  'Digital presenter video',   'YOUTUBE',   'V05_DIGITAL_PRESENTER',
   'HeyGen presenter delivering the answer to camera. Not available at TIER_4.', 50),
  ('reel_real_ethiopia',      'Real Ethiopia hybrid reel', 'TIKTOK',    'V06_REAL_ETHIOPIA_HYBRID',
   'Generative b-roll of everyday Ethiopian settings behind the answer.', 60),
  ('carousel',                'Carousel',                  'INSTAGRAM', 'C01_CAROUSEL',
   'Multi-slide static carousel built in Canva.', 70),
  ('static_graphic',          'Static graphic',            'FACEBOOK',  'C02_STATIC_GRAPHIC',
   'Single static graphic card built in Canva.', 80),
  ('telegram_post',           'Telegram post',              'TELEGRAM',  'C03_TELEGRAM_POST',
   'Plain text post for the Telegram channel.', 90)
ON CONFLICT (code) DO NOTHING;
