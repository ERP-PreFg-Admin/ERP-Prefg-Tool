-- entity_emails: a status, and who added the row.
--
-- WHAT
--   status     ENUM('active','inactive') NOT NULL DEFAULT 'active'
--   created_by INT NULL, the users.id of whoever added it
--
--   `created_at` already exists and is the "added on" — no new column for it.
--   Named created_by/created_at rather than added_by/added_on to match
--   invoice_mfg and the rest of the schema; two names for one idea is how a
--   query ends up joining the wrong column.
--
-- WHY status
--   A contact who has left, or an inbox that has been retired, currently has to
--   be DELETED to stop being mailed — which also destroys the record of who used
--   to receive that paperwork. Deactivating keeps the history and stops the mail.
--
--   ⚠️ A status column that nothing filters on is worse than no column: the UI
--   would show "inactive" while the address kept receiving every PO. The read
--   paths in lib/queries/entity-emails.ts (selectByEntity, selectForMfg,
--   selectByWarehouseForEntity) therefore all filter status = 'active'. If you
--   add another read path, it filters too.
--
-- WHY created_by IS NULLABLE
--   The 2 rows that predate this column have no author to attribute, and
--   inventing one would be worse than admitting we don't know. NULL renders as
--   "—" in the list.
--
--   No FK to users: a user is never deleted in this system (deactivated instead,
--   see lib/queries/users.ts), so the reference cannot dangle — and the rest of
--   the audit columns here follow the same convention.
--
-- ON THE UNIQUE INDEX
--   uq_entity_email (entity_type, entity_code, legal_entity_key, email) does NOT
--   include status, on purpose. An inactive row still occupies the address, so
--   re-adding the same contact is refused and the user is pointed at the existing
--   row to reactivate. Including status would allow one active and one inactive
--   copy of the same address, and then "which one wins" becomes a real question.
--
-- MySQL 8.0: no ADD COLUMN IF NOT EXISTS, so NOT re-runnable. Run once per schema.

ALTER TABLE entity_emails
  ADD COLUMN status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  ADD COLUMN created_by INT NULL;

-- The list filters and sorts on status; the send paths filter on it with
-- entity_type/entity_code, which uq_entity_email already leads with.
CREATE INDEX idx_entity_emails_status ON entity_emails (status);
