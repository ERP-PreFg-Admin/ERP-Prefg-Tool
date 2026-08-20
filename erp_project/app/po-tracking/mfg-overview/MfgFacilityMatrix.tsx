"use client"

/**
 * The MFG × Facility mapping matrix — rows are manufacturers, columns are the 18
 * Unicommerce facilities (details_warehouse_entity: one per location × legal
 * entity, so Gurgaon appears twice — GGN_WAREHOUSE under Pep, HYP_B2B_GGN under
 * Kreative, with different vendor codes).
 *
 * Cells are read-only counts; clicking one opens the drilldown, which is where the
 * mapping is edited. That split is deliberate — see the note in
 * MfgFacilityMapPanel.tsx.
 *
 * A raw <table> rather than components/ui/table.tsx, because that one wraps every
 * table in <ScrollFade axis="x"> (table.tsx:7), which hides the scrollbar in favour
 * of an edge fade. At 20 columns the scrollbar IS the affordance. Sticky-column
 * mechanics copied from app/po-tracking/po-inwarding/InvoiceLineItems.tsx:70-140,
 * including the one non-obvious requirement: `border-separate border-spacing-0` is
 * load-bearing, because under the preflight's `border-collapse` a sticky cell
 * paints in the table's background layer and the scrolling columns' text draws
 * straight over the frozen ones.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { SearchInput } from "@/components/masters/SearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { cn } from "@/lib/utils"
import {
  cellState, cellLabel, needsPush, summarise, matchesSearch,
  MAP_STATES, MAP_STATE_CELL, MAP_STATE_BLOCK, MAP_STATE_DOT, MAP_STATE_LABEL,
} from "./mapping-state"
import { MfgFacilityMapPanel } from "./MfgFacilityMapPanel"
import { SyncFacilityMapDialog } from "./SyncFacilityMapDialog"
import type { MfgFacilityCell, MfgFacilitySkuRow } from "@/types/masters"

/** One (manufacturer, SKU) pair the matrix knows about, as shipped by the page.
 *  A SKU qualifies via a recipe line, a Unicommerce mapping, or both — see
 *  LIVE_SKUS_CTE in lib/queries/mfg-facility-map.ts. */
export type LiveLine = {
  mfg_id: number
  sku_id: number
  sku_code: string
  sku_name: string | null
  brand_id: number | null
  /** 1 when this SKU has a live master_recipe_mfg line for this manufacturer. */
  has_recipe: number
  /** 1 when it is actively mapped at some facility. */
  has_mapping: number
}

/** One active mapping row, as shipped by the page. */
export type MappingRow = {
  mfg_id: number
  wh_id: number
  sku_id: number
  un_pushed_at: string | null
  un_push_error: string | null
  un_seen_at: string | null
}

/** Facility column widths. `left-*` offsets below are derived from these, so the
 *  two cannot be changed independently — hence one place. */
const MFG_COL = "w-56 min-w-56"
const TOTAL_COL = "w-16 min-w-16"
/** Must equal MFG_COL's width, or the second frozen column overlaps or gaps. */
const TOTAL_LEFT = "left-56"

export function MfgFacilityMatrix({
  cells,
  lines,
  mappings,
  canEdit,
}: {
  cells: MfgFacilityCell[]
  lines: LiveLine[]
  mappings: MappingRow[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<{ mfgId: number; whId: number } | null>(null)

  /** The facility columns, in the order the server sent them (MWH before CWH,
   *  then name, then entity). Derived from the cells so there is no second source
   *  that could disagree about which facilities exist. */
  const facilities = useMemo(() => {
    const seen = new Map<number, MfgFacilityCell>()
    for (const c of cells) if (!seen.has(c.wh_id)) seen.set(c.wh_id, c)
    return [...seen.values()]
  }, [cells])

  /** Rows, in server order, each with its cells keyed by facility. */
  const rows = useMemo(() => {
    const byMfg = new Map<number, { first: MfgFacilityCell; cells: Map<number, MfgFacilityCell> }>()
    for (const c of cells) {
      const entry = byMfg.get(c.mfg_id) ?? { first: c, cells: new Map() }
      entry.cells.set(c.wh_id, c)
      byMfg.set(c.mfg_id, entry)
    }
    return [...byMfg.values()]
  }, [cells])

  const linesByMfg = useMemo(() => {
    const map = new Map<number, LiveLine[]>()
    for (const l of lines) {
      const list = map.get(l.mfg_id) ?? []
      list.push(l)
      map.set(l.mfg_id, list)
    }
    return map
  }, [lines])

  /** (mfg, facility) -> mapped rows, so the panel can be built without a fetch. */
  const mappingsByCell = useMemo(() => {
    const map = new Map<string, MappingRow[]>()
    for (const m of mappings) {
      const key = `${m.mfg_id}:${m.wh_id}`
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return map
  }, [mappings])

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        matchesSearch(
          { name: r.first.mfg_name, code: r.first.mfg_code },
          (linesByMfg.get(r.first.mfg_id) ?? []).flatMap((l) => [l.sku_code, l.sku_name ?? ""]),
          search,
        )
      ),
    [rows, linesByMfg, search]
  )

  /** Over the VISIBLE rows, so narrowing the search narrows the headline numbers —
   *  otherwise the pills describe a grid that is not on screen. */
  const pills = useMemo(
    () => summarise(visible.flatMap((r) => [...r.cells.values()])),
    [visible]
  )

  const selectedCell = selected
    ? rows.find((r) => r.first.mfg_id === selected.mfgId)?.cells.get(selected.whId) ?? null
    : null

  /** The panel's SKU list: this manufacturer's live lines, each flagged with its
   *  mapping state at the selected facility. */
  const selectedSkus = useMemo<MfgFacilitySkuRow[]>(() => {
    if (!selected) return []
    const mapped = new Map(
      (mappingsByCell.get(`${selected.mfgId}:${selected.whId}`) ?? []).map((m) => [m.sku_id, m])
    )
    return (linesByMfg.get(selected.mfgId) ?? []).map((l) => {
      const m = mapped.get(l.sku_id)
      return {
        sku_id: l.sku_id,
        sku_code: l.sku_code,
        sku_name: l.sku_name,
        brand_id: l.brand_id,
        has_recipe: l.has_recipe,
        has_mapping: l.has_mapping,
        map_id: m ? 1 : null,
        map_status: m ? ("active" as const) : null,
        un_pushed_at: m?.un_pushed_at ?? null,
        un_push_error: m?.un_push_error ?? null,
        un_seen_at: m?.un_seen_at ?? null,
      }
    })
  }, [selected, linesByMfg, mappingsByCell])

  return (
    <>
      <MasterToolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search manufacturer or SKU…"
        />
        <MasterToolbarActions className="flex-wrap items-center gap-x-5 gap-y-1">
          {/* Legend, copied from RailLegend (PermissionsClient.tsx:151-166): the
              colour language is only readable once, so say it once, next to the
              rows it explains. */}
          {/* A square swatch, not a dot: the cells are now blocks of colour, and a
              legend should look like the thing it explains. `unavailable` gets a
              dashed outline instead of a fill, because its cells have no fill. */}
          {MAP_STATES.map((state) => (
            <span key={state} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-[2px]",
                  state === "unavailable"
                    ? "border border-dashed border-muted-foreground/40"
                    : MAP_STATE_DOT[state]
                )}
              />
              {MAP_STATE_LABEL[state]}
            </span>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          {/* Zero pills are dropped rather than shown as "0 unmapped" — same call
              AccessCounts makes (UserAccessTable.tsx:85-111). */}
          {pills.unmapped > 0 && <Pill state="unmapped" n={pills.unmapped} label="unmapped" />}
          {pills.partial > 0 && <Pill state="partial" n={pills.partial} label="partial" />}
          {pills.missing > 0 && <Pill state="unavailable" n={pills.missing} label="missing" />}
          {pills.unmapped === 0 && pills.partial === 0 && pills.missing === 0 && (
            <span className="text-[11px] text-muted-foreground">Nothing outstanding</span>
          )}
          {canEdit && (
            <SyncFacilityMapDialog
              // Derived from the matrix's own columns, so the sync covers exactly
              // the facilities on screen — and skips any without a facility code,
              // which Uniware cannot be asked about at all.
              facilities={facilities
                .filter((f) => f.facility_code)
                .map((f) => ({ code: f.facility_code!, label: `${f.wh_name} · ${f.entity_code}` }))}
              onSynced={() => router.refresh()}
            />
          )}
        </MasterToolbarActions>
      </MasterToolbar>

      <Card>
        {/* p-0 so the horizontal scrollbar sits on the card's own edge. */}
        <CardContent className="p-0">
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
            <table className="w-full border-separate border-spacing-0 text-xs">
              {/* z-20 beats the frozen columns' z-10, or they paint over the
                  header they scroll past. */}
              <thead className="sticky top-0 z-20 bg-muted">
                <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:align-bottom [&>th]:font-medium [&>th]:text-muted-foreground">
                  <th className={cn("sticky left-0 z-20 bg-muted text-left", MFG_COL)}>
                    Manufacturer
                  </th>
                  {/* Also frozen: a count with its denominator scrolled off screen
                      gives no clue why the cell is amber. */}
                  <th
                    className={cn(
                      "sticky z-20 bg-muted text-right shadow-[1px_0_0_var(--color-border)]",
                      TOTAL_LEFT, TOTAL_COL
                    )}
                  >
                    Total SKUs
                  </th>
                  {facilities.map((f) => (
                    <th
                      key={f.wh_id}
                      className={cn(
                        "min-w-32 border-l border-border/60 text-center leading-tight",
                        selected?.whId === f.wh_id && "bg-accent"
                      )}
                    >
                      <div className="font-medium text-foreground">{f.wh_name}</div>
                      {/* master_warehouse.code is NULL on every row today, so the
                          facility code is both the available and the more useful
                          second line — it is what Uniware is addressed by, and it is
                          the vocabulary this screen's readers actually use. Upper
                          case + tracking because it is a machine identifier, not a
                          word. */}
                      <div className="font-mono text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                        {f.facility_code ?? "no facility code"}
                      </div>
                      {/* The dimension that makes one site appear twice. Without it
                          the two Gurgaon columns look like a duplicate row. */}
                      <div className="mt-0.5 text-[9px] font-normal uppercase tracking-wide text-muted-foreground/70">
                        {f.entity_code}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={facilities.length + 2}
                      className="border-t border-border py-10 text-center text-muted-foreground"
                    >
                      No manufacturers match your search.
                    </td>
                  </tr>
                ) : (
                  visible.map((row) => {
                    const isRowSel = selected?.mfgId === row.first.mfg_id
                    return (
                      // The row tint goes on the <tr>: the frozen cells are
                      // bg-inherit, so a per-cell tint never reaches them.
                      <tr
                        key={row.first.mfg_id}
                        className={cn(
                          // Padding is NOT set here any more. A `[&>td]:px-2` on the
                          // row outranks a `p-0` on the child td (0,1,1 vs 0,1,0), so
                          // the facility cells could never clear it to let their
                          // colour reach the cell edge. Each cell type sets its own.
                          "[&>td]:border-t [&>td]:border-border",
                          isRowSel ? "bg-accent/40" : "bg-background"
                        )}
                      >
                        <td className={cn("sticky left-0 z-10 bg-inherit px-2 py-1.5", MFG_COL)}>
                          <div className="truncate font-medium" title={row.first.mfg_name}>
                            {row.first.mfg_name}
                          </div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {row.first.mfg_code ?? "—"}
                          </div>
                        </td>
                        <td
                          className={cn(
                            "sticky z-10 bg-inherit px-2 py-1.5 text-right tabular-nums shadow-[1px_0_0_var(--color-border)]",
                            TOTAL_LEFT, TOTAL_COL
                          )}
                        >
                          {row.first.total_skus}
                        </td>
                        {facilities.map((f) => {
                          const cell = row.cells.get(f.wh_id)
                          if (!cell) return <td key={f.wh_id} />
                          const state = cellState(cell)
                          const isSel = isRowSel && selected?.whId === f.wh_id
                          return (
                            // The state colour lives on the CELL, so the grid reads
                            // as blocks of coverage rather than dots on a field. No
                            // padding here — the button fills the cell edge to edge
                            // and owns the height.
                            // Hover lives on the CELL, not the button: `h-full` inside
                            // a <td> only stretches once the row has a definite
                            // height, which is engine-dependent — so a hover on the
                            // button could brighten just part of the block. The td
                            // always covers the whole cell.
                            <td
                              key={f.wh_id}
                              className={cn(
                                "border-l border-border/60 p-0 text-center transition-colors",
                                MAP_STATE_BLOCK[state],
                                state === "unavailable"
                                  ? "hover:bg-accent"
                                  : "hover:brightness-[0.97] dark:hover:brightness-125"
                              )}
                            >
                              {/* A <button>, not tabIndex on the <td> — a
                                  focusable cell with no role reads as noise to a
                                  screen reader (same call as
                                  WarehousesClient.tsx:286-300).
                                  Unavailable cells stay clickable: it is the only
                                  way to start mapping somewhere new. */}
                              <button
                                type="button"
                                onClick={() => setSelected({ mfgId: cell.mfg_id, whId: cell.wh_id })}
                                aria-label={
                                  `${cell.mfg_name} at ${cell.wh_name} ${cell.entity_code}: ` +
                                  `${MAP_STATE_LABEL[state]}, ${cell.mapped_skus} of ${cell.total_skus} SKUs mapped`
                                }
                                className={cn(
                                  "relative flex h-full w-full items-center justify-center",
                                  "px-2 py-2 font-medium tabular-nums",
                                  // ring-inset, or the highlight would spill over the
                                  // neighbouring cell's colour instead of sitting in
                                  // its own block.
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                  isSel && "ring-2 ring-inset ring-ring"
                                )}
                              >
                                {cellLabel(cell)}
                                {/* Not a fifth state — an overlay on whichever
                                    state the cell is already in. */}
                                {needsPush(cell) && (
                                  <span
                                    aria-hidden
                                    title={`${cell.unpushed_skus} not yet confirmed in Uniware`}
                                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500 ring-1 ring-background"
                                  />
                                )}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <MfgFacilityMapPanel
        cell={selectedCell}
        skus={selectedSkus}
        canEdit={canEdit}
        onClose={() => setSelected(null)}
        // force-dynamic page, so a refresh re-derives the matrix and the pills
        // from fresh SQL — no optimistic local state to keep in step.
        onSaved={() => router.refresh()}
      />
    </>
  )
}

function Pill({
  state, n, label,
}: {
  state: (typeof MAP_STATES)[number]
  n: number
  label: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        MAP_STATE_CELL[state]
      )}
    >
      <span className="font-mono tabular-nums">{n}</span>
      {label}
    </span>
  )
}
