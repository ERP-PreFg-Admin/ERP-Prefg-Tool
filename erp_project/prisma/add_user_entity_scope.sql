-- Per-user data scoping: which manufacturers / vendors / warehouses a user may
-- see. Page permissions answer "can you open this screen"; this answers "whose
-- data can you see on it".
--
-- SEMANTICS: the absence of rows for a (user_id, entity_type) pair means
-- UNRESTRICTED — that user sees every entity of that type, exactly as before
-- this table existed. Rows present = allow-list. That is why there is no "all"
-- marker row: an admin narrows access by adding rows and widens it by deleting
-- them. It also means existing users keep working the day this ships.
--
-- Warehouses are stored here by master_warehouse.id, but purchase_orders
-- .destination and supplier_invoices.destination are unindexed VARCHAR copies
-- of master_warehouse.name with no FK (the only join anywhere is
-- `ON wh.name = po.destination`). lib/scope.ts therefore resolves warehouse ids
-- to names once per request and all warehouse predicates compare names.
--
-- No FK on entity_id: it points at three different tables depending on
-- entity_type, so the constraint can't be expressed. Deleting a manufacturer
-- would leave a stale row here, which is harmless (it grants access to nothing).
--
-- Re-running is a harmless no-op. Run on BOTH schemas (test and prod).
-- Keep prisma/schema.prisma in sync.

CREATE TABLE IF NOT EXISTS user_entity_scope (
  user_id     INT NOT NULL,
  entity_type ENUM('mfg','vendor','warehouse') NOT NULL,
  entity_id   INT NOT NULL COMMENT 'master_mfgs.id | master_vendors.id | master_warehouse.id',
  created_at  DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  INT NULL COMMENT 'The admin who granted this',
  PRIMARY KEY (user_id, entity_type, entity_id),
  KEY idx_scope_user (user_id),
  CONSTRAINT fk_user_entity_scope_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
