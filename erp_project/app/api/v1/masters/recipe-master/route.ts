// POST /api/v1/masters/recipe-master
//
// Two actions backing the Recipe creation wizard (app/masters/recipe-master/RecipeCreationWizard.tsx):
//   check-existing — dry-run, fired the instant a SKU is picked (Step 1), tells
//                    the wizard whether that SKU already has an active Recipe.
//   create-full    — single atomic submit for BOTH "new-version" and
//                    "update-existing", from either manual entry or the CSV
//                    step. Inserts/locks the master_recipe header and raises one
//                    approval encoding the full RM/PM line diff, plus any
//                    staged artifact add/remove, as approval_items —
//                    details_recipe/artifacts_recipe are only written at approval
//                    time (see lib/approvals/module-handlers.ts).
//   update-status  — direct, immediate master_recipe.status change from the Edit
//                    Recipe dialog. No approval gate (unlike create-full) —
//                    blocked only while an approval is already pending for
//                    this Recipe. Setting "active" also deactivates any other
//                    active Recipe for the same SKU, same invariant as
//                    bomHandler.applyAndArchive enforces on approval.
//
// This replaces the old action:"create"/"bulk" pair, which inserted directly
// with no approval gate and referenced non-existent master_recipe.sku_code/mfg_id
// columns (broken against the real schema — see lib/queries/bom.ts).

import { NextResponse } from "next/server"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertSkuIdInBrandScope } from "@/lib/brand-guard"
import { bomActionSchema, isRmTotalValid, RM_TOTAL_MIN, RM_TOTAL_MAX } from "@/lib/validation/recipe"
import { bom as recipeSql, RECIPE_STATUS_IN_REVIEW } from "@/lib/queries/recipe"
import { skus as skuSql } from "@/lib/queries/skus"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { approvalsSql } from "@/lib/queries/approvals"
import { STATUS } from "@/lib/constants"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { stageBulkUploadApproval, uploadRowsAsCsv } from "@/lib/master-routes/bulk-approval"
import { diffBomLines, type DiffableLine } from "@/lib/masters/recipe-version"
import { monthIST } from "@/lib/date"

type RecipeHeaderRow = { id: number; bom_code: string; sku_id: number; status: string; created_by: number; effective_from: string | null }
type MostRecentBomRow = { id: number; bom_code: string; rm_version: number; pm_version: number }
type RecipeDetailLineRow = {
  id: number; recipe_id: number; mtrl_type: string; mtrl_id: number
  amount: number; uom: string | null
  status: string; updated_by: number
  [key: string]: unknown
}
type SkuLookupRow = { id: number; sku_code: string; status: string }
type MaterialLookupRow = { id: number; uom: string; status: string }

export const POST = withGateway({
  schema: bomActionSchema,
  access: { pageSlug: "/masters/recipe-master", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // ── check-existing: dry-run, no mutation ──────────────────────────────
    if (body.action === "check-existing") {
      const [rows, allBoms] = await Promise.all([
        query<{ recipe_id: number; bom_code: string; status: string }>(
          recipeSql.selectActiveBomBySkuId,
          [body.sku_id]
        ),
        query(recipeSql.selectBomsBySkuId, [body.sku_id]),
      ])
      const active = rows[0] ?? null
      return NextResponse.json({
        hasActive: !!active,
        recipe_id: active?.recipe_id ?? null,
        bom_code: active?.bom_code ?? null,
        bom_count: allBoms.length,
      })
    }

    // ── create-full: single atomic submit ─────────────────────────────────
    if(body.action == "create-full") {
      const eventId = makeEventId("BOM", "submit", body.sku_id)
      const logCtx = { ...ctx, eventId, module: "BOM" }

      // A recipe belongs to its SKU's brand, so building one is a write against
      // that brand.
      await assertSkuIdInBrandScope(Number(session.user.id), body.sku_id)
      logger.info({ ...logCtx, skuId: body.sku_id, mode: body.mode, lineCount: body.rm_lines.length + body.pm_lines.length, message: "Recipe submit started" })
      recordRawEvent("BOM", eventId, { skuId: body.sku_id, mode: body.mode, lineCount: body.rm_lines.length + body.pm_lines.length, source: body.source })

      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        let bomId: number
        let bomCode: string | undefined

        if (body.mode === "new-version") {
          const [skuRows] = await conn.execute(skuSql.selectById, [body.sku_id])
          const skuRow = (skuRows as { sku_code: string }[])[0]
          if (!skuRow) throw new ApiError(404, "not_found", "SKU not found.")

          const [priorRows] = await conn.execute(recipeSql.selectMostRecentBomForSku, [body.sku_id])
          const prior = (priorRows as MostRecentBomRow[])[0] ?? null

          let priorLines: DiffableLine[] = []
          if (prior) {
            const [priorLineRows] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [prior.id])
            priorLines = (priorLineRows as RecipeDetailLineRow[]).map((r) => ({
              mtrl_type: r.mtrl_type as "rm" | "pm", mtrl_id: r.mtrl_id, amount: r.amount, uom: r.uom,
            }))
          }
          const newLines: DiffableLine[] = [...body.rm_lines, ...body.pm_lines].map((l) => ({
            mtrl_type: l.mtrl_type, mtrl_id: l.mtrl_id, amount: l.amount, uom: l.uom,
          }))
          const { rmChanged, pmChanged } = diffBomLines(priorLines, newLines)
          const rmVersion = !prior || rmChanged ? (prior?.rm_version ?? 0) + 1 : prior.rm_version
          const pmVersion = !prior || pmChanged ? (prior?.pm_version ?? 0) + 1 : prior.pm_version
          bomCode = `${skuRow.sku_code}-RM${rmVersion}-PM${pmVersion}`

          // A prior Recipe exists for this SKU — this submission is really an
          // edit to an established recipe, so require the submitter to say
          // why and what kind of change it is. The very first Recipe ever
          // created for a SKU (prior === null) has nothing to explain yet.
          if (prior && (!body.reason?.trim() || !body.change_type?.length)) {
            throw new ApiError(400, "reason_required", "A reason and type of change (RM/PM) are required when revising an existing Recipe.")
          }

          const [result] = await conn.execute(recipeSql.insertBomHeaderWithVersions, [
            bomCode, body.sku_id, userId, RECIPE_STATUS_IN_REVIEW, body.effective_from!.trim(), rmVersion, pmVersion,

          ])
          bomId = (result as ResultSetHeader).insertId
        } else {
          bomId = body.recipe_id!
          const [rows] = await conn.execute(recipeSql.selectBomHeaderRawById, [bomId])
          const cur = (rows as RecipeHeaderRow[])[0]
          if (!cur) throw new ApiError(404, "not_found", "Recipe not found.")
          if (cur.sku_id !== body.sku_id) {
            throw new ApiError(400, "sku_mismatch", "This Recipe does not belong to the selected SKU.")
          }
          const pending = await query(approvalsSql.hasPending, ["BOM", bomId])
          if (pending.length > 0) {
            throw new ApiError(409, "pending_approval", "This Recipe already has a pending approval.")
          }
          // update-existing is always an edit to an established Recipe — reason
          // and change type are mandatory here (unlike new-version's first-
          // Recipe-for-a-SKU exemption above).
          if (!body.reason?.trim() || !body.change_type?.length) {
            throw new ApiError(400, "reason_required", "A reason and type of change (RM/PM) are required when revising an existing Recipe.")
          }
          await conn.execute(recipeSql.setBomStatus, [RECIPE_STATUS_IN_REVIEW, bomId])
        }

        // Diff against the CURRENT lines for update-existing (real old values,
        // rmVrmHandler-style); for new-version there is no prior state, so
        // every field's old_value is "" (MFG "diff from nothing" style).
        let currentByKey = new Map<string, RecipeDetailLineRow>()
        if (body.mode === "update-existing") {
          const [curRows] = await conn.execute(recipeSql.selectDetailLinesRawByBomId, [bomId])
          currentByKey = new Map((curRows as RecipeDetailLineRow[]).map((r) => [`${r.mtrl_type}:${r.mtrl_id}`, r]))
        }

        const [approvalResult] = await conn.execute(
          approvalsSql.insertApproval,
          [userId, "BOM", bomId, body.mode === "new-version" ? "create" : "edit"]
        )
        const approvalId = (approvalResult as ResultSetHeader).insertId
        await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__mode__", "", body.mode])
        // Reason + type of change — stored as sentinel approval_items (same
        // convention as __mode__ above) rather than approvals.remarks, which
        // is already used for the APPROVER's rejection note and would
        // otherwise collide with the SUBMITTER's reason for this edit.
        if (body.reason?.trim()) {
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__reason__", "", body.reason.trim()])
        }
        if (body.change_type?.length) {
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__change_type__", "", body.change_type.join(",")])
        }

        const allLines = [...body.rm_lines, ...body.pm_lines]
        const seenKeys = new Set<string>()
        for (const line of allLines) {
          const key = `${line.mtrl_type}:${line.mtrl_id}`
          seenKeys.add(key)
          const cur = currentByKey.get(key)
          // Always write a marker for this line, even with zero changed
          // fields — otherwise a line resubmitted unchanged has NO
          // approval_item at all, parseBomLineItems never sees it, and
          // applyAndArchive's wipe-then-reinsert-from-diff step would drop
          // it permanently. This is what makes an "artifact-only" edit (no
          // line changes) safe to bundle into the same create-full submit.
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:__present__`, "1", "1",
          ])
          const fieldVals: [string, string][] = [
            ["amount", String(line.amount)],
            ["uom", line.uom ?? ""],
          ]
          for (const [field, newVal] of fieldVals) {
            const oldVal = cur ? String(cur[field] ?? "") : ""
            if (oldVal !== newVal) {
              await conn.execute(approvalsSql.insertApprovalItem, [
                approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:${field}`, oldVal, newVal,
              ])
            }
          }
        }
        // Lines present in the current Recipe but absent from this submission
        // (update-existing only) — mark as removed so applyAndArchive drops them.
        for (const [key] of currentByKey) {
          if (!seenKeys.has(key)) {
            const [mtrlType, mtrlId] = key.split(":")
            await conn.execute(approvalsSql.insertApprovalItem, [
              approvalId, `line:${mtrlType}:${mtrlId}:__removed__`, "1", "",
            ])
          }
        }

        // Artifacts (artifacts_recipe) are bundled into this same approval —
        // actually written/deleted only at approval time, see
        // bomHandler.applyAndArchive.
        for (const [i, artifact] of (body.artifact_adds ?? []).entries()) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId, `artifact:add:${i}`, "", JSON.stringify(artifact),
          ])
        }
        for (const artifactId of body.artifact_removes ?? []) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId, `artifact:remove:${artifactId}`, "1", "",
          ])
        }

        await conn.commit()
        logger.info({ ...logCtx, bomId, approvalId, message: "Recipe submitted for approval" })
        recordProcessedEvent("BOM", eventId, { bomId, approvalId, skuId: body.sku_id, mode: body.mode })
        return NextResponse.json({ ok: true, recipe_id: bomId, approval_id: approvalId, bom_code: bomCode })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        recordFailedEvent("BOM", eventId, { skuId: body.sku_id, mode: body.mode }, message)
        logger.error({ ...logCtx, err: message, message: "Recipe submit failed" })
        if (err instanceof ApiError) throw err
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }

    // ── update-status: direct, immediate status change (no approval gate) ──
    if (body.action === "update-status") {
      const { recipe_id, status } = body
      const eventId = makeEventId("BOM", "status", recipe_id)
      const logCtx = { ...ctx, eventId, module: "BOM" }

      const pending = await query(approvalsSql.hasPending, ["BOM", recipe_id])
      if (pending.length > 0) {
        throw new ApiError(409, "pending_approval", "This Recipe has a pending approval — resolve it before changing status directly.")
      }

      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [rows] = await conn.execute(recipeSql.selectBomHeaderRawById, [recipe_id])
        const cur = (rows as RecipeHeaderRow[])[0]
        if (!cur) throw new ApiError(404, "not_found", "Recipe not found.")

        await conn.execute(recipeSql.setBomStatusWithUpdater, [status, userId, recipe_id])

        // Manually activating a Recipe must still respect "only one active Recipe
        // per SKU" — the same invariant bomHandler.applyAndArchive enforces
        // on approval — otherwise downstream costing/reporting queries that
        // join details_recipe on status='active' assuming a single row break.
        if (status === "active" && cur.sku_id) {
          // Keep master_skus.active_bom_id in sync — same as
          // bomHandler.applyAndArchive does on approval.
          await conn.execute(skuSql.setActiveBomId, [recipe_id, cur.sku_id])

          const [siblingRows] = await conn.execute(recipeSql.selectOtherActiveBomsForSku, [cur.sku_id, recipe_id])
          const siblingIds = (siblingRows as { id: number }[]).map((r) => r.id)
          if (siblingIds.length > 0) {
            await conn.execute(recipeSql.discontinueOverlappingActiveBomsForSku, [cur.sku_id, recipe_id, cur.effective_from])
            for (const siblingId of siblingIds) {
              const deactivateEventId = makeEventId("BOM", "deactivate", siblingId)
              logger.info({ module: "BOM", eventId: deactivateEventId, bomId: siblingId, skuId: cur.sku_id, supersededBy: recipe_id, message: "Recipe discontinued (superseded by manual status change)" })
              recordProcessedEvent("BOM", deactivateEventId, { bomId: siblingId, skuId: cur.sku_id, supersededBy: recipe_id })
            }
          }
        } else if (cur.sku_id) {
          // Manually moving THIS Recipe away from 'active' — clear
          // active_bom_id if it was still the one pointed to, so the SKU
          // master list doesn't keep showing a no-longer-active bom_code.
          // No-op if another Recipe already took over active_bom_id.
          await conn.execute(skuSql.clearActiveBomIdIfMatches, [cur.sku_id, recipe_id])
        }

        await conn.commit()
        logger.info({ ...logCtx, bomId: recipe_id, status, message: "Recipe status updated manually" })
        recordProcessedEvent("BOM", eventId, { bomId: recipe_id, status })
        return NextResponse.json({ ok: true })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        recordFailedEvent("BOM", eventId, { bomId: recipe_id, status }, message)
        logger.error({ ...logCtx, err: message, message: "Recipe status update failed" })
        if (err instanceof ApiError) throw err
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }

    // ── check_duplicates: CsvImportDialog's preview-time deep check ────────
    // Not actually about duplicates — reuses the same generic hook (POST
    // parsed rows, get back { duplicates: { rowIndex: [msg] } }) to run the
    // SAME resolution checks BOM_BULK's applyAndArchive runs at approval
    // time (SKU exists & active, material code resolves & active, RM lines
    // total ~100% per SKU group), so a bad row is caught here — before the
    // user can submit at all — instead of silently being skipped later.
    // CsvImportDialog is wired with requireAllValid for Recipe, so ANY flagged
    // row here blocks the whole upload; see this route's `bulk` action and
    // BOM_BULK's applyAndArchive for the authoritative re-check at approval
    // time (data can still drift between this preview and an admin's approval).
    if (body.action === "check_duplicates") {
      const { rows } = body
      const duplicates: Record<number, string[]> = {}

      // Cache resolved codes so a code repeated across many rows/lines only
      // hits the DB once.
      const skuCache = new Map<string, SkuLookupRow | null>()
      const rmCache = new Map<string, MaterialLookupRow | null>()
      const pmCache = new Map<string, MaterialLookupRow | null>()
      const priorBomCountCache = new Map<number, number>()
      async function resolveSku(code: string) {
        if (!skuCache.has(code)) {
          const found = await query<SkuLookupRow>(skuSql.selectByCode, [code])
          skuCache.set(code, found[0] ?? null)
        }
        return skuCache.get(code)
      }
      // Same "reason/change_type required once a SKU already has a Recipe" rule
      // create-full enforces for manual edits — mirrored here so a bulk row
      // is flagged in the preview instead of only failing at approval time
      // (see bomBulkHandler.applyAndArchive, the authoritative check).
      async function hasPriorBom(skuId: number) {
        if (!priorBomCountCache.has(skuId)) {
          const found = await query(recipeSql.selectBomsBySkuId, [skuId])
          priorBomCountCache.set(skuId, found.length)
        }
        return (priorBomCountCache.get(skuId) ?? 0) > 0
      }
      async function resolveMaterial(type: "rm" | "pm", code: string) {
        const cache = type === "rm" ? rmCache : pmCache
        if (!cache.has(code)) {
          const found = await query<MaterialLookupRow>(type === "rm" ? rmSql.selectByCode : pmSql.selectByCode, [code])
          cache.set(code, found[0] ?? null)
        }
        return cache.get(code)
      }

      const groups = new Map<string, number[]>() // sku_code -> row indices in `rows`
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const skuCode = String(row.sku_code ?? "").trim()
        if (!skuCode) continue
        if (!groups.has(skuCode)) groups.set(skuCode, [])
        groups.get(skuCode)!.push(i)

        const sku = await resolveSku(skuCode)
        if (!sku) { (duplicates[i] ??= []).push(`SKU "${skuCode}" not found`); continue }
        if (sku.status !== STATUS.ACTIVE) { (duplicates[i] ??= []).push(`SKU "${skuCode}" is not active`); continue }

        const mtrlType = String(row.mtrl_type ?? "").trim().toLowerCase()
        if (mtrlType !== "rm" && mtrlType !== "pm") continue // already flagged by the mtrl_type field's validate hook

        const mtrlCode = String(row.mtrl_code ?? "").trim()
        if (!mtrlCode) continue // already flagged as a missing required field
        const material = await resolveMaterial(mtrlType, mtrlCode)
        if (!material) { (duplicates[i] ??= []).push(`Material code "${mtrlCode}" not found`); continue }
        if (material.status !== STATUS.ACTIVE) { (duplicates[i] ??= []).push(`Material code "${mtrlCode}" is not active`) }
      }

      for (const [skuCode, indices] of groups) {
        const rmTotal = indices
          .map((i) => rows[i])
          .filter((r) => String(r.mtrl_type).trim().toLowerCase() === "rm")
          .reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
        if (!isRmTotalValid(rmTotal)) {
          const msg = `SKU ${skuCode}: RM total ${rmTotal.toFixed(2)}% (needs ${RM_TOTAL_MIN}-${RM_TOTAL_MAX}%)`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
      }

      // Duplicate material line within one SKU group — same mtrl_type+mtrl_code
      // listed twice for the same SKU is almost always a copy-paste mistake;
      // BOM_BULK's applyAndArchive would otherwise insert it as two separate
      // details_recipe rows with no unique constraint to catch it.
      for (const [skuCode, indices] of groups) {
        const seen = new Map<string, number[]>() // "rm:CODE" -> row indices
        for (const i of indices) {
          const row = rows[i]
          const key = `${String(row.mtrl_type).trim().toLowerCase()}:${String(row.mtrl_code).trim().toLowerCase()}`
          if (!seen.has(key)) seen.set(key, [])
          seen.get(key)!.push(i)
        }
        for (const [key, idxs] of seen) {
          if (idxs.length <= 1) continue
          const [type, code] = key.split(":")
          const msg = `Duplicate ${type.toUpperCase()} code "${code}" appears ${idxs.length} times for SKU ${skuCode}`
          for (const i of idxs) (duplicates[i] ??= []).push(msg)
        }
      }

      // Inconsistent bom_code within one SKU group — a group can only ever
      // produce ONE Recipe; BOM_BULK's applyAndArchive silently uses only the
      // first row's bom_code, so conflicting values elsewhere in the group
      // would otherwise be dropped without the user ever knowing.
      for (const [skuCode, indices] of groups) {
        const codes = new Set<string>()
        for (const i of indices) {
          const c = String(rows[i].bom_code ?? "").trim()
          if (c) codes.add(c)
        }
        if (codes.size > 1) {
          const msg = `Inconsistent bom_code for SKU ${skuCode}: found ${[...codes].map((c) => `"${c}"`).join(", ")} — a SKU group can only produce one Recipe`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
      }

      // Inconsistent effective_from within one SKU group — same rationale as
      // bom_code above: a group produces one Recipe header, so applyAndArchive
      // only reads the first row's effective_from.
      for (const [skuCode, indices] of groups) {
        const dates = new Set<string>()
        for (const i of indices) {
          const d = String(rows[i].effective_from ?? "").trim()
          if (d) dates.add(d)
        }
        if (dates.size > 1) {
          const msg = `Inconsistent effective_from for SKU ${skuCode}: found ${[...dates].map((d) => `"${d}"`).join(", ")} — a SKU group can only have one effective_from`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
      }

      // Inconsistent reason/change_type within one SKU group — same rationale
      // as bom_code/effective_from above: a group produces one Recipe header, so
      // applyAndArchive only reads the first row's reason/change_type.
      for (const [skuCode, indices] of groups) {
        const reasons = new Set<string>()
        const changeTypes = new Set<string>()
        for (const i of indices) {
          const r = String(rows[i].reason ?? "").trim()
          if (r) reasons.add(r)
          const ct = String(rows[i].change_type ?? "").trim().toLowerCase()
          if (ct) changeTypes.add(ct)
        }
        if (reasons.size > 1) {
          const msg = `Inconsistent reason for SKU ${skuCode} — a SKU group can only have one reason`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
        if (changeTypes.size > 1) {
          const msg = `Inconsistent change_type for SKU ${skuCode} — a SKU group can only have one type of change`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
      }

      // Reason + type of change are required once a SKU already has a prior
      // Recipe (any status) — a bulk-uploaded revision is otherwise
      // indistinguishable from a manual one, and manual edits require this.
      // Not required for a SKU's very first Recipe.
      for (const [skuCode, indices] of groups) {
        const sku = await resolveSku(skuCode)
        if (!sku) continue
        if (!(await hasPriorBom(sku.id))) continue
        const reason = String(rows[indices[0]].reason ?? "").trim()
        const changeType = String(rows[indices[0]].change_type ?? "").trim()
        if (!reason || !changeType) {
          const msg = `SKU ${skuCode} already has a Recipe — reason and type of change are required`
          for (const i of indices) (duplicates[i] ??= []).push(msg)
        }
      }

      // Duplicate bom_code used by more than one SKU group — bom_code has no
      // unique constraint in the schema, so two different Recipes could
      // silently share the same code.
      const bomCodeToSkus = new Map<string, Set<string>>()
      for (const [skuCode, indices] of groups) {
        for (const i of indices) {
          const c = String(rows[i].bom_code ?? "").trim()
          if (!c) continue
          if (!bomCodeToSkus.has(c)) bomCodeToSkus.set(c, new Set())
          bomCodeToSkus.get(c)!.add(skuCode)
        }
      }
      for (const [bomCode, skuCodes] of bomCodeToSkus) {
        if (skuCodes.size <= 1) continue
        const msg = `bom_code "${bomCode}" is used by multiple SKUs (${[...skuCodes].join(", ")})`
        for (const skuCode of skuCodes) {
          for (const i of groups.get(skuCode)!) {
            if (String(rows[i].bom_code ?? "").trim() === bomCode) (duplicates[i] ??= []).push(msg)
          }
        }
      }

      return NextResponse.json({ duplicates })
    }

    // ── bulk: stage the WHOLE uploaded file as ONE pending approval ────────
    // Nothing is inserted into master_recipe/details_recipe here — the real per-SKU
    // grouping, validation, and insert happens in BOM_BULK's applyAndArchive
    // (lib/approvals/module-handlers.ts) once an admin approves.
    if (body.action === "bulk") {
      const { rows } = body
      const eventId = makeEventId("BOM_BULK", "bulk")
      const logCtx = { ...ctx, eventId, module: "BOM_BULK" }
      logger.info({ ...logCtx, rowCount: rows.length, message: "Recipe bulk upload started" })
      recordRawEvent("BOM_BULK", eventId, { rowCount: rows.length, source: "csv" })

      const conn: PoolConnection = await pool.getConnection()
      try {
        const yyyymm = monthIST()
        const { key, filename } = await uploadRowsAsCsv(rows, `imports/bom-bulk/${yyyymm}`, "bom_bulk")

        await conn.beginTransaction()
        const approvalId = await stageBulkUploadApproval(conn, {
          userId, module: "BOM_BULK", s3Key: key, filename, rowCount: rows.length,
        })
        await conn.commit()
        logger.info({ ...logCtx, approvalId, message: "Recipe bulk upload staged for approval" })
        recordProcessedEvent("BOM_BULK", eventId, { rowCount: rows.length, source: "csv", approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId, staged: rows.length, skipped: 0 })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        recordFailedEvent("BOM_BULK", eventId, { rowCount: rows.length, source: "csv" }, message)
        logger.error({ ...logCtx, err: message, message: "Recipe bulk upload failed" })
        throw new ApiError(500, "internal", "Bulk upload failed: " + message)
      } finally {
        conn.release()
      }
    }

    return NextResponse.json({ ok: false, message: "Invalid action" }, { status: 400 })
  },
})
