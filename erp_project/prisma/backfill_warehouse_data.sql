-- WHAT: fill in city / state / zone / type on the 10 existing master_warehouse
-- rows, and add the 18 details_warehouse_entity rows carrying each location's
-- Unicommerce facility code per legal entity.
--
-- WHY UPDATE AND NOT DELETE+INSERT: the plan called for a wipe on the assumption
-- the existing rows were junk. The pre-flight said otherwise — all 10 rows carry
-- a correct state and zone, they map 1:1 onto the source sheet, and three of them
-- have data attached by NAME:
--
--     Gurgaon   3 POs + 1 invoice
--     Mumbai    4 POs + 1 entity_emails recipient
--     Guwahati  1 PO
--
-- master_warehouse.name is copied by value into purchase_orders.destination,
-- invoice_mfg.destination and entity_emails.entity_code with no foreign key
-- anywhere, so a delete or a rename orphans all of that silently. The existing
-- names are city names and read better in the PO destination dropdown than the
-- sheet's internal codes (GGN MW, KOL, BGLR), so they are kept as-is and this
-- file only ever UPDATEs matched-on-name. No DELETE, no TRUNCATE.
--
-- The one exception is 'Ahemdabad' -> 'Ahmedabad': a plain misspelling, and that
-- row has zero POs, invoices, mail rows and scope rows, so the rename is free.
--
-- `location` changes meaning here. It held the state ('Mumbai'/'Maharashtra');
-- it now holds the city, and the new `state` column holds the state. This is
-- user-visible: warehouseOptions in lib/queries/purchase-orders.ts selects
-- `location` and the PO destination dropdown renders it, so that dropdown will
-- start showing Bhiwandi rather than Maharashtra.
--
-- RE-RUNNABLE: yes, and intended to be — re-run after any correction. Part 1 is
-- an UPDATE keyed on name and Part 2 upserts on uq_warehouse_entity. The only
-- non-idempotent line is the Ahemdabad rename, which simply matches nothing on a
-- second run.
--
-- Run on BOTH schemas (test and prod), AFTER prisma/add_warehouse_master.sql.


-- ── Part 1. The 10 locations ─────────────────────────────────────────────────
--
-- `zone` values are exactly ZONE_OPTIONS (components/masters/field-config.ts) —
-- anything else fails normalizeZone() in the UI later. Guwahati is corrected
-- from 'East' to 'North East'; Assam is not in the East zone.
--
-- type: MWH = Mother Warehouse, CWH = Child Warehouse. Gurgaon and Mumbai are the
-- two mother warehouses, which is what the rows already said — restated here so
-- the file is the whole picture rather than a diff.
--
-- Chennai is set inactive: it is not on the source sheet, so it has no facility
-- code under either entity and nothing can be inwarded to it. Inactive rather
-- than deleted so that if a PO ever did point at it, the destination still
-- resolves. Every costing/dropdown query filters status = 'active'.
UPDATE master_warehouse w
JOIN (
            SELECT 'Gurgaon'   AS nm, 'Gurgaon'   AS new_nm, 'Gurugram'  AS city, 'Haryana'       AS st, 'North'      AS zn, 'MWH' AS ty, 'active'   AS sts
  UNION ALL SELECT 'Mumbai',          'Mumbai',            'Bhiwandi',          'Maharashtra',           'West',            'MWH',      'active'
  UNION ALL SELECT 'Kolkata',         'Kolkata',           'Kolkata',           'West Bengal',           'East',            'CWH',      'active'
  UNION ALL SELECT 'Bangalore',       'Bangalore',         'Bengaluru',         'Karnataka',             'South',           'CWH',      'active'
  UNION ALL SELECT 'Hyderabad',       'Hyderabad',         'Hyderabad',         'Telangana',             'South',           'CWH',      'active'
  UNION ALL SELECT 'Ahemdabad',       'Ahmedabad',         'Ahmedabad',         'Gujarat',               'West',            'CWH',      'active'
  UNION ALL SELECT 'Lucknow',         'Lucknow',           'Lucknow',           'Uttar Pradesh',         'North',           'CWH',      'active'
  UNION ALL SELECT 'Nagpur',          'Nagpur',            'Nagpur',            'Maharashtra',           'West',            'CWH',      'active'
  UNION ALL SELECT 'Guwahati',        'Guwahati',          'Guwahati',          'Assam',                 'North East',      'CWH',      'active'
  UNION ALL SELECT 'Chennai',         'Chennai',           'Chennai',           'Tamil Nadu',            'South',           'CWH',      'inactive'
) d ON d.nm = w.name
SET w.name     = d.new_nm,
    w.location = d.city,
    w.state    = d.st,
    w.zone     = d.zn,
    w.type     = d.ty,
    w.status   = d.sts;

-- Expect 10. Fewer means a name in the list above no longer matches a row —
-- the JOIN drops it silently rather than erroring.
SELECT ROW_COUNT() AS rows_matched;


-- ── Part 2. Facility code per (location, legal entity) ───────────────────────
--
-- Joined by name and entity code, never by id: ids differ between the test and
-- prod schemas, the business keys do not.
--
-- Chennai gets no rows — not on the sheet, no facility under either entity.
--
-- The sheet also lists facility codes for two SUPERSEDED facilities: HYP_SRGWHT
-- / mCaff_Guwahati for the old Guwahati site, and a closed GGN. master_warehouse
-- holds one row per city, so there is nowhere to put a retired facility's code
-- alongside its replacement. They are omitted deliberately — the live codes
-- below are HYP_DLGWHT / mCaff_Guwahati2 for Guwahati.
--
-- gstin, bill_to_* and ship_to_* stay NULL: they are entered through
-- /masters/warehouses once that page ships. Step 7's facility resolver keys on
-- master_entity.pan and never reads gstin, so routing works without them.
INSERT INTO details_warehouse_entity (warehouse_id, entity_id, facility_code, status)
SELECT w.id, e.id, d.facility_code, 'active'
FROM (
            SELECT 'Gurgaon'   AS wh_name, 'KREATIVE' AS entity_code, 'HYP_B2B_GGN'      AS facility_code
  UNION ALL SELECT 'Gurgaon',              'PEP',                     'GGN_WAREHOUSE'
  UNION ALL SELECT 'Mumbai',               'KREATIVE',                'HYP_B2B_MUM2'
  UNION ALL SELECT 'Mumbai',               'PEP',                     'MUM_WAREHOUSE2'
  UNION ALL SELECT 'Kolkata',              'KREATIVE',                'HYP_SRKOL'
  UNION ALL SELECT 'Kolkata',              'PEP',                     'mCaff_Kolkata2'
  UNION ALL SELECT 'Bangalore',            'KREATIVE',                'HYP_SRBGLR'
  UNION ALL SELECT 'Bangalore',            'PEP',                     'mCaff_Bangalore2'
  UNION ALL SELECT 'Hyderabad',            'KREATIVE',                'HYP_SRHYD'
  UNION ALL SELECT 'Hyderabad',            'PEP',                     'mCaff_Hyderabad2'
  UNION ALL SELECT 'Ahmedabad',            'KREATIVE',                'HYP_AHMO'
  UNION ALL SELECT 'Ahmedabad',            'PEP',                     'mCaff_Ahmedabad'
  UNION ALL SELECT 'Lucknow',              'KREATIVE',                'HYP_SRLOK2'
  UNION ALL SELECT 'Lucknow',              'PEP',                     'mCaff_Lucknow3'
  UNION ALL SELECT 'Nagpur',               'KREATIVE',                'HYP_DLNAG'
  UNION ALL SELECT 'Nagpur',               'PEP',                     'mCaff_Nagpur'
  UNION ALL SELECT 'Guwahati',             'KREATIVE',                'HYP_DLGWHT'
  UNION ALL SELECT 'Guwahati',             'PEP',                     'mCaff_Guwahati2'
) d
JOIN master_warehouse w ON w.name = d.wh_name
JOIN master_entity    e ON e.code = d.entity_code
ON DUPLICATE KEY UPDATE
  facility_code = VALUES(facility_code),
  status        = VALUES(status);


-- ── Verify. All four must return zero rows; then the counts. ─────────────────

-- 1. Every active location has both entities configured. Both JOINs above drop a
--    row silently on a name or code typo, so this is the check that catches it.
SELECT w.name, COUNT(dwe.id) c
  FROM master_warehouse w
  LEFT JOIN details_warehouse_entity dwe ON dwe.warehouse_id = w.id
 WHERE w.status = 'active'
 GROUP BY w.name HAVING c <> 2;

-- 2. No blank facility codes on active rows.
SELECT w.name, e.code
  FROM details_warehouse_entity dwe
  JOIN master_warehouse w ON w.id = dwe.warehouse_id
  JOIN master_entity    e ON e.id = dwe.entity_id
 WHERE dwe.status = 'active' AND (dwe.facility_code IS NULL OR dwe.facility_code = '');

-- 3. No duplicate facility code. A Unicommerce facility code is unique per
--    facility, so a repeat means a copy-paste slip in the list above.
SELECT facility_code, COUNT(*) c
  FROM details_warehouse_entity
 WHERE facility_code IS NOT NULL
 GROUP BY facility_code HAVING c > 1;

-- 4. Nothing lost its destination. Every PO/invoice destination string should
--    still match a warehouse row — this is what the UPDATE-in-place approach
--    exists to guarantee, so it must stay empty.
SELECT p.destination, COUNT(*) c FROM purchase_orders p
  LEFT JOIN master_warehouse w ON w.name = p.destination
 WHERE p.destination IS NOT NULL AND w.id IS NULL
 GROUP BY p.destination
UNION ALL
SELECT i.destination, COUNT(*) FROM invoice_mfg i
  LEFT JOIN master_warehouse w ON w.name = i.destination
 WHERE i.destination IS NOT NULL AND w.id IS NULL
 GROUP BY i.destination;

-- Expect 10 locations (9 active + Chennai inactive) and 18 entity rows.
SELECT (SELECT COUNT(*) FROM master_warehouse)                            AS locations,
       (SELECT COUNT(*) FROM master_warehouse WHERE status = 'active')    AS active_locations,
       (SELECT COUNT(*) FROM details_warehouse_entity)                    AS entity_rows;

-- Eyeball it: the sheet's two columns, side by side.
SELECT w.name, w.location, w.state, w.zone, w.type, w.status,
       MAX(CASE WHEN e.code = 'KREATIVE' THEN dwe.facility_code END) AS kreative_facility,
       MAX(CASE WHEN e.code = 'PEP'      THEN dwe.facility_code END) AS pep_facility
  FROM master_warehouse w
  LEFT JOIN details_warehouse_entity dwe ON dwe.warehouse_id = w.id
  LEFT JOIN master_entity            e   ON e.id = dwe.entity_id
 GROUP BY w.id, w.name, w.location, w.state, w.zone, w.type, w.status
 ORDER BY w.type DESC, w.name;
