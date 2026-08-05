-- Replaces the free-text role taxonomy with the declared one in lib/roles.ts:
-- `developer` + `admin`, plus four domains (rm/pm/production/cost) x three
-- designations (head/lead/executive), keyed `${domain}_${designation}`.
--
-- Roles are pure join keys — nothing in the app branches on a role name — so
-- this is a data migration with no code coupling beyond lib/roles.ts.
--
-- What the live dev schema held before this ran:
--   user_roles       admin, "cost creator", developer, "production executive"
--   page_permissions admin(2), "cost creator"(1), developer(19), manager(1),
--                    "production executive"(3), "production head"(11)
-- Note the SPACES. scripts/seed-permissions.ts historically seeded underscored
-- variants (production_operations, cost_creator, bom_creator) that nobody ever
-- held, so every statement below matches both spellings.
--
-- Re-running is a harmless no-op. Run on BOTH schemas (test and prod).

-- ── 1. Remap the users on retired roles ─────────────────────────────────────
-- INSERT IGNORE + DELETE rather than UPDATE: user_roles' PK is (user_id, role),
-- so updating a row to a role the user already holds would be a PK violation.

INSERT IGNORE INTO user_roles (user_id, role)
  SELECT user_id, 'cost_executive' FROM user_roles
  WHERE role IN ('cost creator', 'cost_creator');

INSERT IGNORE INTO user_roles (user_id, role)
  SELECT user_id, 'production_executive' FROM user_roles
  WHERE role IN ('production executive', 'production_operations');

INSERT IGNORE INTO user_roles (user_id, role)
  SELECT user_id, 'production_head' FROM user_roles
  WHERE role IN ('production head');

-- ── 2. Drop every role that isn't in the new taxonomy ───────────────────────
-- Clears the originals of the remaps above, plus `manager` and the orphaned
-- seed roles. Users keep their account and their per-user overrides; they just
-- hold no role until one is assigned in /admin.

DELETE FROM user_roles WHERE role NOT IN (
  'developer', 'admin',
  'rm_head', 'rm_lead', 'rm_executive',
  'pm_head', 'pm_lead', 'pm_executive',
  'production_head', 'production_lead', 'production_executive',
  'cost_head', 'cost_lead', 'cost_executive'
);

-- ── 3. Clean slate for role-based page access ───────────────────────────────
-- Everything except developer/admin goes, deliberately: access is granted from
-- the tool now. This also drops the old "production head" grants, whose name
-- collides with the new production_head role and would otherwise carry 11
-- inherited grants (/manufacturing, /po-tracking, …) forward invisibly.
-- user_page_permissions (per-user overrides) is untouched.

DELETE FROM page_permissions WHERE role NOT IN ('developer', 'admin');

-- ── 4. The one seeded rule: approvals are done by Head ──────────────────────
-- /approvals has no parent slug, so lib/permissions.ts' parent-walk can't fall
-- back to '/' — without these rows a Head cannot approve anything.

INSERT INTO page_permissions (role, page_slug, access_level) VALUES
  ('rm_head',         '/approvals', 'editor'),
  ('pm_head',         '/approvals', 'editor'),
  ('production_head', '/approvals', 'editor'),
  ('cost_head',       '/approvals', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);
