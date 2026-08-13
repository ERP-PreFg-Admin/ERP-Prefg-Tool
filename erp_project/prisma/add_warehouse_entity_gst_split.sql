-- WHAT: make details_warehouse_entity carry a full, independent record per
-- (location, legal entity) — separate bill-to and ship-to GSTINs, its own
-- MWH/CWH type, and a remarks note. Renames `gstin` to `bill_to_gstin`.
--
-- WHY: the source sheet is 18 rows, one per location per entity, and the two
-- GSTINs on a row are genuinely different registrations — often with DIFFERENT
-- PANs. Kreative's Kolkata row bills to 27AAJCK9697F1ZS (Kreative, Maharashtra)
-- and ships to 19AAICP2804J1Z9 (PEP, West Bengal), because Pep operates that
-- site and Kreative's goods are consigned to it. Same on Bengaluru, Ahmedabad,
-- Nagpur and Guwahati; only Gurgaon and Mumbai have Kreative shipping under its
-- own registration.
--
-- That is why one `gstin` column could not work, and it also means a validation
-- rule of "the GSTIN's PAN must match this entity" is WRONG for ship-to. The
-- route now enforces:
--   bill_to_gstin — PAN must equal this entity's PAN (it is who we bill)
--   ship_to_gstin — must be one of OUR_PANS (lib/gstin.ts), any of them
--
-- The rename is free: `gstin` was added days ago and is NULL on every row —
-- addresses and GSTINs were always going to be entered through the UI.
--
-- ON `type`: added here as NULLABLE and additive, not moved. A location's type
-- can differ per entity, but master_warehouse.type is NOT NULL and is what
-- warehouseOptions selects and AddPODialog's default-destination logic reads. So
-- master_warehouse.type stays the location's value and the PO dropdown's source;
-- this column overrides it per entity when set. Two places hold a type, which is
-- a real cost — the alternative was breaking the PO destination default.
--
-- master_warehouse is untouched and remains the destination anchor:
-- purchase_orders.destination, invoice_mfg.destination and
-- entity_emails.entity_code all still resolve by its `name`, which is what keeps
-- the existing 8 POs, 1 invoice and 1 mail recipient attached.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, and the RENAME
-- fails once it has already run.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_address_fields.sql to have run first.


-- ── 1. Split the single GSTIN into bill-to and ship-to ───────────────────────
-- RENAME COLUMN keeps the type, nullability and default untouched, so there is
-- nothing to restate.
ALTER TABLE details_warehouse_entity
  RENAME COLUMN gstin TO bill_to_gstin;

ALTER TABLE details_warehouse_entity
  MODIFY COLUMN bill_to_gstin VARCHAR(15) NULL
    COMMENT 'The registration WE bill under for this site. PAN must match this row''s entity',
  ADD COLUMN ship_to_gstin VARCHAR(15) NULL
    COMMENT 'The consignee registration. One of OUR_PANS but NOT necessarily this row''s entity — Pep operates most sites, so Kreative rows often ship under Pep'
    AFTER ship_to_pincode;


-- ── 2. Per-entity type and remarks ───────────────────────────────────────────
ALTER TABLE details_warehouse_entity
  ADD COLUMN type ENUM('CWH','MWH') NULL
    COMMENT 'Overrides master_warehouse.type for this entity. NULL = use the location''s. MWH = Mother, CWH = Child'
    AFTER facility_code,
  ADD COLUMN remarks VARCHAR(255) NULL
    COMMENT 'Free note — e.g. "Activity started 22.04.2026"'
    AFTER status;


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Expect bill_to_gstin present, gstin absent, plus ship_to_gstin/type/remarks.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'details_warehouse_entity'
 ORDER BY ORDINAL_POSITION;

-- 18 rows, 9 per entity, all facility codes still set. The rename must not have
-- disturbed anything.
SELECT e.code, COUNT(*) rows_total, SUM(dwe.facility_code IS NOT NULL) with_facility
  FROM details_warehouse_entity dwe
  JOIN master_entity e ON e.id = dwe.entity_id
 GROUP BY e.code;

-- Once you have entered GSTINs, these two must both return zero rows.
--
-- bill_to_gstin whose PAN is not this row's entity:
SELECT dwe.id, e.code, dwe.bill_to_gstin
  FROM details_warehouse_entity dwe
  JOIN master_entity e ON e.id = dwe.entity_id
 WHERE dwe.bill_to_gstin IS NOT NULL
   AND (dwe.bill_to_gstin NOT REGEXP '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$'
        OR SUBSTRING(dwe.bill_to_gstin, 3, 10) <> e.pan);

-- ship_to_gstin that is not one of OUR PANs at all. Deliberately does NOT
-- compare against this row's entity — a Kreative row shipping under Pep's
-- registration is correct data, not an error.
SELECT dwe.id, e.code AS billed_entity, dwe.ship_to_gstin
  FROM details_warehouse_entity dwe
  JOIN master_entity e ON e.id = dwe.entity_id
 WHERE dwe.ship_to_gstin IS NOT NULL
   AND (dwe.ship_to_gstin NOT REGEXP '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$'
        OR SUBSTRING(dwe.ship_to_gstin, 3, 10) NOT IN
             (SELECT pan FROM master_entity WHERE pan IS NOT NULL));
