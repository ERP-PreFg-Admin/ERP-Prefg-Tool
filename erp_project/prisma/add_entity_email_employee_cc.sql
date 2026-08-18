-- Entity emails: an 'employee' type for internal recipients, and a To/CC split.
--
-- WHAT
--   1. entity_emails.entity_type gains 'employee' — one of our own people, taken
--      from `users`. An employee row attaches to either a warehouse (entity_code
--      = master_warehouse.name, so they ride that site's inward-invoice mail) or
--      a manufacturer (entity_code = master_mfgs.code). The single value '*'
--      means EVERY manufacturer, including ones added later; that wildcard is
--      only ever written on an employee row.
--   2. entity_emails.recipient_type ENUM('to','cc'). Every existing row takes
--      the 'to' default, so no mail changes recipients when this is applied.
--
-- WHY
--   There was no way to copy someone internally on a warehouse or manufacturer
--   notification. People were being added as if they were the entity's own
--   contact, which put them in To and left them indistinguishable from the
--   site's real inbox — so nobody could tell a supplier's address from ours.
--
-- entity_code carries no foreign key (it points at three different tables
-- depending on entity_type), so the API validates the code against the right
-- table on insert. See app/api/v1/entity-emails/route.ts.
--
-- RE-RUNNABLE: NO. This is real MySQL 8.0, not MariaDB — there is no
-- ADD COLUMN IF NOT EXISTS. Run once per schema, on BOTH the test and prod
-- databases, and keep prisma/schema.prisma in sync.

ALTER TABLE entity_emails
  MODIFY COLUMN entity_type ENUM('vendor', 'mfg', 'warehouse', 'employee') NOT NULL;

ALTER TABLE entity_emails
  ADD COLUMN recipient_type ENUM('to', 'cc') NOT NULL DEFAULT 'to' AFTER email;
