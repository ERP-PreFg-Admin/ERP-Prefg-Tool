"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Select } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SearchInput } from "@/components/masters/SearchInput"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { AddRecordDialog } from "@/components/masters/AddRecordDialog"
import type { MasterField } from "@/components/masters/field-config"
import type { PM } from "@/types/masters"

// CLIENT component for /masters/packing-materials. Receives PM rows from the
// server page as `initialRows` and owns search + a status filter + the Add /
// CSV-import dialogs, which POST to /api/masters/packing-materials.

const PM_FIELDS: MasterField[] = [
  {
    key: "pm_code",
    label: "PM Code",
    aliases: ["code"],
    placeholder: "e.g. PM-001",
    sample: "PM-001",
  },
  {
    key: "name",
    label: "Name",
    required: true,
    placeholder: "Material name",
    sample: "Bottle 100ml",
  },
  { key: "type", label: "Type", placeholder: "Type", sample: "Bottle" },
  {
    key: "hsn_code",
    label: "HSN Code",
    placeholder: "HSN",
    sample: "39235010",
  },
  { key: "uom", label: "UOM", placeholder: "e.g. pcs", sample: "pcs" },
]

export default function PackingMaterialsClient({
  initialRows,
}: {
  initialRows: PM[]
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")

  const filtered = initialRows.filter((r) => {
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      (r.pm_code ?? "").toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      (r.type ?? "").toLowerCase().includes(q)
    const matchStatus = statusFilter === "all" || r.status === statusFilter
    return matchSearch && matchStatus
  })

  const hasFilters = search || statusFilter !== "all"
  const refresh = () => router.refresh()

  return (
    <>
      <MasterToolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by code, name, type…"
        />

        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="discontinued">Discontinued</option>
        </Select>

        <MasterToolbarActions>
          <CsvImportDialog
            entityLabel="Packing Material"
            entityLabelPlural="Packing Materials"
            endpoint="/api/masters/packing-materials"
            templateFilename="packing_material_template.csv"
            fields={PM_FIELDS}
            onSuccess={refresh}
          />
          <AddRecordDialog
            entityLabel="Packing Material"
            endpoint="/api/masters/packing-materials"
            fields={PM_FIELDS}
            onSuccess={refresh}
          />
        </MasterToolbarActions>
      </MasterToolbar>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {filtered.length} of {initialRows.length} records
            {hasFilters && (
              <button
                onClick={() => {
                  setSearch("")
                  setStatusFilter("all")
                }}
                className="ml-2 text-xs text-primary hover:underline"
              >
                Clear filters
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PM Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>UOM</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center py-10"
                  >
                    <EmptyState hasFilters={!!hasFilters} filteredMessage="No packing materials match your filters." />
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs font-medium">
                      {row.pm_code ?? "—"}
                    </TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.type ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground uppercase text-xs">
                      {row.uom ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.status === "active" ? "success" : "secondary"}
                        className="capitalize"
                      >
                        {row.status ?? "—"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
