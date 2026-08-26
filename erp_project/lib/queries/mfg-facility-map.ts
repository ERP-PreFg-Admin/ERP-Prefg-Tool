/**
 * MFG × Facility × SKU mapping queries — table `un_code_mfg_sku_wh_map`.
 *
 * In Unicommerce a manufacturer is a VENDOR, and a vendor's item catalog is scoped
 * to a FACILITY. This table is that catalog, mirrored locally.
 *
 * ── The grain, which is not what the table name suggests ─────────────────────
 * ONE ROW PER (wh_id, mfg_id, sku_id), enforced by `uq_wh_mfg_sku`. Two special
 * things follow:
 *
 *   1. `sku_id IS NULL` is the VENDOR-CODE row: "this manufacturer is a Uniware
 *      vendor at this facility, under code X, with no SKUs mapped yet." Its
 *      existence is what separates a grey matrix cell (not a vendor here — nothing
 *      can be mapped and no PO can carry a vendorCode) from a pink one (vendor
 *      here, nothing mapped). Every count below must therefore exclude it, or
 *      every configured cell reads one SKU too high.
 *
 *   2. `un_mfg_code` REPEATS across a pair's rows. Denormalised on purpose: it is
 *      exactly the shape of a Vendor Item Master export row (vendorCode, facility,
 *      itemTypeSku on one line), so ingest is an upsert with no reshaping. Read it
 *      with MAX() — any row for the pair carries the same value.
 *
 * `wh_id` is **details_warehouse_entity.id — a FACILITY** (location × legal
 * entity), NOT master_warehouse.id. 18 active facilities over ~10 locations, which
 * is the matrix's column count. Gurgaon appears twice: GGN_WAREHOUSE under Pep and
 * HYP_B2B_GGN under Kreative, with different vendor codes.
 *
 * ── The guard that moved into application code ───────────────────────────────
 * `uq_wh_code (wh_id, un_mfg_code)` used to be UNIQUE and had to be dropped for
 * the re-grain (see prisma/alter_un_code_mfg_sku_wh_map.sql). It was the only
 * thing stopping two manufacturers from claiming the same Uniware vendor code at
 * one facility — which would silently inward one against the other's ledger.
 * `selectVendorCodeConflict` is now that check, and tests/db/mfg-facility-map
 * .test.ts pins it. Deleting either brings the hazard back unguarded.
 *
 * ponytail: duplicate `sku_id IS NULL` rows for one pair are deduped in the route,
 * not by the index — MySQL unique keys treat NULLs as distinct, so uq_wh_mfg_sku
 * does not constrain them. A generated sentinel column would, if this ever drifts.
 */

/**
 * Every (manufacturer, SKU) pair this screen knows about, from EITHER source.
 *
 * ── Why a union, and not just the recipe lines ────────────────────────────────
 * `master_recipe_mfg` reaches a SKU through a recipe, and there are 5 recipes for
 * 304 SKUs — so on today's data almost nothing has one. If the matrix's
 * denominator came only from there, every SKU imported from Unicommerce would
 * land outside it, be counted as an `orphan_skus` reconciliation oddity, and the
 * cell would stay grey no matter how much real data was mapped.
 *
 * So a SKU counts as this manufacturer's if EITHER
 *   (a) it has a live master_recipe_mfg line — the costing-side relation, or
 *   (b) it is actively mapped at some facility — the Unicommerce-side relation.
 *
 * A union rather than a replacement: (a) keeps working, and as recipes are
 * created the two converge instead of one superseding the other. `has_recipe` /
 * `has_mapping` come back so callers can tell which source a SKU came from
 * without asking again.
 *
 * (a) uses 'active' + 'discontinued', matching selectLiveLinesByMfg — a
 * discontinued line can still consume existing stock and still be raised against;
 * only 'inactive' is out.
 *
 * Both branches are brand-scoped. Scoping only one would let an out-of-brand SKU
 * in through the other and leak a count across the boundary.
 * Params: [brandScope×2 (recipes), brandScope×2 (mappings)]
 */
const LIVE_SKUS_CTE = `
  WITH live_skus AS (
    SELECT mfg_id, sku_id, MAX(has_recipe) AS has_recipe, MAX(has_mapping) AS has_mapping
    FROM (
      SELECT l.mfg_id, b.sku_id, 1 AS has_recipe, 0 AS has_mapping
      FROM master_recipe_mfg l
      INNER JOIN master_recipe b  ON b.id  = l.recipe_id AND b.sku_id IS NOT NULL
      INNER JOIN master_skus   sk ON sk.id = b.sku_id
      WHERE l.status IN ('active', 'discontinued')
        AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
      UNION ALL
      SELECT map.mfg_id, map.sku_id, 0 AS has_recipe, 1 AS has_mapping
      FROM un_code_mfg_sku_wh_map map
      INNER JOIN master_skus sk ON sk.id = map.sku_id
      INNER JOIN details_warehouse_entity dwe ON dwe.id = map.wh_id AND dwe.status = 'active'
      WHERE map.status = 'active' AND map.sku_id IS NOT NULL
        AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
    ) u
    GROUP BY mfg_id, sku_id
  )
`

export const mfgFacilityMap = {
  // ============ SELECT QUERIES ============

  /**
   * The whole matrix in one round trip — every active manufacturer × every active
   * facility, ~10 × 18 = ~180 rows, so no pagination.
   *
   * CROSS JOIN on purpose: a pair with no rows at all still has to appear, because
   * "this manufacturer is not set up at this facility" is exactly what the screen
   * exists to surface. Same reasoning as the (location × entity) cross-product in
   * app/masters/warehouses/WarehousesClient.tsx.
   *
   * `mapped_skus` is INTERSECTED with the live line set rather than counted raw.
   * A SKU mapped at a facility whose master_recipe_mfg line was later set inactive
   * would otherwise push mapped_skus above total_skus and paint the cell greener
   * than reality. Its complement is `orphan_skus` — mapped or Uniware-reported but
   * no longer a live line — which is a reconciliation number, not an error.
   *
   * Brand scope is applied INSIDE BOTH derived tables. Applying it only to the
   * total would let out-of-brand mapped rows fall into orphan_skus, leaking a count
   * across the brand boundary.
   *
   * The live-SKU set is a CTE referenced twice — once for the denominator, once to
   * decide whether a mapped row still counts. A derived table would have to be
   * written (and parameterised) twice; MySQL 8 CTEs let it be stated once.
   *
   * Needs query(), not execute() — the IN (?) array expansions.
   * Params: [brandScope×2 (recipes), brandScope×2 (mappings), mfgScope×2, whScope×2]
   */
  matrix: `
    ${LIVE_SKUS_CTE}
    SELECT
      m.id   AS mfg_id,
      m.code AS mfg_code,
      m.name AS mfg_name,
      dwe.id AS wh_id,
      w.name AS wh_name,
      w.code AS wh_code,
      w.location,
      e.code AS entity_code,
      dwe.facility_code,
      COALESCE(dwe.type, w.type) AS wh_type,
      x.un_mfg_code,
      COALESCE(t.total_skus, 0)     AS total_skus,
      COALESCE(x.mapped_skus, 0)    AS mapped_skus,
      COALESCE(x.confirmed_skus, 0) AS confirmed_skus,
      COALESCE(x.unpushed_skus, 0)  AS unpushed_skus,
      COALESCE(x.orphan_skus, 0)    AS orphan_skus,
      x.last_seen_at
    FROM master_mfgs m
    INNER JOIN details_mfg dm ON dm.mfg_id = m.id
    CROSS JOIN details_warehouse_entity dwe
    INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
    INNER JOIN master_entity   e ON e.id = dwe.entity_id
    LEFT JOIN (
      SELECT mfg_id, COUNT(*) AS total_skus FROM live_skus GROUP BY mfg_id
    ) t ON t.mfg_id = m.id
    LEFT JOIN (
      SELECT
        map.mfg_id,
        map.wh_id,
        -- Every row for the pair carries the same code; MAX() just picks it.
        -- Non-null here is the cell's existence test — see cellState().
        MAX(map.un_mfg_code) AS un_mfg_code,
        COUNT(CASE WHEN map.sku_id IS NOT NULL AND ln.sku_id IS NOT NULL THEN 1 END) AS mapped_skus,
        COUNT(CASE WHEN map.sku_id IS NOT NULL AND ln.sku_id IS NOT NULL
                    AND map.un_seen_at IS NOT NULL THEN 1 END) AS confirmed_skus,
        -- Mapped here but Uniware has neither acknowledged our push nor reported
        -- it in an export. Drives the warning overlay and the Retry button.
        COUNT(CASE WHEN map.sku_id IS NOT NULL AND ln.sku_id IS NOT NULL
                    AND map.un_pushed_at IS NULL AND map.un_seen_at IS NULL THEN 1 END) AS unpushed_skus,
        COUNT(CASE WHEN map.sku_id IS NOT NULL AND ln.sku_id IS NULL THEN 1 END) AS orphan_skus,
        MAX(map.un_seen_at) AS last_seen_at
      FROM un_code_mfg_sku_wh_map map
      LEFT JOIN live_skus ln
             ON ln.mfg_id = map.mfg_id AND ln.sku_id = map.sku_id
      WHERE map.status = 'active'
      GROUP BY map.mfg_id, map.wh_id
    ) x ON x.mfg_id = m.id AND x.wh_id = dwe.id
    WHERE dm.status = 'active'
      AND dwe.status = 'active'
      AND (? IS NULL OR m.id IN (?))
      AND (? IS NULL OR w.name IN (?))
    ORDER BY m.name ASC, COALESCE(dwe.type, w.type) DESC, w.name ASC, e.code ASC
  `,

  /**
   * Every SKU on this manufacturer, flagged with whether it is mapped at ONE
   * facility. Feeds the drilldown panel's checkbox list.
   *
   * LEFT JOIN, so UNMAPPED SKUs come back too — they are the ones you tick, and a
   * list of only the already-mapped ones would make the panel useless for its main
   * job. `map_id IS NULL OR map_status <> 'active'` means unmapped.
   *
   * The join carries `sku_id IS NOT NULL` so the pair's vendor-code row can never
   * attach itself to a SKU row.
   * Params: [wh_id, mfg_id, brandScope×2]
   */
  cellSkus: `
    ${LIVE_SKUS_CTE}
    SELECT
      sk.id        AS sku_id,
      sk.sku_code,
      sk.name      AS sku_name,
      sk.brand_id,
      ls.has_recipe,
      ls.has_mapping,
      map.id       AS map_id,
      map.status   AS map_status,
      map.un_pushed_at,
      map.un_push_error,
      map.un_seen_at
    FROM live_skus ls
    INNER JOIN master_skus sk ON sk.id = ls.sku_id
    LEFT  JOIN un_code_mfg_sku_wh_map map
           ON map.mfg_id = ls.mfg_id
          AND map.sku_id = sk.id
          AND map.wh_id  = ?
    WHERE ls.mfg_id = ?
    ORDER BY sk.sku_code ASC
  `,

  /**
   * Every manufacturer's live SKU lines, for the whole matrix at once.
   *
   * Shipped with the page rather than fetched per cell, for two reasons: the
   * search box filters rows by SKU code and name, so this text has to be on the
   * client regardless; and once it is there the drilldown panel needs no fetch and
   * no loading state.
   *
   * Reads the same union as the matrix, so the panel offers every SKU the cell's
   * denominator counted — a SKU that arrived from a Unicommerce import is tickable
   * even though it has no recipe.
   * Params: [brandScope×2 (recipes), brandScope×2 (mappings), mfgScope×2]
   */
  allLiveLines: `
    ${LIVE_SKUS_CTE}
    SELECT
      ls.mfg_id, sk.id AS sku_id, sk.sku_code, sk.name AS sku_name,
      sk.brand_id, ls.has_recipe, ls.has_mapping
    FROM live_skus ls
    INNER JOIN master_skus sk ON sk.id = ls.sku_id
    WHERE (? IS NULL OR ls.mfg_id IN (?))
    ORDER BY sk.sku_code ASC
  `,

  /**
   * Every active SKU mapping, for the whole matrix at once. Pairs with
   * allLiveLines so the panel can be rendered entirely from page data.
   *
   * `sku_id IS NOT NULL` excludes the vendor-code rows — those are already
   * summarised as `un_mfg_code` on the matrix row.
   * Params: [mfgScope×2]
   */
  allMappings: `
    SELECT map.mfg_id, map.wh_id, map.sku_id, map.un_pushed_at, map.un_push_error, map.un_seen_at
    FROM un_code_mfg_sku_wh_map map
    INNER JOIN details_warehouse_entity dwe ON dwe.id = map.wh_id AND dwe.status = 'active'
    WHERE map.status = 'active' AND map.sku_id IS NOT NULL
      AND (? IS NULL OR map.mfg_id IN (?))
  `,

  /**
   * This pair's Uniware vendor code, or nothing. Read before mapping SKUs, because
   * `un_mfg_code` is NOT NULL on every row — there is no way to write a SKU row
   * without knowing it.
   * Params: [wh_id, mfg_id]
   */
  selectVendorCode: `
    SELECT MAX(un_mfg_code) AS un_mfg_code, COUNT(*) AS row_count
    FROM un_code_mfg_sku_wh_map
    WHERE wh_id = ? AND mfg_id = ? AND status = 'active'
  `,

  /**
   * Is this vendor code already ANOTHER manufacturer's at this facility?
   *
   * ⚠️ This is the replacement for the dropped `uq_wh_code` UNIQUE key, and the
   * only thing now standing between two manufacturers sharing a Uniware vendor
   * code at one facility — which would inward one against the other's ledger. It
   * must run before every vendor-code write.
   * Params: [wh_id, un_mfg_code, mfg_id]
   */
  selectVendorCodeConflict: `
    SELECT u.mfg_id, m.code AS mfg_code, m.name AS mfg_name
    FROM un_code_mfg_sku_wh_map u
    INNER JOIN master_mfgs m ON m.id = u.mfg_id
    WHERE u.wh_id = ? AND u.un_mfg_code = ? AND u.mfg_id <> ? AND u.status = 'active'
    LIMIT 1
  `,

  /**
   * A facility's id → its warehouse NAME, for the scope check.
   *
   * Required because wh_id arrives from the client as a guessable integer, while
   * lib/scope.ts's warehouse dimension is names (purchase_orders.destination stores
   * the name). Without this a warehouse-scoped user can map into any facility by
   * id.
   * Params: [wh_id]
   */
  selectFacilityById: `
    SELECT dwe.id, dwe.facility_code, w.name AS wh_name, e.code AS entity_code
    FROM details_warehouse_entity dwe
    INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
    INNER JOIN master_entity   e ON e.id = dwe.entity_id
    WHERE dwe.id = ? LIMIT 1
  `,
    /**
   * One facility's PO-code config, with the columns a scope check needs.
   *
   * `wh_name` is not decoration: facility ids arrive from the client as small
   * consecutive integers, and lib/scope.ts's warehouse dimension is NAMES
   * (purchase_orders.destination stores the name), so the id must be resolved to
   * a name before it can be checked at all. Same reason
   * mfgFacilityMap.selectFacilityById returns it.
   *
   * Params: [facility_id]
   */
  selectPoConfigById: `
    SELECT dwe.id, dwe.facility_code, dwe.po_short_code, dwe.po_seq_seed,
           w.name AS wh_name, e.code AS entity_code
      FROM details_warehouse_entity dwe
      INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
      INNER JOIN master_entity    e ON e.id = dwe.entity_id
     WHERE dwe.id = ? LIMIT 1
  `,

  /**
   * Every active facility's PO-code config, for the review screen.
   *
   * Unpaginated on purpose — 18 rows, the same call the mfg-overview matrix makes
   * over the same table. Ordered entity-then-location so the two rows of one site
   * sit in predictable places.
   */
  selectPoConfigs: `
    SELECT dwe.id, dwe.facility_code, dwe.po_short_code, dwe.po_seq_seed,
           w.name AS wh_name, w.location, e.code AS entity_code
      FROM details_warehouse_entity dwe
      INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
      INNER JOIN master_entity    e ON e.id = dwe.entity_id
     WHERE dwe.status = 'active'
     ORDER BY e.code, w.name
  `,

  /**
   * Set or clear one facility's PO-code config.
   *
   * Both values may be NULL — clearing po_short_code returns that facility to
   * today's behaviour (no code sent, Uniware numbers the PO), which is the
   * documented way to back a pilot out.
   *
   * Params: [po_short_code, po_seq_seed, facility_id]
   */
  updatePoConfig: `
    UPDATE details_warehouse_entity
       SET po_short_code = ?, po_seq_seed = ?
     WHERE id = ?
  `,

  /** sku_code → id, for the UI write and the catalog sync. Codes that resolve to
   *  nothing simply do not come back, and the caller reports them. `brand_id` comes
   *  along so a bulk sync can drop out-of-brand SKUs without a second round trip.
   *  Needs query() — IN (?) array expansion. Params: [skuCodes] */
  skuIdsByCodes: `
    SELECT id, sku_code, brand_id FROM master_skus WHERE sku_code IN (?)
  `,

  /**
   * Every active (facility, Uniware vendor code) → manufacturer, for resolving a
   * sync's rows.
   *
   * This is the table doing the job the export script's MANUAL_ALIASES dict and
   * difflib matcher were doing by hand: after one approved seed, matching is an
   * exact string compare on a pair that was confirmed by a human once.
   *
   * Includes the warehouse NAME so the caller can apply warehouse scope without
   * another query — the scope dimension is names, not ids.
   * Params: none
   */
  vendorCodeIndex: `
    SELECT DISTINCT
      u.wh_id, u.un_mfg_code, u.mfg_id,
      dwe.facility_code, w.name AS wh_name
    FROM un_code_mfg_sku_wh_map u
    INNER JOIN details_warehouse_entity dwe ON dwe.id = u.wh_id AND dwe.status = 'active'
    INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
    WHERE u.status = 'active' AND dwe.facility_code IS NOT NULL
  `,

  /**
   * Record what a Vendor Item Master export contained.
   *
   * Sets `un_seen_at` and leaves `mapped_at` alone: Unicommerce reporting a row is
   * a CONFIRMATION, not somebody here intending it. A row that arrives only this
   * way still counts as mapped (the matrix counts active rows), and correctly does
   * NOT ask to be pushed — Uniware already has it.
   *
   * `status` is forced active on insert but NOT on update, so a SKU somebody
   * deliberately unmapped stays unmapped even though Uniware still lists it. That
   * discrepancy is the report, not a bug to overwrite.
   * Params per row: (mfg_id, wh_id, sku_id, un_mfg_code, seenAt, userId, userId)
   */
  buildRecordSeen(count: number): string {
    const group = "(?, ?, ?, ?, 'active', ?, ?, ?)"
    return `
      INSERT INTO un_code_mfg_sku_wh_map
        (mfg_id, wh_id, sku_id, un_mfg_code, status, un_seen_at, created_by, updated_by)
      VALUES ${Array(count).fill(group).join(", ")}
      ON DUPLICATE KEY UPDATE
        un_mfg_code = VALUES(un_mfg_code),
        un_seen_at  = VALUES(un_seen_at),
        updated_by  = VALUES(updated_by)
    `
  },

  /**
   * Every facility's active vendor codes.
   *
   * This is what lets the external export script delete WANTED_VENDORS,
   * MANUAL_ALIASES and its difflib fuzzy matcher: it can dump every vendor's rows
   * and match on an exact (facility_code, un_mfg_code) pair instead of guessing at
   * KAPCO_INTERNATIONAL_ vs KAPCO_INTERNATIONAL.
   * Params: none
   */
  vendorCodesForExport: `
    SELECT DISTINCT dwe.facility_code, u.un_mfg_code, m.id AS mfg_id, m.code AS mfg_code
    FROM un_code_mfg_sku_wh_map u
    INNER JOIN details_warehouse_entity dwe ON dwe.id = u.wh_id AND dwe.status = 'active'
    INNER JOIN master_mfgs m ON m.id = u.mfg_id
    WHERE u.status = 'active' AND dwe.facility_code IS NOT NULL
    ORDER BY dwe.facility_code, u.un_mfg_code
  `,

  // ============ WRITE QUERIES ============

  /**
   * Upsert N SKU mappings for one (mfg, facility).
   *
   * Multi-row VALUES built to a fixed placeholder count so it can go through
   * execute() as a prepared statement — same approach as
   * purchaseOrdersSql.buildSetUniwarePoCode. Do NOT pass this to query().
   *
   * ON DUPLICATE KEY is unambiguous: uq_wh_mfg_sku is the table's only unique key
   * besides the PK. (Contrast the pre-migration shape, which had two — a blind
   * upsert there updated the wrong row.)
   *
   * ⚠️ The caller MUST filter to SKUs not already mapped (selectMappedSkuIds).
   * `un_pushed_at` and `un_push_error` are reset to NULL on a duplicate key, so
   * re-sending an already-synced SKU would blank Uniware's confirmation and make a
   * row it already has look like it still needs pushing. On a genuinely new row
   * that reset is correct; on an existing one it is data loss.
   *
   * `status` is forced back to 'active' so a historically-inactive row revives
   * rather than being skipped. `un_seen_at` is deliberately absent from the update
   * list: Uniware's observation is not the user's to overwrite.
   *
   * Params per row: (mfg_id, wh_id, sku_id, un_mfg_code, userId, userId)
   */
  buildUpsertMappings(count: number): string {
    const group = "(?, ?, ?, ?, 'active', ?, ?)"
    return `
      INSERT INTO un_code_mfg_sku_wh_map
        (mfg_id, wh_id, sku_id, un_mfg_code, status, created_by, updated_by)
      VALUES ${Array(count).fill(group).join(", ")}
      ON DUPLICATE KEY UPDATE
        un_mfg_code   = VALUES(un_mfg_code),
        status        = 'active',
        un_pushed_at  = NULL,
        un_push_error = NULL,
        updated_by    = VALUES(updated_by)
    `
  },

  /**
   * Rows that still need pushing to Uniware for one (mfg, facility), with
   * everything the call needs joined in.
   *
   * "Needs pushing" is `un_pushed_at IS NULL` — our own push has not succeeded.
   * `un_seen_at` is deliberately NOT part of the test: a row an export confirmed
   * exists in Uniware already, so pushing it again would be a no-op at best.
   * Hence the `un_seen_at IS NULL` clause — only rows Uniware has never
   * acknowledged, by either route, are candidates.
   *
   * Params: [mfg_id, wh_id]
   */
  selectPushTargets: `
    SELECT
      map.id, map.sku_id, map.un_mfg_code, map.un_push_error,
      sk.sku_code,
      dwe.facility_code,
      m.code AS mfg_code
    FROM un_code_mfg_sku_wh_map map
    INNER JOIN master_skus sk ON sk.id = map.sku_id
    INNER JOIN details_warehouse_entity dwe ON dwe.id = map.wh_id
    INNER JOIN master_mfgs m ON m.id = map.mfg_id
    WHERE map.mfg_id = ? AND map.wh_id = ?
      AND map.sku_id IS NOT NULL
      AND map.status = 'active'
      AND map.un_pushed_at IS NULL
      AND map.un_seen_at IS NULL
    ORDER BY sk.sku_code
  `,

  /** Params: [id] */
  markPushed: `
    UPDATE un_code_mfg_sku_wh_map
    SET un_pushed_at = NOW(), un_push_error = NULL
    WHERE id = ?
  `,

  /** Stores WHY, so the panel can show it next to Retry instead of a bare failure
   *  count. Truncated to the column width by the caller.
   *  Params: [error, id] */
  markPushFailed: `
    UPDATE un_code_mfg_sku_wh_map
    SET un_push_error = ?
    WHERE id = ?
  `,

  /**
   * The SKUs already mapped for one (mfg, facility).
   *
   * Read before every write so the mapping stays APPEND-ONLY — see the note on
   * buildUpsertMappings. There is deliberately no unmap query in this file:
   * Unicommerce cannot un-map a vendor item, so retracting one here would leave the
   * two systems disagreeing with nothing to reveal it but the next export.
   *
   * Params: [mfg_id, wh_id]
   */
  selectMappedSkuIds: `
    SELECT sku_id FROM un_code_mfg_sku_wh_map
    WHERE mfg_id = ? AND wh_id = ? AND sku_id IS NOT NULL AND status = 'active'
  `,

  /**
   * Set this (facility, mfg) pair's Uniware vendor code.
   *
   * Writes the `sku_id IS NULL` row, and rewrites the code on the pair's existing
   * SKU rows so the denormalised copies cannot drift — the matrix reads it with
   * MAX(), which would otherwise return whichever value happened to sort highest.
   *
   * ⚠️ Call selectVendorCodeConflict FIRST. See its comment.
   * Params: [mfg_id, wh_id, un_mfg_code, remarks, userId, userId]
   */
  insertVendorCodeRow: `
    INSERT INTO un_code_mfg_sku_wh_map
      (mfg_id, wh_id, sku_id, un_mfg_code, status, remarks, created_by, updated_by)
    VALUES (?, ?, NULL, ?, 'active', ?, ?, ?)
  `,

  /** Params: [un_mfg_code, remarks, userId, mfg_id, wh_id] */
  updateVendorCodeRow: `
    UPDATE un_code_mfg_sku_wh_map
    SET un_mfg_code = ?, remarks = ?, status = 'active', updated_by = ?
    WHERE mfg_id = ? AND wh_id = ? AND sku_id IS NULL
  `,

  /** Keep the denormalised copies in step. Params: [un_mfg_code, userId, mfg_id, wh_id] */
  syncVendorCodeOnSkuRows: `
    UPDATE un_code_mfg_sku_wh_map
    SET un_mfg_code = ?, updated_by = ?
    WHERE mfg_id = ? AND wh_id = ? AND sku_id IS NOT NULL
  `,

  /** Does the pair already have a vendor-code row? Decides insert vs update, and
   *  is the dedupe the NULL-tolerant unique key cannot do.
   *  Params: [mfg_id, wh_id] */
  selectVendorCodeRow: `
    SELECT id, un_mfg_code, status FROM un_code_mfg_sku_wh_map
    WHERE mfg_id = ? AND wh_id = ? AND sku_id IS NULL
    ORDER BY id ASC LIMIT 1
  `,
}
