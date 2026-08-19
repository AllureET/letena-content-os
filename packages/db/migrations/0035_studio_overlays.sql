-- 0035: Video Studio burned-in overlays (19 Aug 2026). The real production
-- brief "Spotting on the Pill" (25s, talking-head presenter) needs SIX
-- burned-in graphic elements over the footage: a title card (0:00-0:02), a
-- "share this" label (0:02-0:06), a clinical keyword label (0:11-0:15), a
-- door/CTA card at the end (0:20-0:25) with four staggered fade-in lines,
-- and icon overlays at a couple of moments -- each with an exact hex
-- background/text colour, a font, a screen position, and a timed
-- slide-in/fade-in/fade-out animation. Video Studio's assemble() had zero
-- capability to burn anything in; it was pure clip concatenation plus
-- optional music (see 0031/0034). This is the schema for that gap.
--
-- Same discipline the rest of Video Studio already applies (see 0031's
-- header comment on locks, and studio.mjs's compileStillPrompt/
-- compileMotionPrompt): overlays are reviewable, structured DATA, not a
-- rendered artifact and not a prompt. An AI may help DRAFT an overlay's
-- fields from a producer's free text later (the same pattern
-- studio_lock_drafter already uses for locks, 0033), but the actual
-- burned-in graphic is always compiled deterministically from these
-- reviewed rows at assemble time (apps/api/src/modules/studio_overlays.mjs,
-- compileOverlaySvg/buildOverlayFilterGraph) -- never generated fresh, and
-- never handed to a model to freehand the pixels.
CREATE SCHEMA IF NOT EXISTS studio;
SET search_path = studio, public;

CREATE TABLE overlays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Four kinds, matching exactly what the brief needs and nothing more:
  --   TITLE_CARD  a full opening card (the brief's 0:00-0:02 open)
  --   LABEL       a small on-screen tag over live footage (the brief's
  --               "share this" label at 0:02-0:06 and the clinical keyword
  --               label at 0:11-0:15) -- same shape as TITLE_CARD, since
  --               both are "a rounded box with text, positioned somewhere
  --               on screen, that fades/slides in and out"; kept as two
  --               kinds rather than one because a title card and a corner
  --               label read as different AUTHORING intents to Rudy/Girum
  --               even though the render path is identical.
  --   DOOR_CARD   the closing CTA card (the brief's 0:20-0:25), which is
  --               NOT one label but a background plus up to several lines
  --               of text, each with its own fade-in delay -- structurally
  --               different from TITLE_CARD/LABEL, so it gets its own data
  --               shape rather than forcing it through multiple LABEL rows
  --               (which could not share one background or guarantee they
  --               stay visually locked together).
  --   ICON        a small reusable icon graphic (from the existing asset
  --               library, kind ICON in lcos.assets -- see
  --               apps/api/src/modules/production.mjs's KINDS list and
  --               apps/web/app.js's asset-library screen, both of which
  --               already treat ICON as a first-class asset kind) placed
  --               and animated over the footage, reusing that library
  --               rather than inventing a second icon concept.
  kind          text NOT NULL CHECK (kind IN ('TITLE_CARD','LABEL','DOOR_CARD','ICON')),
  start_s       numeric(6,2) NOT NULL,
  end_s         numeric(6,2) NOT NULL CHECK (end_s > start_s),
  -- Controls both DOOR_CARD line stacking order (top to bottom) and, for
  -- everything else, z-order among overlays whose time ranges overlap
  -- (higher order_index compositing on top) -- one column doing both jobs
  -- because in every real case they are the same thing: what a viewer
  -- reads as "on top" is also what a viewer reads as "listed first."
  order_index   integer NOT NULL DEFAULT 0,
  -- Shape depends on kind; see the header comment above and
  -- studio_overlays.mjs's validateOverlayData for the exact fields each
  -- kind requires. Documented here so a reader of this table does not have
  -- to go find the validator to know what is stored:
  --
  -- TITLE_CARD / LABEL:
  --   { text, font_family: 'bold'|'regular', font_size_px, text_color,
  --     background_color, background_opacity: 0-1, corner_radius_px,
  --     position: { anchor: 'top'|'upper-third'|'top-right'|'right-center'
  --                 |'center', inset_px },
  --     animation_in:  { type: 'none'|'fade'|'slide-left'|'slide-right',
  --                       duration_s },
  --     animation_out: { type: 'none'|'fade', duration_s } }
  --   font_family is 'bold'/'regular' rather than a free string because
  --   those are the only two Ethiopic-capable weights this build actually
  --   has instantiated (apps/api/assets/fonts/NotoSansEthiopic-{Bold,
  --   Regular}.ttf) -- offering more choices here would offer a font that
  --   silently fails to render Amharic.
  --
  -- DOOR_CARD:
  --   { background_color,
  --     lines: [ { text, font_family: 'bold'|'regular', font_size_px,
  --                text_color, delay_s }, ... ] }
  --   One DOOR_CARD row is the WHOLE card -- background plus every line --
  --   matching the brief's structure exactly (its door card is one
  --   background with four lines, each fading in at its own offset from
  --   the card's own start_s via delay_s). order_index of the LINE within
  --   the array is its stacking position top-to-bottom; there is no
  --   separate position field per line, since a door card's lines are
  --   always vertically stacked, never freely placed.
  --
  -- ICON:
  --   { asset_id, position: { anchor, inset_px }, width_px,
  --     animation_in, animation_out }
  --   asset_id references lcos.assets(id) where kind='ICON' -- the
  --   existing asset library, not a new asset concept. Not a foreign key
  --   at the SQL level because lcos.assets is a different schema's table
  --   already reached by uuid reference elsewhere in Video Studio without
  --   a cross-schema FK (see studio.locks.reference_asset_ids); validity
  --   is checked at the API layer instead (see the POST /overlays route),
  --   consistent with that existing pattern.
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_at   timestamptz,
  approved_by   uuid REFERENCES lcos.users(id),
  created_by    uuid REFERENCES lcos.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX overlays_project_idx ON overlays(project_id, start_s);

COMMENT ON TABLE overlays IS
  'Burned-in graphic overlays for a Video Studio project''s final assembled cut (title cards, on-screen labels, the closing door/CTA card, icon moments). Reviewable structured data, same continuity-lock philosophy as studio.locks: code compiles the actual SVG/ffmpeg burn-in deterministically from these approved rows at assemble time, the model never freehands the pixels. See apps/api/src/modules/studio_overlays.mjs.';
COMMENT ON COLUMN overlays.kind IS
  'TITLE_CARD and LABEL share one data shape (a positioned, animated text-on-box); DOOR_CARD is one card with several independently-timed lines; ICON places a library icon asset. See the CREATE TABLE comment for the full per-kind data shape.';
COMMENT ON COLUMN overlays.data IS
  'Shape depends on kind -- see the CREATE TABLE comment above for the exact fields each kind requires, and studio_overlays.mjs''s validateOverlayData for the enforced version of that same contract.';
COMMENT ON COLUMN overlays.order_index IS
  'Controls DOOR_CARD line stacking order (via data.lines'' own array order, not this column) is NOT what this drives -- this column orders/z-stacks OVERLAY ROWS themselves: which door card line group sits above another simultaneous overlay, and general z-order when two overlays'' time ranges overlap on screen.';
COMMENT ON COLUMN overlays.approved_at IS
  'An overlay only burns into assemble()''s final pass once approved (POST /studio/overlays/:overlayId/approve), same human-gate discipline as studio.assets.accept for shot footage. Editing an approved overlay (PATCH) un-approves it -- see the route -- mirroring how a lock revision invalidates shots generated against the prior version.';

SET search_path = lcos, public;
