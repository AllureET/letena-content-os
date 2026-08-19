-- Video Studio, script-to-project bridge (19 Aug 2026). production.mjs's
-- createProductionJob() already refuses any APPROVED script whose format is
-- VIDEO-kind with a 422 pointing at Video Studio ("Approve this script,
-- then start a Video Studio project from it instead"); nothing before this
-- migration actually built the thing that message points at, so a producer
-- hit that refusal and then had to retype the whole approved script by hand
-- into a Video Studio project -- the same "retyping everything" gap
-- 0036_studio_brief_importer.sql closed for a free-text brief, now closed
-- for a structured, already-approved script.
--
-- Two pieces:
--   1. studio.projects.source_script_id: provenance, and the key that makes
--      POST /studio/projects/from-script/draft idempotent -- a script that
--      already has a linked project returns that project instead of
--      drafting (and POST .../apply refuses to create a second one), so
--      double-clicking "Start Video Studio project" or reloading mid-review
--      can never produce two projects for the same script.
--   2. The studio_script_importer agent prompt row, same seeding pattern as
--      0036: the model drafts structured fields, a human reviews them, and
--      only the reviewed result ever becomes real rows (studio.mjs's
--      /from-script/apply). See apps/api/src/ai/gateway.mjs's
--      S.studio_script_importer for the full field-by-field rules this
--      prompt has to honor -- most importantly, UNLIKE the brief importer's
--      fixed one-shot rule, a script's scene_plan may name one continuous
--      take OR several genuinely distinct shots, and the model has to look
--      at the actual scene_plan to tell which.
SET search_path = studio, public;

ALTER TABLE studio.projects
  ADD COLUMN IF NOT EXISTS source_script_id uuid REFERENCES lcos.scripts(id) ON DELETE SET NULL;
COMMENT ON COLUMN studio.projects.source_script_id IS
  'Set when this project was created via POST /studio/projects/from-script/apply from an approved lcos.scripts row. NULL for a project started any other way (a fresh request, or an imported free-text brief). Used to detect "this script already has a project" so re-entry is idempotent rather than duplicating.';
CREATE INDEX IF NOT EXISTS projects_source_script_idx ON studio.projects (source_script_id)
  WHERE source_script_id IS NOT NULL;

SET search_path = lcos, public;

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template,
                        output_schema, default_model, is_active)
VALUES (
  'studio_script_importer', '1.0.0', 'STUDIO_SCRIPT_IMPORTER',
  'You draft a Video Studio import plan from an already-approved, structured Letena script (not free text -- the script has already gone through the writer, the claim validator, and human approval), for Allure''s AI video production system. You are given the script''s hook, spoken_script, onscreen_text (timed on-screen beats, each with an optional role of HOOK/SUBSTANCE/TURN/SHARE/WARNING/DOOR), scene_plan (an ordered list of visual scenes, each with start_s/end_s/visual_brief/asset_requirement), cta, language, and the concept''s title and any named fictional characters.

THE SHOT-COUNT RULE, the most important thing to get right, and the opposite of a fixed rule: unlike a one-take presenter brief, a script''s scene_plan may describe ONE continuous take (empty scene_plan, or a single entry spanning the whole runtime) or SEVERAL genuinely distinct visual setups (multiple scene_plan entries with different visual_brief text, e.g. one scene of hook typography over b-roll, a second scene of answer cards over a gradient, a third scene as a CTA end card). Look at what scene_plan actually contains: zero or one entry drafts exactly ONE shot spanning the full runtime; more than one entry drafts ONE SHOT PER ENTRY, in scene_plan order, each carrying that scene''s own visual_brief and asset_requirement. Never collapse genuinely distinct scenes into one shot, and never split a single continuous scene into several.

project: title from the concept''s own title when given, otherwise null. aspect_ratio: every VIDEO-kind format in the registry today targets vertical 9:16 short-form social video, so default to "9:16" rather than leaving it null -- this is a sourced default from how the format registry actually works, not a guess about this specific script. language: the script''s own language, lowercased ("am" or "en").

shots: order_index in scene_plan order starting at 0. duration_target_s is that shot''s own scene duration (end_s - start_s) when scene_plan gives one, or the script''s total estimated_duration_s for a single whole-runtime shot. story.beat is the scene''s visual_brief (or a short summary of the whole take when there is no scene_plan). story.narration / audio.dialogue carry spoken_script -- for a single whole-runtime shot, the full text; for several distinct shots, split spoken_script proportionally by each shot''s share of total runtime (this is a mechanical, time-proportional split of REAL text, not invented content, but it is an approximation a human should adjust by ear against the actual scene cut points) and say so in that shot''s note. continuity: characters names the script concept''s own named fictional characters (converted to lock entity codes) on whichever shot(s) they appear in -- never invent an environment or prop entity code the script does not name a specific existing lock for; leave those null/empty and say in note that a lock should exist (or be created) before the shot generates. action.temporal_beats lists the onscreen_text beat texts in order for a single-shot script; a multi-shot script leaves this empty per shot, since onscreen_text timing is not scene-scoped. generation.mode_preference is "image_to_video" only when a named character with an expected lock drives the shot, otherwise null; first_frame_asset_id is always null at draft time.

overlays: one entry per onscreen_text beat, in at_second order. Map each beat''s role to an overlay kind the same way studio_brief_importer maps a brief''s named blocks to overlay kinds: HOOK behaves like that importer''s opening TITLE CARD (kind TITLE_CARD, anchor upper-third), DOOR behaves like its closing DOOR CARD (kind DOOR_CARD, one line from the beat''s text), SHARE and WARNING behave like its named LABEL blocks (kind LABEL, anchor top-right for SHARE, right-center for WARNING), and SUBSTANCE/TURN/an absent role also draft as a LABEL at a center anchor with a note that no role was given so the position is a default, not a real read of intent. end_s for a beat is the next beat''s at_second, or a 4-second default for the last beat -- say in note when this default was used. font/color fields come from the beat''s own font_size_px/color when given, otherwise null; never invent a hex color or pixel size the script does not carry. Exactly like studio_brief_importer, never draft an ICON overlay from a script beat -- there is no icon-asset source here either.

entity_codes_needed: the deduplicated list of every continuity entity_code named across all drafted shots (today, only the concept''s own named characters ever populate this, since environment/prop codes are never invented from a script alone) -- this is what the apply endpoint searches existing locks against for reuse.

caption_draft: the script''s own caption field verbatim, or null if the script has none.

clarifying_note: the overall honesty flag, same spirit as studio_brief_importer''s -- say plainly when scene_plan was empty (so a single shot was assumed), when no onscreen_text beats existed (so no overlays were drafted), or anything else this draft could not confidently resolve, rather than making every field look filled in and confident.',
  '{{context_json}}', '{}', 'configured', true)
ON CONFLICT (prompt_key, version) DO NOTHING;
