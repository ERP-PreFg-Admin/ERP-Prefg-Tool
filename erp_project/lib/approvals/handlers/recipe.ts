// ── BOM (spans master_bom + details_bom + history_bom), BOM_BULK (spans
// master_bom + details_bom, one new BOM per sku_code group in an uploaded
// file) ─────────────────────────────────────────────────────────────────────
//
// BOM: one handler covers both "create new version" and "update existing in
// place", since both converge on the same master_bom.status lifecycle. The
// mode and the full RM/PM line diff are encoded as flat approval_items rows
// (see app/api/masters/bom-master/route.ts for how they're written at submit
// time):
//   - a "__mode__" sentinel item: new_value is "new-version" | "update-existing"
//   - a "__reason__" / "__change_type__" sentinel item (optional — omitted
//     for the very first BOM created for a SKU): the submitter's free-text
//     reason and comma-joined "rm"/"pm" change-type tags. Neither is
//     consumed here — parseBomLineItems below only cares about line:*/
//     artifact:* items — they exist purely for the approval/history UI
//     (app/approvals/approval-card/BomLineDiffTable.tsx). Kept as sentinel
//     approval_items rather than a new approvals column so they don't
//     collide with approvals.remarks, which already means the APPROVER's
//     rejection note.
//   - one item per (mtrl_type, mtrl_id, field) tuple: field_name =
//     "line:<rm|pm>:<mtrl_id>:<field>", e.g. "line:rm:12:amount"
//   - a dropped line (present before, absent from the new submission) gets a
//     synthetic "line:<type>:<id>:__removed__" marker (old="1", new="")
//
// details_bom rows are only ever written HERE, at approval time, for BOTH
// modes — never at submit time. This keeps half-approved formulations out of
// costing/reporting queries that join details_bom with no status filter, and
// keeps the CURRENT lines of an "update existing" BOM fully live/queryable
// while its edit is pending.
//
// BOM_BULK: unlike every other *_BULK handler (one CSV row = one entity), a
// BOM is a header + N RM/PM lines, so rows are grouped by sku_code first.
// Each group always creates a NEW BOM version — this never updates an
// existing BOM in place (that's bomHandler's job, for the single-BOM
// wizard). If a SKU already has an active BOM, the group is NOT blocked: it
// still creates another new version, which supersedes the old one below,
// exactly like bomHandler's own "only one active BOM per SKU" invariant.
//
// Validation is all-or-nothing PER GROUP: every line must resolve (SKU
// exists and is active, material code resolves to an active RM/PM, positive
// amount, effective_from present) and RM lines must total 99.9-100.1%, or
// the WHOLE group is skipped — never a partially-inserted BOM. Other groups
// in the same file still proceed (file-level partial success), matching the
// existing inserted/skipped counter convention used by rmBulkHandler/pmBulkHandler.

import { skus as skuSql } from "@/lib/queries/skus"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { bom as bomSql } from "@/lib/queries/bom"
import { approvalsSql } from "@/lib/queries/approvals"
import { diffBomLines, type DiffableLine } from "@/lib/masters/bom-version"
import { isRmTotalValid } from "@/lib/validation/bom"
import { deleteFile } from "@/lib/s3"
import { parseS3Import } from "@/lib/import-s3"
import { recordProcessedEvent, makeEventId } from "@/lib/events"
import { STATUS } from "@/lib/constants"
import logger from "@/lib/logger"
import { type DiffItem, type ModuleHandler, s3KeyOf } from "./types"

type BomLineDiff = {
  mtrlType: "rm" | "pm"
  mtrlId: number
  removed: boolean
  fields: Record<string, string> // field -> new_value
}

type BomArtifactAdd = { s3_key: string; file_name: string }

function parseBomLineItems(items: DiffItem[]): {
  mode: "new-version" | "update-existing"
  lines: BomLineDiff[]
  artifactAdds: BomArtifactAdd[]
  artifactRemoveIds: number[]
} {
  const modeItem = items.find((i) => i.field_name === "__mode__")
  const mode: "new-version" | "update-existing" =
    modeItem?.new_value === "update-existing" ? "update-existing" : "new-version"

  const lineMap = new Map<string, BomLineDiff>()
  const artifactAdds: BomArtifactAdd[] = []
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
      artifactAdds.push(JSON.parse(it.new_value!) as BomArtifactAdd)
      continue
    }
    const removeMatch = it.field_name.match(/^artifact:remove:(\d+)$/)
    if (removeMatch) artifactRemoveIds.push(Number(removeMatch[1]))
  }
  return { mode, lines: [...lineMap.values()], artifactAdds, artifactRemoveIds }
}

export const bomHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(bomSql.setBomStatus, [status, entityId])
  },

  async applyAndArchive(conn, entityId, items, approverId) {
    const { mode, lines, artifactAdds, artifactRemoveIds } = parseBomLineItems(items)

    const [headerRows] = await conn.execute(bomSql.selectBomHeaderRawById, [entityId])
    const header = (headerRows as any[])[0]
    if (!header) throw new Error(`BOM ${entityId} not found`)

    // Current lines, keyed the same way as the diff — used as a fallback for
    // any field that didn't change (and so has no approval_item), and as the
    // archival source for "update existing".
    const [currentRows] = await conn.execute(bomSql.selectDetailLinesRawByBomId, [entityId])
    const currentByKey = new Map<string, any>(
      (currentRows as any[]).map((r) => [`${r.mtrl_type}:${r.mtrl_id}`, r])
    )

    if (mode === "update-existing") {
      // 1. Snapshot EVERY current line into history_bom before touching anything.
      for (const cur of currentRows as any[]) {
        await conn.execute(bomSql.archiveDetailLineToHistory, [
          cur.bom_id, cur.mtrl_type, cur.mtrl_id, cur.amount, cur.uom, null,
          cur.status, cur.updated_by ?? approverId, approverId,
        ])
      }
      // 2. Wipe current lines; the new set (minus removed ones) is reinserted below.
      await conn.execute(bomSql.deleteDetailLinesByBomId, [entityId])
    }

    for (const line of lines) {
      if (line.removed) continue // update-existing only: line dropped, don't reinsert
      const key = `${line.mtrlType}:${line.mtrlId}`
      const cur = currentByKey.get(key)
      const amount = Number(line.fields.amount ?? cur?.amount ?? 0)
      const uom = line.fields.uom ?? cur?.uom ?? null
      await conn.execute(bomSql.insertDetailLine, [
        entityId, line.mtrlType, line.mtrlId, amount, uom, "active", approverId,
      ])
      // new-version: no prior line-state to snapshot (that's what
      // update-existing's step 1 above does) — instead, archive THIS
      // version's own lines as they're approved, so history_bom ends up
      // with a full line-level record of every BOM version, grouped by SKU
      // via master_bom, not just in-place overwrites.
      if (mode === "new-version") {
        await conn.execute(bomSql.archiveDetailLineToHistory, [
          entityId, line.mtrlType, line.mtrlId, amount, uom, null,
          "active", header.created_by, approverId,
        ])
      }
    }

    // 3. Artifacts (bom_artifacts) — only ever written/deleted here, at
    //    approval time. Adds/removes were staged client-side and bundled
    //    into this same approval (see app/api/masters/bom-master/route.ts).
    for (const artifact of artifactAdds) {
      await conn.execute(bomSql.insertArtifact, [entityId, artifact.s3_key, artifact.file_name, approverId])
    }
    if (artifactRemoveIds.length > 0) {
      // .query (not .execute) — prepared statements don't support expanding
      // an array param into "IN (?)"'s comma-separated list the way .query does.
      const [removedRows] = await conn.query(bomSql.selectArtifactsByIds, [entityId, artifactRemoveIds])
      await conn.query(bomSql.deleteArtifactsByIds, [entityId, artifactRemoveIds])
      for (const removed of removedRows as any[]) {
        // Best-effort — not transactional with the DB delete above, same as
        // every other S3-key cleanup in this codebase.
        deleteFile(removed.s3_key).catch((err) => {
          logger.warn({ module: "BOM", bomId: entityId, s3Key: removed.s3_key, err: err.message, message: "Failed to delete artifact from S3" })
        })
      }
    }

    // 4. Activate this BOM and deactivate any other active BOM for the same
    //    sku_id — enforces "only one active BOM per SKU" at approval time.
    await conn.execute(bomSql.setBomStatusWithUpdater, [STATUS.ACTIVE, approverId, entityId])
    const bomActivateEventId = makeEventId("BOM", "activate", entityId)
    logger.info({ module: "BOM", eventId: bomActivateEventId, bomId: entityId, skuId: header.sku_id, approverId, message: "BOM activated" })
    recordProcessedEvent("BOM", bomActivateEventId, { bomId: entityId, skuId: header.sku_id, approverId })

    if (header.sku_id) {
      // Keep master_skus.active_bom_id pointed at the version that's
      // actually active — otherwise the SKU master list's bom_code column
      // (resolved from active_bom_id) goes stale the moment a new version
      // is approved.
      await conn.execute(skuSql.setActiveBomId, [entityId, header.sku_id])

      // Read the sibling ids BEFORE deactivating — MariaDB's UPDATE has no
      // RETURNING, so this is the only way to know which BOMs are about to
      // be deactivated and log/emit one event per sibling, not one for the
      // whole batch.
      const [siblingRows] = await conn.execute(bomSql.selectOtherActiveBomsForSku, [header.sku_id, entityId])
      const siblingIds = (siblingRows as any[]).map((r) => r.id)

      if (siblingIds.length > 0) {
        await conn.execute(bomSql.discontinueOverlappingActiveBomsForSku, [header.sku_id, entityId, header.effective_from])
        for (const siblingId of siblingIds) {
          const bomDeactivateEventId = makeEventId("BOM", "deactivate", siblingId)
          logger.info({ module: "BOM", eventId: bomDeactivateEventId, bomId: siblingId, skuId: header.sku_id, supersededBy: entityId, message: "BOM discontinued (superseded)" })
          recordProcessedEvent("BOM", bomDeactivateEventId, { bomId: siblingId, skuId: header.sku_id, supersededBy: entityId })
        }
      }
    }
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

        // Auto-generate bom_code when not supplied — same <sku_code>-RM<n>-PM<n>
        // independent-version scheme the single-BOM wizard path uses (see
        // lib/masters/bom-version.ts), so a bulk-uploaded BOM's code format
        // never differs from a manually-created one.
        const providedCode = groupRows[0].bom_code?.trim()
        const [priorRows] = await conn.execute(bomSql.selectMostRecentBomForSku, [sku.id])
        const prior = (priorRows as { id: number; rm_version: number; pm_version: number }[])[0] ?? null
        let priorLines: DiffableLine[] = []
        if (prior) {
          const [priorLineRows] = await conn.execute(bomSql.selectDetailLinesRawByBomId, [prior.id])
          priorLines = (priorLineRows as any[]).map((r) => ({
            mtrl_type: r.mtrl_type, mtrl_id: r.mtrl_id, amount: r.amount, uom: r.uom,
          }))
        }
        const newLines: DiffableLine[] = lines.map((l) => ({
          mtrl_type: l.mtrl_type, mtrl_id: l.mtrl_id, amount: l.amount, uom: l.uom,
        }))
        const { rmChanged, pmChanged } = diffBomLines(priorLines, newLines)
        const rmVersion = !prior || rmChanged ? (prior?.rm_version ?? 0) + 1 : prior.rm_version
        const pmVersion = !prior || pmChanged ? (prior?.pm_version ?? 0) + 1 : prior.pm_version
        const bomCode = providedCode || `${skuCode}-RM${rmVersion}-PM${pmVersion}`

        // Same "reason/change_type required once a prior BOM exists" rule the
        // single-BOM path enforces — bulk upload is just a faster way to
        // submit the SAME kind of change, not a different one, so it carries
        // the same requirement (checked here again, authoritatively, even
        // though check_duplicates already warned about it in the preview).
        const reason = groupRows[0].reason?.trim() || null
        const changeTypeRaw = groupRows[0].change_type?.trim().toLowerCase()
        const changeType: ("rm" | "pm")[] =
          changeTypeRaw === "both" ? ["rm", "pm"] : changeTypeRaw === "rm" || changeTypeRaw === "pm" ? [changeTypeRaw] : []
        if (prior && (!reason || changeType.length === 0)) {
          groupsSkipped++
          skipReasons.push(`${skuCode}: reason and type of change are required — a BOM already exists for this SKU`)
          continue
        }

        const [headerResult] = await conn.execute(bomSql.insertBomHeaderWithVersions, [
          bomCode, sku.id, approverId, STATUS.ACTIVE, effectiveFrom, rmVersion, pmVersion,
        ])
        const bomId = (headerResult as any).insertId

        // Keep master_skus.active_bom_id in sync — same as bomHandler's
        // single-BOM path does on approval, otherwise a bulk-created BOM
        // never shows up as the SKU's current recipe on the SKU master list.
        await conn.execute(skuSql.setActiveBomId, [bomId, sku.id])

        // Mirror the SAME "BOM" module approval record the single-BOM path
        // raises at submit time (see app/api/masters/bom-master/route.ts) —
        // already resolved/approved, since the data write above already
        // happened. This is what makes a bulk-created version show up
        // identically to a manual one in the row-level History dialog and
        // the SKU-linked audit trail (both key off module='BOM' approvals).
        const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [raisedBy ?? approverId, "BOM", bomId, "create"])
        const approvalId = (approvalResult as any).insertId
        await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__mode__", "", "new-version"])
        if (reason) await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__reason__", "", reason])
        if (changeType.length > 0) await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "__change_type__", "", changeType.join(",")])

        for (const line of lines) {
          await conn.execute(bomSql.insertDetailLine, [
            bomId, line.mtrl_type, line.mtrl_id, line.amount, line.uom,
            "active", approverId,
          ])
          // Same per-line history_bom archive bomHandler writes for the
          // single-BOM new-version path — keeps the History page's SKU-wise
          // lineage complete regardless of upload path.
          await conn.execute(bomSql.archiveDetailLineToHistory, [
            bomId, line.mtrl_type, line.mtrl_id, line.amount, line.uom, null,
            "active", approverId, approverId,
          ])
          // Line-level diff items for the synthetic approval above — every
          // field is "new" (old_value "") since there's no prior state for a
          // brand-new BOM header, same as create-full's own new-version mode.
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:__present__`, "1", "1"])
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:amount`, "", String(line.amount)])
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, `line:${line.mtrl_type}:${line.mtrl_id}:uom`, "", line.uom ?? ""])
          linesInserted++
        }
        // Already applied above — mark this synthetic approval resolved so
        // it reads as "approved" in the audit trail rather than sitting
        // pending forever.
        await conn.execute(approvalsSql.markApproved, [approverId, approvalId])

        // Enforce "only one active BOM per SKU" — same invariant bomHandler
        // applies for the single-BOM path, gated the same way on effective_from
        // overlap so a future-dated bulk-uploaded recipe doesn't prematurely
        // discontinue the one it hasn't superseded yet.
        const [siblingRows] = await conn.execute(bomSql.selectOtherActiveBomsForSku, [sku.id, bomId])
        const siblingIds = (siblingRows as any[]).map((r) => r.id)
        if (siblingIds.length > 0) {
          await conn.execute(bomSql.discontinueOverlappingActiveBomsForSku, [sku.id, bomId, effectiveFrom])
          for (const siblingId of siblingIds) {
            const deactivateEventId = makeEventId("BOM", "deactivate", siblingId)
            logger.info({ module: "BOM", eventId: deactivateEventId, bomId: siblingId, skuId: sku.id, supersededBy: bomId, message: "BOM discontinued (superseded by bulk upload)" })
            recordProcessedEvent("BOM", deactivateEventId, { bomId: siblingId, skuId: sku.id, supersededBy: bomId })
          }
        }

        bomsCreated++
      } catch (err: any) {
        groupsSkipped++
        skipReasons.push(`${skuCode}: ${err.message}`)
      }
    }

    const eventId = makeEventId("BOM_BULK", "apply")
    logger.info({ module: "BOM_BULK", eventId, s3Key, bomsCreated, groupsSkipped, linesInserted, message: "BOM bulk upload applied" })
    recordProcessedEvent("BOM_BULK", eventId, { s3Key, bomsCreated, groupsSkipped, linesInserted, skipReasons })
    if (bomsCreated === 0) {
      throw new Error(`BOM_BULK: no BOMs created. ${skipReasons.join("; ")}`)
    }
  },
}
