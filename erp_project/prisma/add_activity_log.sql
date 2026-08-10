-- Per-request user activity trail, for the /admin > Activity screen.
--
-- Why this exists:
--   The app already logs three unrelated things — session_history (login/logout),
--   history_masters_edits (master edits) and history_pos (PO field changes) —
--   but nothing answers "what did this user do". Winston writes to files/stdout
--   which no admin can read.
--
-- Written from ONE place: lib/gateway/with-gateway.ts, fire-and-forget, for
-- every non-GET request. GETs are deliberately skipped — every page load and
-- dropdown fetch would land a row here for no audit value.
--
-- No FK on user_id: it's NULL for requests that 401 before a session resolves,
-- and this is the highest-volume table in the app (session_history.session_id
-- already sets the no-FK precedent).
--
-- created_on WAS IST — written as CONVERT_TZ(NOW(), '+00:00', '+05:30') because
-- the DB session runs in UTC, matching history_masters_edits.
--   SUPERSEDED: it is a plain UTC NOW() now, and the rows written before that
--   change are re-stamped by prisma/backfill_ist_timestamps_to_utc.sql. Storing
--   IST wall-clock in a column mysql2 reads back as UTC meant the UI converted
--   to IST twice and showed every row 5h30m in the future. Store UTC, convert
--   once at display time — see lib/date.ts.
--
-- Re-running is a harmless no-op. Run on BOTH schemas (test and prod).
-- Keep prisma/schema.prisma in sync.

CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NULL COMMENT 'NULL when the request failed auth',
  method      VARCHAR(10)  NOT NULL,
  path        VARCHAR(255) NOT NULL COMMENT 'API route path, e.g. /api/masters/vendors',
  status      SMALLINT     NOT NULL COMMENT 'HTTP status the request returned',
  duration_ms INT          NOT NULL,
  ip_address  VARCHAR(45)  NULL COMMENT 'First hop of x-forwarded-for',
  user_agent  VARCHAR(255) NULL,
  request_id  CHAR(36)     NULL COMMENT 'Ties the row to its Winston log lines',
  created_on  DATETIME(0)  NOT NULL COMMENT 'IST, see header',
  KEY idx_activity_user (user_id, id),
  KEY idx_activity_created (created_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bootstrap the /admin section's own permissions. REQUIRED: "/admin" has no
-- parent slug, so lib/permissions.ts' parent-walk can't fall back to "/" —
-- without these rows the admin panel is closed to everyone, including
-- developers, with no way to open it from the UI.
INSERT INTO page_permissions (role, page_slug, access_level)
VALUES ('developer', '/admin', 'editor'), ('admin', '/admin', 'editor')
ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);
