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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Pencil } from "lucide-react"
import { useRouter } from "next/navigation"
import { AddWarehouseDialog } from "./AddWarehouseDialog"
import { EditWarehouseDialog } from "./EditWarehouseDialog"
import { WarehouseDetailPanel } from "./WarehouseDetailPanel"
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
  const [editing, setEditing] = useState<Warehouse | null>(null)
  const [viewing, setViewing] = useState<Warehouse | null>(null)

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
  const flat = useMemo(
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return flat
    return flat.filter((r) =>
      [
        r.warehouse.name, r.warehouse.location, r.warehouse.state, r.warehouse.zone,
        r.entity.code, r.entity.legal_name,
        r.detail?.facility_code, r.detail?.bill_to_gstin, r.detail?.ship_to_gstin,
        r.detail?.remarks,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [flat, search])

  /** The per-entity type wins; the location's is the fallback. */
  const typeOf = (r: (typeof flat)[number]) => r.detail?.type ?? r.warehouse.type

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
        <MasterToolbarActions>
          <AddWarehouseDialog entities={entities} onSuccess={() => router.refresh()} />
        </MasterToolbarActions>
      </MasterToolbar>

      <Card>
        <RecordCountHeader total={filtered.length} matching={search || undefined} />
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
                      hasFilters={Boolean(search)}
                      filteredMessage="No warehouses match your search."
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
                    onClick={() => setViewing(row.warehouse)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      <button
                        type="button"
                        className="text-left hover:underline focus-visible:underline focus-visible:outline-none"
                        onClick={(e) => { e.stopPropagation(); setViewing(row.warehouse) }}
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
                        aria-label={`Edit ${row.warehouse.name}`}
                        // stopPropagation or the row's own handler also fires and
                        // the detail panel opens behind the edit dialog.
                        onClick={(e) => { e.stopPropagation(); setEditing(row.warehouse) }}
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

      <WarehouseDetailPanel
        warehouse={viewing}
        entities={entities}
        entityRows={viewing ? byWarehouse.get(viewing.id) ?? [] : []}
        onClose={() => setViewing(null)}
        onEdit={setEditing}
      />

      <EditWarehouseDialog
        warehouse={editing}
        entities={entities}
        entityRows={editing ? byWarehouse.get(editing.id) ?? [] : []}
        onSuccess={() => router.refresh()}
        onClose={() => setEditing(null)}
      />
    </>
  )
}
