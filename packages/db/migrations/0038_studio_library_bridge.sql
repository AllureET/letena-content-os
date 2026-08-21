-- 0038: bridge Video Studio's own images (studio.assets) into the
-- browsable content library (lcos.assets), in both directions.
--
-- Owner request, 21 Aug 2026: a reference image or composed first frame
-- generated inside Video Studio was invisible everywhere else -- no
-- thumbnail on the lock card, not in the Production > Asset library, no
-- way to reuse one you already made or hand-pick one from the library
-- instead of paying for a new Gemini call. This migration only adds the
-- tracking columns the bridge needs; the actual bridging (inserting into
-- lcos.assets, reading it back for a picker, remixing through Gemini)
-- lives in apps/api/src/modules/studio.mjs, not here.
--
-- library_asset_id: set once studio.mjs mirrors this studio.assets row
-- into lcos.assets, so the same image is never mirrored twice and so a
-- studio asset can point at its own library listing.
-- source_asset_id: set when this row was produced by remixing (Gemini
-- image-edit) an EARLIER studio.assets row, so remix history is traceable
-- without overloading the generator jsonb blob for a real foreign key.
SET search_path = studio, public;

ALTER TABLE studio.assets
  ADD COLUMN IF NOT EXISTS library_asset_id uuid REFERENCES lcos.assets(id),
  ADD COLUMN IF NOT EXISTS source_asset_id  uuid REFERENCES studio.assets(id);

CREATE INDEX IF NOT EXISTS assets_library_asset_idx ON studio.assets(library_asset_id) WHERE library_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_source_asset_idx ON studio.assets(source_asset_id) WHERE source_asset_id IS NOT NULL;

SET search_path = lcos, public;
