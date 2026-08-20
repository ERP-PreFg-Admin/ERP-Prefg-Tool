-- Bring mcaff_prefg_prod up to mcaff_prefg_dev's schema.
--
-- WHY THIS FILE EXISTS RATHER THAN "run the migrations":
-- three tables live in dev with NO CREATE migration anywhere in prisma/ —
-- entity_brand_map, un_code_mfg_sku_wh_map and bom_misc (only an ALTER exists
-- for that last one). Replaying prisma/*.sql therefore cannot reach parity.
-- Everything below is generated from dev's LIVE schema (SHOW CREATE TABLE /
-- information_schema), so it matches what the deployed code actually queries.
--
-- RUN AGAINST PROD ONLY:  USE mcaff_prefg_prod;
-- Run top to bottom. Order is FK dependency order — master_entity before the
-- tables that reference it, master_warehouse columns before
-- details_warehouse_entity, and so on.
--
-- MySQL DDL is NOT transactional: each statement commits on its own and a
-- failure halts mid-way rather than rolling back. Run section by section and
-- check the verification query at the end of each before continuing.
--
-- Every CREATE uses IF NOT EXISTS, so re-running is safe. The ALTERs are NOT
-- re-runnable (MySQL 8 has no ADD COLUMN IF NOT EXISTS) — a second run errors
-- with "Duplicate column name", which is harmless but noisy.

USE mcaff_prefg_prod;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. master_entity — our own legal entities. Nothing else can be created first;
--    brands, warehouse rows and PO letterheads all point at it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `master_entity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `legal_name` varchar(150) NOT NULL,
  `code` varchar(50) NOT NULL,
  `pan` varchar(10) DEFAULT NULL,
  `address` text,
  `default_gstin` varchar(15) DEFAULT NULL,
  `bank_name` varchar(150) DEFAULT NULL,
  `bank_account_no` varchar(30) DEFAULT NULL,
  `bank_ifsc` varchar(11) DEFAULT NULL,
  `bank_branch` varchar(150) DEFAULT NULL,
  `status` enum('active','inactive') DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_entity_legal_name` (`legal_name`),
  UNIQUE KEY `uq_master_entity_code` (`code`),
  UNIQUE KEY `uq_master_entity_pan` (`pan`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Brands. po_code prefixes every PO number, and the per-month sequence is
--    derived by counting rows with that prefix — so these rows are load-bearing,
--    not decorative.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `master_brand` (
  `id` int NOT NULL AUTO_INCREMENT,
  `brand_key` varchar(50) NOT NULL COMMENT 'Normalised: lowercase, non-alphanumerics stripped. Mirrors brandKey() in lib/constants.ts',
  `name` varchar(100) NOT NULL COMMENT 'Display form, e.g. mCaffeine',
  `po_code` varchar(20) NOT NULL COMMENT 'PO-number prefix — MCAFF | FEIN | HYP | DND',
  `entity_id` int DEFAULT NULL COMMENT 'master_entity.id — the legal entity that sells this brand. NULL = not yet identified',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_brand_key` (`brand_key`),
  KEY `fk_brand_entity` (`entity_id`),
  CONSTRAINT `fk_brand_entity` FOREIGN KEY (`entity_id`) REFERENCES `master_entity` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- COLLATION DELIBERATELY CHANGED FROM DEV.
-- dev's entity_brand_map is utf8mb4_unicode_ci while every other prod table is
-- utf8mb4_0900_ai_ci. That mismatch is exactly what took /po-tracking and the
-- manufacturer pages down on 2026-08-10 ("Illegal mix of collations") — it was
-- master_skus then, and copying dev verbatim would plant the same fault here,
-- since `brand` is a string column that will be joined.
CREATE TABLE IF NOT EXISTS `entity_brand_map` (
  `id` int NOT NULL AUTO_INCREMENT,
  `entity_id` int NOT NULL,
  `brand` varchar(100) NOT NULL,
  `status` enum('active','inactive') DEFAULT 'active',
  `remarks` varchar(300) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `entity_brand` (`entity_id`,`brand`),
  KEY `brand` (`brand`),
  CONSTRAINT `entity_brand_map_ibfk_1` FOREIGN KEY (`entity_id`) REFERENCES `master_entity` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. master_warehouse gains the legal-entity era's columns. prod currently has
--    the bare original table, so these are all additive.
--    The two UNIQUE keys come last: they cannot be added while the columns are
--    empty on existing rows (prod has 0 warehouse rows today, so this is clean —
--    if that changes, populate `code` before adding uq_warehouse_code).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `master_warehouse` ADD COLUMN `code` varchar(20) NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `state` varchar(50) NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `status` enum('active','inactive','in_review','rejected') NOT NULL DEFAULT 'active';
ALTER TABLE `master_warehouse` ADD COLUMN `site_gstin` varchar(15) NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `contact_person` varchar(120) NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `contact_phone` varchar(20) NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `created_by` int NULL;
ALTER TABLE `master_warehouse` ADD COLUMN `updated_at` datetime NULL ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE `master_warehouse` ADD UNIQUE KEY `uq_warehouse_code` (`code`);
ALTER TABLE `master_warehouse` ADD UNIQUE KEY `uq_warehouse_name` (`name`);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. details_warehouse_entity — one row per (location, legal entity), holding
--    that entity's Unicommerce facility code and its own bill-to/ship-to GSTINs.
--    Needs master_warehouse and master_entity to exist first.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `details_warehouse_entity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `warehouse_id` int NOT NULL COMMENT 'master_warehouse.id',
  `entity_id` int NOT NULL COMMENT 'master_entity.id',
  `facility_code` varchar(50) DEFAULT NULL COMMENT 'Unicommerce facility — sent as the Facility header, see authHeaders() in lib/uniware.ts',
  `type` enum('CWH','MWH') DEFAULT NULL COMMENT 'Overrides master_warehouse.type for this entity. NULL = use the location''s. MWH = Mother, CWH = Child',
  `bill_to_gstin` varchar(15) DEFAULT NULL COMMENT 'The registration WE bill under for this site. PAN must match this row''s entity',
  `bill_to_name` varchar(200) DEFAULT NULL,
  `bill_to_address` text,
  `ship_to_name` varchar(200) DEFAULT NULL,
  `ship_to_line1` varchar(200) DEFAULT NULL COMMENT 'Building / unit / plot',
  `ship_to_line2` varchar(200) DEFAULT NULL COMMENT 'Area / locality / landmark',
  `ship_to_city` varchar(100) DEFAULT NULL,
  `ship_to_state` varchar(50) DEFAULT NULL,
  `ship_to_pincode` char(6) DEFAULT NULL,
  `ship_to_gstin` varchar(15) DEFAULT NULL COMMENT 'The consignee registration. One of OUR_PANS but NOT necessarily this row''s entity',
  `ship_to_address` text,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active' COMMENT 'A location can be live for one entity and not the other',
  `remarks` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_warehouse_entity` (`warehouse_id`,`entity_id`),
  KEY `fk_dwe_entity` (`entity_id`),
  KEY `idx_dwe_pincode` (`ship_to_pincode`),
  CONSTRAINT `fk_dwe_entity` FOREIGN KEY (`entity_id`) REFERENCES `master_entity` (`id`),
  CONSTRAINT `fk_dwe_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `master_warehouse` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Remaining columns and tables.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `entity_emails` ADD COLUMN `legal_entity_code` varchar(50) NULL;

ALTER TABLE `master_skus` ADD COLUMN `brand_id` int NULL;
ALTER TABLE `master_skus` ADD CONSTRAINT `fk_sku_brand` FOREIGN KEY (`brand_id`) REFERENCES `master_brand`(`id`);

CREATE TABLE IF NOT EXISTS `nanonets_usage` (
  `day` date NOT NULL,
  `calls` int DEFAULT '0',
  PRIMARY KEY (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Same collation correction as entity_brand_map above: dev has this on
-- utf8mb4_unicode_ci, and `type` / `status` are compared in costing queries.
CREATE TABLE IF NOT EXISTS `bom_misc` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bom_id` int NOT NULL,
  `mfg_id` int NOT NULL,
  `type` enum('jw','shrink','shipper','utility','margin','rm_loss','pm_loss') NOT NULL,
  `cost` decimal(12,4) DEFAULT NULL,
  `effective_from` date DEFAULT NULL,
  `effective_till` date DEFAULT NULL,
  `last_updated` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `status` enum('active','inactive','discontinued','in_review','rejected') DEFAULT 'active',
  PRIMARY KEY (`id`),
  KEY `bom_id` (`bom_id`),
  KEY `mfg_id` (`mfg_id`),
  CONSTRAINT `bom_misc_ibfk_1` FOREIGN KEY (`bom_id`) REFERENCES `master_recipe` (`id`),
  CONSTRAINT `bom_misc_ibfk_2` FOREIGN KEY (`mfg_id`) REFERENCES `master_mfgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Depends on details_warehouse_entity, master_mfgs, master_skus and users.
CREATE TABLE IF NOT EXISTS `un_code_mfg_sku_wh_map` (
  `id` int NOT NULL AUTO_INCREMENT,
  `mfg_id` int NOT NULL,
  `wh_id` int NOT NULL,
  `un_mfg_code` varchar(100) NOT NULL,
  `sku_id` int DEFAULT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `remarks` varchar(500) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `updated_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wh_code` (`wh_id`,`un_mfg_code`),
  UNIQUE KEY `uq_wh_mfg` (`wh_id`,`mfg_id`),
  KEY `idx_mfg` (`mfg_id`),
  KEY `idx_wh` (`wh_id`),
  KEY `idx_status` (`status`),
  KEY `fk_map_user_create` (`created_by`),
  KEY `fk_map_user_update` (`updated_by`),
  KEY `fk_map_sku` (`sku_id`),
  CONSTRAINT `fk_map_mfg` FOREIGN KEY (`mfg_id`) REFERENCES `master_mfgs` (`id`),
  CONSTRAINT `fk_map_sku` FOREIGN KEY (`sku_id`) REFERENCES `master_skus` (`id`),
  CONSTRAINT `fk_map_user_create` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_map_user_update` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_map_wh` FOREIGN KEY (`wh_id`) REFERENCES `details_warehouse_entity` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. REFERENCE DATA. Schema alone leaves the app running but empty — no
--    entities means no PO letterhead, no warehouses means no destinations.
--
--    Both schemas are on the same server, so this copies straight across and
--    KEEPS THE IDS, which the foreign keys above depend on.
--    Run in this order. Each is a no-op on re-run (INSERT IGNORE).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO mcaff_prefg_prod.master_entity
  SELECT * FROM mcaff_prefg_dev.master_entity;

INSERT IGNORE INTO mcaff_prefg_prod.master_brand
  SELECT * FROM mcaff_prefg_dev.master_brand;

INSERT IGNORE INTO mcaff_prefg_prod.entity_brand_map
  SELECT * FROM mcaff_prefg_dev.entity_brand_map;

INSERT IGNORE INTO mcaff_prefg_prod.master_warehouse
  SELECT * FROM mcaff_prefg_dev.master_warehouse;

INSERT IGNORE INTO mcaff_prefg_prod.details_warehouse_entity
  SELECT * FROM mcaff_prefg_dev.details_warehouse_entity;

-- bom_misc is NOT copied. Its 55 dev rows are Job Work / wastage COSTS, which
-- price real POs — dev values would quietly misprice prod. Enter them through
-- the Misc. Cost tab, or copy deliberately once someone has confirmed the
-- figures are the agreed ones:
--   INSERT IGNORE INTO mcaff_prefg_prod.bom_misc SELECT * FROM mcaff_prefg_dev.bom_misc;

-- nanonets_usage is NOT copied — it is a counter of API calls made, and dev's
-- count is not prod's.


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. VERIFY. Expect zero rows from the first query and matching counts below.
-- ─────────────────────────────────────────────────────────────────────────────

-- Any table still missing from prod? Expect an empty result.
SELECT d.TABLE_NAME AS still_missing
  FROM information_schema.TABLES d
  LEFT JOIN information_schema.TABLES p
    ON p.TABLE_SCHEMA = 'mcaff_prefg_prod' AND p.TABLE_NAME = d.TABLE_NAME
 WHERE d.TABLE_SCHEMA = 'mcaff_prefg_dev' AND p.TABLE_NAME IS NULL;

-- Any column still missing? Expect an empty result.
SELECT CONCAT(d.TABLE_NAME, '.', d.COLUMN_NAME) AS still_missing
  FROM information_schema.COLUMNS d
  JOIN information_schema.TABLES t
    ON t.TABLE_SCHEMA = 'mcaff_prefg_prod' AND t.TABLE_NAME = d.TABLE_NAME
  LEFT JOIN information_schema.COLUMNS p
    ON p.TABLE_SCHEMA = 'mcaff_prefg_prod' AND p.TABLE_NAME = d.TABLE_NAME
   AND p.COLUMN_NAME = d.COLUMN_NAME
 WHERE d.TABLE_SCHEMA = 'mcaff_prefg_dev' AND p.COLUMN_NAME IS NULL;

-- Any column not on the schema's standard collation? Expect only the four
-- known cost_master_pm_mfg columns, which predate this and are unused in joins.
SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'mcaff_prefg_prod'
   AND COLLATION_NAME IS NOT NULL
   AND COLLATION_NAME <> 'utf8mb4_0900_ai_ci';

-- Reference data landed? Expect 2 / 4 / 2 / 10 / 18.
SELECT
  (SELECT COUNT(*) FROM master_entity)            AS entities,
  (SELECT COUNT(*) FROM master_brand)             AS brands,
  (SELECT COUNT(*) FROM entity_brand_map)         AS brand_map,
  (SELECT COUNT(*) FROM master_warehouse)         AS warehouses,
  (SELECT COUNT(*) FROM details_warehouse_entity) AS warehouse_entities;
