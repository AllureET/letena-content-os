-- Video Studio, archive a project (19 Aug 2026). Nate: "im looking a t the
-- studio project for spotting on the pill, and I dont see. a way to dlete
-- it" -- there was genuinely no delete/archive/cancel route anywhere in
-- studio.mjs.
--
-- This adds ARCHIVE rather than a hard DELETE. Every child table
-- (studio.events, studio.locks, studio.shots, studio.assets) references
-- projects(id) ON DELETE CASCADE, so a real SQL DELETE would silently wipe
-- the whole audit trail and orphan any already-generated media sitting in
-- storage, with no way back. That is the opposite of how this codebase
-- already treats destructive actions elsewhere (retiring a content card
-- instead of deleting it, referrals moving through status rather than
-- disappearing). archived_at is nullable and reversible: archiving hides a
-- project from the default list, unarchiving brings it right back, and
-- nothing about its data is touched either way.
SET search_path = lcos, public;

ALTER TABLE studio.projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN studio.projects.archived_at IS
  'When the project was archived (hidden from the default project list). Null means active. Archiving never deletes data -- see POST /studio/projects/:id/archive.';
