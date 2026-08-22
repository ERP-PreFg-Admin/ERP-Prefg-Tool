// ── Recipe (spans master_recipe + details_recipe + history_recipe), BOM_BULK (spans
// master_recipe + details_recipe, one new Recipe per sku_code group in an uploaded
// file) ─────────────────────────────────────────────────────────────────────
//
// Recipe: one handler covers both "create new version" and "update existing in
// place", since both converge on the same master_recipe.status lifecycle. The
// mode and the full RM/PM line diff are encoded as flat approval_items rows
// (see app/api/v1/masters/recipe-master/route.ts for how they're written at submit
// time):
//   - a "__mode__" sentinel item: new_value is "new-version" | "update-existing"
//   - a "__reason__" / "__change_type__" sentinel item (optional — omitted
//     for the very first Recipe created for a SKU): the submitter's free-text
//     reason and comma-joined "rm"/"pm" change-type tags. Neither is
//     consumed here — parseBomLineItems below only cares about line:*/
//     artifact:* items — they exist purely for the approval/history UI
//     (app/approvals/approval-card/RecipeLineDiffTable.tsx). Kept as sentinel
//     approval_items rather than a new approvals column so they don't
//     collide with approvals.remarks, which already means the APPROVER's
//     rejection note.
//   - one item per (mtrl_type, mtrl_id, field) tuple: field_name =
//     "line:<rm|pm>:<mtrl_id>:<field>", e.g. "line:rm:12:amount"
//   - a dropped line (present before, absent from the new submission) gets a
//     synthetic "line:<type>:<id>:__removed__" marker (old="1", new="")
//
// details_recipe rows are only ever written HERE, at approval time, for BOTH
// modes — never at submit time. This keeps half-approved formulations out of
// costing/reporting queries that join details_recipe with no status filter, and
// keeps the CURRENT lines of an "update existing" Recipe fully live/queryable
// while its edit is pending.
//
// BOM_BULK: unlike every other *_BULK handler (one CSV row = one entity), a
// Recipe is a header + N RM/PM lines, so rows are grouped by sku_code first.
// Each group always creates a NEW Recipe version — this never updates an
// existing Recipe in place (that's bomHandler's job, for the single-Recipe
// wizard). If a SKU already has an active Recipe, the group is NOT blocked: it
// still creates another new version, which supersedes the old one below,
// exactly like bomHandler's own "only one active Recipe per SKU" invariant.
//
// Validation is all-or-nothing PER GROUP: every line must resolve (SKU
// exists and is active, material code resolves to an active RM/PM, positive
// amount, effective_from present) and RM lines must total 99.9-100.1%, or
// the WHOLE group is skipped — never a partially-inserted Recipe. Other groups
// in the same file still proceed (file-level partial success), matching the
// existing inserted/skipped counter convention used by rmBulkHandler/pmBulkHandler.

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { skus as skuSql } from "@/lib/queries/skus"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { bom as recipeSql } from "@/lib/queries/recipe"
import { approvalsSql } from "@/lib/queries/approvals"
import { diffBomLines, resolveRecipeVersions, type DiffableLine } from "@/lib/masters/recipe-version"
import { describeRmDrift, rmLineageHead, resolveRmLock, type FamilyMember } from "@/lib/masters/variant-rm-lock"
import { isRmTotalValid } from "@/lib/validation/recipe"
import { deleteFile } from "@/lib/s3"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import logger from "@/lib/logger"
import { type DiffItem, type ModuleHandler, s3KeyOf } from "./types"

type RecipeLineDiff = {
  mtrlType: "rm" | "pm"
  mtrlId: number
  removed: boolean
  fields: Record<string, string> // field -> new_value
}

type RecipeArtifactAdd = { s3_key: string; file_name: string }

function parseBomLineItems(items: DiffItem[]): {
  mode: "new-version" | "update-existing"
  lines: RecipeLineDiff[]
  artifactAdds: RecipeArtifactAdd[]
  artifactRemoveIds: number[]
} {
  const modeItem = items.find((i) => i.field_name === "__mode__")
  const mode: "new-version" | "update-existing" =
    modeItem?.new_value === "update-existing" ? "update-existing" : "new-version"

  const lineMap = new Map<string, RecipeLineDiff>()
  const artifactAdds: RecipeArtifactAdd[] = []
  const artifactRemoveIds: number[] = []
  for (const it of items) {
    const lineMatch = it.field_name.match(/^line:(rm|pm):(\d+):(.+)$/)
    if (lineMatch) {
      const [, mtrlType, mtrlIdStr, field] = lineMatch
      const key = `${mtrlType}:${mtrlIdStr}`
      if (!lineMap.has(key)) {
        lineMap.set(key, { mtrlType: mtrlType as "rm" | "pm", mtrlId: Number(mtrlIdStr), removed: false, fields: {} })
      }
      const entry = lineMap.get(key)!
      if (field === "__removed__") entry.removed = true
      else entry.fields[field] = it.new_value
      continue
    }
    if (it.field_name.startsWith("artifact:add:")) {
      artifactAdds.push(JSON.parse(it.new_value!) as RecipeArtifactAdd)
      continue
    }
    const removeMatch = it.field_name.match(/^artifact:remove:(\d+)$/)
    if (removeMatch) artifactRemoveIds.push(Number(removeMatch[1]))
  }
  return { mode, lines: [...lineMap.values()], artifactAdds, artifactRemoveIds }
}

type RecipeLine = { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number; uom: string | null }

/** A details_recipe row as read back — amount is DECIMAL, so a string. */
type StoredRecipeLine = { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: string | number; uom: string | null }

/**
 * This SKU's variant family's current RM and the version it sits at, or null
 * when the SKU is in no family (or nobody in it has a recipe yet).
 *
 * The write-side counterpart of the same lookup the submit route does — RM is
 * family-scoped, so its version has to be read from the family, not the SKU.
 */
async function readFamily(conn: PoolConnection, skuId: number | null): Promise<FamilyMember[]> {
  if (skuId == null) return []
  const [rows] = await conn.execute(skuSql.selectVariantFamilyBySkuId, [skuId])
  return rows as FamilyMember[]
}

async function resolveFamilyRm(
  conn: PoolConnection,
  skuId: number
): Promise<{ version: number; lines: DiffableLine[] } | null> {
  const head = rmLineageHead(await readFamily(conn, skuId))
  if (!head?.active_recipe_id) return null

  const [headLines] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [head.active_recipe_id])
  return {
    version: Number(head.rm_version ?? 0),
    lines: (headLines as StoredRecipeLine[]).map((r) => ({
      mtrl_type: r.mtrl_type, mtrl_id: r.mtrl_id, amount: r.amount, uom: r.uom,
    })),
  }
}

/**
 * Create ONE new, already-approved Recipe version for a SKU: header + lines +
 * history snapshot + active_bom_id + a synthetic resolved 'BOM' approval, then
 * supersede whatever it replaces.
 *
 * Extracted because two callers need the identical sequence and a third copy
 * would be where they silently drift:
 *   - bomBulkHandler, one version per sku_code group in an uploaded CSV
 *   - bomHandler's variant fan-out, one version per sibling of a base SKU whose
 *     RM just changed
 *
 * Exported so tests/db/recipe-variant-propagation.test.ts can drive the
 * numbering against real SQL — the submit route owns its own transaction and so
 * cannot run under withRollback (see tests/helpers/db.ts).
 *
 * The synthetic approval is not bookkeeping for its own sake — the Recipe list's
 * change_reason/change_type columns and the row-level History dialog both read
 * module='BOM' approval_items (see CHANGE_REASON_SUBQUERY in
 * lib/queries/recipe.ts), so a version created without one shows up blank.
 *
 * Takes an ALREADY-OPEN connection and never opens a transaction of its own —
 * a nested beginTransaction() implicitly COMMITs in MySQL, which would make the
 * approve route's rollback a no-op. Throws on a rule violation so a caller that
 * processes many SKUs (bulk) can catch per item and keep going.
 */
export async function createRecipeVersion(
  conn: PoolConnection,
  opts: {
    skuId: number
    skuCode: string
    lines: RecipeLine[]
    effectiveFrom: string
    /** Credited as the author of this version (master_recipe.created_by). */
    createdBy: number
    approverId: number
    /** Raiser of the synthetic approval — the original submitter, where known. */
    raisedBy: number
    reason: string | null
    changeType: ("rm" | "pm")[]
    /** Explicit bom_code (bulk CSV only); otherwise <sku>-RM<n>-PM<n>. */
    bomCode?: string | null
    /** Appended to the "Recipe discontinued" log line, e.g. "bulk upload". */
    supersededBy: string
  }
): Promise<{ recipeId: number; bomCode: string; linesInserted: number }> {
  const { skuId, skuCode, lines, effectiveFrom, createdBy, approverId, raisedBy } = opts

  const [priorRows] = await conn.execute(recipeSql.selectMostRecentBomForSku, [skuId])
  const prior = (priorRows as { id: number; rm_version: number; pm_version: number }[])[0] ?? null
  let priorLines: DiffableLine[] = []
  if (prior) {
    const [priorLineRows] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [prior.id])
    priorLines = (priorLineRows as StoredRecipeLine[]).map((r) => ({
      mtrl_type: r.mtrl_type, mtrl_id: r.mtrl_id, amount: r.amount, uom: r.uom,
    }))
  }
  const newLines: DiffableLine[] = lines.map((l) => ({
    mtrl_type: l.mtrl_type, mtrl_id: l.mtrl_id, amount: l.amount, uom: l.uom,
  }))

  // RM numbers off the variant FAMILY's lineage, PM off this SKU's own — see
  // resolveRecipeVersions. Resolved here rather than passed in so every caller
  // gets it: the sibling fan-out (where the parent's just-activated recipe IS
  // the lineage head, so a sibling lands on the parent's exact rm_version) and
  // the CSV bulk path alike. Numbering RM per SKU is what once stamped a
  // variant's first recipe RM1 while its family was already on RM2.
  const family = await readFamily(conn, skuId)
  const familyRm = await resolveFamilyRm(conn, skuId)

  // Keep the family in step. create-full has its own copy of this check for the
  // wizard, but the CSV bulk path reaches active recipes through HERE and had no
  // check at all — an upload could hand one pack size a formulation none of its
  // siblings had. Both directions are refused, and a throw becomes that group's
  // skip reason in bulk's per-group catch.
  if (familyRm && diffBomLines(familyRm.lines, newLines).rmChanged) {
    const lock = resolveRmLock(skuId, family)
    if (lock.locked) {
      throw new Error(
        `RM for this variant family is set on ${lock.ownerSkuCode} — a variant cannot change it. ` +
        "Only the PM lines may differ per pack size."
      )
    }
    // Not locked, so this SKU may legitimately change RM — but siblings are
    // already live on the old formulation and a CSV cannot fan out to them
    // (that needs the reviewed approval flow, which stages one variant_child
    // item per sibling). Refuse rather than leave the family split.
    const others = family.filter((m) => m.id !== skuId && m.active_recipe_id != null)
    if (others.length > 0) {
      throw new Error(
        `changing RM here would leave its variants (${others.map((m) => m.sku_code).join(", ")}) ` +
        "on the old formulation. Submit the RM change from Recipe Master instead, which updates " +
        "the whole variant family in one approval."
      )
    }
  }

  const { rmVersion, pmVersion } = resolveRecipeVersions({ prior, priorLines, newLines, familyRm })
  const bomCode = opts.bomCode?.trim() || `${skuCode}-RM${rmVersion}-PM${pmVersion}`

  // Same "reason/change_type required once a prior Recipe exists" rule the
  // single-Recipe wizard enforces — a bulk upload or a fanned-out variant
  // version is a faster way to submit the SAME kind of change, not a different
  // one. Thrown rather than returned so bulk's per-group catch reports it as a
  // skip reason unchanged.
  if (prior && (!opts.reason || opts.changeType.length === 0)) {
    throw new Error("reason and type of change are required — a Recipe already exists for this SKU")
  }

  const [headerResult] = await conn.execute(recipeSql.insertBomHeaderWithVersions, [
    bomCode, skuId, createdBy, STATUS.ACTIVE, effectiveFrom, rmVersion, pmVersion,
  ])
  const recipeId = (headerResult as ResultSetHeader).insertId

  // Keep master_skus.active_bom_id in sync, or the SKU master list's bom_code
  // column (resolved from it) goes stale the moment this version lands.
  await conn.execute(skuSql.setActiveBomId, [recipeId, skuId])

  // The synthetic, already-resolved 'BOM' approval described above.
  const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [raisedBy, "BOM", recipeId, "create"])
  const approvalId = (approvalResult as ResultSetHeader).insertId
  await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__mode__", "", "new-version"])
  if (opts.reason) await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__reason__", "", opts.reason])
  if (opts.changeType.length > 0) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__change_type__", "", opts.changeType.join(",")])
  }

  let linesInserted = 0
  for (const line of lines) {
    await conn.execute(recipeSql.insertDetailLine, [
      recipeId, line.mtrl_type, line.mtrl_id, line.amount, line.uom, "active", approverId,
    ])
    // Per-line history_recipe archive, same as bomHandler's own new-version
    // path — keeps the History page's SKU-wise lineage complete regardless of
    // which path created the version.
    await conn.execute(recipeSql.archiveDetailLineToHistory, [
      recipeId, line.mtrl_type, line.mtrl_id, line.amount, line.uom, null,
      "active", createdBy, approverId,
    ])
    // Line-level diff items for the synthetic approval: every field is "new"
    // (old_value "") since a brand-new header has no prior state, same as
    // create-full's own new-version mode.
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:__present__`, "1", "1"])
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:amount`, "", String(line.amount)])
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:uom`, "", line.uom ?? ""])
    linesInserted++
  }
  // Applied already, so resolve it — otherwise it sits pending forever.
  await conn.execute(approvalsSql.markApproved, [approverId, approvalId])

  // "Only one active Recipe per SKU", gated on effective_from overlap so a
  // future-dated version doesn't prematurely discontinue the one it hasn't
  // superseded yet. Sibling ids are read FIRST — MySQL's UPDATE has no
  // RETURNING, so this is the only way to emit one event per superseded recipe.
  const [supersededRows] = await conn.execute(recipeSql.selectOtherActiveBomsForSku, [skuId, recipeId])
  const supersededIds = (supersededRows as { id: number }[]).map((r) => r.id)
  if (supersededIds.length > 0) {
    await conn.execute(recipeSql.discontinueOverlappingActiveBomsForSku, [skuId, recipeId, effectiveFrom])
    for (const oldId of supersededIds) {
      const deactivateEventId = makeEventId("BOM", "deactivate", oldId)
      logger.info({ module: "BOM", eventId: deactivateEventId, bomId: oldId, skuId, supersededBy: recipeId, message: `Recipe discontinued (superseded by ${opts.supersededBy})` })
      recordProcessedEvent("BOM", deactivateEventId, { bomId: oldId, skuId, supersededBy: recipeId })
    }
  }

  return { recipeId, bomCode, linesInserted }
}

/**
 * Fan a base SKU's approved RM change out to its variant family: every sibling
 * named by a `variant_child:<sku_id>` approval_item gets a new Recipe version
 * carrying the base's NEW RM lines and its OWN existing PM lines.
 *
 * Only the sku_id was staged at submit time (see create-full) — each sibling's
 * PM lines are read fresh here, so a PM edit that landed on a sibling between
 * submit and approve survives instead of being reverted to a stale snapshot.
 *
 * ATOMIC: a sibling that fails aborts the whole approval. The invariant is that
 * every active recipe in a family carries the same rm_version (see rmDrift), and
 * a partial fan-out breaks exactly that — one pack size manufactured against a
 * formulation nobody approved for it, silently, until someone reconciles two
 * costing sheets. Since this runs inside the approve route's transaction,
 * throwing rolls the base's own new version back too: the family moves together
 * or not at all, and the approval stays pending to be retried.
 *
 * A sibling with NO active recipe is still skipped rather than failed — it has
 * nothing to be out of step with, and inherits the RM when it first gets one.
 */
async function propagateRmToVariants(
  conn: PoolConnection,
  opts: {
    items: DiffItem[]
    parentRecipeId: number
    parentSkuId: number | null
    rmLines: RecipeLine[]
    effectiveFrom: string
    createdBy: number
    approverId: number
    reason: string | null
  }
): Promise<void> {
  const targets: { skuId: number; skuCode: string }[] = []
  for (const it of opts.items) {
    const m = it.field_name.match(/^variant_child:(\d+)$/)
    if (m) targets.push({ skuId: Number(m[1]), skuCode: it.new_value ?? `#${m[1]}` })
  }
  if (targets.length === 0) return

  for (const target of targets) {
    try {
      // The sibling's own PM lines, from whatever its current active Recipe is.
      const [priorRows] = await conn.execute(recipeSql.selectMostRecentBomForSku, [target.skuId])
      const prior = (priorRows as { id: number }[])[0] ?? null
      if (!prior) {
        logger.warn({ module: "BOM", bomId: opts.parentRecipeId, skuId: target.skuId, message: "Variant RM fan-out skipped — sibling has no Recipe to version" })
        continue
      }
      const [siblingLineRows] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [prior.id])
      const siblingPm: RecipeLine[] = (siblingLineRows as StoredRecipeLine[])
        .filter((r) => r.mtrl_type === "pm")
        .map((r) => ({ mtrl_type: "pm", mtrl_id: r.mtrl_id, amount: Number(r.amount), uom: r.uom }))

      const { recipeId, bomCode } = await createRecipeVersion(conn, {
        skuId: target.skuId,
        skuCode: target.skuCode,
        // The whole point: base's new RM + sibling's own PM.
        lines: [...opts.rmLines, ...siblingPm],
        effectiveFrom: opts.effectiveFrom,
        createdBy: opts.createdBy,
        approverId: opts.approverId,
        raisedBy: opts.createdBy,
        reason: opts.reason ?? `RM inherited from variant base (recipe #${opts.parentRecipeId})`,
        changeType: ["rm"],
        supersededBy: "variant RM change on the base SKU",
      })

      const eventId = makeEventId("BOM", "variant-propagate", recipeId)
      logger.info({ module: "BOM", eventId, bomId: recipeId, bomCode, skuId: target.skuId, parentRecipeId: opts.parentRecipeId, parentSkuId: opts.parentSkuId, message: "Variant sibling re-versioned with inherited RM" })
      recordProcessedEvent("BOM", eventId, { bomId: recipeId, bomCode, skuId: target.skuId, parentRecipeId: opts.parentRecipeId })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ module: "BOM", bomId: opts.parentRecipeId, skuId: target.skuId, err: message, message: "Variant RM fan-out failed — aborting the whole approval to keep the family in step" })
      // Rethrown, not swallowed: see this function's docblock. The approve
      // route's transaction rolls the base's version back with it.
      throw new Error(
        `Could not apply this RM change to variant ${target.skuCode}: ${message}. ` +
        "No part of the change was applied — the whole variant family must move together."
      )
    }
  }

  // Belt and braces: prove the family actually ended up in step rather than
  // trusting that every branch above did its job. Cheap (one query) next to what
  // it catches — a silent split formulation that only surfaces in costing.
  const drift = describeRmDrift(await readFamily(conn, opts.parentSkuId))
  if (drift) throw new Error(`Refusing to complete this approval: ${drift}.`)
}

export const bomHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(recipeSql.setBomStatus, [status, entityId])
  },

  async applyAndArchive(conn, entityId, items, approverId) {
    const { mode, lines, artifactAdds, artifactRemoveIds } = parseBomLineItems(items)

    const [headerRows] = await conn.execute(recipeSql.selectBomHeaderRawById, [entityId])
    const header = (headerRows as any[])[0]
    if (!header) throw new Error(`Recipe ${entityId} not found`)

    // Current lines, keyed the same way as the diff — used as a fallback for
    // any field that didn't change (and so has no approval_item), and as the
    // archival source for "update existing".
    const [currentRows] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [entityId])
    const currentByKey = new Map<string, any>(
      (currentRows as any[]).map((r) => [`${r.mtrl_type}:${r.mtrl_id}`, r])
    )

    if (mode === "update-existing") {
      // 1. Snapshot EVERY current line into history_recipe before touching anything.
      for (const cur of currentRows as any[]) {
        await conn.execute(recipeSql.archiveDetailLineToHistory, [
          cur.recipe_id, cur.mtrl_type, cur.mtrl_id, cur.amount, cur.uom, null,
          cur.status, cur.updated_by ?? approverId, approverId,
        ])
      }
      // 2. Wipe current lines; the new set (minus removed ones) is reinserted below.
      await conn.execute(recipeSql.deleteDetailLinesByBomId, [entityId])
    }

    // Collected as they're inserted so the variant fan-out below can hand each
    // sibling the RM lines EXACTLY as approved here — resolved values, after the
    // currentByKey fallback, not the raw approval_items.
    const approvedRmLines: RecipeLine[] = []

    for (const line of lines) {
      if (line.removed) continue // update-existing only: line dropped, don't reinsert
      const key = `${line.mtrlType}:${line.mtrlId}`
      const cur = currentByKey.get(key)
      const amount = Number(line.fields.amount ?? cur?.amount ?? 0)
      const uom = line.fields.uom ?? cur?.uom ?? null
      if (line.mtrlType === "rm") {
        approvedRmLines.push({ mtrl_type: "rm", mtrl_id: line.mtrlId, amount, uom })
      }
      await conn.execute(recipeSql.insertDetailLine, [
        entityId, line.mtrlType, line.mtrlId, amount, uom, "active", approverId,
      ])
      // new-version: no prior line-state to snapshot (that's what
      // update-existing's step 1 above does) — instead, archive THIS
      // version's own lines as they're approved, so history_recipe ends up
      // with a full line-level record of every Recipe version, grouped by SKU
      // via master_recipe, not just in-place overwrites.
      if (mode === "new-version") {
        await conn.execute(recipeSql.archiveDetailLineToHistory, [
          entityId, line.mtrlType, line.mtrlId, amount, uom, null,
          "active", header.created_by, approverId,
        ])
      }
    }

    // 3. Artifacts (artifacts_recipe) — only ever written/deleted here, at
    //    approval time. Adds/removes were staged client-side and bundled
    //    into this same approval (see app/api/v1/masters/recipe-master/route.ts).
    for (const artifact of artifactAdds) {
      await conn.execute(recipeSql.insertArtifact, [entityId, artifact.s3_key, artifact.file_name, approverId])
    }
    if (artifactRemoveIds.length > 0) {
      // .query (not .execute) — prepared statements don't support expanding
      // an array param into "IN (?)"'s comma-separated list the way .query does.
      const [removedRows] = await conn.query(recipeSql.selectArtifactsByIds, [entityId, artifactRemoveIds])
      await conn.query(recipeSql.deleteArtifactsByIds, [entityId, artifactRemoveIds])
      for (const removed of removedRows as any[]) {
        // Best-effort — not transactional with the DB delete above, same as
        // every other S3-key cleanup in this codebase.
        deleteFile(removed.s3_key).catch((err) => {
          logger.warn({ module: "BOM", bomId: entityId, s3Key: removed.s3_key, err: err.message, message: "Failed to delete artifact from S3" })
        })
      }
    }

    // 4. Activate this Recipe and deactivate any other active Recipe for the same
    //    sku_id — enforces "only one active Recipe per SKU" at approval time.
    await conn.execute(recipeSql.setBomStatusWithUpdater, [STATUS.ACTIVE, approverId, entityId])
    const bomActivateEventId = makeEventId("BOM", "activate", entityId)
    logger.info({ module: "BOM", eventId: bomActivateEventId, bomId: entityId, skuId: header.sku_id, approverId, message: "Recipe activated" })
    recordProcessedEvent("BOM", bomActivateEventId, { bomId: entityId, skuId: header.sku_id, approverId })

    if (header.sku_id) {
      // Keep master_skus.active_bom_id pointed at the version that's
      // actually active — otherwise the SKU master list's bom_code column
      // (resolved from active_bom_id) goes stale the moment a new version
      // is approved.
      await conn.execute(skuSql.setActiveBomId, [entityId, header.sku_id])

      // Read the sibling ids BEFORE deactivating — MariaDB's UPDATE has no
      // RETURNING, so this is the only way to know which Recipes are about to
      // be deactivated and log/emit one event per sibling, not one for the
      // whole batch.
      const [siblingRows] = await conn.execute(recipeSql.selectOtherActiveBomsForSku, [header.sku_id, entityId])
      const siblingIds = (siblingRows as any[]).map((r) => r.id)

      if (siblingIds.length > 0) {
        await conn.execute(recipeSql.discontinueOverlappingActiveBomsForSku, [header.sku_id, entityId, header.effective_from])
        for (const siblingId of siblingIds) {
          const bomDeactivateEventId = makeEventId("BOM", "deactivate", siblingId)
          logger.info({ module: "BOM", eventId: bomDeactivateEventId, bomId: siblingId, skuId: header.sku_id, supersededBy: entityId, message: "Recipe discontinued (superseded)" })
          recordProcessedEvent("BOM", bomDeactivateEventId, { bomId: siblingId, skuId: header.sku_id, supersededBy: entityId })
        }
      }
    }

    // 5. Variant-family fan-out. RM is family-scoped, so a base SKU's approved
    //    RM change has to reach every sibling that already has a recipe — one
    //    approval, the whole family. Staged as variant_child:<sku_id> items at
    //    submit time; a no-op when there are none (every recipe that isn't a
    //    base-SKU RM change). Runs LAST, after this recipe is fully applied and
    //    activated, so a sibling can never be re-versioned off a half-written
    //    parent.
    await propagateRmToVariants(conn, {
      items,
      parentRecipeId: entityId,
      parentSkuId: header.sku_id ?? null,
      rmLines: approvedRmLines,
      effectiveFrom: header.effective_from,
      createdBy: header.created_by,
      approverId,
      reason: items.find((i) => i.field_name === "__reason__")?.new_value ?? null,
    })
  },
}

export const bomBulkHandler: ModuleHandler = {
  async setStatus() {
    // No entity exists before approval — nothing to roll back on reject.
  },

  async applyAndArchive(conn, _entityId, items, approverId, raisedBy) {
    const s3Key = s3KeyOf(items, "BOM_BULK")
    const rows = await parseS3Import(s3Key)
    if (rows.length === 0) throw new Error("BOM_BULK: file has no data rows")

    const groups = new Map<string, typeof rows>() // sku_code -> its CSV rows, first-seen order
    for (const row of rows) {
      const skuCode = row.sku_code?.trim()
      if (!skuCode) continue
      if (!groups.has(skuCode)) groups.set(skuCode, [])
      groups.get(skuCode)!.push(row)
    }

    let bomsCreated = 0
    let groupsSkipped = 0
    let linesInserted = 0
    const skipReasons: string[] = []

    for (const [skuCode, groupRows] of groups) {
      try {
        const [skuRows] = await conn.execute(skuSql.selectByCode, [skuCode])
        const sku = (skuRows as any[])[0]
        if (!sku) { groupsSkipped++; skipReasons.push(`${skuCode}: SKU not found`); continue }
        if (sku.status !== STATUS.ACTIVE) { groupsSkipped++; skipReasons.push(`${skuCode}: SKU is not active`); continue }

        const lines: { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number; uom: string | null }[] = []
        let groupError: string | null = null

        for (const row of groupRows) {
          const mtrlType = row.mtrl_type?.trim().toLowerCase()
          if (mtrlType !== "rm" && mtrlType !== "pm") { groupError = `invalid mtrl_type "${row.mtrl_type}"`; break }

          const codeQuery = mtrlType === "rm" ? rmSql.selectByCode : pmSql.selectByCode
          const [matRows] = await conn.execute(codeQuery, [row.mtrl_code?.trim()])
          const material = (matRows as any[])[0]
          if (!material) { groupError = `material code "${row.mtrl_code}" not found`; break }
          if (material.status !== STATUS.ACTIVE) { groupError = `material code "${row.mtrl_code}" is not active`; break }

          const amount = Number(row.amount)
          if (!Number.isFinite(amount) || amount <= 0) { groupError = `invalid amount "${row.amount}"`; break }

          lines.push({
            mtrl_type: mtrlType,
            mtrl_id: material.id,
            amount,
            uom: row.uom?.trim() || material.uom || null,
          })
        }
        if (groupError) { groupsSkipped++; skipReasons.push(`${skuCode}: ${groupError}`); continue }
        const effectiveFrom = groupRows[0].effective_from?.trim()
        if (!effectiveFrom) { groupsSkipped++; skipReasons.push(`${skuCode}: missing effective_from`); continue }

        const rmTotal = lines.filter((l) => l.mtrl_type === "rm").reduce((sum, l) => sum + l.amount, 0)
        if (!isRmTotalValid(rmTotal)) {
          groupsSkipped++
          skipReasons.push(`${skuCode}: RM total ${rmTotal.toFixed(2)}% out of range`)
          continue
        }

        const changeTypeRaw = groupRows[0].change_type?.trim().toLowerCase()
        const changeType: ("rm" | "pm")[] =
          changeTypeRaw === "both" ? ["rm", "pm"] : changeTypeRaw === "rm" || changeTypeRaw === "pm" ? [changeTypeRaw] : []

        // Everything from here — version numbers, header, lines, history,
        // active_bom_id, the synthetic approval, supersession — is the same
        // sequence the variant fan-out needs, so it lives in
        // createRecipeVersion. A rule violation (e.g. a missing reason when the
        // SKU already has a Recipe) throws and is caught below as this group's
        // skip reason, exactly as when the check was inline here.
        const created = await createRecipeVersion(conn, {
          skuId: sku.id,
          skuCode,
          lines,
          effectiveFrom,
          createdBy: approverId,
          approverId,
          raisedBy: raisedBy ?? approverId,
          reason: groupRows[0].reason?.trim() || null,
          changeType,
          // An explicit code from the CSV wins; otherwise the same
          // <sku_code>-RM<n>-PM<n> scheme the wizard path uses, so a
          // bulk-uploaded Recipe's code format never differs from a manual one.
          bomCode: groupRows[0].bom_code?.trim() || null,
          supersededBy: "bulk upload",
        })
        linesInserted += created.linesInserted
        bomsCreated++
      } catch (err: any) {
        groupsSkipped++
        skipReasons.push(`${skuCode}: ${err.message}`)
      }
    }

    const eventId = makeEventId("BOM_BULK", "apply")
    logger.info({ module: "BOM_BULK", eventId, s3Key, bomsCreated, groupsSkipped, linesInserted, message: "Recipe bulk upload applied" })
    recordProcessedEvent("BOM_BULK", eventId, { s3Key, bomsCreated, groupsSkipped, linesInserted, skipReasons })
    if (bomsCreated === 0) {
      throw new Error(`BOM_BULK: no Recipes created. ${skipReasons.join("; ")}`)
    }
  },
}
