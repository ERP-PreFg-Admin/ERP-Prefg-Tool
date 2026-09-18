-- WHAT: invoice_payment — where a human moves an invoice along the payment
-- lifecycle, and the UTR once the money has actually gone out.
--
-- WHY: the Payment column was derived from the three-way match, which can only
-- ever say whether the PAPERWORK supports paying. It cannot say whether anyone
-- paid. Finance needs to drive the invoice through initiated -> approved ->
-- completed and record the bank reference, and none of that is inferable.
--
-- ── ONLY THE MANUAL STATES ARE STORED ────────────────────────────────────────
-- The ENUM holds exactly the four states a person can set. "Awaiting documents",
-- "Awaiting verification" and "Blocked" are DERIVED from the match and are
-- deliberately absent here, so a stored row can never claim a state the desk has
-- no way to choose. Absence of a row IS the derived state, which is also why
-- reverting to automatic is a DELETE and nothing needs backfilling.
--
-- ── ONE ROW PER INVOICE ──────────────────────────────────────────────────────
-- invoice_id is the primary key, not a surrogate id: an invoice has one payment
-- state, and "who last moved it" must have exactly one answer. The history of
-- the moves lives in activity_log, which withGateway writes on every call.
--
-- ── utr ──────────────────────────────────────────────────────────────────────
-- The bank's Unique Transaction Reference for the NEFT/RTGS/IMPS transfer.
-- NULLable because it does not exist until the money moves; the application
-- refuses 'completed' without one (see the payment route), which is a rule the
-- schema cannot express since the same column must stay NULL for every earlier
-- state.
--
-- RE-RUNNABLE: yes. CREATE TABLE IF NOT EXISTS, no ALTER.
--
-- APPLY TO: dev first. Prod needs its own go-ahead.

CREATE TABLE IF NOT EXISTS invoice_payment (
  invoice_id INT NOT NULL PRIMARY KEY,
  status     ENUM('pending','initiated','approved','completed') NOT NULL,
  -- Bank reference. Free text: UTR formats differ per channel and per bank, and
  -- a pattern guessed here would reject a real one at the worst moment.
  utr        VARCHAR(64) NULL,
  remarks    VARCHAR(500) NULL,
  updated_by INT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_ipay_invoice FOREIGN KEY (invoice_id)
    REFERENCES invoice_mfg(id) ON DELETE CASCADE,
  -- No ON DELETE on the user: a deactivated approver must not erase the record
  -- of who released a payment.
  CONSTRAINT fk_ipay_user FOREIGN KEY (updated_by)
    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
