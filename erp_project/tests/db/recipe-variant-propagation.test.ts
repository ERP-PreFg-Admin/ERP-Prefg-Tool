// Variant-family RM fan-out — the half of the rule that cannot be unit tested.
//
// RM is family-scoped (the same formulation in different pack sizes) and PM is
// SKU-scoped. So approving a base SKU's RM change has to create a matching new
// Recipe version for every sibling, carrying the base's NEW RM and each
// sibling's OWN PM. Get that backwards and either the family silently keeps
// diverging (the whole thing this guards against) or every variant is packaged
// with the base's PM, which is the wrong box.
//
// The decision logic lives in lib/masters/variant-rm-lock.ts and is pinned by
// tests/unit/variant-rm-lock.test.ts. This file pins the WRITE: four tables in
// one transaction. bomHandler.applyAndArchive takes an open connection and never
// opens its own, so it runs under withRollback (see tests/helpers/db.ts); the
// route that submits does own a transaction and so is not testable here.
//
// Deliberately does not touch master_skus.is_base_sku: the handler is driven by
// the variant_child:<sku_id> approval_items the route staged, not by the flag.
// That keeps this file runnable whether or not prisma/add_sku_is_base_sku.sql has
// been applied to the test schema yet.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { bomHandler, createRecipeVersion } from "../../lib/approvals/handlers/recipe"
import { bom as recipeSql } from "../../lib/queries/recipe"
import type { DiffItem } from "../../lib/approvals/handlers/types"

after(closePool)

/** createRecipeVersion with the audit args a test doesn't care about filled in. */
async function createRecipeVersionForTest(
  conn: PoolConnection,
  opts: {
    skuId: number
    skuCode: string
    lines: { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number; uom: string }[]
    userId: number
  }
): Promise<number> {
  const { recipeId } = await createRecipeVersion(conn, {
    skuId: opts.skuId,
    skuCode: opts.skuCode,
    lines: opts.lines,
    effectiveFrom: "2026-06-01",
    createdBy: opts.userId,
    approverId: opts.userId,
    raisedBy: opts.userId,
    reason: "test",
    changeType: ["rm"],
    supersededBy: "test",
  })
  return recipeId
}

type Materials = { rmA: number; rmB: number; pmBase: number; pmVariant: number; userId: number }

/** Two RMs, two PMs and a user to hang fixtures off — null if the dev DB lacks them. */
async function materials(conn: PoolConnection): Promise<Materials | null> {
  const [rmRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM master_rm ORDER BY id LIMIT 2"
  )
  const [pmRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM master_pm ORDER BY id LIMIT 2"
  )
  const [userRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM users ORDER BY id LIMIT 1"
  )
  if (rmRows.length < 2 || pmRows.length < 2 || !userRows[0]) return null
  return {
    rmA: rmRows[0].id, rmB: rmRows[1].id,
    pmBase: pmRows[0].id, pmVariant: pmRows[1].id,
    userId: userRows[0].id,
  }
}

let seq = 0
const testCode = (part: string) => `QA${process.pid}-${part}-${++seq}`

/** A SKU in the variant family keyed on (brand, base_sku_sno). */
async function makeSku(conn: PoolConnection, brand: string, sno: number, userId: number) {
  const skuCode = testCode("SKU")
  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO master_skus (sku_code, name, brand, base_sku_sno, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [skuCode, `Variant test ${skuCode}`, brand, sno, userId]
  )
  return { id: res.insertId, sku_code: skuCode }
}

/** An ACTIVE recipe with its lines already materialised, i.e. a live one. */
async function makeActiveRecipe(
  conn: PoolConnection,
  skuId: number,
  bomCode: string,
  lines: { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number; uom: string }[],
  userId: number,
  versions: { rm: number; pm: number } = { rm: 1, pm: 1 }
) {
  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO master_recipe (bom_code, sku_id, created_by, status, effective_from, rm_version, pm_version, created_at)
     VALUES (?, ?, ?, 'active', '2026-01-01', ?, ?, NOW())`,
    [bomCode, skuId, userId, versions.rm, versions.pm]
  )
  const recipeId = res.insertId
  for (const l of lines) {
    await conn.execute(
      `INSERT INTO details_recipe (recipe_id, mtrl_type, mtrl_id, amount, uom, status, updated_by, last_updated)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NOW())`,
      [recipeId, l.mtrl_type, l.mtrl_id, l.amount, l.uom, userId]
    )
  }
  await conn.execute(`UPDATE master_skus SET active_bom_id = ? WHERE id = ?`, [recipeId, skuId])
  return recipeId
}

/**
 * A submitted-but-unapproved recipe: header only, in review. This mirrors
 * create-full, which writes the header and encodes the lines as approval_items —
 * details_recipe is only ever written at approval time.
 */
async function makePendingRecipe(conn: PoolConnection, skuId: number, bomCode: string, userId: number) {
  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO master_recipe (bom_code, sku_id, created_by, status, effective_from, rm_version, pm_version, created_at)
     VALUES (?, ?, ?, 'in review', '2026-06-01', 2, 1, NOW())`,
    [bomCode, skuId, userId]
  )
  return res.insertId
}

/** The approval_items create-full writes for a new version. */
function lineItems(lines: { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number; uom: string }[]): DiffItem[] {
  return lines.flatMap((l) => [
    { field_name: `line:${l.mtrl_type}:${l.mtrl_id}:__present__`, old_value: "1", new_value: "1" },
    { field_name: `line:${l.mtrl_type}:${l.mtrl_id}:amount`, old_value: "", new_value: String(l.amount) },
    { field_name: `line:${l.mtrl_type}:${l.mtrl_id}:uom`, old_value: "", new_value: l.uom },
  ])
}

async function readLines(conn: PoolConnection, recipeId: number) {
  const [rows] = await conn.execute<(RowDataPacket & { mtrl_type: string; mtrl_id: number; amount: string })[]>(
    `SELECT mtrl_type, mtrl_id, amount FROM details_recipe WHERE recipe_id = ?`,
    [recipeId]
  )
  // Sorted here, not in SQL: mtrl_type is an ENUM, so ORDER BY sorts it by
  // DECLARATION order ('rm' before 'pm'), not alphabetically — a trap worth
  // not relying on either way round.
  return rows
    .map((r) => ({ type: r.mtrl_type, id: Number(r.mtrl_id), amount: Number(r.amount) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)
}

async function readHeader(conn: PoolConnection, recipeId: number) {
  const [rows] = await conn.execute<(RowDataPacket & { bom_code: string; status: string; sku_id: number; rm_version: number; pm_version: number })[]>(
    `SELECT bom_code, status, sku_id, rm_version, pm_version FROM master_recipe WHERE id = ?`,
    [recipeId]
  )
  return rows[0]
}

test("approving a base SKU's RM change re-versions every sibling with its own PM", async () => {
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return // dev DB has no RM/PM to build a recipe from

    const brand = testCode("BRAND")
    const sno = 990000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)

    // The variant is live on the OLD RM (rmA) with its OWN PM (pmVariant).
    const variantOldRecipeId = await makeActiveRecipe(
      conn, variant.id, `${variant.sku_code}-RM1-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" }],
      m.userId
    )

    // The base's pending new version switches RM from rmA to rmB.
    const baseRecipeId = await makePendingRecipe(conn, base.id, `${base.sku_code}-RM2-PM1`, m.userId)
    const newLines = [
      { mtrl_type: "rm" as const, mtrl_id: m.rmB, amount: 100, uom: "%" },
      { mtrl_type: "pm" as const, mtrl_id: m.pmBase, amount: 1, uom: "pcs" },
    ]

    const items: DiffItem[] = [
      { field_name: "__mode__", old_value: "", new_value: "new-version" },
      { field_name: "__reason__", old_value: "", new_value: "switched preservative" },
      { field_name: "__change_type__", old_value: "", new_value: "rm" },
      ...lineItems(newLines),
      // The fan-out instruction the route staged.
      { field_name: `variant_child:${variant.id}`, old_value: "", new_value: variant.sku_code },
    ]

    await bomHandler.applyAndArchive(conn, baseRecipeId, items, m.userId)

    // ── the base itself applied normally ─────────────────────────────────────
    assert.equal((await readHeader(conn, baseRecipeId)).status, "active")
    assert.deepEqual(await readLines(conn, baseRecipeId), [
      { type: "pm", id: m.pmBase, amount: 1 },
      { type: "rm", id: m.rmB, amount: 100 },
    ])

    // ── the sibling got a NEW version, not an edit of its old one ────────────
    const [siblingRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
      `SELECT id FROM master_recipe WHERE sku_id = ? AND id <> ? ORDER BY id DESC`,
      [variant.id, variantOldRecipeId]
    )
    assert.equal(siblingRows.length, 1, "exactly one new recipe for the sibling")
    const newVariantRecipeId = siblingRows[0].id
    const newVariantHeader = await readHeader(conn, newVariantRecipeId)
    assert.equal(newVariantHeader.status, "active")

    // THE point of the whole feature: base's new RM, sibling's own PM.
    assert.deepEqual(await readLines(conn, newVariantRecipeId), [
      { type: "pm", id: m.pmVariant, amount: 3 },
      { type: "rm", id: m.rmB, amount: 100 },
    ], "sibling must carry the base's new RM and keep its OWN PM")

    // RM version bumped, PM version did not — the sibling's PM is unchanged.
    assert.equal(Number(newVariantHeader.rm_version), 2)
    assert.equal(Number(newVariantHeader.pm_version), 1)
    assert.equal(newVariantHeader.bom_code, `${variant.sku_code}-RM2-PM1`)

    // ── the sibling's predecessor is retired, and the SKU points at the new one
    assert.equal((await readHeader(conn, variantOldRecipeId)).status, "discontinued")
    const [skuRows] = await conn.execute<(RowDataPacket & { active_bom_id: number })[]>(
      `SELECT active_bom_id FROM master_skus WHERE id = ?`, [variant.id]
    )
    assert.equal(Number(skuRows[0].active_bom_id), newVariantRecipeId)

    // ── the new sibling version is archived, so History shows the lineage ────
    const [histRows] = await conn.execute<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM history_recipe WHERE recipe_id = ?`, [newVariantRecipeId]
    )
    assert.equal(Number(histRows[0].c), 2, "one history_recipe row per approved line")
  })
})

test("a recipe with no variant_child items touches nothing but itself", async () => {
  // The overwhelmingly common case — every recipe that isn't a base-SKU RM
  // change. If the fan-out ever fired unconditionally it would re-version
  // unrelated SKUs on every single approval.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 991000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)
    const variantRecipeId = await makeActiveRecipe(
      conn, variant.id, `${variant.sku_code}-RM1-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" }],
      m.userId
    )

    const baseRecipeId = await makePendingRecipe(conn, base.id, `${base.sku_code}-RM1-PM1`, m.userId)
    await bomHandler.applyAndArchive(conn, baseRecipeId, [
      { field_name: "__mode__", old_value: "", new_value: "new-version" },
      ...lineItems([
        { mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
        { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" },
      ]),
    ], m.userId)

    const [siblingRows] = await conn.execute<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM master_recipe WHERE sku_id = ?`, [variant.id]
    )
    assert.equal(Number(siblingRows[0].c), 1, "the sibling must not gain a version")
    assert.equal((await readHeader(conn, variantRecipeId)).status, "active", "and must stay active")
  })
})

test("a variant's first recipe joins the family's RM version instead of restarting at RM1", async () => {
  // The reported bug, end to end through the real handler:
  //   1. base gets BASE-RM1-PM1
  //   2. base's RM changes  -> BASE-RM2-PM1   (variant has no recipe, no fan-out)
  //   3. variant's FIRST recipe is created, inheriting that RM
  // Step 3 used to produce VARIANT-RM1-PM1 because rm_version was counted from
  // the variant's own (empty) history. It must be RM2: the RM it carries IS
  // revision 2 of the family formulation. PM is its own, so PM starts at 1.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 993000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)

    // 1 + 2 collapsed: the base is live on the SECOND revision of the RM.
    await makeActiveRecipe(
      conn, base.id, `${base.sku_code}-RM2-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmB, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }],
      m.userId, { rm: 2, pm: 1 }
    )

    // 3. The variant's first-ever recipe: the family's RM (rmB) + its own PM.
    //    createRecipeVersion is the shared numbering path, so proving it here
    //    covers the fan-out and the CSV bulk route too.
    const created = await createRecipeVersionForTest(conn, {
      skuId: variant.id,
      skuCode: variant.sku_code,
      lines: [
        { mtrl_type: "rm", mtrl_id: m.rmB, amount: 100, uom: "%" },
        { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" },
      ],
      userId: m.userId,
    })

    const header = await readHeader(conn, created)
    assert.equal(Number(header.rm_version), 2, "RM must continue the family lineage, not restart at 1")
    assert.equal(Number(header.pm_version), 1, "PM is per pack size, so it starts at 1")
    assert.equal(header.bom_code, `${variant.sku_code}-RM2-PM1`)
  })
})

test("a variant that changes nothing on a later revision keeps the family RM version", async () => {
  // Two variants of one product must never disagree about which revision of the
  // formulation they are on.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 994000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const v1 = await makeSku(conn, brand, sno, m.userId)
    const v2 = await makeSku(conn, brand, sno, m.userId)

    await makeActiveRecipe(
      conn, base.id, `${base.sku_code}-RM5-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }],
      m.userId, { rm: 5, pm: 1 }
    )

    const familyRm = { mtrl_type: "rm" as const, mtrl_id: m.rmA, amount: 100, uom: "%" }
    const a = await createRecipeVersionForTest(conn, {
      skuId: v1.id, skuCode: v1.sku_code, userId: m.userId,
      lines: [familyRm, { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 2, uom: "pcs" }],
    })
    const b = await createRecipeVersionForTest(conn, {
      skuId: v2.id, skuCode: v2.sku_code, userId: m.userId,
      lines: [familyRm, { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 9, uom: "pcs" }],
    })

    assert.equal(Number((await readHeader(conn, a)).rm_version), 5)
    assert.equal(Number((await readHeader(conn, b)).rm_version), 5)
  })
})

// ── the invariant, at every write path that can activate a recipe ────────────
// Every active recipe in a variant family must carry the same rm_version. The
// enforcement is application-side (no constraint can span these rows), so each
// door needs its own test or the invariant is only a convention.

test("createRecipeVersion refuses a variant RM that differs from its family", async () => {
  // The CSV bulk path reaches active recipes through createRecipeVersion and
  // had NO lock check — an upload could hand one pack size a formulation none
  // of its siblings had. bulk turns this throw into that group's skip reason.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 995000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)

    await makeActiveRecipe(
      conn, base.id, `${base.sku_code}-RM1-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }],
      m.userId
    )

    await assert.rejects(
      () => createRecipeVersionForTest(conn, {
        skuId: variant.id, skuCode: variant.sku_code, userId: m.userId,
        // rmB, not the family's rmA — a different formulation.
        lines: [
          { mtrl_type: "rm", mtrl_id: m.rmB, amount: 100, uom: "%" },
          { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" },
        ],
      }),
      /variant cannot change it|set on/i
    )

    // Nothing was created for the variant.
    const [rows] = await conn.execute<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM master_recipe WHERE sku_id = ?`, [variant.id]
    )
    assert.equal(Number(rows[0].c), 0)
  })
})

test("createRecipeVersion refuses an RM change that would strand live siblings", async () => {
  // The other direction: the SKU may legitimately change RM (it is the base, or
  // no base is marked), but a CSV cannot fan out to siblings — that needs the
  // reviewed approval flow. Refuse rather than split the family.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 996000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)

    // Base is the marked RM owner, so it is NOT locked...
    await conn.execute(`UPDATE master_skus SET is_base_sku = 1 WHERE id = ?`, [base.id])
    await makeActiveRecipe(
      conn, base.id, `${base.sku_code}-RM1-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }],
      m.userId
    )
    // ...but the variant is live on the current formulation.
    await makeActiveRecipe(
      conn, variant.id, `${variant.sku_code}-RM1-PM1`,
      [{ mtrl_type: "rm", mtrl_id: m.rmA, amount: 100, uom: "%" },
       { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" }],
      m.userId
    )

    await assert.rejects(
      () => createRecipeVersionForTest(conn, {
        skuId: base.id, skuCode: base.sku_code, userId: m.userId,
        lines: [
          { mtrl_type: "rm", mtrl_id: m.rmB, amount: 100, uom: "%" },
          { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" },
        ],
      }),
      /old formulation|Recipe Master/i
    )
  })
})

test("a PM-only bulk revision on a variant is still allowed", async () => {
  // The guard must not become "variants can never be touched" — PM is exactly
  // the half that legitimately differs per pack size.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 997000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const variant = await makeSku(conn, brand, sno, m.userId)

    const familyRm = { mtrl_type: "rm" as const, mtrl_id: m.rmA, amount: 100, uom: "%" }
    await makeActiveRecipe(
      conn, base.id, `${base.sku_code}-RM4-PM1`,
      [familyRm, { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }],
      m.userId, { rm: 4, pm: 1 }
    )

    const created = await createRecipeVersionForTest(conn, {
      skuId: variant.id, skuCode: variant.sku_code, userId: m.userId,
      lines: [familyRm, { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 7, uom: "pcs" }],
    })
    const header = await readHeader(conn, created)
    assert.equal(Number(header.rm_version), 4, "joins the family's RM version")
    assert.equal(Number(header.pm_version), 1)
  })
})

test("the drift audit query finds a split family, and ignores a family in step", async () => {
  // Pins the DETECTOR, not the live data — asserting the whole schema is clean
  // would make this test a report on production rather than a test of code, and
  // it would fail for reasons no code change can fix. Seeds a known split inside
  // the rollback, proves the query reports it, and proves it stays quiet for a
  // family that agrees.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const preexisting = async () => {
      const [rows] = await conn.execute<(RowDataPacket & { brand: string; members: string })[]>(
        recipeSql.selectVariantFamiliesWithRmDrift
      )
      return rows
    }
    const before = (await preexisting()).length

    // A family that AGREES — must not be reported.
    const okBrand = testCode("BRAND")
    const okSno = 998000 + (process.pid % 1000)
    const okA = await makeSku(conn, okBrand, okSno, m.userId)
    const okB = await makeSku(conn, okBrand, okSno, m.userId)
    const sameRm = { mtrl_type: "rm" as const, mtrl_id: m.rmA, amount: 100, uom: "%" }
    await makeActiveRecipe(conn, okA.id, `${okA.sku_code}-RM2-PM1`,
      [sameRm, { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }], m.userId, { rm: 2, pm: 1 })
    await makeActiveRecipe(conn, okB.id, `${okB.sku_code}-RM2-PM1`,
      [sameRm, { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" }], m.userId, { rm: 2, pm: 1 })
    assert.equal((await preexisting()).length, before, "a family in step must not be reported")

    // A family that DISAGREES — must be reported, exactly once.
    const badBrand = testCode("BRAND")
    const badSno = 999000 + (process.pid % 1000)
    const badA = await makeSku(conn, badBrand, badSno, m.userId)
    const badB = await makeSku(conn, badBrand, badSno, m.userId)
    await makeActiveRecipe(conn, badA.id, `${badA.sku_code}-RM3-PM1`,
      [sameRm, { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" }], m.userId, { rm: 3, pm: 1 })
    await makeActiveRecipe(conn, badB.id, `${badB.sku_code}-RM1-PM1`,
      [sameRm, { mtrl_type: "pm", mtrl_id: m.pmVariant, amount: 3, uom: "pcs" }], m.userId, { rm: 1, pm: 1 })

    const after = await preexisting()
    assert.equal(after.length, before + 1)
    const found = after.find((r) => r.brand === badBrand)
    assert.ok(found, "the split family must be reported")
    assert.match(found.members, new RegExp(`${badA.sku_code}=RM3`))
    assert.match(found.members, new RegExp(`${badB.sku_code}=RM1`))
  })
})

test("a sibling with no recipe of its own is skipped, not half-created", async () => {
  // rmPropagationTargets already filters these out, so a variant_child item for
  // one only arrives if the sibling's recipe vanished between submit and
  // approve. It must be a no-op, not a recipe with no PM lines.
  await withRollback(async (conn) => {
    const m = await materials(conn)
    if (!m) return

    const brand = testCode("BRAND")
    const sno = 992000 + (process.pid % 1000)
    const base = await makeSku(conn, brand, sno, m.userId)
    const bare = await makeSku(conn, brand, sno, m.userId) // no recipe at all

    const baseRecipeId = await makePendingRecipe(conn, base.id, `${base.sku_code}-RM2-PM1`, m.userId)
    await bomHandler.applyAndArchive(conn, baseRecipeId, [
      { field_name: "__mode__", old_value: "", new_value: "new-version" },
      { field_name: "__reason__", old_value: "", new_value: "switched preservative" },
      ...lineItems([
        { mtrl_type: "rm", mtrl_id: m.rmB, amount: 100, uom: "%" },
        { mtrl_type: "pm", mtrl_id: m.pmBase, amount: 1, uom: "pcs" },
      ]),
      { field_name: `variant_child:${bare.id}`, old_value: "", new_value: bare.sku_code },
    ], m.userId)

    const [rows] = await conn.execute<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM master_recipe WHERE sku_id = ?`, [bare.id]
    )
    assert.equal(Number(rows[0].c), 0, "no recipe should be invented for a sibling that had none")
    // The base's own approval still went through — one bad sibling must not
    // take the whole approval down with it.
    assert.equal((await readHeader(conn, baseRecipeId)).status, "active")
  })
})
