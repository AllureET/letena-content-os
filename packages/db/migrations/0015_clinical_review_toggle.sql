-- 0015: admin-manageable toggle for the clinical review gate itself.
--
-- Nate, 14 Aug 2026: "We dont want to have clinical review anymore remember.
-- We are going past that to allow this to just run so we can see that it
-- works first and then we can go back to adding clinical review. Add an
-- admin toggle to turn it on/off and have it off for now."
--
-- Deliberately a separate setting from publishing.mode rather than folded
-- into its existing FULL_AUTO/AUTO_EXCEPT_SENSITIVE levels: those also
-- govern language review and are meant as a durable operating mode, where
-- this is a temporary, single-purpose kill switch for the clinical
-- sign-off step specifically, with an explicit plan to flip it back on.
-- routeReviews() in apps/api/src/modules/content.mjs reads it: when off,
-- a TIER_3/TIER_4 script that passes claim validation auto-approves
-- instead of creating a CLINICAL_SCRIPT review task. Admin-only to change,
-- validated as strict boolean, same treatment as approval.override
-- (apps/api/src/server.mjs).

SET search_path = lcos, public;

INSERT INTO settings (key, value, description, is_secret)
VALUES ('review.clinical_review_enabled', 'false',
  'Whether TIER_3/TIER_4 scripts that pass claim validation stop for a doctor''s clinical sign-off (true) or auto-approve straight through (false). Off since 14 Aug 2026 to test the rest of the pipeline; turn back on when ready. Admin only.',
  false)
ON CONFLICT (key) DO NOTHING;
