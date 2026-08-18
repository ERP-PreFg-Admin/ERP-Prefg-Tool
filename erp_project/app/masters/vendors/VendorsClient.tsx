"use client"

/**
 * CLIENT component for /masters/vendors.
 *
 * Receives a pre-filtered, pre-paginated slice of vendors from the server page.
 * Owns all interactive behaviour:
 *   - URL-synced search (UrlSearchInput — 350 ms debounce → ?search=)
 *   - Type filter (select → ?type=)
 *   - Add record dialog (POST /api/v1/masters/vendors)
 *   - CSV import dialog  (POST /api/v1/masters/vendors)
 *   - Pagination footer  (PaginationBar — navigates ?page= / ?size=)
 *
 * Navigation strategy: every filter/page change is merged into the current URL
 * via the local `navigate()` helper, which calls router.push(). This keeps all
 * active params (?search=, ?type=, ?page=, ?size=) consistent in the URL.
 *
 * After an Add or CSV import, router.refresh() re-runs the server page with
 * the SAME URL params so the user stays on their current page and filters.
 */

import { useUrlFilters } from "@/lib/useUrlFilters"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Select } from "@/components/ui/select"
import { useFilterPanel, FilterToggleButton, FilterPanel, FilterField } from "@/components/masters/FilterPanel"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
  MasterToolbar,
  MasterToolbarActions,
} from "@/components/masters/MasterToolbar"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { MasterField } from "@/components/masters/field-config"
import { ZONE_OPTIONS, normalizeZone } from "@/components/masters/field-config"
import type { Vendor } from "@/types/masters"
import { useEffect, useState } from "react"
import { FileText, Pencil, History as HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EditVendorDialog } from "./EditVendorDialog"
import { AddVendorDialog } from "./AddVendorDialog"
import { VendorDocumentsDialog } from "./VendorDocumentsDialog"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import { useEditGuard } from "@/components/AccessContext"
// Common fields shared by the CSV importer.
// `code` is auto-generated server-side on single-record create AND on a
// bulk-CSV new-record row — never collected from the user directly. In the
// CSV importer it's the authoritative "this row edits THAT record" signal: a
// row whose `code` cell matches an existing vendor is an edit of it; a blank
// `code` (e.g. every row in the downloadable template) is always a new
// record. `aliases` covers the exported file's "Vendor Code" column header.
const VENDOR_CSV_FIELDS: MasterField[] = [
  { key: "code",            label: "Code",            colSpan: 2, placeholder: "Leave blank for a new vendor",
    aliases: ["Vendor Code"], sample: "" },
  { key: "name",            label: "Name",            required: true, placeholder: "Vendor name",      sample: "Acme Pvt Ltd" },
  {
    key: "type", label: "Type", type: "select", required: true, requiredForCreateOnly: true, colSpan: 2, sample: "rm",
    options: [
      { value: "rm",   label: "RM"   },
      { value: "pm",   label: "PM"   },
      { value: "both", label: "BOTH" },
    ],
  },
  { key: "registered_name", label: "Registered Name", required: true, requiredForCreateOnly: true, placeholder: "Legal registered name", sample: "Acme Pvt Ltd" },
  { key: "location",        label: "Location",        placeholder: "e.g. Mumbai",           sample: "Mumbai" },
  // Optional on the bulk upload: a vendor can be onboarded before its zone is
  // decided. Still validated when present — a wrong zone is worse than none,
  // since the vendor list filters on it. field-config.ts only runs `validate`
  // on a non-empty cell, so a blank one passes.
  { key: "zone",            label: "Zone",            type: "select", options: ZONE_OPTIONS, sample: "West",
    validate: (raw) => (normalizeZone(raw) ? null : `Must be one of: ${ZONE_OPTIONS.map((o) => o.value).join(", ")}`),
    parse: (raw) => normalizeZone(raw) ?? raw },
  { key: "gst_number",      label: "GST Number",      placeholder: "e.g. 27AAEPM1234C1Z5",  sample: "27AAEPM1234C1Z5" },
  { key: "bank_name",       label: "Bank Name",       placeholder: "e.g. HDFC Bank",        sample: "HDFC Bank" },
  { key: "ifsc_number",     label: "IFSC Number",     placeholder: "e.g. HDFC0001234",      sample: "HDFC0001234" },
  { key: "account_number",  label: "Account Number",  placeholder: "e.g. 12345678901234",   sample: "12345678901234" },
  { key: "remarks",         label: "Remarks",         colSpan: 2, placeholder: "Optional for new records — remarks are required when submitting an edit", sample: "New vendor onboarding" },
]

export default function VendorsClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentType,
  currentZone,
  zones,
}: {
  rows: Vendor[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentType: string
  currentZone: string
  zones: string[]
}) {
  const { navigate, router } = useUrlFilters()
  const [editVendor, setEditVendor] = useState<Vendor | null>(null)
  const guard = useEditGuard()
  const [docsVendor, setDocsVendor] = useState<Vendor | null>(null)
  const [historyVendorId, setHistoryVendorId] = useState<number | null>(null)

  // Filter panel open/close.
  const filterPanel = useFilterPanel()

  // Draft filter state — selects only update these locally; the actual
  // server refetch fires only when "Apply" is clicked.
  const [draftType, setDraftType] = useState(currentType)
  const [draftZone, setDraftZone] = useState(currentZone)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft type when the URL-driven type filter changes
  useEffect(() => setDraftType(currentType), [currentType])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft zone when the URL-driven zone filter changes
  useEffect(() => setDraftZone(currentZone), [currentZone])

  const activeFilterCount = [currentType, currentZone].filter(Boolean).length
  const hasFilters = currentSearch || currentType || currentZone
  // router.refresh() re-runs the server page with the SAME URL, keeping page + filters.
  const refresh    = () => router.refresh()

  function applyFilters() {
    navigate({ type: draftType, zone: draftZone })
    filterPanel.close()
  }

  function clearAllFilters() {
    setDraftType("")
    setDraftZone("")
    navigate({ search: "", type: "", zone: "" })
    filterPanel.close()
  }

  return (
    <>
      {/* ── Toolbar ── */}
      <MasterToolbar>
        <UrlSearchInput
          initialValue={currentSearch}
          placeholder="Search by code or name…"
        />

        <FilterToggleButton open={filterPanel.open} onToggle={filterPanel.toggle} activeCount={activeFilterCount} />

        <MasterToolbarActions>
          <DownloadButton
            endpoint="/api/v1/masters/vendors/export"
            label="Vendors"
          />
          <CsvImportDialog
            entityLabel="Vendor"
            endpoint="/api/v1/masters/vendors"
            templateFilename="vendor_template.csv"
            fields={VENDOR_CSV_FIELDS}
            onSuccess={refresh}
            enableDuplicateCheck
            previewExcel
          />
          <AddVendorDialog onSuccess={refresh} />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Filter panel ── */}
      <FilterPanel open={filterPanel.open} onClose={filterPanel.close} onApply={applyFilters} onClear={clearAllFilters}>
        <FilterField label="Type">
          <Select
            className="w-full"
            value={draftType || "all"}
            onChange={(e) => setDraftType(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="rm">RM</option>
            <option value="pm">PM</option>
            <option value="both">BOTH</option>
          </Select>
        </FilterField>

        <FilterField label="Zone">
          <Select
            className="w-full"
            value={draftZone || "all"}
            onChange={(e) => setDraftZone(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Zones</option>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </Select>
        </FilterField>
      </FilterPanel>

      {/* ── Table card ── */}
      <Card>
        <RecordCountHeader
          total={total}
          onClearFilters={hasFilters ? clearAllFilters : undefined}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Registered Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>GST Number</TableHead>
                <TableHead>Bank</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-10">
                    <EmptyState hasFilters={!!hasFilters} filteredMessage="No vendors match your filters." />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.vendor_id}>
                    <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>{row.registered_name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.type?.toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>{row.location ?? "—"}</TableCell>
                    <TableCell>{row.zone ?? "—"}</TableCell>
                    <TableCell>{row.gst_number ?? "—"}</TableCell>
                    <TableCell>{row.bank_name ?? "—"}</TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => { if (guard("edit a vendor")) setEditVendor(row) }}
                          disabled={row.status === "in_review"}
                          title={row.status === "in_review" ? "Pending approval — cannot edit" : "Edit"}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDocsVendor(row)}
                          title="Documents"
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setHistoryVendorId(row.vendor_id)}
                          title="History"
                        >
                          <HistoryIcon className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {/* Pagination footer: rows-per-page selector + prev/next */}
          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>
      <EditVendorDialog
        vendor={editVendor}
        onSuccess={refresh}
        onClose={() => setEditVendor(null)}
      />
      <VendorDocumentsDialog
        vendor={docsVendor}
        onSuccess={refresh}
        onClose={() => setDocsVendor(null)}
      />
      <EntityHistoryDialog
        module="VENDOR"
        entityId={historyVendorId}
        title="Vendor Edit History"
        onClose={() => setHistoryVendorId(null)}
      />
    </>
  )
}
