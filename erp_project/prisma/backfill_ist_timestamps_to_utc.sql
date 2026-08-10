-- Re-stamp the two tables that stored IST wall-clock as UTC instants.
--
-- Why:
--   activity_log.created_on and history_masters_edits.created_on/approved_on
--   were written as CONVERT_TZ(NOW(), '+00:00', '+05:30') — IST wall-clock in a
--   column everything else treats as UTC. mysql2 reads every DATETIME as UTC
--   (lib/db.ts sets `timezone: "+00:00"`), so the UI converted to IST a SECOND
--   time and /admin > Activity displayed every request 5h30m in the future.
--   Worse, that feed UNIONs activity_log with session_history, which was always
--   UTC — so the two halves of one timeline were 5½ hours apart and interleaved
--   in the wrong order.
--
--   The writes now use plain NOW() (lib/queries/activity.ts, lib/queries/history.ts).
--   This migration corrects the rows written before that change.
--
-- NOT RE-RUNNABLE. Running it twice shifts the same rows back a second 5h30m.
--   The guard below is the cutoff id: set @cutoff to the highest id that still
--   holds an IST timestamp — i.e. the last row inserted before the code deploy.
--   Find it with:
--     SELECT MAX(id) FROM activity_log WHERE created_on > UTC_TIMESTAMP();
--   Any row whose created_on is in the future is, by definition, still IST —
--   a UTC-stamped row can never be ahead of UTC_TIMESTAMP().
--
-- Run on BOTH schemas (test and prod). No schema.prisma change: the column
-- types are unchanged, only the values.

-- ── activity_log ────────────────────────────────────────────────────────────
SET @cutoff_activity = (
  SELECT COALESCE(MAX(id), 0) FROM activity_log WHERE created_on > UTC_TIMESTAMP()
);

UPDATE activity_log
SET created_on = CONVERT_TZ(created_on, '+05:30', '+00:00')
WHERE id <= @cutoff_activity;

-- ── history_masters_edits ───────────────────────────────────────────────────
SET @cutoff_history = (
  SELECT COALESCE(MAX(id), 0) FROM history_masters_edits WHERE created_on > UTC_TIMESTAMP()
);

UPDATE history_masters_edits
SET created_on  = CONVERT_TZ(created_on,  '+05:30', '+00:00'),
    approved_on = CASE
                    WHEN approved_on IS NULL THEN NULL
                    ELSE CONVERT_TZ(approved_on, '+05:30', '+00:00')
                  END
WHERE id <= @cutoff_history;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Nothing may remain in the future, and the newest rows should sit within a few
-- minutes of UTC_TIMESTAMP() rather than 5h30m ahead of it:
--
--   SELECT MAX(created_on) AS newest, UTC_TIMESTAMP() AS utc_now FROM activity_log;
--   SELECT COUNT(*) AS still_future FROM activity_log WHERE created_on > UTC_TIMESTAMP();
