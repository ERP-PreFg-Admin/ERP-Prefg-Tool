"use client"

/**
 * CLIENT component for /po-tracking/po-procurement/entity-emails — standalone
 * page counterpart to the vendor/manufacturer contact-email list (formerly a
 * dialog on the FG POs Tracking page).
 */

import { useState } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { ArrowLeft, Plus } from "lucide-react"
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
  created_at: string | null
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8 text-sm">
                    No entity emails found.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="capitalize">{r.entity_type}</TableCell>
                    <TableCell className="font-mono">
                      {/* '*' is a real stored value, not missing data: one
                          employee row standing in for every manufacturer. */}
                      {r.entity_code === "*"
                        ? <span className="font-sans text-xs">All manufacturers</span>
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
    </>
  )
}
