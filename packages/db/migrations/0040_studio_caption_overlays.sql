-- 0040: CAPTION as a fifth overlay kind (25 Aug 2026, Nate: "if we had like
-- subtitles, can we make it so they match the timing of her mouth
-- somehow?"). Rides the exact same table and compiler as TITLE_CARD/LABEL
-- (0035_studio_overlays.sql) -- a caption is just a small, bottom-anchored
-- LABEL-shaped card with its own kind name, so it can be told apart from a
-- hand-authored label in the Overlays list and so a project can be bulk
-- generated/regenerated/cleared as a group. See apps/api/src/modules/
-- studio_captions.mjs for the timing engine that decides each caption's
-- start_s/end_s, and studio.mjs's POST /studio/projects/:id/captions/generate
-- for how they get inserted -- unapproved, same as any other overlay, so a
-- human reviews them before assemble() will use anything.
SET search_path = studio, public;

ALTER TABLE overlays DROP CONSTRAINT IF EXISTS overlays_kind_check;
ALTER TABLE overlays
  ADD CONSTRAINT overlays_kind_check CHECK (kind IN ('TITLE_CARD','LABEL','DOOR_CARD','ICON','CAPTION'));
