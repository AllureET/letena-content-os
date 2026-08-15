-- 0027: per-user permission overrides, and let a role be revoked as well as
-- granted.
--
-- Nate, 15 Aug 2026, looking at Users & roles: "shouldn't every role have
-- individual settings" and wanted a full permission editor per person, not
-- just a role picker. The role/permission model (roles -> role_permissions
-- -> permissions) only ever expressed "what this role can do"; there was no
-- way to say "this one person, on top of their role, can also do X" or
-- "...cannot do Y even though their role normally allows it". This table is
-- that layer. It sits beside role_permissions, not instead of it: a user's
-- effective permissions are still their roles' permissions by default, this
-- only records the exceptions.

SET search_path = lcos, public;

CREATE TABLE user_permission_overrides (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect        text NOT NULL CHECK (effect IN ('GRANT','REVOKE')),
  set_by        uuid REFERENCES users(id),
  set_at        timestamptz NOT NULL DEFAULT now(),
  reason        text,
  PRIMARY KEY (user_id, permission_id)
);
COMMENT ON TABLE user_permission_overrides IS
  'Per-user exceptions layered on top of role_permissions. GRANT adds a
   permission the user''s roles do not already carry; REVOKE removes one
   their roles otherwise would. Applied last, after the role union, so a
   REVOKE always wins over a role grant for the same permission.';
