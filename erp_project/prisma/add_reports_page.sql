-- Open the Reports tab (/reports) to the developer role.
--
-- "/reports" is a top-level slug, so resolveAccess has no parent to fall back to:
-- until a row exists everyone reads "none" and the sidebar item stays locked.
--
-- Developer only here, like /gatepass and /observability. Everyone else is granted
-- from /admin > Permissions, which is safe to do broadly: every report ALSO needs
-- its source page (lib/reports/catalog.ts) and is scoped to the viewer's brands,
-- manufacturers and warehouses. 'viewer' is enough: the reports only read.
--
-- Re-runnable: ON DUPLICATE KEY UPDATE.
--
-- Applied to mcaff_prefg_dev on 2026-10-26. Prod: pending its own go-ahead.

INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('developer', '/reports', 'viewer')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);

-- ── Verify ───────────────────────────────────────────────────────────────────

SELECT role, page_slug, access_level FROM page_permissions WHERE page_slug = '/reports';
