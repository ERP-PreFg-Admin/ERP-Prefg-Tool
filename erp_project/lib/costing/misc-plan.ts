// Classifies misc-cost bulk rows as new line / price update / error. Pure: the caller loads
// the manufacturer's SKUs and live lines. Run at preview, at submit and again at approval.

import { normalizeDateCell } from "@/lib/date"
import { parseMiscCostTypeCell } from "@/lib/validation/manufacturing"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import type { MiscCostType } from "@/types/masters"

export type MiscSkuOption = { id: number; sku_code: string | null }

export type MiscLiveLine = {
  id: number
  sku_id: number
  type: string
  status: string
  cost: string | number | null
  effective_from: string | null
  effective_till: string | null
}

type Parsed = {
  line: number
  sku_code: string
  sku_id: number
  type: MiscCostType
  cost: number
  effective_from: string
  effective_till: string | null
  remarks: string
}

export type MiscPlanRow =
  | { kind: "error"; line: number; sku_code: string; reasons: string[] }
  | (Parsed & { kind: "new" })
  | (Parsed & { kind: "update"; live: MiscLiveLine })

const sameCost = (a: unknown, b: unknown) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 0.00005
const sameDate = (a: string | null | undefined, b: string | null | undefined) => (a || "") === (b || "")

export function planMiscRows(
  rows: Record<string, unknown>[],
  skus: MiscSkuOption[],
  live: MiscLiveLine[],
): MiscPlanRow[] {
  const skuByCode = new Map(skus.filter((s) => s.sku_code).map((s) => [String(s.sku_code).trim().toLowerCase(), s]))
  const liveBySlot = new Map(live.map((l) => [`${l.sku_id}:${l.type}`, l]))

  const parsed: (Parsed | { line: number; sku_code: string; reasons: string[] })[] = rows.map((row, i) => {
    const line = i + 2 // header row + 1-based
    const reasons: string[] = []
    const skuCode = String(row.sku_code ?? "").trim()
    const sku = skuCode ? skuByCode.get(skuCode.toLowerCase()) : undefined
    if (!skuCode) reasons.push("missing sku_code")
    else if (!sku) reasons.push("this manufacturer has no production line for this SKU")

    const type = parseMiscCostTypeCell(row.type)
    if (!type.success) reasons.push(`type "${String(row.type ?? "")}" is not a misc cost type`)

    const costRaw = String(row.cost ?? "").trim()
    const cost = Number(costRaw)
    if (!costRaw || !Number.isFinite(cost) || cost < 0) reasons.push(`cost "${costRaw}" must be a non-negative number`)

    const from = normalizeDateCell(String(row.effective_from ?? ""))
    if (!from) reasons.push("missing or unreadable effective_from")
    const tillRaw = String(row.effective_till ?? "").trim()
    const till = tillRaw ? normalizeDateCell(tillRaw) : ""
    if (tillRaw && !till) reasons.push(`unreadable effective_till "${tillRaw}"`)

    if (reasons.length || !sku || !type.success) return { line, sku_code: skuCode, reasons }
    return {
      line, sku_code: skuCode, sku_id: sku.id, type: type.data, cost,
      effective_from: from, effective_till: till || null, remarks: String(row.remarks ?? "").trim(),
    }
  })

  // Same SKU + type twice in one file: neither row is applied, so the file is fixed rather than guessed at.
  const linesBySlot = new Map<string, number[]>()
  for (const p of parsed) {
    if ("reasons" in p) continue
    const key = `${p.sku_id}:${p.type}`
    linesBySlot.set(key, [...(linesBySlot.get(key) ?? []), p.line])
  }

  return parsed.map((p): MiscPlanRow => {
    if ("reasons" in p) return { kind: "error", ...p }
    const key = `${p.sku_id}:${p.type}`
    const dupes = linesBySlot.get(key) ?? []
    const err = (reason: string): MiscPlanRow => ({ kind: "error", line: p.line, sku_code: p.sku_code, reasons: [reason] })
    if (dupes.length > 1) return err(`${p.type} appears more than once for this SKU in the file (rows ${dupes.join(", ")})`)

    const current = liveBySlot.get(key)
    if (!current) return { kind: "new", ...p }
    if (current.status === "in_review") return err(`its ${p.type} cost already has a change awaiting approval — wait for that first`)
    if (sameCost(current.cost, p.cost) && sameDate(current.effective_from, p.effective_from) && sameDate(current.effective_till, p.effective_till)) {
      return err(`${p.type} is already live at this cost and dates — nothing to change`)
    }
    return { kind: "update", ...p, live: current }
  })
}

type Run = (sql: string, params: unknown[]) => Promise<unknown>

/** The manufacturer's SKUs and live lines, through whichever executor the caller holds (pool or open connection). */
export async function loadMiscPlanContext(run: Run, mfgId: number): Promise<{ skus: MiscSkuOption[]; live: MiscLiveLine[] }> {
  const [skus, live] = await Promise.all([
    run(manufacturingSql.selectMfgSkuOptions, [mfgId]),
    run(manufacturingSql.selectLiveMiscByMfg, [mfgId]),
  ])
  return { skus: skus as MiscSkuOption[], live: live as MiscLiveLine[] }
}

/** "row 4 (MCaf48): reason" lines for every error row. */
export function describePlanErrors(plan: MiscPlanRow[]): string[] {
  return plan.flatMap((p) => (p.kind === "error" ? p.reasons.map((r) => `row ${p.line}${p.sku_code ? ` (${p.sku_code})` : ""}: ${r}`) : []))
}

/** Update rows with no remark — a price change needs a reason, like every other master edit. */
export function updatesMissingRemarks(plan: MiscPlanRow[]): string[] {
  return plan.flatMap((p) => (p.kind === "update" && !p.remarks ? [`row ${p.line} (${p.sku_code}): remarks are required when replacing a live price`] : []))
}

/** The row as staged to S3: normalised values plus what it replaces, so the approver sees old → new. */
export function stagedMiscRow(p: Extract<MiscPlanRow, { kind: "new" | "update" }>): Record<string, string> {
  return {
    sku_code: p.sku_code,
    type: p.type,
    cost: String(p.cost),
    effective_from: p.effective_from,
    effective_till: p.effective_till ?? "",
    remarks: p.remarks,
    plan_action: p.kind,
    old_cost: p.kind === "update" ? String(Number(p.live.cost ?? 0)) : "",
    old_effective_from: p.kind === "update" ? p.live.effective_from ?? "" : "",
    old_effective_till: p.kind === "update" ? p.live.effective_till ?? "" : "",
  }
}

/** At approval: did the live data move since upload? A price the uploader never saw must not be archived and overwritten. */
export function staleSinceUpload(p: MiscPlanRow, staged: Record<string, unknown>): string | null {
  if (p.kind === "error") return null
  const was = String(staged.plan_action ?? "")
  if (was && was !== p.kind) {
    return was === "update"
      ? "the live line it was replacing is gone since upload — upload the file again"
      : "a live line was added for it since upload — upload the file again"
  }
  if (p.kind === "update" && was === "update") {
    const moved = !sameCost(p.live.cost, staged.old_cost)
      || !sameDate(p.live.effective_from, String(staged.old_effective_from ?? ""))
      || !sameDate(p.live.effective_till, String(staged.old_effective_till ?? ""))
    if (moved) return "its live price changed since upload — upload the file again"
  }
  return null
}
