-- 0022: Part 1 corrections to the unified content machine registry.
--
-- Owner feedback, Nate, 14 Aug 2026, correcting Run One. Everything here is
-- data and schema; the prompt/voice half of the same feedback lands in 0023
-- and the code half in the same commit (pipeline_rules.mjs, pipeline.mjs,
-- content.mjs, style_lint.mjs, letena_canon.mjs, formats.mjs, provider.mjs,
-- gateway.mjs).
--
-- What this migration does, item by item of the feedback:
--   1.  Audience: content_concepts.audience (WOMEN default, MEN, COUPLES,
--       GENERAL) drives the Amharic register per piece. "This is mainly
--       women but also men, they just dont ask as much as women but they
--       ask a lot."
--   2.  Terminology: terminology.keep_english marks the terms that are
--       written in English inside Amharic copy, never translated, never
--       transliterated. The English-stays-English set is seeded here as
--       APPROVED because it is a settled owner decision (12 Aug 2026,
--       reconfirmed 14 Aug: "we still use english for those, and that
--       should be respected"), not a pending language-team question.
--   4.  CTA: content_formats.cta_spec names which canonical Amharic blocks
--       each format ends on, the actions (call and DM), and the surface
--       adaptation. The phone number is carried by the door block, never
--       retyped. "The goal is to get them to call us or DM us for help."
--   5.  New formats: ask_dr_letena, aua_live / aua_promo / aua_recap
--       (aua_clip split three ways and removed), quiz_carousel, quiz_reel,
--       whiteboard_explainer.
--   7.  Comments: content_formats.comment_prompt_allowed. The blanket ban
--       is removed; the real rule (never invite self-disclosure in public)
--       lives in the prompts and the deterministic lint.
--   9.  Production: scripts.production_path (DIGITAL default, LIVE, NONE),
--       content_formats.production_paths (which paths a format supports,
--       first entry is the format's default), and a new 'produce' stage
--       that replaces shoot+edit on the DIGITAL path. "it should default
--       to digital production with our piepleine."
--   11. Role-based sign-off: script_gates.signed_role records the role in
--       which a gate was signed, so an admin override is visible as one.
--   12.1 Edit feedback loop: lcos.phrasing_examples stores human-corrected
--       Amharic phrasing from non-medical edits; the localizer prompt gets
--       recent examples injected. "the updated amharic should be used to
--       retrain the descriptions for output." No model fine-tuning.
--   12.2 brand_tier: scripts.is_brand_tier, a flag on any piece, not a
--       format. In letenav2 it was a production-time tier of the dropped
--       quota system, never a content format.
--   13. Captions: script_versions.captions_by_platform, keyed by platform
--       and driven by the format's platforms array, replacing the fixed
--       letenav2 trio. The three legacy columns are migrated in and kept
--       readable for old rows.

SET search_path = lcos, public;

-- ---------------------------------------------------------------------------
-- 1. The produce stage exists (item 9). Constraint surgery first so the
-- format rows below can reference it.
ALTER TABLE content_formats DROP CONSTRAINT IF EXISTS content_formats_stages_valid;
ALTER TABLE content_formats
  ADD CONSTRAINT content_formats_stages_valid
  CHECK (stages_applicable <@ ARRAY['plan','script','medical_review','produce','shoot','edit',
                                    'approve','publish','repurpose','measure']::text[]);
ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_stage_check;
ALTER TABLE scripts
  ADD CONSTRAINT scripts_stage_check
  CHECK (stage IN ('plan','script','medical_review','produce','shoot','edit',
                   'approve','publish','repurpose','measure'));
ALTER TABLE script_gates DROP CONSTRAINT IF EXISTS script_gates_gate_check;
ALTER TABLE script_gates
  ADD CONSTRAINT script_gates_gate_check
  CHECK (gate IN ('plan','script','medical_review','clinical_signoff','produce','shoot',
                  'edit','approve','publish','repurpose','measure'));

-- ---------------------------------------------------------------------------
-- 2. New columns.
ALTER TABLE content_formats
  ADD COLUMN IF NOT EXISTS comment_prompt_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS production_paths text[] NOT NULL DEFAULT '{DIGITAL,LIVE}',
  ADD COLUMN IF NOT EXISTS cta_spec jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN content_formats.comment_prompt_allowed IS
  'Whether this format may invite a public comment. Even when true, the invitation must be non-disclosing (an opinion, a vote, a myth heard, a topic request, a quiz answer, tag-a-friend), never a symptom, diagnosis, experience or question about the reader''s own body. Owner ruling 14 Aug 2026: the blanket ban was overcorrected.';
COMMENT ON COLUMN content_formats.production_paths IS
  'Which production paths the format supports: DIGITAL (adapter stack: Gemini, Kling, ElevenLabs, Creatomate, Canva), LIVE (real shoot: shoot+edit stages), NONE (no production at all). The FIRST entry is the format''s default path. Owner, 14 Aug 2026: default to digital production.';
COMMENT ON COLUMN content_formats.cta_spec IS
  'The format''s CTA, defined properly (owner, 14 Aug 2026: "The goal is to get them to call us or DM us for help"). blocks[] names canonical Amharic blocks from letena_canon.mjs (door, vo_close, onscreen, bot, send, cost) so the phone number is carried, never retyped. actions[] is what the reader does (call, dm, send_question, visit). deep_link/contact for surfaces that cannot carry the door. cost_barrier notes when the cost line rides.';

ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS production_path text NOT NULL DEFAULT 'DIGITAL'
    CHECK (production_path IN ('DIGITAL','LIVE','NONE')),
  ADD COLUMN IF NOT EXISTS is_brand_tier boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN scripts.production_path IS
  'How this piece gets produced: DIGITAL (default; a single produce stage runs the adapter pipeline), LIVE (real shoot; shoot and edit stages), NONE (no production; text and app surfaces). Chosen at plan time from the format''s production_paths, changeable until production starts.';
COMMENT ON COLUMN scripts.is_brand_tier IS
  'This piece builds the brand rather than answering a clinical question. Replaces letenav2''s brand_tier, which was never a content format: it was a protected share of production hours in the dropped weekly quota system. Owner asked "whats brand tier?" 14 Aug 2026; this flag is the honest answer.';

ALTER TABLE content_concepts
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'WOMEN'
    CHECK (audience IN ('WOMEN','MEN','COUPLES','GENERAL'));
COMMENT ON COLUMN content_concepts.audience IS
  'Who the piece is written to, driving the Amharic register: WOMEN (default, feminine second person), MEN (masculine; a different question with different fears, never a pronoun swap), COUPLES / GENERAL (plural or neutral). Owner, 14 Aug 2026.';

ALTER TABLE script_gates
  ADD COLUMN IF NOT EXISTS signed_role text;
COMMENT ON COLUMN script_gates.signed_role IS
  'The role in which the signer signed (content_lead, consulting_doctor, medical_director, producer, social_lead), or admin_override when an admin signed a gate outside their declared role. Owner, 14 Aug 2026: "I sign off cause I have admin rights, but we also allow the proper letena roles to sign off respectively." Admin is the override, not the design, and it must be visible as one.';

ALTER TABLE script_versions
  ADD COLUMN IF NOT EXISTS captions_by_platform jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN script_versions.captions_by_platform IS
  'Captions keyed by platform (TIKTOK, INSTAGRAM, FACEBOOK, TELEGRAM, TWITTER, LINKEDIN, YOUTUBE), driven by the format''s platforms array. Replaces the fixed letenav2 trio (caption_short/fbtg/x), which missed TikTok, Instagram and LinkedIn (owner, 14 Aug 2026). Legacy columns stay readable for old rows and are migrated below. Every value here is walked by bodyTextOf() and therefore claim-validated.';

-- Migrate the legacy three-caption columns into the platform-keyed shape.
-- short was written for short vertical video (TikTok first), fbtg for
-- Facebook and Telegram, x for Twitter/X.
UPDATE script_versions SET captions_by_platform =
  (CASE WHEN caption_short IS NOT NULL THEN jsonb_build_object('TIKTOK', caption_short) ELSE '{}'::jsonb END)
  || (CASE WHEN caption_fbtg IS NOT NULL
        THEN jsonb_build_object('FACEBOOK', caption_fbtg, 'TELEGRAM', caption_fbtg) ELSE '{}'::jsonb END)
  || (CASE WHEN caption_x IS NOT NULL THEN jsonb_build_object('TWITTER', caption_x) ELSE '{}'::jsonb END)
WHERE (caption_short IS NOT NULL OR caption_fbtg IS NOT NULL OR caption_x IS NOT NULL)
  AND captions_by_platform = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 3. The human-corrected Amharic feedback loop (item 12.1).
CREATE TABLE IF NOT EXISTS phrasing_examples (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id    uuid REFERENCES scripts(id) ON DELETE SET NULL,
  amharic_text text NOT NULL,
  english_context text,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE phrasing_examples IS
  'Human-corrected Amharic phrasing captured from NON-medical edits (a medical edit goes back to review instead). Recent rows are injected into the amharic_localizer prompt as approved phrasing examples. This is what "the updated amharic should be used to retrain the descriptions" (owner, 14 Aug 2026) means here; no model fine-tuning.';
CREATE INDEX IF NOT EXISTS phrasing_examples_created_idx ON phrasing_examples (created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Terminology: the English-stays-English set, seeded and enforced
-- (item 2). keep_english marks the rule; the avoid_am list carries the
-- Amharic renderings the deterministic lint flags.
ALTER TABLE terminology
  ADD COLUMN IF NOT EXISTS keep_english boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN terminology.keep_english IS
  'This term is written in English (Latin script) inside Amharic copy, never translated, never transliterated into Amharic script. Owner decision 12 Aug 2026, reconfirmed 14 Aug: "we dont use amharic for sex organs or words like postpill or condom, we still use english for those, and that should be respected." avoid_am carries the renderings the deterministic lint flags.';

-- The settled set: anatomy, contraceptive methods and brands, clinical
-- terms. status=APPROVED because the owner decided this; the localizer only
-- uses APPROVED rows and these must be in force immediately. Amharic-native
-- everyday terms stay with the language team via the seeder (IN_REVIEW).
INSERT INTO terminology (term_en, preferred_am, avoid_am, avoid_reason, notes, register, status, keep_english)
VALUES
  ('Postpill',            'Postpill',            '{ፖስትፒል}',                        'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Brand name of the levonorgestrel emergency pill sold in Ethiopia. Always Latin script.', 'MIXED', 'APPROVED', true),
  ('ellaOne',             'ellaOne',             '{}',                               'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Brand name of the ulipristal acetate emergency pill. Always Latin script.', 'MIXED', 'APPROVED', true),
  ('levonorgestrel',      'levonorgestrel',      '{ሌቮኖርጌስትሬል}',                  'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Drug name, lowercase Latin inside Amharic sentences.', 'MIXED', 'APPROVED', true),
  ('ulipristal acetate',  'ulipristal acetate',  '{"ዩሊፕሪስታል አሴቴት"}',            'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Drug name, lowercase Latin inside Amharic sentences.', 'MIXED', 'APPROVED', true),
  ('Condom',              'Condom',              '{ኮንዶም}',                          'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Speakers say it in English. Restructure rather than attach Amharic prefixes.', 'MIXED', 'APPROVED', true),
  ('IUD',                 'IUD',                 '{አይ.ዩ.ዲ,ሉፕ}',                    'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Device acronym. Amharic modifiers stay Amharic, e.g. የመዳብ IUD for copper IUD.', 'MIXED', 'APPROVED', true),
  ('Implant',             'Implant',             '{ኢምፕላንት}',                       'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Contraceptive implant. A short Amharic gloss in parentheses is allowed on first mention.', 'MIXED', 'APPROVED', true),
  ('HIV',                 'HIV',                 '{"ኤች አይ ቪ"}',                     'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Acronym stays Latin, never the Ge''ez letter-by-letter spelling.', 'MIXED', 'APPROVED', true),
  ('PEP',                 'PEP',                 '{ፒኢፒ}',                           'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Post-exposure prophylaxis. Acronym stays Latin; describe its function in Amharic.', 'MIXED', 'APPROVED', true),
  ('hCG',                 'hCG',                 '{ኤች.ሲ.ጂ}',                        'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Pregnancy hormone measured by tests. Keep the standard casing hCG.', 'MIXED', 'APPROVED', true),
  ('PCOS',                'PCOS',                '{ፒሲኦኤስ,"ፖሊሲስቲክ ኦቫሪ ሲንድሮም"}', 'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Condition acronym stays Latin.', 'MIXED', 'APPROVED', true),
  ('HPV',                 'HPV',                 '{ኤች.ፒ.ቪ}',                        'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Virus acronym stays Latin.', 'MIXED', 'APPROVED', true),
  ('Hepatitis B',         'Hepatitis B',         '{"ሄፓታይተስ ቢ"}',                   'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Disease name stays English.', 'MIXED', 'APPROVED', true),
  ('STI',                 'STI',                 '{ኤስቲአይ}',                         'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Acronym stays Latin.', 'MIXED', 'APPROVED', true),
  ('TB',                  'TB',                  '{ቲቢ}',                             'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Acronym stays Latin.', 'MIXED', 'APPROVED', true),
  ('CDC',                 'CDC',                 '{ሲዲሲ}',                           'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Organisation acronym stays Latin.', 'MIXED', 'APPROVED', true),
  ('latex',               'latex',               '{ላቴክስ}',                          'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Material name stays English.', 'MIXED', 'APPROVED', true),
  ('progestogen',         'progestogen',         '{ፕሮጄስቶጅን}',                      'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Hormone class stays English.', 'MIXED', 'APPROVED', true),
  ('positive (test result)','positive',          '{ፖዘቲቭ}',                          'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Test results are spoken in English.', 'MIXED', 'APPROVED', true),
  ('negative (test result)','negative',          '{ኔጋቲቭ}',                          'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Test results are spoken in English.', 'MIXED', 'APPROVED', true),
  ('nucleic acid test',   'nucleic acid test',   '{"የኑክሊክ አሲድ ምርመራ"}',           'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Test name stays English; ምርመራ alone stays Amharic.', 'MIXED', 'APPROVED', true),
  ('antigen/antibody test','antigen/antibody test','{"አንቲጅን/አንቲቦዲ ምርመራ"}',       'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy', 'Test name stays English; ምርመራ alone stays Amharic.', 'MIXED', 'APPROVED', true),
  ('clitoris',            'clitoris',            '{}',                               'Owner rule 12 Aug 2026: anatomy terms stay in English inside Amharic copy', 'Anatomy stays English.', 'MIXED', 'APPROVED', true),
  ('vagina',              'vagina',              '{}',                               'Owner rule 12 Aug 2026: anatomy terms stay in English inside Amharic copy', 'Anatomy stays English.', 'MIXED', 'APPROVED', true),
  ('penis',               'penis',               '{}',                               'Owner rule 12 Aug 2026: anatomy terms stay in English inside Amharic copy', 'Anatomy stays English.', 'MIXED', 'APPROVED', true),
  ('sperm',               'sperm',               '{}',                               'Owner rule 12 Aug 2026: anatomy terms stay in English inside Amharic copy', 'Anatomy stays English.', 'MIXED', 'APPROVED', true)
ON CONFLICT (term_en, register) DO UPDATE SET
  keep_english = true,
  avoid_am = EXCLUDED.avoid_am,
  avoid_reason = EXCLUDED.avoid_reason,
  status = 'APPROVED';

-- ---------------------------------------------------------------------------
-- 5. Registry corrections to the existing 35 surviving rows: production
-- paths, produce stage, comment prompts, CTA specs, and the ends_at_door
-- audit (item 4: a format that can carry the door does).

-- Social video (DIGITAL default, LIVE possible; digital_presenter is HeyGen
-- and therefore DIGITAL only). All may invite a NON-DISCLOSING comment.
UPDATE content_formats SET
  production_paths = CASE WHEN code = 'digital_presenter' THEN '{DIGITAL}'::text[] ELSE '{DIGITAL,LIVE}'::text[] END,
  stages_applicable = '{plan,script,medical_review,produce,shoot,edit,approve,publish,repurpose,measure}',
  comment_prompt_allowed = true
WHERE code IN ('send_it','question_explainer','chat_story','illustrated_scenario',
               'medical_visual','digital_presenter','real_ethiopia','reply_video','animated_news');

UPDATE content_formats SET cta_spec = '{"blocks":["door","vo_close","onscreen"],"actions":["call","dm"],"cost_barrier":"when the piece routes to a service","note":"VO ends on the spoken close, the end card carries the on-screen close, the caption carries the door."}'::jsonb
WHERE code IN ('send_it','question_explainer','digital_presenter','real_ethiopia','animated_news');
UPDATE content_formats SET cta_spec = '{"blocks":["door","onscreen","bot"],"actions":["call","dm"],"note":"The chat resolves into the door; the bot fallback fits the chat surface."}'::jsonb
WHERE code = 'chat_story';
UPDATE content_formats SET cta_spec = '{"blocks":["door","onscreen"],"actions":["call","dm"],"note":"The scenario resolves with the fact, then the door."}'::jsonb
WHERE code IN ('illustrated_scenario','medical_visual');
UPDATE content_formats SET cta_spec = '{"blocks":["door","vo_close"],"actions":["call","dm"],"note":"Answers one public comment briefly, then turns to the private door."}'::jsonb
WHERE code = 'reply_video';

-- Static and card (DIGITAL default through Canva, LIVE means a designer).
UPDATE content_formats SET
  production_paths = '{DIGITAL,LIVE}',
  stages_applicable = '{plan,script,medical_review,produce,edit,approve,publish,repurpose,measure}',
  comment_prompt_allowed = true
WHERE code IN ('save_it','carousel','static_graphic','myth_buster','infographic');

UPDATE content_formats SET cta_spec = '{"blocks":["door","cost","send"],"actions":["call","dm"],"cost_barrier":"own slide when the card routes to services","note":"The final slide is the door; the send line invites a private share."}'::jsonb
WHERE code = 'save_it';
UPDATE content_formats SET cta_spec = '{"blocks":["door"],"actions":["call","dm"],"note":"The last slide carries the door, adapted per platform."}'::jsonb
WHERE code IN ('carousel','myth_buster');
UPDATE content_formats SET cta_spec = '{"blocks":["door"],"actions":["call","dm"],"note":"One image; the door rides in the footer and the caption."}'::jsonb
WHERE code IN ('static_graphic','infographic');

-- Text and long form. No production at all except the blog''s teaser shots.
UPDATE content_formats SET production_paths = '{NONE}'
WHERE code IN ('telegram_post','x_thread','linkedin_post','newsletter','library_explainer');
UPDATE content_formats SET
  production_paths = '{DIGITAL,NONE}',
  stages_applicable = '{plan,script,medical_review,produce,edit,approve,publish,repurpose,measure}'
WHERE code = 'blog';

UPDATE content_formats SET cta_spec = '{"blocks":["door","bot"],"actions":["call","dm"],"note":"The door rides in the message itself; Telegram readers can also use the bot without giving a name."}'::jsonb
WHERE code = 'telegram_post';
UPDATE content_formats SET cta_spec = '{"blocks":["door","cost"],"actions":["call","dm"],"note":"The door section closes the piece."}'::jsonb
WHERE code IN ('blog','library_explainer');
UPDATE content_formats SET cta_spec = '{"blocks":["door"],"actions":["call","dm"],"note":"Value in the main post; the door goes in a self-reply, never the main post."}'::jsonb,
  comment_prompt_allowed = true
WHERE code = 'x_thread';
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":["visit"],"contact":"letena.et","note":"Institutional register for donors and partners; no patient door on this surface."}'::jsonb,
  comment_prompt_allowed = true
WHERE code = 'linkedin_post';
UPDATE content_formats SET cta_spec = '{"blocks":["door","cost"],"actions":["call","dm"],"note":"Closes at the door after the one story and the library links."}'::jsonb
WHERE code = 'newsletter';

-- Abeba app surfaces: no production; the Ask tab IS the door in-app, so the
-- CTA is the deep link, one line, never the full door block.
UPDATE content_formats SET production_paths = '{NONE}'
WHERE surface = 'ABEBA_APP';
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":["dm"],"deep_link":"abeba://ask","note":"In-app the Ask tab is the door; the when-to-talk-to-a-doctor section routes there."}'::jsonb
WHERE code IN ('library_article','faq','while_you_wait','daily_insight','voices_seed_post','ask_sample_question');
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":["dm"],"deep_link":"abeba://","note":"A push cannot carry the whole door block: one line plus one abeba:// deep link."}'::jsonb
WHERE code = 'push_notification';
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":[],"deep_link":"abeba://","note":"UI strings carry no CTA; the app itself is the door."}'::jsonb
WHERE code = 'app_copy';
UPDATE content_formats SET cta_spec = '{}'::jsonb
WHERE code = 'doctor_reply_starter';

-- Programme and institutional.
UPDATE content_formats SET
  production_paths = '{DIGITAL,LIVE}',
  stages_applicable = '{plan,script,medical_review,produce,shoot,edit,approve,publish,repurpose,measure}'
WHERE code IN ('foundations_episode','radio_spot','poster');
UPDATE content_formats SET production_paths = '{NONE}'
WHERE code IN ('cse_session','insight_brief','partner_onepager');

UPDATE content_formats SET cta_spec = '{"blocks":["door","vo_close"],"actions":["call","dm"],"note":"Each episode closes at the spoken door."}'::jsonb,
  comment_prompt_allowed = true
WHERE code = 'foundations_episode';
UPDATE content_formats SET cta_spec = '{"blocks":["door"],"actions":["call","dm"],"note":"Audio only: no on-screen close. The number is spoken slowly and twice, from the door block, never retyped."}'::jsonb
WHERE code = 'radio_spot';
UPDATE content_formats SET cta_spec = '{"blocks":["onscreen","cost"],"actions":["call","dm"],"note":"Print at distance: the on-screen close carries the number large; no link-only path."}'::jsonb
WHERE code = 'poster';
-- The CSE facilitator guide CAN carry the door (participants may need care
-- privately after a session), so it does. ends_at_door audit, item 4.
UPDATE content_formats SET
  cta_spec = '{"blocks":["door","cost"],"actions":["call","dm"],"note":"The facilitator closes every session by sharing the private door and the free-care line."}'::jsonb,
  ends_at_door = true
WHERE code = 'cse_session';
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":["visit"],"contact":"letena.et","note":"MEL and donor document; organisational contact, no patient door."}'::jsonb
WHERE code = 'insight_brief';
UPDATE content_formats SET cta_spec = '{"blocks":[],"actions":["visit"],"contact":"letena.et","note":"Partner referral contact; the patient door is what partners refer INTO, described, not pasted."}'::jsonb
WHERE code = 'partner_onepager';

-- ---------------------------------------------------------------------------
-- 6. AUA is three formats, not one (item 5). The old aua_clip row mixed the
-- live run-of-show with the recap cutdowns. Existing concept references move
-- to aua_live (the run-of-show LIVE body is what they carried), then the
-- dangling code is removed.
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description,
   comment_prompt_allowed, production_paths, cta_spec)
VALUES
('aua_live', 'AUA live', 'live', 'PROGRAMME', '{TIKTOK,FACEBOOK,YOUTUBE}', 'AM_FIRST', 'LIVE', 'C03_TELEGRAM_POST',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Pre-live checklist","Segment 1","Segment 2","Segment 3","Segment 4","Segment 5","Segment 6","Pinned message (Amharic)","Pinned message (English gloss)","Anonymised questions (high-sensitivity topics)","Clinical note"]'::jsonb,
 '["The live session itself, run a couple of times weekly.","Run of show is six timed segments totaling about thirty minutes.","A pre-live checklist and a pinned message carrying the door.","For the highest-sensitivity topics (abortion and options among them) use the anonymized format: eight to twelve reworded past questions, no ages, no neighborhoods, no workplaces, no identifying detail, clinically reviewed. A question that cannot be fully anonymized does not run."]'::jsonb,
 '{"segments":6,"checklist":true,"anonymized_format":{"questions":{"min":8,"max":12},"strip":["ages","neighbourhoods","workplaces","identifying detail"]}}'::jsonb,
 '{plan,script,medical_review,shoot,approve,publish,repurpose,measure}',
 '{"unit":"minutes","target":30}'::jsonb,
 false, true, true, false, 410,
 'The Ask Us Anything live session itself: run of show, checklist, pinned message. LIVE only.',
 true, '{LIVE}',
 '{"blocks":["door","bot"],"actions":["call","dm"],"note":"The pinned message carries the door for the whole session; live viewers may ask non-disclosing questions in chat and are steered private for anything personal."}'::jsonb),

('aua_promo', 'AUA promo', 'clip', 'PROGRAMME', '{TIKTOK,INSTAGRAM,FACEBOOK}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","What is happening and when","How to send a question in advance","The turn to send-your-question","Clinical note"]'::jsonb,
 '["A short promo run before the live: it is happening, when, and how to send a question in advance.","The CTA is send your question now, through the private channels, not the usual help door.","Never promise a specific doctor by name; it is always a Letena doctor."]'::jsonb,
 '{"promotes":"aua_live"}'::jsonb,
 '{plan,script,medical_review,produce,shoot,edit,approve,publish,measure}',
 '{"unit":"seconds","min":15,"max":30}'::jsonb,
 false, true, true, false, 412,
 'Promo before the AUA live. New format, not in letenav2. CTA is send your question in advance.',
 true, '{DIGITAL,LIVE}',
 '{"blocks":["door"],"actions":["send_question"],"note":"CTA is send your question now for the live, through the same private channels the door names; not the usual help door."}'::jsonb),

('aua_recap', 'AUA recap', 'clip', 'PROGRAMME', '{TIKTOK,FACEBOOK,YOUTUBE}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","The recap spine (what the live answered)","Cutdown brief 1","Cutdown brief 2","Cutdown brief 3","Cutdown brief 4","The turn toward the door","Door beat (canonical Amharic door)","Clinical note"]'::jsonb,
 '["The recap of a finished live, plus the four cutdown briefs (this is what the old aua_clip schema''s cutdown half described).","Every medical statement in the recap maps to an approved claim exactly as if freshly written; the live having said it is not a source.","Cut from the live recording; the anonymised-questions rule of the live carries into every cut."]'::jsonb,
 '{"cutdown_briefs":4,"source":"a finished aua_live"}'::jsonb,
 '{plan,script,medical_review,produce,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":30,"max":90}'::jsonb,
 false, true, true, false, 414,
 'Recap of a finished AUA live with four cutdown briefs.',
 true, '{LIVE,DIGITAL}',
 '{"blocks":["door","vo_close","onscreen"],"actions":["call","dm"],"note":"The recap closes at the door like any clip."}'::jsonb)
ON CONFLICT (code) DO NOTHING;

UPDATE content_concepts SET format_code = 'aua_live' WHERE format_code = 'aua_clip';
DELETE FROM content_formats WHERE code = 'aua_clip';

-- ---------------------------------------------------------------------------
-- 7. New formats (item 5): ask_dr_letena, the quiz pair, and the animated
-- whiteboard explainer.
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description,
   comment_prompt_allowed, production_paths, cta_spec)
VALUES
('ask_dr_letena', 'Ask Dr Letena', 'clip', 'SOCIAL_VIDEO', '{TIKTOK,INSTAGRAM,YOUTUBE}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","The question as read aloud (de-identified, reworded)","The doctor''s spoken answer","The turn toward the door","Door beat (canonical Amharic door)","VO close","Clinical note"]'::jsonb,
 '["A real, named Letena format: the doctor reads a user-sent question aloud and answers it. The question being real is what gives it authority.","The quoted question comes from real patient traffic. It goes through the same de-identification as everything else AND is reworded rather than quoted verbatim, so the asker cannot recognise herself. A question that cannot be fully de-identified does not run.","The doctor is always a Letena doctor, never a named individual.","Distinct from digital_presenter: there the presenter delivers a scripted answer; here a real reworded question is read aloud and answered.","Works shot live or produced digitally; both production paths apply."]'::jsonb,
 '{"question_field":"body.question_quoted","deid_required":true,"reworded_required":true}'::jsonb,
 '{plan,script,medical_review,produce,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":30,"max":90}'::jsonb,
 false, true, true, false, 85,
 'Talking head: a Letena doctor reads a de-identified, reworded user question aloud and answers it.',
 true, '{DIGITAL,LIVE}',
 '{"blocks":["door","vo_close","onscreen"],"actions":["call","dm"],"note":"The answer turns to the door: your question can be next, privately."}'::jsonb),

('quiz_reel', 'Quiz reel', 'clip', 'SOCIAL_VIDEO', '{TIKTOK,INSTAGRAM}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen question (Amharic)","A beat to think","The answer","Why (the approved claim, in plain words)","Giveaway mechanic (how to enter, deadline, how a winner is picked)","The turn toward the door","Door beat (canonical Amharic door)","Clinical note"]'::jsonb,
 '["On-screen question, a beat to think, then the answer. Built for reach and comments.","A quiz answer is a medical statement and is claim-mapped and validated like any other.","The giveaway mechanic (how to enter, deadline, how a winner is picked) is a non-medical body field: required, never claim-mapped, and it must not promise anything clinical.","Inviting the quiz answer in the comments is allowed: it is a non-disclosing response. Never invite anything personal."]'::jsonb,
 '{"giveaway_field":"body.giveaway","quiz_field":"body.quiz"}'::jsonb,
 '{plan,script,medical_review,produce,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":15,"max":45}'::jsonb,
 false, true, true, false, 95,
 'Quiz for giveaways as a reel: question, a beat, the answer. Claim-mapped like everything else.',
 true, '{DIGITAL,LIVE}',
 '{"blocks":["door","onscreen"],"actions":["call","dm"],"note":"Entry mechanic first, then the door for anything personal."}'::jsonb),

('quiz_carousel', 'Quiz carousel', 'card', 'SOCIAL_STATIC', '{INSTAGRAM,FACEBOOK}', 'AM_FIRST', 'CAROUSEL', 'C01_CAROUSEL',
 '["Title","Theme","Slide 1, the question","Reveal slides, the answer and why","Last slide, entry mechanic and the door","Clinical note"]'::jsonb,
 '["Swipe-to-reveal: slide one asks, the next slides reveal and explain, the last carries the entry mechanic and the door. Built for saves and shares.","A quiz answer is a medical statement and is claim-mapped and validated like any other.","The giveaway mechanic (how to enter, deadline, how a winner is picked) is a non-medical body field: required, never claim-mapped, and it must not promise anything clinical.","Inviting the quiz answer in the comments is allowed: it is a non-disclosing response. Never invite anything personal."]'::jsonb,
 '{"giveaway_field":"body.giveaway","quiz_field":"body.quiz"}'::jsonb,
 '{plan,script,medical_review,produce,edit,approve,publish,repurpose,measure}',
 '{"unit":"slides","min":3,"max":7}'::jsonb,
 false, true, true, false, 145,
 'Quiz for giveaways as a swipe-to-reveal carousel.',
 true, '{DIGITAL,LIVE}',
 '{"blocks":["door"],"actions":["call","dm"],"note":"The last slide carries the entry mechanic and the door."}'::jsonb),

('whiteboard_explainer', 'Whiteboard explainer', 'clip', 'SOCIAL_VIDEO', '{TIKTOK,INSTAGRAM}', 'AM_FIRST', 'VIDEO', 'V03_ILLUSTRATED_SCENARIO',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Character and board style references","Board map (one row per element)","Clip 1 (dialogue, beats, last-frame anchor)","Clip 2 (dialogue, beats, last-frame anchor)","Clip 3 (dialogue, beats, last-frame anchor)","Pronunciation notes","The turn toward the door","Door beat (canonical Amharic door)","Clinical note"]'::jsonb,
 '["An animated whiteboard explainer: a stylized 3D animated character beside a whiteboard, holding a pointer stick, content revealing live as she talks, each new word or icon led into existence at the stick''s tip, timed to the line being delivered.","Three to four clips of roughly fifteen seconds each, written as one continuous read then split. For every clip, state what is already on the board and what is new. Nothing appears before its moment, nothing repeats.","Keep a running board map, one row per new element (left-column text, right-column icon), so nothing collides as it accumulates.","Every clip carries a last-frame anchor: a precise description of exactly what the board shows at the end of that clip. Anchors are generated as still images before the clip; describing the end state in prose alone is not reliable.","Gaze rule: she looks at the board only while pointing at a new or re-pointed element, back to camera on transitional words, and never points at empty unlabeled space.","Any glow or emphasis is a fixed permanent property of a named element type, never a this-is-relevant-now highlight. The stick alone indicates relevance.","Stick targets use explicit spatial anchors relative to labeled elements (one text-line below X, same left margin), never vague descriptions of empty space.","Voice is locked across clips by timbre only: accent, pitch and rhythm carry over, dialogue content never does. Each clip speaks only its own dialogue.","Pronunciation notes lock every English clinical or brand term the script uses (the stay-English terminology), one line per term.","Vertical 9:16. English stay-English terms appear on the board in Latin script exactly as the terminology rule requires."]'::jsonb,
 '{"clips":{"min":3,"max":4},"per_clip":["dialogue","beats","last_frame_anchor"],"board_map":"one row per element","shared_rules":["gaze","glow","stick_target","voice_firewall","pronunciation_notes"],"aspect":"9:16"}'::jsonb,
 '{plan,script,medical_review,produce,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":40,"max":60}'::jsonb,
 false, true, true, false, 97,
 'Animated whiteboard explainer: character with a pointer stick, board content revealing live, built clip by clip with last-frame anchors. DIGITAL only.',
 true, '{DIGITAL}',
 '{"blocks":["door","onscreen"],"actions":["call","dm"],"note":"The final board beat writes the door; the end card carries the on-screen close."}'::jsonb)
ON CONFLICT (code) DO NOTHING;
