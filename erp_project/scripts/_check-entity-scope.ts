// Verifies per-user entity scoping end to end against the configured schema.
//   npx tsx scripts/_check-entity-scope.ts
//
// The property that matters most: an UNRESTRICTED scope must be a perfect no-op.
// Every scoped query is asserted to return the exact same row count with
// UNRESTRICTED as it does with the scope clause stripped out — if that ever
// breaks, every existing user silently loses data.
//
// Then the inverse: a restricted scope must return a strict subset, and every
// row in it must belong to an allowed entity.
import "dotenv/config"
import assert from "node:assert/strict"
import { query, execute, pool } from "../lib/db"
import { UNRESTRICTED, scopeParams, inScope, type UserScope } from "../lib/scope"
import { entityScopeSql } from "../lib/queries/entity-scope"
import {
  purchaseOrdersSql, buildFilterParams, buildStatusCountParams,
} from "../lib/queries/purchase-orders"
import { manufacturers } from "../lib/queries/manufacturers"
import { vendors } from "../lib/queries/vendors"
import { rawMaterials } from "../lib/queries/raw-materials"
import { packingMaterials } from "../lib/queries/packing-materials"
import { manufacturingSql } from "../lib/queries/manufacturing"

/** Strips the scope predicates so the same query can be run truly unfiltered. */
/**
 * Strip every per-user scope predicate, so the same query can be run unscoped and
 * the two counts compared.
 *
 * Three shapes, because the predicates were hand-written at different times:
 *   AND (? IS NULL OR <subquery>) IN (?))       — the EXISTS/derived form
 *   AND (? IS NULL OR col IN (?))               — mfg / warehouse
 *   AND (? IS NULL OR col IS NULL OR col IN (?)) — brand, which lets NULL through
 *
 * The third was missing for as long as brand scope existed, so the brand clause
 * survived into the "bare" query and left two placeholders unbound. Use
 * assertStripped below rather than trusting these patterns by eye.
 */
function withoutScope(sql: string): string {
  return sql.replace(/AND \(\? IS NULL OR [^)]*\) IN \(\?\)\)/g, "")
            .replace(/AND \(\? IS NULL OR [\w.]+ IS NULL OR [\w.]+ IN \(\?\)\)/g, "")
            .replace(/AND \(\? IS NULL OR [\w.]+ +IN \(\?\)\)/g, "")
}

/**
 * The regexes above are the weak link: a new scope predicate written in a shape
 * none of them match leaves its placeholders behind, and the failure is a syntax
 * error in an unrelated part of the query. Assert the placeholder count actually
 * dropped by the number of scope params instead of hoping.
 */
function assertStripped(sql: string, scopeParamCount: number, label: string) {
  const count = (t: string) => (t.match(/\?/g) ?? []).length
  assert.equal(
    count(sql) - count(withoutScope(sql)),
    scopeParamCount,
    `withoutScope did not strip every scope predicate from ${label} — add its shape to the regexes`
  )
}

function countOf(rows: { total: number }[]): number {
  return Number(rows[0]?.total ?? 0)
}

async function main() {
  const scoped = (ids: number[] | null): UserScope => ({
    mfgIds: ids, vendorIds: ids, warehouseNames: null,  brandIds: null
  })

  // ── 1. Unrestricted is a no-op, per query ─────────────────────────────────
  console.log("── unrestricted must equal unfiltered ──")

  const mfgFp = manufacturers.filterParams(null, UNRESTRICTED)
  const mfgScoped = countOf(await query<{ total: number }>(manufacturers.countAll, mfgFp))
  // NOT a prefix slice: manufacturers puts its scope pair in the MIDDLE of the
  // array (search×3, scope×2, status×2), so dropping the tail also drops the status
  // filter and leaves two placeholders unbound. Vendors and POs happen to put scope
  // last, which is why a slice works for them and hid this for so long.
  const mfgBare = countOf(await query<{ total: number }>(
    withoutScope(manufacturers.countAll), [...mfgFp.slice(0, 3), ...mfgFp.slice(5)]))
  assert.equal(mfgScoped, mfgBare, "manufacturers.countAll unchanged by unrestricted scope")
  console.log(`  manufacturers: ${mfgScoped} == ${mfgBare}`)

  const venFp = vendors.filterParams(null, null, null, UNRESTRICTED)
  const venScoped = countOf(await query<{ total: number }>(vendors.countAll, venFp))
  const venBare = countOf(await query<{ total: number }>(withoutScope(vendors.countAll), venFp.slice(0, 7)))
  assert.equal(venScoped, venBare, "vendors.countAll unchanged by unrestricted scope")
  console.log(`  vendors: ${venScoped} == ${venBare}`)

  // 6 scope placeholders on the PO query (mfg, warehouse, brand — 2 each).
  assertStripped(purchaseOrdersSql.countPaginated, 6, "purchaseOrdersSql.countPaginated")
  const poFp = buildFilterParams(null, null, null, null, null, null, null, null, false, UNRESTRICTED)
  const poScoped = countOf(await query<{ total: number }>(purchaseOrdersSql.countPaginated, poFp))
  const poBare = countOf(await query<{ total: number }>(withoutScope(purchaseOrdersSql.countPaginated), poFp.slice(0, 25)))
  assert.equal(poScoped, poBare, "PO countPaginated unchanged by unrestricted scope")
  console.log(`  purchase orders: ${poScoped} == ${poBare}`)

  for (const [name, sql, fp, bareLen] of [
    ["rm vendor rates", rawMaterials.countVendor, rawMaterials.vendorFilterParams(null, null, null, null, null, null, null, null, UNRESTRICTED), 17],
    ["rm mfg rates", rawMaterials.countMfg, rawMaterials.mfgFilterParams(null, null, null, null, null, null, null, UNRESTRICTED), 15],
    ["pm vendor rates", packingMaterials.countVendor, packingMaterials.vendorFilterParams(null, null, null, null, null, null, null, UNRESTRICTED), 15],
    ["pm mfg rates", packingMaterials.countMfg, packingMaterials.mfgFilterParams(null, null, null, null, null, null, null, UNRESTRICTED), 15],
  ] as [string, string, unknown[], number][]) {
    const s = countOf(await query<{ total: number }>(sql, fp))
    const b = countOf(await query<{ total: number }>(withoutScope(sql), fp.slice(0, bareLen)))
    assert.equal(s, b, `${name} unchanged by unrestricted scope`)
    console.log(`  ${name}: ${s} == ${b}`)
  }

  const navAll = await query(manufacturingSql.selectActiveForNav, scopeParams(null))
  const navBare = await query(withoutScope(manufacturingSql.selectActiveForNav), [])
  assert.equal(navAll.length, navBare.length, "sidebar nav unchanged by unrestricted scope")
  console.log(`  sidebar nav: ${navAll.length} == ${navBare.length}`)

  // ── 2. A restricted scope returns a correct strict subset ─────────────────
  console.log("\n── restricted must be a correct subset ──")

  const someMfgs = await query<{ id: number }>("SELECT id FROM master_mfgs ORDER BY id LIMIT 2")
  const allowedMfgIds = someMfgs.map((m) => m.id)
  assert.ok(allowedMfgIds.length > 0, "there is at least one manufacturer to scope to")
  const s = scoped(allowedMfgIds)

  const poRows = await query<{ mfg_id: number }>(
    purchaseOrdersSql.buildSelectPaginated("date", "desc"),
    [...buildFilterParams(null, null, null, null, null, null, null, null, false, s), 500, 0]
  )
  assert.ok(poRows.every((r) => allowedMfgIds.includes(r.mfg_id)), "every PO row is an allowed mfg")
  const poRestricted = countOf(await query<{ total: number }>(
    purchaseOrdersSql.countPaginated,
    buildFilterParams(null, null, null, null, null, null, null, null, false, s)
  ))
  assert.ok(poRestricted <= poScoped, "restricted PO count is not larger than unrestricted")
  console.log(`  POs: ${poRestricted} of ${poScoped}, all within mfg [${allowedMfgIds}]`)

  const navRestricted = await query<{ id: number }>(manufacturingSql.selectActiveForNav, scopeParams(allowedMfgIds))
  assert.ok(navRestricted.every((r) => allowedMfgIds.includes(r.id)), "nav lists only allowed mfgs")
  assert.ok(navRestricted.length <= navAll.length, "nav is not widened by a restriction")
  console.log(`  sidebar nav: ${navRestricted.length} of ${navAll.length}`)

  const mfgRestricted = countOf(await query<{ total: number }>(
    manufacturers.countAll, manufacturers.filterParams(null, s)
  ))
  assert.ok(mfgRestricted <= allowedMfgIds.length, "manufacturers master is narrowed to the allow-list")
  console.log(`  manufacturers: ${mfgRestricted} of ${mfgScoped}`)

  // statusCounts/summaryStats share SUMMARY_WHERE — a param-count slip there is
  // a hard mysql2 error, so just running them is the assertion.
  await query(purchaseOrdersSql.statusCounts, buildStatusCountParams(null, null, null, null, null, null, null, false, s))
  await query(purchaseOrdersSql.summaryStats, buildStatusCountParams(null, null, null, null, null, null, null, false, s))
  await query(purchaseOrdersSql.inwardCount, buildStatusCountParams(null, null, null, null, null, null, null, false, s))
  console.log("  statusCounts / summaryStats / inwardCount run with scope params")

  // ── 3. An empty allow-list must not silently mean "everything" ─────────────
  const emptyScope = countOf(await query<{ total: number }>(
    purchaseOrdersSql.countPaginated,
    buildFilterParams(null, null, null, null, null, null, null, null, false, scoped([-1]))
  ))
  assert.equal(emptyScope, 0, "a scope matching no entity returns nothing, not everything")
  console.log(`\n  scope of a nonexistent mfg -> ${emptyScope} rows (fails closed)`)

  // ── 4. getUserScope semantics + warehouse id->name resolution ─────────────
  console.log("\n── storage round trip ──")
  const users = await query<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1")
  const probeUser = users[0].id
  const warehouses = await query<{ id: number; name: string }>("SELECT id, name FROM master_warehouse LIMIT 2")

  await execute(entityScopeSql.deleteForUserAndType, [probeUser, "mfg"])
  await execute(entityScopeSql.deleteForUserAndType, [probeUser, "warehouse"])
  try {
    for (const id of allowedMfgIds) {
      await execute(entityScopeSql.insert, [probeUser, "mfg", id, null])
    }
    for (const w of warehouses) {
      await execute(entityScopeSql.insert, [probeUser, "warehouse", w.id, null])
    }

    const rows = await query<{ entity_type: string; entity_id: number }>(entityScopeSql.selectByUser, [probeUser])
    assert.equal(rows.filter((r) => r.entity_type === "mfg").length, allowedMfgIds.length, "mfg rows round-trip")
    assert.equal(rows.filter((r) => r.entity_type === "vendor").length, 0, "vendor stays unset -> unrestricted")

    if (warehouses.length > 0) {
      const names = await query<{ name: string }>(entityScopeSql.warehouseNamesByIds, [warehouses.map((w) => w.id)])
      assert.deepEqual(names.map((n) => n.name).sort(), warehouses.map((w) => w.name).sort(),
        "warehouse ids resolve to the names purchase_orders.destination stores")
      console.log(`  warehouse ids -> names: ${names.map((n) => n.name).join(", ")}`)

      // The resolved name must be what `destination` actually holds, or every
      // warehouse-scoped query silently matches nothing.
      const matching = countOf(await query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM purchase_orders WHERE destination IN (?)",
        [names.map((n) => n.name)]
      ))
      console.log(`  POs whose destination matches those names: ${matching}`)
    }
  } finally {
    await execute(entityScopeSql.deleteForUserAndType, [probeUser, "mfg"])
    await execute(entityScopeSql.deleteForUserAndType, [probeUser, "warehouse"])
  }
  const cleaned = await query(entityScopeSql.selectByUser, [probeUser])
  assert.equal(cleaned.length, 0, "probe rows cleaned up")

  // ── 5. inScope() unit behaviour ───────────────────────────────────────────
  assert.equal(inScope(UNRESTRICTED, "mfg", 999), true, "unrestricted admits anything")
  assert.equal(inScope(scoped([1, 2]), "mfg", 2), true, "allowed id admitted")
  assert.equal(inScope(scoped([1, 2]), "mfg", 3), false, "disallowed id refused")
  assert.equal(inScope(scoped([1, 2]), "vendor", 3), false, "vendor dimension is checked too")
  assert.equal(inScope(scoped([1, 2]), "warehouse", "Bhiwandi"), true, "unset warehouse dimension is unrestricted")
  assert.equal(inScope({ ...UNRESTRICTED, warehouseNames: ["A"] }, "warehouse", "B"), false, "warehouse name refused")
  assert.equal(inScope(scoped([1]), "mfg", null), true, "a null id is not a scope violation (nothing addressed)")
  console.log("\n  inScope() behaviour ok")

  // ── 6. Param-count guards, so a WHERE and its builder can't drift ─────────
  // 25 filter params + 6 scope. Both grew by 2 when the destination filter gained
  // its entity half — a location is one master_warehouse row but two destinations.
  assert.equal(buildFilterParams(null, null, null, null, null, null, null, null, false, UNRESTRICTED).length, 31)
  assert.equal(buildStatusCountParams(null, null, null, null, null, null, null, false, UNRESTRICTED).length, 27)
  assert.equal(manufacturers.filterParams(null, UNRESTRICTED).length, 7)
  assert.equal(vendors.filterParams(null, null, null, UNRESTRICTED).length, 9)
  assert.deepEqual(scopeParams(null), [null, [0]], "unrestricted params are inert")
  assert.deepEqual(scopeParams([7]), [1, [7]], "restricted params carry the list")
  console.log("  param counts ok")

  console.log("\nALL CHECKS PASSED")
  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
