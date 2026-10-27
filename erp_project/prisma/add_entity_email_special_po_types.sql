-- Entity emails: 'npd', 'tech_transfer' and 'cpr' types for special-PO contacts.
--
-- WHAT
--   entity_type gains the three special po_type values. entity_code is a manufacturer
--   code, or '*' for every manufacturer. A special PO is mailed to these rows only,
--   never to the manufacturer's own contacts.
--
-- WHY ITS OWN TYPES: selectForMfg cannot reach them, so they never join a regular PO mail.
--
-- RE-RUNNABLE: yes, MODIFY restates the full enum. No existing row changes.
-- APPLY TO: dev first; prod needs its own go-ahead.

ALTER TABLE entity_emails
  MODIFY COLUMN entity_type
    ENUM('vendor', 'mfg', 'warehouse', 'employee', 'report', 'npd', 'tech_transfer', 'cpr') NOT NULL;
