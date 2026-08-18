"use client"

/**
 * CLIENT component for /masters/warehouses.
 *
 * ONE ROW PER (location, legal entity) — 18 rows for 9 locations, matching the
 * source sheet. Every location operates under both Pep and Kreative with its own
 * facility code, GSTINs and addresses, so a per-entity row is the real unit of
 * data even though master_warehouse still holds one row per place (that is what
 * purchase_orders.destination resolves against, so it cannot be split).
 *
 * A location with no row for an entity still appears, with blanks — otherwise the
 * one screen that can fix it is the one place it is invisible.
 *
 * Filters in memory: 18 rows, so no PaginationBar and no server round trip.
 * Plain <TableHead> like ManufacturersClient, not DataTable/ColumnDef.
 *
 * The filter panel is the shared FilterPanel chrome, but WITHOUT the draft-state
 * +navigate() dance the other masters use: those filter server-side through the
 * URL, and here the whole table is already in memory. So each select binds
 * straight to state and applies as you change it — Apply only closes the panel.
 */

import { useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { SearchInput } from "@/components/masters/SearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { StatusBadge } from "@/components/masters/StatusBadge"
import {
  useFilterPanel, FilterToggleButton, FilterPanel, FilterField,
} from "@/components/masters/FilterPanel"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Pencil } from "lucide-react"
import { useRouter } from "next/navigation"
import { AddWarehouseDialog } from "./AddWarehouseDialog"
import { EditWarehouseDialog } from "./EditWarehouseDialog"
import { WarehouseDetailPanel } from "./WarehouseDetailPanel"
// Row, the filter predicate and the two status/type resolvers live in filters.ts
// so they can be tested — see tests/unit/warehouse-filters.test.ts. `Row` carries
// the entity, not just the warehouse: dropping it is what used to leak Kreative's
// facility, GSTINs and addresses into a Pep record and vice versa.
import { type Row, NO_FILTERS, typeOf, statusOf, matchesRow } from "./filters"
import type { Warehouse, WarehouseEntity, Entity } from "@/types/masters"

export default function WarehousesClient({
  rows,
  entityRows,
  entities,
}: {
  rows: Warehouse[]
  entityRows: WarehouseEntity[]
  entities: Entity[]
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState(NO_FILTERS)
  const [editing, setEditing] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)
  const filterPanel = useFilterPanel()

  /** warehouse_id -> its entity rows, so the table and the Edit dialog both read
   *  the child data without re-querying. */
  const byWarehouse = useMemo(() => {
    const map = new Map<number, WarehouseEntity[]>()
    for (const row of entityRows) {
      const list = map.get(row.warehouse_id) ?? []
      list.push(row)
      map.set(row.warehouse_id, list)
    }
    return map
  }, [entityRows])

  /**
   * The flat list: one entry per (location, entity), locations ordered as the
   * server sent them and entities by code within each.
   *
   * `detail` is null when that entity has no row for the location yet. Those are
   * still listed — a missing pair is exactly what needs fixing, and hiding it
   * would make it invisible on the only screen that can fix it.
   */
  const flat = useMemo<Row[]>(
    () =>
      rows.flatMap((warehouse) =>
        entities.map((entity) => ({
          warehouse,
          entity,
          detail: (byWarehouse.get(warehouse.id) ?? []).find((r) => r.entity_code === entity.code) ?? null,
          key: `${warehouse.id}:${entity.code}`,
        }))
      ),
    [rows, entities, byWarehouse]
  )

  /** Every entity's PAN. Passed down because a ship-to GSTIN must be one of OURS
   *  but need not be the row's own entity — Pep operates most sites — so the
   *  one-entity dialog cannot derive this set itself. */
  const ourPans = useMemo(
    () => entities.map((e) => e.pan).filter((p): p is string => Boolean(p)),
    [entities]
  )

  /**
   * Zone and Status options come from the rows rather than from a fixed list
   * (ZONE_OPTIONS / the status ENUM): an option that matches nothing is worse
   * than no option, and the location statuses in play depend on what is mid-
   * approval right now. Entity comes from `entities` — every location is meant to
   * have a row for each, so an entity with none yet must still be selectable to
   * find the gap.
   */
  // The type predicates are load-bearing: `zone` is nullable, and a bare
  // .filter(Boolean) leaves the element type `string | null`, which then fails to
  // typecheck as an <option value>.
  const zoneOptions = useMemo(
    () => [...new Set(rows.map((r) => r.zone).filter((z): z is string => Boolean(z)))].sort(),
    [rows]
  )
  const statusOptions = useMemo(
    () => [...new Set(flat.map(statusOf).filter((s): s is string => Boolean(s)))].sort(),
    [flat]
  )

  const filtered = useMemo(
    () => flat.filter((r) => matchesRow(r, filters, search)),
    [flat, search, filters]
  )

  const activeFilterCount = Object.values(filters).filter(Boolean).length
  const hasFilters = Boolean(search) || activeFilterCount > 0

  /** One select's onChange. "all" is the sentinel the other masters' panels use
   *  for the blank option, because an <option value=""> loses its selected state
   *  in some browsers. */
  const setFilter = (key: keyof typeof NO_FILTERS) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value === "all" ? "" : value }))

  function clearAllFilters() {
    setFilters(NO_FILTERS)
    setSearch("")
    filterPanel.close()
  }

  const COL_COUNT = 9

  // No DownloadButton: it takes a server export endpoint (see its props), and a
  // whole route + query for 18 rows that are all on screen already isn't worth
  // it. Add one alongside the export route if the list ever grows.

  return (
    <>
      <MasterToolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search facility, location, entity, GSTIN or remarks…"
        />
        <FilterToggleButton
          open={filterPanel.open}
          onToggle={filterPanel.toggle}
          activeCount={activeFilterCount}
        />
        <MasterToolbarActions>
          <AddWarehouseDialog entities={entities} onSuccess={() => router.refresh()} />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* onApply only closes: every select above already applied on change, since
          there is no server round trip to batch. */}
      <FilterPanel
        open={filterPanel.open}
        onClose={filterPanel.close}
        onApply={filterPanel.close}
        onClear={clearAllFilters}
      >
        <FilterField label="Legal Entity">
          <Select
            className="w-full"
            value={filters.entity || "all"}
            onChange={(e) => setFilter("entity")(e.target.value)}
          >
            <option value="all">All Entities</option>
            {entities.map((entity) => (
              <option key={entity.code} value={entity.code}>
                {entity.code} — {entity.legal_name}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Type">
          <Select
            className="w-full"
            value={filters.type || "all"}
            onChange={(e) => setFilter("type")(e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="MWH">MWH — Mother Warehouse</option>
            <option value="CWH">CWH — Child Warehouse</option>
          </Select>
        </FilterField>

        <FilterField label="Zone">
          <Select
            className="w-full"
            value={filters.zone || "all"}
            onChange={(e) => setFilter("zone")(e.target.value)}
          >
            <option value="all">All Zones</option>
            {zoneOptions.map((zone) => (
              <option key={zone} value={zone}>{zone}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Status">
          <Select
            className="w-full"
            value={filters.status || "all"}
            onChange={(e) => setFilter("status")(e.target.value)}
          >
            <option value="all">All Status</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>{status.replace("_", " ")}</option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Uniware Facility">
          <Select
            className="w-full"
            value={filters.configured || "all"}
            onChange={(e) => setFilter("configured")(e.target.value)}
          >
            <option value="all">Configured or not</option>
            <option value="yes">Configured</option>
            {/* The one that earns its place: these are the pairs that silently
                block inwarding, and this screen is the only place to fix them. */}
            <option value="no">Not configured</option>
          </Select>
        </FilterField>
      </FilterPanel>

      <Card>
        <RecordCountHeader
          total={filtered.length}
          matching={search || undefined}
          onClearFilters={hasFilters ? clearAllFilters : undefined}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Facility</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Bill-To GSTIN</TableHead>
                <TableHead>Ship-To GSTIN</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Remarks</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COL_COUNT} className="text-center py-10">
                    <EmptyState
                      hasFilters={hasFilters}
                      filteredMessage="No warehouses match your filters."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => (
                  // The whole row opens the detail panel. Keyboard-reachable via
                  // the button in the first cell rather than by putting a tabIndex
                  // on the <tr> — a focusable row with no role reads as noise to
                  // a screen reader.
                  <TableRow
                    key={row.key}
                    onClick={() => setViewing(row)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      <button
                        type="button"
                        className="text-left hover:underline focus-visible:underline focus-visible:outline-none"
                        onClick={(e) => { e.stopPropagation(); setViewing(row) }}
                      >
                        {row.detail?.facility_code ?? (
                          <span className="font-sans text-muted-foreground">Not configured</span>
                        )}
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.entity.code}</Badge>
                    </TableCell>
                    <TableCell>
                      {row.warehouse.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {[row.warehouse.location, row.warehouse.state].filter(Boolean).join(", ")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={typeOf(row) === "MWH" ? "info" : "secondary"}>
                        {typeOf(row)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.detail?.bill_to_gstin ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.detail?.ship_to_gstin ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {/* The location's status if the pair doesn't exist yet —
                          otherwise a missing row would read as active. */}
                      <StatusBadge status={row.detail?.status ?? row.warehouse.status} />
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                      {row.detail?.remarks ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${row.warehouse.name} — ${row.entity.code}`}
                        // stopPropagation or the row's own handler also fires and
                        // the detail panel opens behind the edit dialog.
                        onClick={(e) => { e.stopPropagation(); setEditing(row) }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* One entity only — the row that was clicked. */}
      <WarehouseDetailPanel
        warehouse={viewing?.warehouse ?? null}
        entity={viewing?.entity ?? null}
        entityRow={viewing?.detail ?? null}
        onClose={() => setViewing(null)}
        onEdit={() => viewing && setEditing(viewing)}
      />

      <EditWarehouseDialog
        warehouse={editing?.warehouse ?? null}
        entity={editing?.entity ?? null}
        entityRow={editing?.detail ?? null}
        ourPans={ourPans}
        onSuccess={() => router.refresh()}
        onClose={() => setEditing(null)}
      />
    </>
  )
}
