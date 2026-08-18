-- WHAT: canonicalise brand. Creates master_brand, adds master_skus.brand_id, and
-- backfills it. Also corrects the 'FIEN' -> 'Fein' typo on 28 SKUs.
--
-- WHY: brand is about to become an ACCESS BOUNDARY (see the brand-scope work
-- that follows), and master_skus.brand is free text — nullable VARCHAR(100), no
-- ENUM, no FK, and the filter dropdown is built with SELECT DISTINCT over it
-- (skusSql.selectDistinctBrands), so every variant becomes its own option.
--
-- A boundary written as `brand = 'Fein'` leaks every row spelled differently, and
-- leaks SILENTLY — the row just doesn't appear, which looks like correct
-- filtering. The schema collation (utf8mb4_0900_ai_ci) forgives case but NOT
-- punctuation or transposition: 'FIEN' <> 'Fein' regardless of case.
--
-- The survey on dev found exactly that, which is why this file exists:
--   mCaffeine  176   -> mcaffeine  (maps)
--   HYPHEN      90   -> hyphen     (maps)
--   FIEN        28   -> fien       DID NOT MAP — 'Fein' transposed
--   DND          6   -> dnd        real brand, legal entity not yet identified
--   PEP Test     4   -> peptest    test data, deliberately left unattributed
--
-- Left unattributed (brand_id NULL) means visible to EVERYONE once scoping
-- lands, matching entity_emails.legal_entity_code where NULL = all entities.
-- Nothing ever becomes invisible, so a mis-typed brand stays findable.
--
-- `brand` (the text column) is deliberately KEPT. It is a grouping key paired
-- with base_sku_sno in five queries (lib/queries/skus.ts:72-76, :122-146,
-- :153-157) that build the SKU variant families. brand_id becomes the boundary
-- key; brand stays the display and grouping value. Collapsing the two is a
-- separate refactor.
--
-- lib/constants.ts BRANDS is NOT changed. It still maps the three brands it
-- knows for PO-number prefixes, and brandCode() upper-cases an unmapped brand
-- unchanged — so DND POs are already numbered DND-PO-… and stay that way.
-- master_brand is the authority for scoping; BRANDS is the authority for
-- prefixes.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_master.sql (master_entity) to have run first.


-- ── 1. Pre-flight. Read this before running anything below. ──────────────────
-- If a brand appears here that is not seeded in section 3, its SKUs end up
-- unattributed and therefore visible to every scoped user.
SELECT brand, COUNT(*) AS skus,
       LOWER(REGEXP_REPLACE(brand, '[^a-zA-Z0-9]', '')) AS brand_key
  FROM master_skus
 GROUP BY brand
 ORDER BY skus DESC;


-- ── 2. Correct the FIEN typo ─────────────────────────────────────────────────
-- Fixing the data rather than aliasing it, so the typo cannot reappear as its
-- own option in the SELECT DISTINCT filter dropdown.
--
-- No WHERE guard beyond the match: unlike a case-only comparison this one is
-- meaningful, because 'FIEN' and 'Fein' differ by transposition and the _ci
-- collation does not equate them.
UPDATE master_skus SET brand = 'Fein' WHERE brand = 'FIEN';
SELECT ROW_COUNT() AS fien_rows_fixed;   -- expect 28 on dev


-- ── 3. The brand master ──────────────────────────────────────────────────────
-- brand_key is the normalised form and the UNIQUE key: it is what SQL compares,
-- and it must stay identical in meaning to brandKey() in lib/constants.ts
-- (lowercase, all non-alphanumerics stripped). If the two ever diverge, the
-- boundary and the display value disagree.
CREATE TABLE IF NOT EXISTS master_brand (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  brand_key  VARCHAR(50)  NOT NULL COMMENT 'Normalised: lowercase, non-alphanumerics stripped. Mirrors brandKey() in lib/constants.ts',
  name       VARCHAR(100) NOT NULL COMMENT 'Display form, e.g. mCaffeine',
  po_code    VARCHAR(20)  NOT NULL COMMENT 'PO-number prefix — MCAFF | FEIN | HYP | DND',
  entity_id  INT NULL     COMMENT 'master_entity.id — the legal entity that sells this brand. NULL = not yet identified',
  status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME(0)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_master_brand_key (brand_key),
  CONSTRAINT fk_brand_entity FOREIGN KEY (entity_id) REFERENCES master_entity (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- Same collation as master_skus and master_entity (both verified
-- utf8mb4_0900_ai_ci), so the backfill join below is not a mixed-collation
-- comparison.

-- po_code matches what brandCode() already produces, so PO numbering is
-- unaffected. DND's entity is NULL pending identification — it scopes as its own
-- brand but attributes to no legal entity, which entityForBrand() already
-- models by returning null rather than guessing.
INSERT INTO master_brand (brand_key, name, po_code, entity_id)
SELECT d.brand_key, d.name, d.po_code, e.id
FROM (
            SELECT 'mcaffeine' AS brand_key, 'mCaffeine' AS name, 'MCAFF' AS po_code, 'PEP'      AS entity_code
  UNION ALL SELECT 'fein',                   'Fein',              'FEIN',             'PEP'
  UNION ALL SELECT 'hyphen',                 'Hyphen',            'HYP',              'KREATIVE'
  UNION ALL SELECT 'dnd',                    'DND',               'DND',              NULL
) d
LEFT JOIN master_entity e ON e.code = d.entity_code
ON DUPLICATE KEY UPDATE
  name = VALUES(name), po_code = VALUES(po_code), entity_id = VALUES(entity_id);


-- ── 4. The boundary key on master_skus ───────────────────────────────────────
ALTER TABLE master_skus
  ADD COLUMN brand_id INT NULL
    COMMENT 'master_brand.id. NULL = unattributed, visible to every scoped user'
    AFTER brand,
  ADD KEY idx_sku_brand_id (brand_id),
  ADD CONSTRAINT fk_sku_brand FOREIGN KEY (brand_id) REFERENCES master_brand (id);


-- ── 5. Backfill ──────────────────────────────────────────────────────────────
UPDATE master_skus s
JOIN master_brand b
  ON b.brand_key = LOWER(REGEXP_REPLACE(s.brand, '[^a-zA-Z0-9]', ''))
SET s.brand_id = b.id
WHERE s.brand IS NOT NULL;
SELECT ROW_COUNT() AS skus_attributed;   -- expect 300 on dev (176+90+28+6)


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Per-brand counts. Cross-check against the section 1 survey.
SELECT b.brand_key, b.name, b.po_code, e.code AS entity, COUNT(s.id) AS skus
  FROM master_brand b
  LEFT JOIN master_entity e ON e.id = b.entity_id
  LEFT JOIN master_skus   s ON s.brand_id = b.id
 GROUP BY b.id, b.brand_key, b.name, b.po_code, e.code
 ORDER BY skus DESC;

-- Every SKU that will be visible to EVERY scoped user. Expect only 'PEP Test'
-- (4) and any NULL-brand rows on dev. Anything else here is a brand that should
-- have been seeded in section 3 — read it, do not assume it is empty.
SELECT COALESCE(brand, '(null)') AS brand, COUNT(*) AS skus
  FROM master_skus
 WHERE brand_id IS NULL
 GROUP BY brand
 ORDER BY skus DESC;

-- Must return zero rows: a brand whose normalised form does not round-trip to
-- its own brand_key. Catches a name edited without updating brand_key.
SELECT id, brand_key, name FROM master_brand
 WHERE brand_key <> LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', ''));

-- Must return zero rows: FIEN should no longer exist.
SELECT COUNT(*) AS fien_remaining FROM master_skus WHERE brand = 'FIEN';
