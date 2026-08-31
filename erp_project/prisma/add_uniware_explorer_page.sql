-- Open the Unicommerce PO Explorer (/uniware) to the developer role, and ONLY
-- the developer role.
--
-- ── WHY THE SLUG IS TOP-LEVEL ────────────────────────────────────────────────
-- The screen had to be grantable to developers WITHOUT admins inheriting it, and
-- that constraint alone decided where it lives.
--
-- resolveAccess (lib/permissions.ts) walks a slug up its parents and returns at
-- the FIRST slug the user's own roles hold a row for. So a developer-only row on
-- "/admin/uniware" would not exclude anyone: an admin hits that slug, finds no
-- row for their role, walks up to "/admin", finds the grant seeded by
-- add_activity_log.sql, and is let straight in.
--
-- "/uniware" has no parent — parentSlug("/uniware") is null — so the walk ends
-- immediately and absence of a row IS denial. Same structural reason
-- /gatepass sits where it does (add_gatepass_page.sql).
--
-- ── WHY DEVELOPER ONLY ───────────────────────────────────────────────────────
-- The page has NO ENTITY SCOPING and cannot have any. It reads the Uniware
-- tenant by facility code, and a PO there belongs to whoever raised it — there
-- is no local row to resolve against lib/scope.ts, so the grant means "may read
-- every purchase order at every facility, across both legal entities and every
-- brand". That is a tenant-wide read, decided per person.
--
-- It also bypasses the sandbox facility pin (lib/uniware/po-explorer.ts): off
-- prod, every other Uniware call is forced to TEST_FACILITY, and this one is
-- not. Safe because the module only reads — but it means a developer on a dev
-- box is talking to real warehouses, which is another reason not to hand it out.
--
-- 'viewer' would be enough to use the screen — it only reads, and both API
-- routes ask for `level: "viewer"`. 'editor' matches how /gatepass was seeded
-- and costs nothing today.
--
-- ── THIS IS A CONVENIENCE, NOT A BOOTSTRAP ───────────────────────────────────
-- /admin > Permissions is gated on "/admin", not on the slug being edited (see
-- app/api/v1/admin/permissions/route.ts), so anyone who can reach /admin can
-- grant /uniware through the UI without holding it. There is no chicken-and-egg
-- here, unlike the "/admin" rows in add_activity_log.sql.
--
-- NOTE: granting this to any other role is a real decision, not a formality.
-- Adding a row for 'admin' here would undo the whole point of the slug choice.
--
-- Re-runnable: ON DUPLICATE KEY UPDATE.
--
-- Run on BOTH schemas (test and prod).

INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('developer', '/uniware', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Exactly one row, for 'developer'. Anything else here means someone widened it.
SELECT role, page_slug, access_level
  FROM page_permissions
 WHERE page_slug = '/uniware';

-- Must return zero rows: a per-user override would route around the role grant.
SELECT u.email, upp.access_level
  FROM user_page_permissions upp
  JOIN users u ON u.id = upp.user_id
 WHERE upp.page_slug = '/uniware';
