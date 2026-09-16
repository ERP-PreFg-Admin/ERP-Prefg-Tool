-- master_rm.name: repair the 14 names holding a literal U+FFFD.
--
-- WHAT WAS WRONG
-- `Carbopol® Aqua SF-1 OS polymer` displayed as `Carbopol<?> Aqua SF-1 OS polymer`.
-- Nothing is wrong with the connection, the column or the rendering — the column
-- is utf8mb4_0900_ai_ci, the mysql2 connection negotiates utf8mb4, and the same
-- table holds 9 names whose ® / ™ are stored correctly (C2AE / E284A2). The 14
-- broken rows store bytes EF BF BD, which IS U+FFFD REPLACEMENT CHARACTER. The
-- damage is at rest, written that way.
--
-- HOW IT GOT THERE
-- Excel on Windows saves "CSV" as windows-1252 unless you pick "CSV UTF-8".
-- There ® is the single byte 0xAE and ™ is 0x99 — neither is valid UTF-8. The
-- bulk-upload path decoded those bytes as UTF-8 (`buffer.toString("utf-8")` in
-- lib/import-s3.ts, `readAsText` in CsvImportDialog, `file.text()` in the recipe
-- wizard), and a UTF-8 decoder substitutes U+FFFD for every invalid byte. The
-- rows uploaded as .xlsx, or as "CSV UTF-8", came through intact — which is why
-- the table has both kinds.
--
-- Fixed going forward by `decodeUpload` in lib/csv.ts (strict UTF-8, falling back
-- to windows-1252), used at all three byte-decoding points. Pinned by
-- tests/unit/csv.test.ts.
--
-- WHY THIS FILE IS A HAND-WRITTEN LIST AND NOT ONE REPLACE()
-- U+FFFD is LOSSY. Every invalid byte becomes the same character, so the stored
-- value cannot tell you whether it was ® (0xAE) or ™ (0x99) — and this table
-- demonstrably has both (Dow's CELLOSIZE™/XIAMETER™ vs BASF's Plantacare®).
-- A blanket `REPLACE(name, 0xEFBFBD, '®')` would silently mislabel the ™ ones.
-- So: one UPDATE per row, symbol taken from the supplier's own branding.
--
-- ⚠️ CONFIRM THE SYMBOL IN EACH LINE AGAINST THE SUPPLIER SPEC SHEET BEFORE
--    RUNNING. The ids are certain; the ® vs ™ is inference, not data.
--
-- RE-RUNNABLE: yes — the WHERE only matches a name that still holds U+FFFD.
-- Applies to mcaff_prefg_prod only; mcaff_prefg_dev has no affected rows.
--
-- APPLIED to mcaff_prefg_prod on 2026-09-16. All 14 rows updated; verified
-- `SELECT ... WHERE HEX(name) LIKE '%EFBFBD%'` returns 0 on master_rm and
-- master_pm. Byte-exact rollback for the pre-repair values was captured first.

-- Confirmed ® — the same brand already exists correctly elsewhere in master_rm
-- (id 91 `Plantacare® 2000 UP` stores C2AE).
UPDATE master_rm SET name = 'Plantacare® 818 UP'          WHERE id = 291  AND HEX(name) LIKE '%EFBFBD%';

-- Inferred ® — supplier registered marks.
UPDATE master_rm SET name = 'Spectrastat® G2 Natural MB'  WHERE id = 316  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'Fision® KeraVeg18'           WHERE id = 383  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'Geogard® ECT'                WHERE id = 387  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'Carbopol® Aqua SF-1 OS polymer' WHERE id = 572 AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'NOMCORT® HK-G'               WHERE id = 600  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'BeauPlex® VH'                WHERE id = 603  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'Cosroma® Retinol 50C-EC'     WHERE id = 802  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'BetaHydrate® (3% Solution)'  WHERE id = 844  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'FARMCARE® Heart leaf extract' WHERE id = 968 AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'AmviSense® S-DM-100'         WHERE id = 1009 AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'CeraSurge® Pro'              WHERE id = 1010 AND HEX(name) LIKE '%EFBFBD%';

-- Inferred ™ — the two whose suppliers mark these lines with ™, not ®. Dow's
-- other entries in this table (CELLOSIZE™, XIAMETER™, HydroxySHIELD™) all store
-- E284A2, which is the evidence for 882.
--
-- ⚠️ 882 IS A DUPLICATE, not just a damaged name. #169 RM-FOAM-DOW-0169 already
-- holds "FOAMYSENSE N60K Polymer" (same make, Dow, no symbol at all). Repairing
-- 882 leaves two rows for one material. Decide which one survives before or
-- after running this — the repair alone does not resolve it. Found by replaying
-- lib/masters/material-duplicates.ts over the live table; it was invisible
-- while the mojibake made the two names look different.
UPDATE master_rm SET name = 'FOAMYSENSE™ N60K Polymer'    WHERE id = 882  AND HEX(name) LIKE '%EFBFBD%';
UPDATE master_rm SET name = 'PhytoCellTec™ Malus Domestica' WHERE id = 814 AND HEX(name) LIKE '%EFBFBD%';

-- Verify: expect 0 rows on both tables.
--
--   SELECT id, rm_code, name FROM master_rm
--    WHERE HEX(name) LIKE '%EFBFBD%';
--   SELECT id, pm_code, name FROM master_pm
--    WHERE HEX(name) LIKE '%EFBFBD%';
--
-- master_pm had no damaged rows at the time of writing (its two non-ASCII names,
-- ids 278/279, both store ™ correctly) — the second query is there because the
-- same upload path feeds it.
