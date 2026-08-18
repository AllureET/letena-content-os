-- Fix (18 Aug 2026): migration 0031_video_studio.sql's permissions section
-- carried a comment claiming "admin gets everything via the existing
-- wildcard grant" -- that is false. There is no wildcard. requirePerm()
-- in apps/api/src/core.mjs checks a literal membership test
-- (req.actor.permissions.includes(perm)); admin's permission ROWS were
-- seeded exactly once, in 0001_init.sql, by copying every permission that
-- existed in the `permissions` table at that moment into role_permissions
-- for the admin role. Any permission created by a LATER migration (like
-- studio.read/write/generate/approve in 0031) is invisible to admin until
-- it is explicitly granted, the same way every other post-0001 permission
-- addition in this repo has had to explicitly grant itself to admin.
-- 0031 never did that, so an admin account hitting any /studio/... route
-- gets a flat 403 "requires studio.read" (etc.) -- this is what surfaced
-- as "the studio page shows an error" tonight.
--
-- This migration only adds the missing admin grant for the four studio.*
-- permissions 0031 already created; it does not touch producer/
-- content_lead/developer (0031 granted those correctly).
SET search_path = lcos, public;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin' AND p.slug LIKE 'studio.%'
ON CONFLICT DO NOTHING;
