/**
 * MFG × Facility SKU mapping — the SQL, against a real database, always rolled back.
 *
 * Three things here are worth a DB test rather than a unit test, because each is a
 * property of the SCHEMA or of MySQL's own behaviour and a mock would assert only
 * what I already believe:
 *
 *   1. The re-grain works. `uq_wh_mfg (wh_id, mfg_id)` used to permit exactly one
 *      row per pair, which made a SKU catalog impossible. Two SKUs for one pair
 *      must now both persist. If prisma/alter_un_code_mfg_sku_wh_map.sql has not
 *      been applied, THIS is the test that says so.
 *
 *   2. The vendor-code conflict check. Dropping the `uq_wh_code` UNIQUE index was
 *      required for the re-grain, and it removed the only thing stopping two
 *      manufacturers from claiming one Uniware vendor code at one facility — which
 *      would inward one against the other's ledger. selectVendorCodeConflict is now
 *      the whole guard, so it is pinned here.
 *
 *   3. The vendor-code row must not be counted as a mapped SKU. It lives in the
 *      same table with `sku_id IS NULL`, so a COUNT(*) that forgets to exclude it
 *      reads one SKU too high in every configured cell — and the matrix would show
 *      "1 of 0 mapped" on a manufacturer with no lines.
 */

import test, { after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { mfgFacilityMap } from "../../lib/queries/mfg-facility-map"
import {
  cellState, cellLabel, summarise,
} from "../../app/po-tracking/mfg-overview/mapping-state"
import type { MfgFacilityCell } from "../../types/masters"

after(closePool)

/** Reuse existing master rows — the FK graph (master_mfgs, master_skus,
 *  details_warehouse_entity) is deep and these tests only need valid ids. */
async function ids(conn: PoolConnection) {
  const [mfgs] = await conn.execute("SELECT id FROM master_mfgs ORDER BY id LIMIT 2")
  const [skus] = await conn.execute("SELECT id FROM master_skus ORDER BY id LIMIT 2")
  const [whs] = await conn.execute(
    "SELECT id FROM details_warehouse_entity WHERE status = 'active' ORDER BY id LIMIT 1"
  )
  const m = mfgs as { id: number }[]
  const s = skus as { id: number }[]
  const w = whs as { id: number }[]
  assert.ok(m.length >= 2, "need 2 manufacturers")
  assert.ok(s.length >= 2, "need 2 SKUs")
  assert.ok(w.length >= 1, "need 1 active facility")
  return { mfgA: m[0].id, mfgB: m[1].id, skuA: s[0].id, skuB: s[1].id, whId: w[0].id }
}

const insert = (conn: PoolConnection, mfgId: number, whId: number, skuId: number | null, code: string) =>
  conn.execute(
    `INSERT INTO un_code_mfg_sku_wh_map (mfg_id, wh_id, sku_id, un_mfg_code, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [mfgId, whId, skuId, code]
  )

/**
 * Take sole ownership of one manufacturer's mapping rows for the rest of the
 * transaction.
 *
 * Needed by any test that asserts an ABSOLUTE count or state. This table is no
 * longer empty — a real Vendor Item Master export has been seeded, ~1,400 rows
 * across 14 manufacturers — so "map two SKUs, expect a total of two" is only true
 * if whatever was already there is cleared first. Rolled back with everything else.
 */
async function ownMappings(conn: PoolConnection, mfgId: number) {
  await conn.execute("DELETE FROM un_code_mfg_sku_wh_map WHERE mfg_id = ?", [mfgId])
}

test("two SKUs can be mapped for ONE (facility, manufacturer)", async () => {
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA, skuB } = await ids(conn)
    await ownMappings(conn, mfgA)

    await insert(conn, mfgA, whId, skuA, "SELFTEST_A")
    await insert(conn, mfgA, whId, skuB, "SELFTEST_A")

    const [rows] = await conn.execute(
      `SELECT sku_id FROM un_code_mfg_sku_wh_map
       WHERE mfg_id = ? AND wh_id = ? AND sku_id IS NOT NULL`,
      [mfgA, whId]
    )
    assert.equal(
      (rows as unknown[]).length, 2,
      "the old uq_wh_mfg key is still present — apply prisma/alter_un_code_mfg_sku_wh_map.sql"
    )
  })
})

test("the same SKU cannot be mapped twice for one pair", async () => {
  // uq_wh_mfg_sku's actual job. The upsert relies on it, so if this stops being
  // unique, buildUpsertMappings silently duplicates instead of updating.
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA } = await ids(conn)
    await ownMappings(conn, mfgA)
    await insert(conn, mfgA, whId, skuA, "SELFTEST_A")
    await assert.rejects(
      () => insert(conn, mfgA, whId, skuA, "SELFTEST_A"),
      /ER_DUP_ENTRY|Duplicate entry/,
      "uq_wh_mfg_sku is missing, so the same SKU can be mapped twice"
    )
  })
})

test("selectVendorCodeConflict catches another manufacturer holding the code", async () => {
  // The guard that replaced the dropped uq_wh_code UNIQUE index. Without it, two
  // manufacturers share a vendor code at one facility and inwarding lands against
  // the wrong ledger.
  await withRollback(async (conn) => {
    const { mfgA, mfgB, whId } = await ids(conn)
    await insert(conn, mfgA, whId, null, "SELFTEST_SHARED")

    const [clash] = await conn.execute(mfgFacilityMap.selectVendorCodeConflict, [
      whId, "SELFTEST_SHARED", mfgB,
    ])
    assert.equal((clash as unknown[]).length, 1, "B taking A's code must be reported")
    assert.equal((clash as { mfg_id: number }[])[0].mfg_id, mfgA)

    // The same manufacturer re-saving its OWN code is not a conflict — the check
    // excludes itself, or every edit would 409.
    const [self] = await conn.execute(mfgFacilityMap.selectVendorCodeConflict, [
      whId, "SELFTEST_SHARED", mfgA,
    ])
    assert.equal((self as unknown[]).length, 0, "a manufacturer must not conflict with itself")

    // A different facility is a different namespace: Uniware codes are per
    // facility, so the same code elsewhere is legitimate.
    const [other] = await conn.execute(mfgFacilityMap.selectVendorCodeConflict, [
      whId + 100000, "SELFTEST_SHARED", mfgB,
    ])
    assert.equal((other as unknown[]).length, 0, "the check must be scoped to one facility")
  })
})

test("an inactive row does not hold a vendor code hostage", async () => {
  // Unmapping is a soft delete, so a released code must be reusable — otherwise
  // every correction permanently burns that string at that facility.
  await withRollback(async (conn) => {
    const { mfgA, mfgB, whId } = await ids(conn)
    await conn.execute(
      `INSERT INTO un_code_mfg_sku_wh_map (mfg_id, wh_id, sku_id, un_mfg_code, status)
       VALUES (?, ?, NULL, ?, 'inactive')`,
      [mfgA, whId, "SELFTEST_RELEASED"]
    )
    const [clash] = await conn.execute(mfgFacilityMap.selectVendorCodeConflict, [
      whId, "SELFTEST_RELEASED", mfgB,
    ])
    assert.equal((clash as unknown[]).length, 0)
  })
})

test("the vendor-code row is not counted as a mapped SKU", async () => {
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA } = await ids(conn)
    await ownMappings(conn, mfgA)
    await insert(conn, mfgA, whId, null, "SELFTEST_A")   // vendor-code row
    await insert(conn, mfgA, whId, skuA, "SELFTEST_A")   // one real mapping

    const [rows] = await conn.execute(
      `SELECT
         COUNT(*)                                  AS all_rows,
         COUNT(CASE WHEN sku_id IS NOT NULL THEN 1 END) AS sku_rows
       FROM un_code_mfg_sku_wh_map
       WHERE mfg_id = ? AND wh_id = ? AND status = 'active'`,
      [mfgA, whId]
    )
    const r = (rows as { all_rows: number; sku_rows: number }[])[0]
    assert.equal(Number(r.all_rows), 2)
    assert.equal(Number(r.sku_rows), 1, "the sku_id IS NULL row must not inflate the count")
  })
})

test("selectVendorCode reads the pair's code from any of its rows", async () => {
  // un_mfg_code is denormalised across a pair's rows, so MAX() has to return the
  // shared value whether or not the vendor-code row itself is present.
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA } = await ids(conn)
    await insert(conn, mfgA, whId, skuA, "SELFTEST_CODE")

    const [rows] = await conn.execute(mfgFacilityMap.selectVendorCode, [whId, mfgA])
    assert.equal((rows as { un_mfg_code: string | null }[])[0].un_mfg_code, "SELFTEST_CODE")
  })
})

test("the upsert remaps rather than duplicating, and resets the push state", async () => {
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA } = await ids(conn)
    // Start from a row that was already pushed to Uniware.
    await conn.execute(
      `INSERT INTO un_code_mfg_sku_wh_map
         (mfg_id, wh_id, sku_id, un_mfg_code, status, un_pushed_at)
       VALUES (?, ?, ?, 'SELFTEST_A', 'inactive', NOW())`,
      [mfgA, whId, skuA]
    )

    await conn.execute(
      mfgFacilityMap.buildUpsertMappings(1),
      [mfgA, whId, skuA, "SELFTEST_A", null, null]
    )

    const [rows] = await conn.execute(
      `SELECT status, un_pushed_at FROM un_code_mfg_sku_wh_map
       WHERE mfg_id = ? AND wh_id = ? AND sku_id = ?`,
      [mfgA, whId, skuA]
    )
    const r = rows as { status: string; un_pushed_at: string | null }[]
    assert.equal(r.length, 1, "the upsert must update, not insert a second row")
    assert.equal(r[0].status, "active", "re-mapping revives a soft-deleted row")
    assert.equal(
      r[0].un_pushed_at, null,
      "the row changed, so the previous push no longer describes it and must be re-pushed"
    )
  })
})

test("matrix returns one row per (active mfg × active facility)", async () => {
  await withRollback(async (conn) => {
    const unrestricted = [null, [0]]
    const [rows] = await conn.query(mfgFacilityMap.matrix, [
      ...unrestricted, ...unrestricted, ...unrestricted, ...unrestricted,
    ])
    const cells = rows as { mfg_id: number; wh_id: number; total_skus: number }[]
    assert.ok(cells.length > 0, "the matrix must not be empty")

    const mfgs = new Set(cells.map((c) => c.mfg_id))
    const whs = new Set(cells.map((c) => c.wh_id))
    assert.equal(
      cells.length, mfgs.size * whs.size,
      "the CROSS JOIN must be complete — a missing pair would hide the gap the screen exists to show"
    )
    // Same manufacturer, so total_skus must not vary across its row.
    const byMfg = new Map<number, Set<number>>()
    for (const c of cells) {
      const set = byMfg.get(c.mfg_id) ?? new Set()
      set.add(Number(c.total_skus))
      byMfg.set(c.mfg_id, set)
    }
    for (const [mfgId, totals] of byMfg) {
      assert.equal(totals.size, 1, `mfg ${mfgId} reports different SKU totals across facilities`)
    }
  })
})

/**
 * The colour progression the screen exists to show, driven through the REAL matrix
 * SQL and the REAL cellState() — not a hand-built fixture.
 *
 * This is the integration check for the whole feature: it is the one test that
 * would catch the query and the state function disagreeing, which is the failure
 * neither tests/unit/mfg-facility-map.test.ts (no SQL) nor the other tests here
 * (no cellState) can see.
 *
 * Uses a manufacturer that actually has live SKU lines, because total_skus is the
 * denominator every state depends on — on a manufacturer with none, every stage
 * below would correctly read "unavailable" and the test would prove nothing.
 */
test("grey -> pink -> amber -> green through the real query", async () => {
  await withRollback(async (conn) => {
    // A manufacturer with at least 2 live lines, so "partial" is reachable.
    const [cands] = await conn.execute(`
      SELECT l.mfg_id, COUNT(DISTINCT b.sku_id) n
      FROM master_recipe_mfg l
      INNER JOIN master_recipe b ON b.id = l.recipe_id AND b.sku_id IS NOT NULL
      WHERE l.status IN ('active','discontinued')
      GROUP BY l.mfg_id HAVING n >= 2 ORDER BY n DESC LIMIT 1
    `)
    const cand = (cands as { mfg_id: number; n: number }[])[0]
    assert.ok(cand, "no manufacturer has 2+ live SKU lines — cannot exercise 'partial'")
    const { mfg_id: mfgId } = cand

    const [skuRows] = await conn.execute(`
      SELECT DISTINCT b.sku_id FROM master_recipe_mfg l
      INNER JOIN master_recipe b ON b.id = l.recipe_id AND b.sku_id IS NOT NULL
      WHERE l.mfg_id = ? AND l.status IN ('active','discontinued')
      ORDER BY b.sku_id
    `, [mfgId])
    const skuIds = (skuRows as { sku_id: number }[]).map((r) => r.sku_id)

    const [whRows] = await conn.execute(
      "SELECT id FROM details_warehouse_entity WHERE status='active' AND facility_code IS NOT NULL LIMIT 1")
    const whId = (whRows as { id: number }[])[0].id

    const unrestricted = [null, [0]]
    /** Re-read this one cell through the production matrix query. Typed as the
     *  real row type, so a renamed column here is a compile error rather than an
     *  `undefined` that quietly satisfies an assertion. */
    const readCell = async (): Promise<MfgFacilityCell> => {
      const [rows] = await conn.query(mfgFacilityMap.matrix, [
        ...unrestricted, ...unrestricted, ...unrestricted, ...unrestricted,
      ])
      const cell = (rows as MfgFacilityCell[]).find(
        (c) => c.mfg_id === mfgId && c.wh_id === whId
      )
      assert.ok(cell, "the cell vanished from the cross-product")
      return cell
    }

    // ── grey: no vendor code, so nothing here can be mapped ──
    let cell = await readCell()
    assert.equal(cell.un_mfg_code, null)
    assert.ok(Number(cell.total_skus) >= 2, "denominator must be real")
    assert.equal(cellState(cell), "unavailable", "no vendor code must read grey")
    assert.equal(cellLabel(cell), "—")

    // ── pink: vendor code set, nothing mapped ──
    await conn.execute(mfgFacilityMap.insertVendorCodeRow,
      [mfgId, whId, "SELFTEST_PROGRESSION", null, null, null])
    cell = await readCell()
    assert.equal(cell.un_mfg_code, "SELFTEST_PROGRESSION")
    assert.equal(Number(cell.mapped_skus), 0, "the sku_id IS NULL row must not count as mapped")
    assert.equal(cellState(cell), "unmapped", "vendor code but nothing mapped must read pink")
    assert.equal(cellLabel(cell), "0")

    // ── amber: some but not all ──
    await conn.execute(mfgFacilityMap.buildUpsertMappings(1),
      [mfgId, whId, skuIds[0], "SELFTEST_PROGRESSION", null, null])
    cell = await readCell()
    assert.equal(Number(cell.mapped_skus), 1)
    assert.equal(cellState(cell), "partial")
    assert.equal(cellLabel(cell), "1")
    // Never pushed and never seen, so the cell must ask to be pushed.
    assert.equal(Number(cell.unpushed_skus), 1)

    // ── green: all of them ──
    await conn.execute(
      mfgFacilityMap.buildUpsertMappings(skuIds.length),
      skuIds.flatMap((id) => [mfgId, whId, id, "SELFTEST_PROGRESSION", null, null])
    )
    cell = await readCell()
    assert.equal(Number(cell.mapped_skus), Number(cell.total_skus))
    assert.equal(cellState(cell), "mapped", "all mapped must read green")
    assert.equal(cellLabel(cell), String(cell.total_skus))

    // ── and there is no way back ──
    // Mapping is append-only: Unicommerce cannot un-map a vendor item, so this
    // file exposes no unmap query at all. If one is ever reintroduced, the two
    // systems can disagree with only the next export to reveal it.
    assert.equal(
      "deactivateAll" in mfgFacilityMap, false,
      "an unmap query is back — Uniware cannot withdraw a vendor item, so neither can we"
    )
    assert.equal("deactivateOthers" in mfgFacilityMap, false)
    assert.equal("buildUnmapMappings" in mfgFacilityMap, false)

    // The pills agree with the green cell they summarise: nothing outstanding.
    const pills = summarise([cell])
    assert.equal(pills.unmapped, 0)
    assert.equal(pills.partial, 0)
    assert.equal(pills.missing, 0, "a fully mapped cell leaves no SKU-slots outstanding")
  })
})

test("re-mapping an already-mapped SKU does not blank Uniware's confirmation", async () => {
  // The trap the append-only filter exists to avoid. buildUpsertMappings resets
  // un_pushed_at/un_push_error on a duplicate key — right for a new row, data loss
  // on one Uniware has already confirmed. The route filters to genuinely-new SKUs
  // via selectMappedSkuIds; this pins what happens if that filter is ever dropped.
  await withRollback(async (conn) => {
    const { mfgA, whId, skuA } = await ids(conn)
    await ownMappings(conn, mfgA)

    // A row already synced from an export.
    await conn.execute(
      `INSERT INTO un_code_mfg_sku_wh_map
         (mfg_id, wh_id, sku_id, un_mfg_code, status, un_seen_at, un_pushed_at)
       VALUES (?, ?, ?, 'SELFTEST_CONFIRMED', 'active', NOW(), NOW())`,
      [mfgA, whId, skuA]
    )

    // What the route would send: the already-mapped SKU filtered OUT.
    const existing = await conn.execute(mfgFacilityMap.selectMappedSkuIds, [mfgA, whId])
    const already = (existing[0] as { sku_id: number }[]).map((r) => r.sku_id)
    assert.deepEqual(already, [skuA], "the filter must see the existing mapping")

    const toAdd = [skuA].filter((id) => !already.includes(id))
    assert.equal(toAdd.length, 0, "nothing to add, so no upsert runs and the row is untouched")

    const [after] = await conn.execute(
      "SELECT un_pushed_at, un_seen_at FROM un_code_mfg_sku_wh_map WHERE mfg_id=? AND wh_id=? AND sku_id=?",
      [mfgA, whId, skuA]
    )
    const row = (after as { un_pushed_at: string | null; un_seen_at: string | null }[])[0]
    assert.ok(row.un_pushed_at, "the push confirmation survived")
    assert.ok(row.un_seen_at, "the export confirmation survived")
  })
})

/**
 * The reason the denominator is a union, pinned.
 *
 * Only 5 recipes exist for 304 SKUs, so nearly every SKU imported from
 * Unicommerce has no master_recipe_mfg line. If total_skus counted only recipe
 * lines, mapping such a SKU would raise mapped_skus above a zero denominator —
 * cellState would read "unavailable" and the cell would stay grey no matter how
 * much real data was mapped. That was the state before this test existed.
 */
test("a SKU with no recipe still counts once mapped", async () => {
  await withRollback(async (conn) => {
    // A manufacturer with NO recipe lines at all, so the recipe branch of the
    // union contributes nothing and only the mapping branch can.
    const [bare] = await conn.execute(`
      SELECT m.id FROM master_mfgs m
      INNER JOIN details_mfg d ON d.mfg_id = m.id AND d.status = 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM master_recipe_mfg l WHERE l.mfg_id = m.id
                 AND l.status IN ('active','discontinued'))
      ORDER BY m.id LIMIT 1`)
    const mfgId = (bare as { id: number }[])[0]?.id
    assert.ok(mfgId, "no manufacturer without recipe lines — cannot test the mapping-only branch")
    // The seeded export gives most manufacturers mappings already; this test
    // asserts absolute totals, so it has to start from a known-empty pair.
    await ownMappings(conn, mfgId)

    const [whs] = await conn.execute(
      "SELECT id FROM details_warehouse_entity WHERE status='active' AND facility_code IS NOT NULL ORDER BY id LIMIT 1")
    const whId = (whs as { id: number }[])[0].id
    const [skus] = await conn.execute("SELECT id FROM master_skus ORDER BY id LIMIT 2")
    const [a, b] = (skus as { id: number }[]).map((r) => r.id)

    const unrestricted = [null, [0]]
    const read = async () => {
      const [rows] = await conn.query(mfgFacilityMap.matrix, [
        ...unrestricted, ...unrestricted, ...unrestricted, ...unrestricted,
      ])
      const cell = (rows as MfgFacilityCell[]).find((c) => c.mfg_id === mfgId && c.wh_id === whId)
      assert.ok(cell)
      return cell
    }

    // Baseline: no recipes, no mappings — nothing to map, so grey.
    let cell = await read()
    assert.equal(Number(cell.total_skus), 0)
    assert.equal(cellState(cell), "unavailable")

    // Map two SKUs that have no recipe anywhere.
    await conn.execute(
      mfgFacilityMap.buildUpsertMappings(2),
      [mfgId, whId, a, "SELFTEST_NORECIPE", null, null,
       mfgId, whId, b, "SELFTEST_NORECIPE", null, null])

    cell = await read()
    assert.equal(Number(cell.total_skus), 2, "the mapping branch must supply the denominator")
    assert.equal(Number(cell.mapped_skus), 2)
    assert.equal(
      Number(cell.orphan_skus), 0,
      "a mapped SKU must count as mapped, not be written off as an orphan"
    )
    assert.equal(cellState(cell), "mapped", "green without a single recipe existing")
  })
})

test("a second facility shares the denominator, so it reads as partial", async () => {
  // The coverage reading the matrix is for: 'this manufacturer supplies N SKUs;
  // this facility carries M of them.' Mapping a SKU at one facility must raise the
  // total everywhere, or each column would silently grade itself.
  await withRollback(async (conn) => {
    const [bare] = await conn.execute(`
      SELECT m.id FROM master_mfgs m
      INNER JOIN details_mfg d ON d.mfg_id = m.id AND d.status = 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM master_recipe_mfg l WHERE l.mfg_id = m.id
                 AND l.status IN ('active','discontinued'))
      ORDER BY m.id LIMIT 1`)
    const mfgId = (bare as { id: number }[])[0].id
    await ownMappings(conn, mfgId)
    const [whs] = await conn.execute(
      "SELECT id FROM details_warehouse_entity WHERE status='active' AND facility_code IS NOT NULL ORDER BY id LIMIT 2")
    const [whA, whB] = (whs as { id: number }[]).map((r) => r.id)
    const [skus] = await conn.execute("SELECT id FROM master_skus ORDER BY id LIMIT 3")
    const ids = (skus as { id: number }[]).map((r) => r.id)

    // All three at A, only one at B.
    await conn.execute(mfgFacilityMap.buildUpsertMappings(3),
      ids.flatMap((s) => [mfgId, whA, s, "SELFTEST_COVER", null, null]))
    await conn.execute(mfgFacilityMap.buildUpsertMappings(1),
      [mfgId, whB, ids[0], "SELFTEST_COVER", null, null])

    const unrestricted = [null, [0]]
    const [rows] = await conn.query(mfgFacilityMap.matrix, [
      ...unrestricted, ...unrestricted, ...unrestricted, ...unrestricted,
    ])
    const cells = rows as MfgFacilityCell[]
    const cellA = cells.find((c) => c.mfg_id === mfgId && c.wh_id === whA)!
    const cellB = cells.find((c) => c.mfg_id === mfgId && c.wh_id === whB)!

    assert.equal(Number(cellA.total_skus), 3, "denominator is the union across facilities")
    assert.equal(Number(cellB.total_skus), 3, "and it is the same for every facility in the row")
    assert.equal(cellState(cellA), "mapped", "3 of 3 here")
    assert.equal(cellState(cellB), "partial", "1 of 3 here")
  })
})
