
-- Run first on dev and then on prod schema after testing fully.
INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('developer', '/observability', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Exactly one row, for 'developer'. Anything else here means someone widened it.
SELECT role, page_slug, access_level
  FROM page_permissions
 WHERE page_slug = '/observability';

-- Must return zero rows: a per-user override would route around the role grant.
SELECT u.email, upp.access_level
  FROM user_page_permissions upp
  JOIN users u ON u.id = upp.user_id
 WHERE upp.page_slug = '/observability';
