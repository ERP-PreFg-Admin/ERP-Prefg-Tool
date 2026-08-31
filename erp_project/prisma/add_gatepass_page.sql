-- Open the GatePass page (/gatepass) to the developer role.
--
-- "/gatepass" is a TOP-LEVEL slug, so lib/permissions.ts' parent-walk has nothing
-- to fall back to — parentSlug("/gatepass") is null, and resolveAccess then
-- returns "none" for everybody, developers included. Until a row exists the page
-- is invisible in the sidebar and the API route 403s.
--
-- This is a CONVENIENCE, not a bootstrap requirement. /admin > Permissions is
-- gated on "/admin", not on the slug being edited (see the GET/POST handlers in
-- app/api/v1/admin/permissions/route.ts), so anyone who can reach /admin can
-- grant /gatepass through the UI without holding it themselves. Unlike the
-- "/admin" rows in add_activity_log.sql, there is no chicken-and-egg here.
--
-- DEVELOPER ONLY, deliberately. Everyone else — admins included — is granted
-- from /admin > Permissions, because this page has NO ENTITY SCOPING of any kind:
-- it reads every facility in lib/gatepass/facilities.ts, and with no DB read
-- behind it a facility code cannot be resolved to a warehouse to check against
-- lib/scope.ts. The grant therefore means "may see all twenty facilities'
-- dispatch counts" and belongs with the dispatch/ops group, decided per person.
--
-- 'viewer' would be enough to use the screen — the page only reads, and the API
-- route asks for `level: "viewer"`. 'editor' is future-proofing for the day
-- gatepasses are created rather than just counted.
--
-- Re-runnable: ON DUPLICATE KEY UPDATE.
--
-- Applied to mcaff_prefg_dev and mcaff_prefg_prod on 2026-08-28.

INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('developer', '/gatepass', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);
