-- WHAT: invoice_leg_verification — one row per (invoice, leg) that a human has
-- physically checked. Legs are 'po', 'pod', 'inv', the three sides of the
-- three-way match on /po-tracking/invoices.
--
-- WHY: until now a leg went green purely because the arithmetic agreed. Numbers
-- agreeing is not the same as someone having the document in front of them —
-- an invoice can reconcile to the paisa against a delivery that never happened,
-- and finance signs off payments and debit notes on this screen. So the green
-- state now requires a person, and the automatic verdict only ever gets a leg
-- as far as "agrees, unverified".
--
-- Verification is ORTHOGONAL to the arithmetic, not a substitute for it: a leg
-- whose numbers disagree stays amber after it is verified. Verifying says "I
-- have seen this document", never "the variance is fine".
--
-- Absence of a row IS the unverified state — there is no verified=0 row, so
-- un-verifying is a DELETE and nothing has to be backfilled.
--
-- RE-RUNNABLE: yes. CREATE TABLE IF NOT EXISTS, no ALTER.
-- (Note MySQL 8.0 has no ADD COLUMN IF NOT EXISTS — that limit does not apply
-- to CREATE TABLE, which is why this migration is safe to re-run and the
-- column-adding ones are not.)
--
-- APPLY TO: dev first. Prod needs its own go-ahead.

CREATE TABLE IF NOT EXISTS invoice_leg_verification (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id  INT NOT NULL,
  leg         ENUM('po','pod','inv') NOT NULL,
  verified_by INT NOT NULL,
  verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- What was actually checked — the GRN seen, the signed copy filed. Optional,
  -- because forcing a sentence on every click buys noise, not evidence.
  remarks     VARCHAR(500) NULL,

  -- One verification per leg. Re-verifying updates the row rather than
  -- appending, so "who last signed this off" has exactly one answer.
  UNIQUE KEY uq_invoice_leg (invoice_id, leg),

  CONSTRAINT fk_ilv_invoice FOREIGN KEY (invoice_id)
    REFERENCES invoice_mfg(id) ON DELETE CASCADE,
  -- No ON DELETE on the user: a deactivated approver must not silently erase
  -- the record of who signed off. users is never hard-deleted (admin
  -- deactivates), so this only guards against a future mistake.
  CONSTRAINT fk_ilv_user FOREIGN KEY (verified_by)
    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
