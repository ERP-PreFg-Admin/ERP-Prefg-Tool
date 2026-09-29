-- Entity emails: a 'report' type for subscribers to scheduled internal reports.
--
-- WHAT
--   entity_type gains 'report'. entity_code names the report ('daily_ops'),
--   legal_entity_code stays NULL, recipient_type works as it does elsewhere.
--
-- WHY A NEW ENUM VALUE, not an 'employee' row with a purpose:
--   entityEmails.selectForMfg matches employee + entity_code '*' and does NOT
--   filter on purpose, so a subscriber stored that way would be silently copied
--   on every manufacturer's PO mail, including future ones. Both entity-facing
--   recipient queries filter on entity_type, so they cannot reach a 'report' row.
--
-- RE-RUNNABLE: yes, MODIFY restates the full enum. No existing row changes.
-- APPLY TO: dev first; prod needs its own go-ahead.

ALTER TABLE entity_emails
  MODIFY COLUMN entity_type
    ENUM('vendor', 'mfg', 'warehouse', 'employee', 'report') NOT NULL;
