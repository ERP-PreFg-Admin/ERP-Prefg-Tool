// Pure shapes + math for the MFG Overview tabs. No DB, no React — unit-tested.

import { parseIso, toIso, todayIST } from "@/lib/date"

/** A PO older than this many days is flagged red on the Open POs tab. */
export const OLD_PO_DAYS = 90

export type OverviewTab = "open" | "dispatch" | "mapping"
export const OVERVIEW_TABS: { key: OverviewTab; label: string }[] = [
  { key: "open", label: "Open POs" },
  { key: "dispatch", label: "Dispatch History" },
  { key: "mapping", label: "MFG x Facility Mapping" },
]
export function parseTab(v: string | null | undefined): OverviewTab {
  return v === "dispatch" || v === "mapping" ? v : "open"
}

export type OpenPoCell = {
  sku_code: string
  sku_name: string | null
  mfg_id: number
  mfg_code: string
  mfg_name: string
  open_qty: number
  open_pos: number
  old_pos: number
}

export type OpenPoListRow = {
  id: number
  po_no: string
  date: string
  age_days: number
  sku_code: string
  sku_name: string | null
  mfg_code: string
  mfg_name: string
  qty: number
  received_total: number
  open_qty: number
  status: string
  expected_on: string
  destination: string | null
}

export type DispatchLine = {
  mfg_id: number
  mfg_code: string
  mfg_name: string
  sku_code: string
  sku_name: string | null
  qty: number
  invoices: number
}

export type MfgOption = { id: number; code: string; name: string }

export type MatrixMfg = { id: number; code: string; name: string; openQty: number; openPos: number; oldPos: number }
export type MatrixSku = { sku_code: string; sku_name: string | null; total: number; cells: Record<number, OpenPoCell> }

/** Columns = manufacturers with anything open (most open qty first); rows = SKUs ranked by total open qty. */
export function buildOpenPoMatrix(cells: OpenPoCell[]): { mfgs: MatrixMfg[]; skus: MatrixSku[] } {
  const mfgs = new Map<number, MatrixMfg>()
  const skus = new Map<string, MatrixSku>()
  for (const c of cells) {
    const m = mfgs.get(c.mfg_id) ?? { id: c.mfg_id, code: c.mfg_code, name: c.mfg_name, openQty: 0, openPos: 0, oldPos: 0 }
    m.openQty += c.open_qty; m.openPos += c.open_pos; m.oldPos += c.old_pos
    mfgs.set(c.mfg_id, m)
    const s = skus.get(c.sku_code) ?? { sku_code: c.sku_code, sku_name: c.sku_name, total: 0, cells: {} }
    s.total += c.open_qty
    s.cells[c.mfg_id] = c
    s.sku_name ??= c.sku_name
    skus.set(c.sku_code, s)
  }
  return {
    mfgs: [...mfgs.values()].sort((a, b) => b.openQty - a.openQty || a.code.localeCompare(b.code)),
    skus: [...skus.values()].sort((a, b) => b.total - a.total || a.sku_code.localeCompare(b.sku_code)),
  }
}

export function matchesSku(s: { sku_code: string; sku_name: string | null }, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return s.sku_code.toLowerCase().includes(needle) || (s.sku_name ?? "").toLowerCase().includes(needle)
}

export type DispatchPreset = "D-1" | "7D" | "15D" | "30D"
export const DISPATCH_PRESETS: DispatchPreset[] = ["D-1", "7D", "15D", "30D"]
const PRESET_DAYS: Record<DispatchPreset, number> = { "D-1": 1, "7D": 7, "15D": 15, "30D": 30 }

function addDays(iso: string, days: number): string {
  const p = parseIso(iso)
  if (!p) return iso
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days))
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Every preset ends YESTERDAY in IST — today's invoices are still being booked. */
export function presetRange(preset: DispatchPreset, at: Date = new Date()): { from: string; to: string } {
  const to = addDays(todayIST(at), -1)
  return { from: addDays(to, -(PRESET_DAYS[preset] - 1)), to }
}

export function activePreset(from: string, to: string, at: Date = new Date()): DispatchPreset | null {
  return DISPATCH_PRESETS.find((p) => {
    const r = presetRange(p, at)
    return r.from === from && r.to === to
  }) ?? null
}

export type DispatchView = "lines" | "mfg" | "sku"
export function parseView(v: string | null | undefined): DispatchView {
  return v === "mfg" || v === "sku" ? v : "lines"
}

export type DispatchMfgRow = { mfg_id: number; mfg_code: string; mfg_name: string; skus: number; qty: number }
export type DispatchSkuRow = { sku_code: string; sku_name: string | null; mfgs: number; qty: number }

export function groupByMfg(lines: DispatchLine[]): DispatchMfgRow[] {
  const out = new Map<number, DispatchMfgRow>()
  for (const l of lines) {
    const r = out.get(l.mfg_id) ?? { mfg_id: l.mfg_id, mfg_code: l.mfg_code, mfg_name: l.mfg_name, skus: 0, qty: 0 }
    r.skus += 1; r.qty += l.qty
    out.set(l.mfg_id, r)
  }
  return [...out.values()].sort((a, b) => b.qty - a.qty)
}

export function groupBySku(lines: DispatchLine[]): DispatchSkuRow[] {
  const out = new Map<string, DispatchSkuRow>()
  for (const l of lines) {
    const r = out.get(l.sku_code) ?? { sku_code: l.sku_code, sku_name: l.sku_name, mfgs: 0, qty: 0 }
    r.mfgs += 1; r.qty += l.qty
    r.sku_name ??= l.sku_name
    out.set(l.sku_code, r)
  }
  return [...out.values()].sort((a, b) => b.qty - a.qty)
}

export function dispatchStats(lines: DispatchLine[]) {
  return {
    qty: lines.reduce((a, l) => a + l.qty, 0),
    skus: new Set(lines.map((l) => l.sku_code)).size,
    mfgs: new Set(lines.map((l) => l.mfg_id)).size,
    lines: lines.length,
  }
}
