-- WHAT: full address detail for warehouses. Structured ship-to columns
-- (line1/line2/city/state/pincode) on details_warehouse_entity, plus a short
-- code, contact person/phone and the site's own GSTIN on master_warehouse.
--
-- WHY the ship-to columns are PER ENTITY and not on the location: at Mumbai the
-- two entities ship to genuinely different physical sites — Kreative to Kukse
-- Borivali, Bhiwandi and Pep to Kalyan, Thane. A single site address on
-- master_warehouse is therefore wrong for that row, and Mumbai is a mother
-- warehouse, so it is the one that matters most.
--
-- The free-text ship_to_address / bill_to_address columns are KEPT. The
-- structured columns are for the things worth querying — pincode drives courier
-- serviceability and GST place-of-supply, and cannot be filtered reliably inside
-- a blob — while the blob stays the verbatim record of what the paperwork says.
-- bill_to gets no structured columns: it is a head-office address nobody filters
-- on, and Kreative's is the same Mumbai HO on almost every row.
--
-- NOTE on the overlap with master_warehouse.location / .state: those remain the
-- site LABEL (what the PO destination dropdown renders). ship_to_city /
-- ship_to_state are authoritative for where goods physically go, which is why
-- both exist rather than one.
--
-- NOTE on site_gstin: this is NOT a duplicate of details_warehouse_entity.gstin.
-- That one is the legal entity's registration for the state it bills this site
-- under. site_gstin is the facility operator's own registration, which is a
-- different party whenever the warehouse is a 3PL. Leave it NULL for own sites.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_master.sql to have run first.


-- ── 1. The location: identity and who to call ────────────────────────────────
--
-- `code` is nullable and UNIQUE. MySQL permits many NULLs in a unique index, so
-- rows can be filled in gradually.
--
-- This is the stable identifier the name-as-FK problem actually needs — but
-- NOTHING joins on it yet. purchase_orders.destination, invoice_mfg.destination
-- and entity_emails.entity_code still hold master_warehouse.name, and migrating
-- them is a data migration across three tables that is deliberately out of scope
-- here. Adding the column now means the codes exist when that day comes.
ALTER TABLE master_warehouse
  ADD COLUMN code           VARCHAR(20)  NULL COMMENT 'Stable short code, e.g. GGN. NOT yet a join key — POs/invoices/mail still reference `name`' AFTER id,
  ADD COLUMN contact_person VARCHAR(120) NULL COMMENT 'Who to call at the site. Serves both entities — one warehouse team handles both' AFTER type,
  ADD COLUMN contact_phone  VARCHAR(20)  NULL AFTER contact_person,
  ADD COLUMN site_gstin     VARCHAR(15)  NULL COMMENT 'The facility OPERATOR''s registration (3PL). Not the same as details_warehouse_entity.gstin, which is ours' AFTER contact_phone,
  ADD UNIQUE KEY uq_warehouse_code (code);


-- ── 2. Per-entity structured ship-to ─────────────────────────────────────────
--
-- pincode is CHAR(6) and not an INT: Indian pincodes have significant leading
-- digits and an integer column would drop a leading zero on any that start with
-- one, silently turning a 6-digit code into 5.
ALTER TABLE details_warehouse_entity
  ADD COLUMN ship_to_line1   VARCHAR(200) NULL COMMENT 'Building / unit / plot' AFTER ship_to_name,
  ADD COLUMN ship_to_line2   VARCHAR(200) NULL COMMENT 'Area / locality / landmark' AFTER ship_to_line1,
  ADD COLUMN ship_to_city    VARCHAR(100) NULL AFTER ship_to_line2,
  ADD COLUMN ship_to_state   VARCHAR(50)  NULL AFTER ship_to_city,
  ADD COLUMN ship_to_pincode CHAR(6)      NULL AFTER ship_to_state,
  ADD KEY idx_dwe_pincode (ship_to_pincode);


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Expect 9 new columns across the two tables.
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND (
     (TABLE_NAME = 'master_warehouse' AND COLUMN_NAME IN
       ('code','contact_person','contact_phone','site_gstin'))
     OR (TABLE_NAME = 'details_warehouse_entity' AND COLUMN_NAME IN
       ('ship_to_line1','ship_to_line2','ship_to_city','ship_to_state','ship_to_pincode'))
   )
 ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- Any pincode that isn't 6 digits. Must return zero rows — CHAR(6) pads rather
-- than rejecting, so a 5-digit value is stored as '12345 ' and looks fine.
SELECT id, warehouse_id, ship_to_pincode FROM details_warehouse_entity
 WHERE ship_to_pincode IS NOT NULL AND ship_to_pincode NOT REGEXP '^[0-9]{6}$';
