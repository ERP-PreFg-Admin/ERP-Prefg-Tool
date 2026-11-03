-- serial_counters: one row per numbering series (Ajay, 2026-11-03, docs/split-po-fixes-plan.md Phase E).
-- Replaces MAX()+1 / COUNT()+1 reads, which let two concurrent writers take the same number.
-- lib/serials.ts bumps the row inside the caller's transaction, so its lock serialises the series
-- and a rolled-back transaction hands its number back. A series is seeded on first use from
-- the highest number already in the table it numbers, so existing codes carry on unchanged.
-- scope examples: PO:MCAFF-PO-202611 (PO, IMP, bulk), PO:MPO-INW-202611 (inward), SPLIT:<parent po_no>, MFG, VENDOR, RM, PM
-- Re-runnable (IF NOT EXISTS). Rows are created by the app, none here.

CREATE TABLE IF NOT EXISTS serial_counters (
  scope      VARCHAR(100) NOT NULL PRIMARY KEY,
  last_no    INT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
