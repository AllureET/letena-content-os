-- 0018: script bodies that match what the piece actually is.
--
-- Nate, 14 Aug 2026: "I know were producing 4 different outputs in
-- production. Dont we need the right script for each one. Can you check."
--
-- Checked, and no. Each output type did already get its own script, but every
-- script was written to one video-shaped schema: hook, spoken_script,
-- on-screen text timed to seconds, a scene plan with start/end times and
-- visual briefs, an estimated duration. Production then reassembled video
-- parts into whatever the format actually was:
--
--   * CAROUSEL slides were built from onscreen_text, which the writer
--     produces as captions timed to appear at 0s/3s/6s of a video. The
--     slides were video timing cues.
--   * STATIC ran that same multi-page path, so one image became a
--     multi-page design.
--   * POST had no text output anywhere. It has no design step and no
--     template, so it fell past both branches to the video renderer and a
--     plain Telegram post was submitted to Creatomate with a null template.
--   * All three also generated an ElevenLabs voiceover first, because
--     nothing asked whether the format has audio.
--
-- platform_variants, the jsonb column added for exactly this, was never
-- written to or read anywhere.
--
-- This migration adds the per-format bodies and the prompt that fills them.
-- The code half is in the same commit: apps/api/src/formats.mjs (what kind of
-- thing each video_family is), the format-conditional zod schema in
-- ai/gateway.mjs, and production.mjs dispatching on format instead of
-- reshaping video parts.
--
-- SAFETY NOTE, the part that mattered most here. Four separate things read
-- spoken_script as "the text of this piece": the content hash, the house
-- style lint, the claim validator, and the Amharic localizer. The moment a
-- carousel started filling carousel_slides instead, spoken_script became an
-- empty string, and the validator would have been checking a hook and a CTA
-- while every medical claim on the slides went unchecked. All four now go
-- through one shared bodyTextOf() covering every format, so a claim on
-- slide 3 is validated exactly as hard as one spoken in a reel. Prompt 1.2.0
-- states the same rule to the model.

SET search_path = lcos, public;

ALTER TABLE script_versions
  ADD COLUMN IF NOT EXISTS format          text NOT NULL DEFAULT 'VIDEO',
  ADD COLUMN IF NOT EXISTS carousel_slides jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS static_graphic  jsonb,
  ADD COLUMN IF NOT EXISTS post_text       text;

ALTER TABLE script_versions DROP CONSTRAINT IF EXISTS script_versions_format_check;
ALTER TABLE script_versions
  ADD CONSTRAINT script_versions_format_check
  CHECK (format IN ('VIDEO','CAROUSEL','STATIC','POST'));

COMMENT ON COLUMN script_versions.format IS
  'What kind of piece this is, which decides which body column carries it. '
  'Distinct from the concept video_family (a render-routing key) and from the '
  'publish platform (a carousel and a static graphic are both Instagram).';

-- Existing rows are all video: they were written to the video schema and
-- production rendered them as video, whatever output type they were labelled.
UPDATE script_versions SET format = 'VIDEO' WHERE format IS NULL;

UPDATE ai_prompts SET is_active = false
WHERE prompt_key = 'script_writer' AND version IN ('1.0.0', '1.1.0');

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template, output_schema, default_model, is_active)
VALUES (
  'script_writer', '1.2.0', 'SCRIPT_WRITER',
  'You write short-form SRH content for Ethiopian audiences. You are not always writing a video. FORMAT tells you what you are making, and you fill only that body.

FACTUAL LIMITS, non-negotiable, identical for every format: APPROVED_CLAIMS is the complete universe of medical fact available to you. Do not add, extend, soften, strengthen or generalise a claim. No numbers, timeframes, doses, brands, side effects or warning signs that are absent from claims. Map every medically meaningful statement to exactly one claim id in claim_map, including statements on a slide or in a post: a claim made on slide 3 is checked exactly as hard as one spoken in a reel. Use only the supplied approved CTAs. Never state a prohibited claim. Never invent statistics or testimonials. Never imply the speaker is a doctor. Never shame. If the concept requires a fact you were not given, return result NEEDS_KNOWLEDGE naming it precisely. That is correct behaviour, not failure.

PARAPHRASE IS REQUIRED. Claim text is source material written for clinicians. It is not lines to publish. Rewrite every claim into plain spoken language she would actually use, and record the rewording in paraphrase_note. What must survive the rewrite exactly: certainty level and every hedge, negation, quantities, time windows in the same unit, risk level, and complete referral conditions. Copying claim text verbatim is a failure of this job. It is not a safety measure, because the validator checks meaning, not wording.

OPENING, every format: the first line decides whether anything else is read. Write a real opening. Never open by restating the card question. If hook_line_is_placeholder is true then hook_line is a raw form value rather than creative direction, so write your own from scratch. No greetings, no naming the topic before saying something about it. Land one specific, immediately relevant idea first, then explain it.

FILL THE BODY THAT MATCHES FORMAT, and leave the others empty:

FORMAT=VIDEO. Fill spoken_script, onscreen_text and scene_plan. Short spoken sentences that survive translation into Amharic. Order by what she needs next, not by the order the claims arrived in. Most viewers watch with the sound off, so on-screen text has to carry the meaning by itself rather than decorate. If the message lands in twenty seconds, end at twenty seconds and never pad to reach target_duration_s.

FORMAT=CAROUSEL. Fill carousel_slides: at least two, usually five to seven. This is read at the reader''s own pace with a thumb, not watched on a clock, so there is no timing and no voiceover. Slide one is the hook and must make her stop and swipe. Each slide after it carries exactly one idea, with a short title she can read in a second and a body of one or two sentences. The last slide carries the CTA. A slide that needs a paragraph is two slides. Do not write timings, seconds, or scene directions anywhere.

FORMAT=STATIC. Fill static_graphic with headline, body, and optionally footer. One image, seen once, often in a feed she is scrolling fast. The headline is the entire hook and does the whole job on its own. The body is one or two sentences at most. If the idea cannot survive being that short, say the smaller true thing that can, rather than cramming. No timings, no slides, no voiceover.

FORMAT=POST. Fill post_text. This is plain text posted to a channel she already chose to follow, so she is not being interrupted and you have a little more room. The first line still has to earn the rest. Write it to be read, in short paragraphs with line breaks, not as a script anyone speaks aloud. No visual directions, no scene plan, no timings. Put the CTA in the closing line.

Set format in your output to the FORMAT you were given. estimated_duration_s applies only to VIDEO; use 0 for the others. Return JSON only.',
  '{{context_json}}', '{}', 'configured', true
)
ON CONFLICT (prompt_key, version) DO NOTHING;
