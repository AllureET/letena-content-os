-- 0039: two things the owner asked for on 21 Aug 2026.
--
-- (1) RUNWAY as a real video engine. Until now videoEngine() knew only
-- KLING and VEO, BOTH of which are unimplemented stubs that throw in
-- production mode -- and studio.projects never even had a video_engine
-- column, so `project.video_engine` in studio.mjs read undefined and every
-- shot silently fell through to the Kling stub. Owner: "I don't want this
-- running through veo. I think runway is cheaper is it not?" It is, by a
-- lot: Runway Gen-4 Turbo is about $0.05/s against Veo 3.1's $0.40/s, and
-- Runway's one API also fronts Veo, Kling and Seedance, so a single real
-- adapter replaces three stubs. This adds the missing column with RUNWAY
-- as the default.
--
-- (2) Reference PACKS. A lock's reference_asset_ids is a flat list of
-- images with no notion of what each one IS. The owner builds proper
-- character/location reference sheets outside LCOS (turnaround, expression
-- sheet, pose sheet, costume close-ups, colour palette; location angles,
-- layout, props) and asked where to put them: "once you create a character
-- or background reference, I can use chatgpt to create these, how can we
-- use it for the LCOS and is there a place where I can insert it right
-- after we lock in a character and background". sheet_kind is that slot:
-- an uploaded image can now declare which kind of sheet it is, so the UI
-- can group a real reference pack under each lock and so generation can
-- pick the RIGHT sheets to condition on (Gemini takes up to 3 images)
-- instead of guessing at whatever happened to be appended last.
--
-- NULL sheet_kind keeps meaning exactly what every existing row means: a
-- plain reference image, not part of a structured pack. Nothing existing
-- changes.
SET search_path = studio, public;

ALTER TABLE studio.projects
  ADD COLUMN IF NOT EXISTS video_engine text
    CHECK (video_engine IS NULL OR video_engine IN ('RUNWAY', 'KLING', 'VEO'));

COMMENT ON COLUMN studio.projects.video_engine IS
  'Which generative video engine this project renders through. NULL means resolve at run time to the system default (RUNWAY). RUNWAY is the only engine with a real implemented adapter; KLING and VEO remain skeletons that throw in production mode.';

ALTER TABLE studio.assets
  ADD COLUMN IF NOT EXISTS sheet_kind text
    CHECK (sheet_kind IS NULL OR sheet_kind IN (
      'MASTER', 'TURNAROUND', 'EXPRESSIONS', 'POSES', 'COSTUME_DETAIL', 'COLOR_PALETTE',
      'LOCATION_ANGLES', 'LOCATION_LAYOUT', 'PROPS', 'OTHER')),
  ADD COLUMN IF NOT EXISTS sheet_note text;

COMMENT ON COLUMN studio.assets.sheet_kind IS
  'For a reference-pack image: which kind of reference sheet this is (a full-body turnaround, an expression sheet, a location angle set, a props sheet, and so on). NULL means an ordinary single reference image, which is what every row predating migration 0039 is.';

CREATE INDEX IF NOT EXISTS assets_sheet_kind_idx ON studio.assets(sheet_kind) WHERE sheet_kind IS NOT NULL;

SET search_path = lcos, public;
