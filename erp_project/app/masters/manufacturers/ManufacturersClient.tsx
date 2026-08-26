"use client"

/**
 * CLIENT component for /masters/manufacturers.
 *
 * Receives a paginated slice of manufacturers from the server page.
 * Owns search (UrlSearchInput), Add/CSV dialogs, and the PaginationBar footer.
 */

import { useUrlFilters } from "@/lib/useUrlFilters"
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
import { AddMfgDialog } from "./AddMfgDialog"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { StatusBadge } from "@/components/masters/StatusBadge"
import type { MasterField } from "@/components/masters/field-config"
import { ZONE_OPTIONS, normalizeZone } from "@/components/masters/field-config"
import { GST_REGEX, IFSC_REGEX, ACCOUNT_NUMBER_REGEX, EMAIL_REGEX } from "@/lib/validation/shared"
import type { Mfg } from "@/types/masters"
import { useEffect, useState } from "react"
import { Pencil, FileText, History as HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EditMfgDialog } from "./EditMfgDialog"
import { ManufacturerDocumentsDialog } from "./ManufacturerDocumentsDialog"
import { EntityHistoryDialog } from "@/components/masters/EntityHistoryDialog"
import { useEditGuard } from "@/components/AccessContext"
// Common fields shared by the Add dialog and the CSV import.
// `code` is auto-generated server-side on single-record create AND on a
// bulk-CSV new-record row (MFG-<serial>-<XX>) — it's never collected from
// the user in the Add form (form: false). In the CSV importer it's the
// authoritative "this row edits THAT record" signal: a row whose `code`
// cell matches an existing manufacturer is an edit of it; a blank `code`
// (e.g. every row in the downloadable template) is always a new record.
const MFG_COMMON_FIELDS: MasterField[] = [
  { key: "code",            label: "Code",            form: false, colSpan: 2, placeholder: "Leave blank for a new manufacturer",
    sample: "" },
  { key: "name",            label: "Name",            required: true, colSpan: 2, placeholder: "Manufacturer name", sample: "Acme Manufacturing",
    duplicateKey: true,
    validate: (raw) => (/^\d+$/.test(raw) ? "Looks numeric, not a name" : null) },
  { key: "registered_name", label: "Registered Name", required: true, requiredForCreateOnly: true, placeholder: "Legal registered name", sample: "Acme Manufacturing Pvt Ltd" },
  { key: "location",        label: "Location",        placeholder: "e.g. Mumbai",                  sample: "Mumbai" },
  { key: "zone",            label: "Zone",            required: true, requiredForCreateOnly: true, type: "select", options: ZONE_OPTIONS, sample: "West",
    validate: (raw) => (normalizeZone(raw) ? null : `Must be one of: ${ZONE_OPTIONS.map((o) => o.value).join(", ")}`),
    parse: (raw) => normalizeZone(raw) ?? raw },
  { key: "gst_number",      label: "GST Number",      required: true, requiredForCreateOnly: true, placeholder: "e.g. 27AAEPM1234C1Z5", sample: "27AAEPM1234C1Z5",
    duplicateKey: true,
    validate: (raw) => (GST_REGEX.test(raw.toUpperCase()) ? null : "Invalid GST format") },
  { key: "bank_name",       label: "Bank Name",       placeholder: "e.g. HDFC Bank",               sample: "HDFC Bank" },
  { key: "ifsc_number",     label: "IFSC Number",     placeholder: "e.g. HDFC0001234",             sample: "HDFC0001234",
    duplicateKey: true,
    validate: (raw) => (IFSC_REGEX.test(raw.toUpperCase()) ? null : "Invalid IFSC format") },
  { key: "account_number",  label: "Account Number",  placeholder: "e.g. 12345678901234",          sample: "12345678901234",
    duplicateKey: true,
    validate: (raw) => (ACCOUNT_NUMBER_REGEX.test(raw) ? null : "Invalid account number — expected 9 to 18 digits") },
  { key: "email",           label: "Email Address",   placeholder: "e.g. vendor@manufacturer.com", sample: "vendor@manufacturer.com",
    aliases: ["Email Address"],
    duplicateKey: true,
    validate: (raw) => (EMAIL_REGEX.test(raw) ? null : "Invalid email address") },
  { key: "remarks",         label: "Remarks",         colSpan: 2, placeholder: "Optional for new records — remarks are required when submitting an edit", sample: "New manufacturer onboarding" },
]

const MFG_CSV_FIELDS: MasterField[] = MFG_COMMON_FIELDS

export default function ManufacturersClient({
  rows,
  total,
  page,
  pageSize,
  currentSearch,
  currentStatus,
}: {
  rows: Mfg[]
  total: number
  page: number
  pageSize: number
  currentSearch: string
  currentStatus: string
}) {
  const { navigate, router } = useUrlFilters()
  // router.refresh() re-runs the server page with current URL — keeps page + filters.
  const refresh = () => router.refresh()
  const [editMfg, setEditMfg] = useState<Mfg | null>(null)
  const guard = useEditGuard()
  const [docsMfg, setDocsMfg] = useState<Mfg | null>(null)
  const [historyMfgId, setHistoryMfgId] = useState<number | null>(null)

  const filterPanel = useFilterPanel()
  const [draftStatus, setDraftStatus] = useState(currentStatus)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft field when the URL-driven status filter changes
  useEffect(() => setDraftStatus(currentStatus), [currentStatus])

  const activeFilterCount = currentStatus ? 1 : 0
  const hasFilters = !!currentSearch || activeFilterCount > 0

  function applyFilters() {
    navigate({ status: draftStatus })
    filterPanel.close()
  }

  function clearAllFilters() {
    setDraftStatus("")
    navigate({ search: "", status: "" })
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
            endpoint="/api/v1/masters/manufacturers/export"
            label="Manufacturers"
          />
          <CsvImportDialog
            entityLabel="Manufacturer"
            endpoint="/api/v1/masters/manufacturers"
            templateFilename="manufacturer_template.csv"
            fields={MFG_CSV_FIELDS}
            onSuccess={refresh}
            enableDuplicateCheck
          />
          <AddMfgDialog onSuccess={refresh} />
        </MasterToolbarActions>
      </MasterToolbar>

      {/* ── Filter panel ── */}
      <FilterPanel open={filterPanel.open} onClose={filterPanel.close} onApply={applyFilters} onClear={clearAllFilters}>
        <FilterField label="Status">
          <Select
            className="w-full"
            value={draftStatus || "all"}
            onChange={(e) => setDraftStatus(e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </FilterField>
      </FilterPanel>

      {/* ── Table card ── */}
      <Card>
        <RecordCountHeader total={total} onClearFilters={hasFilters ? clearAllFilters : undefined} />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Registered Name</TableHead>
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
                  <TableCell colSpan={9} className="text-center py-10">
                    <EmptyState hasFilters={hasFilters} filteredMessage="No manufacturers match your filters." />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.mfg_id}>
                    <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>{row.registered_name ?? "—"}</TableCell>
                    <TableCell>{row.location ?? "—"}</TableCell>
                    <TableCell>{row.zone ?? "—"}</TableCell>
                    <TableCell>{row.gst_number ?? "—"}</TableCell>
                    <TableCell>{row.bank_name ?? "—"}</TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell>
                      <div className="flex items-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => { if (guard("edit a manufacturer")) setEditMfg(row) }}
                          disabled={row.status === "in_review"}
                          title={row.status === "in_review" ? "Pending approval — cannot edit" : "Edit"}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDocsMfg(row)}
                          title="Documents"
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setHistoryMfgId(row.mfg_id)}
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

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>
      <EditMfgDialog
        mfg={editMfg}
        onSuccess={refresh}
        onClose={() => setEditMfg(null)}
      />
      <ManufacturerDocumentsDialog
        mfg={docsMfg}
        onSuccess={refresh}
        onClose={() => setDocsMfg(null)}
      />
      <EntityHistoryDialog
        module="MFG"
        entityId={historyMfgId}
        title="Manufacturer Edit History"
        onClose={() => setHistoryMfgId(null)}
      />
    </>
  )
}
