-- WHAT: manufacturer plants (`details_mfg_unit`) and which plant makes which SKU
-- (`map_mfg_unit_sku`), seeded for NG Electro's MBA (Unit I) and MB2 (Unit II).
-- WHY: the PO "To" block (selectForEmail) must name the unit that makes the SKU;
-- unmapped SKUs fall back to details_mfg, so other manufacturers are unchanged.
-- NOT re-runnable: CREATE TABLE fails on a second run.

CREATE TABLE details_mfg_unit (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  mfg_id          INT NOT NULL,
  unit_code       VARCHAR(10) NOT NULL,
  registered_name VARCHAR(255) NULL,
  address         TEXT NULL,
  gst_number      VARCHAR(20) NULL,
  cin             VARCHAR(30) NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_on      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mfg_unit (mfg_id, unit_code),
  CONSTRAINT fk_mfg_unit_mfg FOREIGN KEY (mfg_id) REFERENCES master_mfgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE map_mfg_unit_sku (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  mfg_id     INT NOT NULL,
  sku_id     INT NOT NULL,
  unit_id    INT NOT NULL,
  created_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mfg_sku (mfg_id, sku_id),
  CONSTRAINT fk_mus_mfg  FOREIGN KEY (mfg_id)  REFERENCES master_mfgs(id),
  CONSTRAINT fk_mus_sku  FOREIGN KEY (sku_id)  REFERENCES master_skus(id),
  CONSTRAINT fk_mus_unit FOREIGN KEY (unit_id) REFERENCES details_mfg_unit(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Keyed on the code, not the id: master_mfgs ids diverge between dev and prod.
INSERT INTO details_mfg_unit (mfg_id, unit_code, registered_name, address, gst_number, cin)
SELECT id, 'MBA', 'N.G. Electro Products Pvt. Ltd.',
       'PLOT NO 51 & 52\nHIMUDA INDUSTRIAL AREA\nPHASE IV BHATOLIKALAN, TEH-BADDI\nDIST SOLAN BADDI - 173205\nHIMACHAL PRADESH, INDIA',
       '02AACCN5184H1ZM', 'U31401DL2006PTC151205'
FROM master_mfgs WHERE code = 'MFG-005-NGE';

INSERT INTO details_mfg_unit (mfg_id, unit_code, registered_name, address, gst_number, cin)
SELECT id, 'MB2', 'N. G. ELECTRO PRODUCTS PVT. LTD.',
       'PLOT NO. 36, HIMUDA INDUSTRIAL AREA, BHATOLIKALAN, BADDI\nSolan, Himachal Pradesh, 173205, India',
       '02AACCN5184H2ZL', NULL
FROM master_mfgs WHERE code = 'MFG-005-NGE';

-- Sheet as given, except: HYPMUBX033F040 → HYPMUBX033F040C002 (the master code), and
-- HYPMUBX018F050 dropped (no such SKU on either schema).
-- A real scratch table, dropped at the end: the app user lacks CREATE TEMPORARY TABLES.
CREATE TABLE _seed_mfg_unit_sku (sku_code VARCHAR(50) NOT NULL, unit_code VARCHAR(10) NOT NULL);

INSERT INTO _seed_mfg_unit_sku (sku_code, unit_code) VALUES
  ('Mcaf396_WB','MBA'), ('Mcaf408_WB','MBA'), ('HYPMUBX038F050','MBA'), ('Mcaf401','MBA'),
  ('MCaf370','MBA'), ('Mcaf397_WB','MBA'), ('MCaf383_WB_N1','MBA'), ('Mcaf406','MB2'),
  ('HYPMUBX004F050','MB2'), ('HYPMUBX0065F0050','MB2'), ('Mcaf409_WB','MBA'), ('MCaf371','MBA'),
  ('HYPMUBX004F030','MB2'), ('Mcaf404','MB2'), ('Mcaf407','MBA'), ('Mcaf398','MBA'),
  ('MCaf375','MB2'), ('MCaf385','MB2'), ('MCaf302','MB2'), ('MCFMUWB0401F0080','MBA'),
  ('MCaf402','MBA'), ('Mcaf405','MB2'), ('25Smcaf397_WB_N1','MBA'), ('MCaf220','MB2'),
  ('MCFMUBX0423F0275','MBA'), ('200MCaf401_WB','MBA'), ('HYPMUBX0054F0040','MB2'), ('DNDMUBX0002F0250','MBA'),
  ('DNDMUBX0001F0250','MBA'), ('HYPMUBX043F050','MB2'), ('MCFMUBX0422F0250','MBA'), ('MCaf145_N','MB2'),
  ('HYPMUBX035F050','MB2'), ('HYPMUBX033F040C002','MB2'), ('MCFMUWB0402F0080','MBA'),
  ('HYPMUWB0004F0015','MB2'), ('MCFMUBX0421F0250','MBA'), ('MCFMUBX0424F0275','MBA'), ('MCFMUWB0405F0015','MB2'),
  ('MCFMUWB0404F0025','MB2'), ('MCFMUWB0406F0020','MB2'), ('HYPMUBX0047F0050','MB2'), ('HYPMUBX0048F0050','MB2'),
  ('HYPMUBX0049F0050','MB2'), ('HYPMUBX0050F0050','MB2'), ('HYPMUBX0051F0050','MB2'), ('HYPMUBX0052F0050','MB2'),
  ('HYPMUBX0058F0050','MB2'), ('HYPMUBX0059F0050','MB2'), ('HYPMUBX0060F0050','MB2'), ('HYPMUBX0061F0050','MB2'),
  ('HYPMUBX0062F0050','MB2'), ('HYPMUBX0063F0050','MB2');

-- Case-insensitive via the column collation (the sheet mixes MCaf / Mcaf).
INSERT INTO map_mfg_unit_sku (mfg_id, sku_id, unit_id)
SELECT u.mfg_id, sk.id, u.id
FROM _seed_mfg_unit_sku s
JOIN master_skus sk ON TRIM(sk.sku_code) = TRIM(s.sku_code)
JOIN details_mfg_unit u ON u.unit_code = s.unit_code
JOIN master_mfgs m ON m.id = u.mfg_id AND m.code = 'MFG-005-NGE';

-- Review: every sheet code that matched no master_skus row (expected: none).
SELECT s.sku_code, s.unit_code AS unmatched_sheet_row
FROM _seed_mfg_unit_sku s
LEFT JOIN master_skus sk ON TRIM(sk.sku_code) = TRIM(s.sku_code)
WHERE sk.id IS NULL;

DROP TABLE _seed_mfg_unit_sku;
