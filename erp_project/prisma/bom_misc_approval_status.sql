-- bom_misc: allow the approval flow's two transient statuses.
--
-- Job Work / Shrink Wrap / Shipper / RM-PM Wastage all feed Total Costing in
-- lib/costing/final-costing.ts, so they carry the same money impact as the
-- RM/PM rates that already require approval — but /api/v1/manufacturing/misc-costs
-- wrote them straight to the table. Routing them through the approval flow needs
-- the two statuses that flow uses to park a row:
--
--   in_review — submitted, awaiting an approver. Every costing query filters
--               `status = 'active'`, so an in_review row is inert by
--               construction: it exists but prices nothing. That is what makes
--               "insert immediately, flip on approve" safe for NEW cost lines,
--               which have no prior row to lock.
--   rejected  — approver said no. The submitter can re-edit; costing still
--               ignores it.
--
-- MySQL 8.0 has no ADD/MODIFY ... IF NOT EXISTS for enums, so this is NOT
-- re-runnable — running it twice is harmless only because the second run
-- produces the identical column definition.
--
-- Existing rows are untouched: every current value ('active', 'inactive',
-- 'discontinued') survives the widening, and the DEFAULT is unchanged.
--
-- Run on BOTH mcaff_prefg_dev and mcaff_prefg_prod, and keep the matching enum
-- in prisma/schema.prisma in sync.

ALTER TABLE bom_misc
  MODIFY COLUMN status
    ENUM('active', 'inactive', 'discontinued', 'in_review', 'rejected')
    DEFAULT 'active';
