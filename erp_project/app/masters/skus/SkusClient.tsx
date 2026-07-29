"use client"

/**
 * CLIENT component for /masters/skus.
 *
 * Receives a paginated slice of SKUs from the server page (SkusPage).
 * Owns all interactive behaviour: URL-synced search, status filter, edit
 * dialog, and the PaginationBar footer.
 *
 * Filter changes push new URL params (resetting to page 1); the server
 * re-renders with the DB-filtered slice.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { Sku } from "@/types/masters"

export default function SkusClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
  currentBrand,
}: {
  rows: Sku[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
  currentBrand: string
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  /** Merge URL-param overrides and reset to page 1. */
  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }
  // Draft status — the select only updates this locally; the actual server
  // refetch fires only when "Apply" is clicked.
  const [draftStatus, setDraftStatus] = useState(currentStatus)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft status when the URL-driven status filter changes
  useEffect(() => setDraftStatus(currentStatus), [currentStatus])
  const draftDirty = draftStatus !== currentStatus
  const hasFilters = !!currentSearch || !!currentStatus || !!currentBrand
  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code, name, brand…"
        />
        {/* Search Based on Status. */}
        <select
          value={draftStatus || "all"}
          onChange={(e) =>
            setDraftStatus(e.target.value === "all" ? "" : e.target.value)
          }
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="discontinued"> Discontinued</option>
        </select>
        <Button variant="outline" size="lg" onClick={() => navigate({ status: draftStatus })} disabled={!draftDirty}>
          Apply
        </Button>
          {/* Search Based on Brands. Applied immediately (server-side filter, whole DB). */}
        <select
          value={currentBrand || "all"}
          onChange={(e) => navigate({ brand: e.target.value === "all" ? "" : e.target.value })}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="all">All Brands</option>
          <option value="mCaffeine">mCaffeine</option>
          <option value="mCaffeine Shades">mCaffeine Shades</option>
          <option value="HYPHEN">HYPHEN</option>
          <option value="FIEN">FIEN</option>
        </select>


        <MasterToolbarActions>
          <DownloadButton
            endpoint="/api/masters/skus/export"
            label="SKUs"
          />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Table card ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {total} record{total !== 1 ? "s" : ""}
            {hasFilters && (
              <button
                onClick={() => {
                  setDraftStatus("")
                  navigate({ search: "", status: "", brand: "" })
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
                <TableHead>SKU Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Sub-Category</TableHead>
                <TableHead>MRP</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead>Launch Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                    {hasFilters ? "No SKUs match your filters." : "No records found."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => (
                  <TableRow key={row.id} className={index % 2 === 0 ? "bg-background" : "bg-muted/40"}>
                    <TableCell className="font-mono text-xs font-medium">{row.sku_code}</TableCell>
                    <TableCell className="font-medium text-wrap">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.brand ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.category ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.sub_category ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.mrp != null ? `₹${row.mrp}` : "—"}
                    </TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.hsn ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.launch_date?.split(" ")[0] ?? "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>
    </>
  )
}
