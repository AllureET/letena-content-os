-- 0025: Part 2, the guided flow (owner brief, Nate, 14 Aug 2026).
-- Schema the flow needs and the engine did not have:
--   1. Asset kinds for everything a production actually reuses. Owner:
--      "it should also have backgrounds etc, and be able to be saved and
--      searched easily". The library was b-roll-shaped; a real reference
--      library carries backgrounds and plates, textures, locked character
--      references, brand elements, and the source recordings behind AUA
--      recaps.
--   2. A production PLAN on the job: the engine slot (Kling or Veo, owner's
--      Foundations material names Veo through the same Gemini key, so the
--      video engine is configuration, never a hard-wired vendor), the
--      subtitle preset (the thing the owner specifically liked about VEED),
--      the voice choice, and pre-chosen asset bindings, all decided BEFORE
--      any money is spent.
--   3. Live transcripts for aua_recap (Part 1 item: the recap transcribes a
--      recorded live before it generates anything). Amharic speech
--      recognition is unreliable in every engine and the transcript carries
--      medical statements a doctor said out loud, so nothing generates from
--      it until a human confirms it.
--   4. Cost estimates and engine default as settings, so the plan screen
--      tells the truth and the numbers are arguable without a deploy.
-- Additive only. Never edit an applied migration.

-- 1) Asset kinds. PG16 allows ADD VALUE inside a transaction as long as the
--    new value is not used in the same transaction; nothing below uses them.
ALTER TYPE lcos.asset_kind ADD VALUE IF NOT EXISTS 'BACKGROUND';
ALTER TYPE lcos.asset_kind ADD VALUE IF NOT EXISTS 'TEXTURE';
ALTER TYPE lcos.asset_kind ADD VALUE IF NOT EXISTS 'CHARACTER_REFERENCE';
ALTER TYPE lcos.asset_kind ADD VALUE IF NOT EXISTS 'BRAND_ELEMENT';
ALTER TYPE lcos.asset_kind ADD VALUE IF NOT EXISTS 'SOURCE_RECORDING';

-- 2) The plan, on the job. video_engine NULL means "resolve at run time:
--    format override, else the production.video_engine setting". The
--    subtitle preset defaults from the format row.
ALTER TABLE lcos.production_jobs
  ADD COLUMN IF NOT EXISTS video_engine text
    CHECK (video_engine IS NULL OR video_engine IN ('KLING', 'VEO')),
  ADD COLUMN IF NOT EXISTS subtitle_preset text
    CHECK (subtitle_preset IS NULL OR subtitle_preset IN ('WORD_HIGHLIGHT', 'POP_ON', 'BOXED', 'CLEAN')),
  ADD COLUMN IF NOT EXISTS plan jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Per-format engine override and per-format default subtitle preset. The
-- first real test once keys exist decides the default per format (one clip
-- through each engine, first-plus-last-frame conditioning and Amharic
-- lip-sync); until then video_engine stays NULL everywhere and the system
-- default applies. Neither engine is presented as better untested.
ALTER TABLE lcos.content_formats
  ADD COLUMN IF NOT EXISTS video_engine text
    CHECK (video_engine IS NULL OR video_engine IN ('KLING', 'VEO')),
  ADD COLUMN IF NOT EXISTS subtitle_preset text
    CHECK (subtitle_preset IS NULL OR subtitle_preset IN ('WORD_HIGHLIGHT', 'POP_ON', 'BOXED', 'CLEAN'));

-- Format subtitle defaults: the fast hook-led formats get the word-by-word
-- highlight (the VEED style the owner liked), the reading-paced ones get
-- clean. Girum can change it per piece on the production plan screen.
UPDATE lcos.content_formats SET subtitle_preset = 'WORD_HIGHLIGHT'
 WHERE code IN ('send_it', 'question_explainer', 'quiz_reel', 'animated_news', 'reply_video');
UPDATE lcos.content_formats SET subtitle_preset = 'POP_ON'
 WHERE code IN ('chat_story', 'illustrated_scenario', 'real_ethiopia', 'aua_promo');
UPDATE lcos.content_formats SET subtitle_preset = 'BOXED'
 WHERE code IN ('aua_recap', 'ask_dr_letena', 'foundations_episode');
UPDATE lcos.content_formats SET subtitle_preset = 'CLEAN'
 WHERE body_kind = 'VIDEO' AND subtitle_preset IS NULL;

-- 3) Live transcripts (aua_recap). segments: [{start_s, end_s, speaker,
--    text}]. source records how the transcript arrived, including the
--    honest note that a video upload had its audio stripped server-side.
--    Editing a CONFIRMED transcript returns it to DRAFT: the confirmation
--    describes the text it confirmed, exactly like a medical sign-off.
CREATE TABLE IF NOT EXISTS lcos.live_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  title text NOT NULL,
  source text NOT NULL CHECK (source IN
    ('PASTED', 'UPLOADED_TRANSCRIPT', 'AUDIO_UPLOAD', 'VIDEO_UPLOAD_AUDIO_STRIPPED')),
  transcription_engine text,          -- 'GEMINI' when machine transcribed, NULL when pasted
  segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
  audio_storage_key text,
  confirmed_by uuid REFERENCES lcos.users(id),
  confirmed_at timestamptz,
  created_by uuid REFERENCES lcos.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A concept generated from a live carries which transcript it came from, so
-- the recap's medical statements are traceable to what the doctor said.
ALTER TABLE lcos.content_concepts
  ADD COLUMN IF NOT EXISTS transcript_id uuid REFERENCES lcos.live_transcripts(id);

-- 4) Settings the plan screen reads. Costs are rough, deliberately in
--    settings so the team can correct them against real invoices without a
--    deploy. Zero means the step runs on the Hetzner box Letena already
--    pays for and is shown as "included", never as a fake dollar figure
--    (owner: only Gemini, Kling/Veo and Azure meter; assembly, cutting,
--    subtitling and carousel rendering are self-hosted FFmpeg/HTML).
INSERT INTO lcos.settings (key, value, description) VALUES
  ('production.video_engine', '"KLING"',
   'Default generative video engine: KLING or VEO. Veo rides the same Gemini key. Swapping engines is this setting, not code. The first real test once keys exist decides the default per format.'),
  ('production.cost_estimates',
   '{"GEMINI_IMAGE": 0.04, "KLING_CLIP": 0.35, "VEO_CLIP": 0.40, "AZURE_TTS": 0.02, "ELEVENLABS_TTS": 0.10, "HEYGEN_MIN": 1.00, "GEMINI_TRANSCRIBE_MIN": 0.01, "FFMPEG_ASSEMBLY": 0, "FFMPEG_SUBTITLES": 0, "CAROUSEL_HTML": 0, "POST_TEXT": 0}',
   'Rough per-step USD estimates shown on the production plan before anything runs. Zero = self-hosted (FFmpeg/HTML on the Hetzner box), shown as included. Correct these against real invoices; no deploy needed.')
ON CONFLICT (key) DO NOTHING;
