-- BOM recipe redesign: effective_from/effective_till are recipe-level
-- (master_bom header) only, never per RM/PM line. details_bom/history_bom
-- still carried these columns from before that convention was settled, but
-- new rows never populate them (see lib/queries/bom.ts) — drop them.
ALTER TABLE details_bom DROP COLUMN effective_from, DROP COLUMN effective_till;
ALTER TABLE history_bom DROP COLUMN effective_from, DROP COLUMN effective_till;
