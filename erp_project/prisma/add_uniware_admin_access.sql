-- Grant the Unicommerce PO Explorer (/uniware) to the admin role, alongside
-- developer.
--
-- ── A DELIBERATE REVERSAL ────────────────────────────────────────────────────
-- add_uniware_explorer_page.sql made this developer-only, and its header argues
-- the case: the page has no entity scoping, reads the tenant across every
-- facility/entity/brand, and bypasses the sandbox facility pin. All still true.
-- Admins are now given it anyway, on request, because the page is also where the
-- Uniware document pull is tested (mint → list → download against a real PO), and
-- an admin needs to run that. A tenant-wide read is within an admin's remit.
--
-- The slug is still top-level ("/uniware", no parent), so this is an EXPLICIT
-- grant, not inheritance through "/admin": absence of a row is still denial for
-- every other role. Adding the admin row is the whole change; nothing else about
-- the access model moves.
--
-- 'editor' matches the developer row (both API routes only need 'viewer'; editor
-- costs nothing and keeps the two rows uniform).
--
-- Re-runnable: ON DUPLICATE KEY UPDATE.
-- Run on BOTH schemas (test and prod).

INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('admin', '/uniware', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Now two rows: developer and admin. No other role.
SELECT role, page_slug, access_level
  FROM page_permissions
 WHERE page_slug = '/uniware'
 ORDER BY role;
