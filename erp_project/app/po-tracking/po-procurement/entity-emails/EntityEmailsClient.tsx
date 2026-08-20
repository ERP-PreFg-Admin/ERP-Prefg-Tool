"use client"

/**
 * CLIENT component for /po-tracking/po-procurement/entity-emails — standalone
 * page counterpart to the vendor/manufacturer contact-email list (formerly a
 * dialog on the FG POs Tracking page).
 */

import { useState } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { ArrowLeft, Pencil, Plus } from "lucide-react"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { Button } from "@/components/ui/button"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select } from "@/components/ui/select"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import AddEntityEmailDialog from "./AddEntityEmailDialog"

type EntityOption = { id: number; code: string; name: string }

type EntityEmailRow = {
  id: number
  entity_type: string
  entity_code: string
  /** master_entity.code, warehouse rows only. NULL = serves every entity. */
  legal_entity_code: string | null
  email: string
  /** Which header this address goes in. Older rows read back as 'to'. */
  recipient_type: string
  purpose: string | null
  /** 'inactive' rows stay listed and keep their history, but every send path
   *  filters status = 'active', so they receive nothing. */
  status: string
  created_at: string | null
  created_by: number | null
  /** Resolved from users; null for the rows that predate the column. */
  created_by_name: string | null
}

export default function EntityEmailsClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentType,
  vendorOptions,
  mfgOptions,
  warehouseOptions,
  legalEntityOptions,
  canEdit,
}: {
  rows: EntityEmailRow[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentType: string
  vendorOptions: EntityOption[]
  mfgOptions: EntityOption[]
  warehouseOptions: EntityOption[]
  legalEntityOptions: { code: string; legal_name: string }[]
  canEdit: boolean
}) {
  const { navigate, router } = useUrlFilters()
  const [showAdd, setShowAdd] = useState(false)
  // The row being edited. One dialog serves both: the entity pickers and the
  // address fields are identical, so a second component would duplicate them.
  const [editing, setEditing] = useState<EntityEmailRow | null>(null)

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code, email, or purpose…"
        />
        <Select
          value={currentType}
          onChange={(e) => navigate({ type: e.target.value })}
        >
          <option value="">All Types</option>
          <option value="vendor">Vendor</option>
          <option value="mfg">Manufacturer</option>
          <option value="warehouse">Warehouse</option>
          <option value="employee">Employee</option>
        </Select>
        <MasterToolbarActions>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => router.push("/po-tracking/po-procurement")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to FG POs Tracking
          </Button>
          {canEdit && (
            <Button size="sm" className="gap-1.5" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add Email
            </Button>
          )}
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Table ── */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Attached To</TableHead>
                <TableHead>Legal Entity</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Send As</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added By</TableHead>
                <TableHead>Added On</TableHead>
                {canEdit && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canEdit ? 10 : 9} className="text-center text-muted-foreground py-8 text-sm">
                    No entity emails found.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow
                    key={r.id}
                    // Dimmed rather than hidden: an inactive contact is still a
                    // record someone may need to find and reactivate.
                    className={r.status === "inactive" ? "opacity-55 hover:opacity-100 transition-opacity" : undefined}
                  >
                    <TableCell className="capitalize">{r.entity_type}</TableCell>
                    <TableCell className="font-mono">
                      {/* '*' is a real stored value, not missing data — one row
                          standing in for every entity of its kind. What it stands
                          for depends on entity_type: every MANUFACTURER on an
                          employee row, every WAREHOUSE on a warehouse row (see
                          selectForMfg vs selectByWarehouseForEntity). Labelling
                          both "All manufacturers" would misdescribe the second. */}
                      {r.entity_code === "*"
                        ? (
                          <span className="font-sans text-xs">
                            {r.entity_type === "warehouse" ? "All warehouses" : "All manufacturers"}
                          </span>
                        )
                        : r.entity_code}
                    </TableCell>
                    <TableCell>
                      {/* "All" rather than an em dash: a blank here means the row
                          serves every entity, which is a real value, not missing
                          data. Only meaningful for warehouses. */}
                      {r.entity_type !== "warehouse" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.legal_entity_code ? (
                        <Badge variant="secondary">{r.legal_entity_code}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">All entities</span>
                      )}
                    </TableCell>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>
                      {r.recipient_type === "cc"
                        ? <Badge variant="secondary">CC</Badge>
                        : <span className="text-muted-foreground text-xs">To</span>}
                    </TableCell>
                    <TableCell>{r.purpose ?? "—"}</TableCell>
                    <TableCell>
                      {r.status === "inactive"
                        ? <Badge variant="outline" title="Kept on file, but left out of every send">Inactive</Badge>
                        : <Badge variant="success">Active</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {/* Null on the rows that predate the column. Saying "—" is
                          honest; inventing an author would not be. */}
                      {r.created_by_name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                      {r.created_at
                        ? new Date(r.created_at).toLocaleDateString("en-IN",
                            { day: "2-digit", month: "short", year: "numeric" })
                        : "—"}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 text-xs"
                          onClick={() => setEditing(r)}
                          title={`Edit ${r.email}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>

      <AddEntityEmailDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        vendorOptions={vendorOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        legalEntityOptions={legalEntityOptions}
        onSaved={() => { setShowAdd(false); router.refresh() }}
      />

      {/* Keyed by row id so opening a different contact remounts the dialog with
          that row's values, rather than needing an effect to resync the form. */}
      {editing && (
        <AddEntityEmailDialog
          key={editing.id}
          open
          editing={editing}
          onClose={() => setEditing(null)}
          vendorOptions={vendorOptions}
          mfgOptions={mfgOptions}
          warehouseOptions={warehouseOptions}
          legalEntityOptions={legalEntityOptions}
          onSaved={() => { setEditing(null); router.refresh() }}
        />
      )}
    </>
  )
}
