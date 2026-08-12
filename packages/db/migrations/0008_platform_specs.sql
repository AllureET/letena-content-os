-- 0008: per-platform video/image sizing specs, admin-editable.
--
-- Source of truth (2026 research, cited per row in format_notes): Instagram
-- Reels, TikTok, Facebook Reels/feed and Telegram sizing, safe zones and
-- duration guidance current as of this migration. Numbers were handed to
-- this build as verified facts, not re-derived here; when a platform changes
-- its recommendations, edit the row through PUT /platform/specs (or here)
-- rather than hunting through code -- production.mjs and distribution.mjs
-- both read this table live, no restart required.
--
-- Renders are produced platform-agnostic (one render can be scheduled to
-- several platforms via separate publishing_jobs rows), so the spec is
-- looked up at PUBLISH time, in POST /distribution/jobs: the chosen
-- platform's dimensions/safe zone ride along on the publishing job's
-- payload, and a render whose duration or aspect ratio does not fit the
-- target platform gets a non-blocking warning back in the response.
SET search_path = lcos, public;

CREATE TABLE IF NOT EXISTS platform_specs (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform                      publish_platform NOT NULL UNIQUE,
  aspect_ratio                  text        NOT NULL,
  width                         integer     NOT NULL,
  height                        integer     NOT NULL,
  max_duration_seconds          integer,
  recommended_duration_seconds  integer,
  safe_zone                     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  format_notes                  text,
  updated_by                    uuid REFERENCES users(id),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform_specs IS
  'Per-platform export sizing: aspect ratio, pixel dimensions, duration '
  'guidance and the UI-overlay safe zone. Read at publish time by '
  'distribution.mjs to attach dimensions and a non-blocking duration/ratio '
  'warning to a publishing job; admin-editable via GET/PUT /platform/specs.';

INSERT INTO platform_specs
  (platform, aspect_ratio, width, height, max_duration_seconds, recommended_duration_seconds,
   safe_zone, format_notes)
VALUES
  ('INSTAGRAM', '9:16', 1080, 1920, 900, 90,
   '{"x":0,"y":285,"width":1080,"height":1350,"description":"Keep captions, logos and CTAs inside the central 1080x1350 area; Reels UI (username, caption, like/comment/share buttons) overlays the rest."}'::jsonb,
   'Instagram Reels 2026: 1080x1920 (9:16), 30-60fps, H.264/MP4 or MOV, AAC audio, 8-12 Mbps bitrate. '
   'Max upload 15 min, but Reels under 90s reach the Explore feed and new audiences better -- '
   'over ~3 min mostly reaches existing followers only.'),

  ('TIKTOK', '9:16', 1080, 1920, 600, 34,
   '{"x":60,"y":150,"width":960,"height":1500,"description":"Keep key content clear of TikTok''s right-side action rail and bottom caption/username band; use on-screen text and stickers sparingly."}'::jsonb,
   'TikTok 2026: 1080x1920 (9:16) primary, 1080x1080 square available as a secondary cross-post '
   'format. Duration flexible 3s-10min; 1080p H.264 at up to 60fps. File size ~287.6MB iOS / '
   '72MB Android. Recommended length here (34s) matches Letena''s existing V01-V06 template runtimes.'),

  ('FACEBOOK', '9:16', 1080, 1920, 240, 60,
   '{"x":0,"y":285,"width":1080,"height":1350,"description":"Same central-safe-area guidance as Instagram Reels for Reels/Stories; feed posts using 1:1 or 4:5 have more usable frame."}'::jsonb,
   'Facebook 2026: Reels/Stories 1080x1920 (9:16) like Instagram; feed video performs well at 1:1 '
   '(1080x1080) or 4:5. Keep feed video under 60s for the best completion rate.'),

  ('TELEGRAM', '9:16', 1080, 1920, NULL, 90,
   '{"x":0,"y":0,"width":1080,"height":1920,"description":"No platform-imposed safe zone -- Telegram is a messaging app, not an algorithmic feed."}'::jsonb,
   'Telegram has no strict platform-imposed aspect ratio and file sizes up to 2GB, so it is a safe '
   'fallback for anything too long or the wrong shape for the other platforms. Default to 9:16 (or '
   '1:1 when repurposing a square asset) purely for consistency with the rest of the pipeline.'),

  -- Generic defaults below: not independently researched to the same 2026
  -- standard as the four platforms above. Sized to the pipeline's existing
  -- 9:16/30-45s template output so lookups never fail; refine the row (via
  -- PUT /platform/specs) before any of these publishing paths goes live.
  ('YOUTUBE', '9:16', 1080, 1920, 180, 60,
   '{"x":0,"y":0,"width":1080,"height":1920,"description":"Generic placeholder -- refine against YouTube Shorts guidance before this publishing path goes live."}'::jsonb,
   'Placeholder sized for YouTube Shorts (vertical, <=180s). Not independently verified; refine when YouTube publishing is built.'),

  ('LINKEDIN', '1:1', 1080, 1080, 600, 90,
   '{"x":0,"y":0,"width":1080,"height":1080,"description":"Generic placeholder -- refine against LinkedIn native video guidance before this publishing path goes live."}'::jsonb,
   'Placeholder square format for LinkedIn native video. Not independently verified; refine when LinkedIn publishing is built.'),

  ('X', '1:1', 1080, 1080, 140, 45,
   '{"x":0,"y":0,"width":1080,"height":1080,"description":"Generic placeholder -- refine against X/Twitter video guidance before this publishing path goes live."}'::jsonb,
   'Placeholder square format for X. Not independently verified; refine when X publishing is built.'),

  ('WEBSITE', '9:16', 1080, 1920, NULL, NULL,
   '{"x":0,"y":0,"width":1080,"height":1920,"description":"No platform constraint -- reuses whichever render already exists."}'::jsonb,
   'No platform-imposed constraint; the manual-channel download path reuses whichever render already exists.')
ON CONFLICT (platform) DO NOTHING;
