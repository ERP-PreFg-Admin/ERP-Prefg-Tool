"use client"

import { useState } from "react"
import { Filter, X } from "lucide-react"
import type { MatchBadge } from "@/lib/invoice/three-way"
import { Button } from "@/components/ui/button"
import { ToggleButton } from "@/components/ui/toggle-button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { DateRangePicker } from "@/components/ui/date-picker"
import { SearchInput } from "@/components/masters/SearchInput"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { MfgOption } from "../po-procurement/po-types"
import SyncUniwareButton from "../SyncUniwareButton"
import SyncDocumentsButton from "../SyncDocumentsButton"
import InvoiceGroupTable from "./InvoiceGroupTable"
import ThreeWaySummary from "./ThreeWaySummary"

export default function InvoicesClient({
  mfgOptions,
  destinations,
}: {
  mfgOptions: MfgOption[]
  /** Distinct warehouse names — invoice_mfg.destination stores the site name. */
  destinations: string[]
}) {
  // Local, not URL-synced: InvoiceGroupTable fetches client-side, so there's no
  // server render to drive with a search param the way the masters pages do.
  // Search stays live and outside the panel, as on FG PO Tracking.
  const [search, setSearch] = useState("")

  // Applied filters — what the table and the export actually use.
  const [mfgCode, setMfgCode] = useState("")
  const [destination, setDestination] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  // Uniware's verdict on the mirrored PO. Server-side, unlike `match`, so it
  // filters the whole result set rather than the page — a cancelled invoice
  // three pages back is exactly what someone opening this filter is after.
  const [uniwareStatus, setUniwareStatus] = useState("")
  // Match is derived in TS from columns the list already returns, so this
  // filters the PAGE. ThreeWaySummary above covers the whole filter.
  const [match, setMatch] = useState<"" | MatchBadge>("")

  // Draft filters — the panel edits these, Apply commits them. Same shape as FG
  // PO Tracking, and here it also stops the table refetching on every select.
  const [showFilters, setShowFilters] = useState(false)
  const [draftMfgCode, setDraftMfgCode] = useState("")
  const [draftDestination, setDraftDestination] = useState("")
  const [draftDateFrom, setDraftDateFrom] = useState("")
  const [draftDateTo, setDraftDateTo] = useState("")
  const [draftUniwareStatus, setDraftUniwareStatus] = useState("")
  const [draftMatch, setDraftMatch] = useState<"" | MatchBadge>("")

  // Bumped after a Uniware sync. The table fetches its own rows, so
  // router.refresh() can't reach them and the new statuses would stay invisible
  // until the next filter change.
  const [reloadKey, setReloadKey] = useState(0)

  const activeFilters = [mfgCode, destination, dateFrom, dateTo, uniwareStatus, match]
  const activeFilterCount = activeFilters.filter(Boolean).length

  // Built as a query string, not an object: the table takes it as a prop and
  // refetches when it changes, and a string compares by value — an object would
  // be a new identity every render and refetch forever.
  const filterQuery = new URLSearchParams(
    Object.entries({ mfgCode, destination, dateFrom, dateTo, uniwareStatus }).filter(([, v]) => v)
  ).toString()

  /** Seed the drafts from what is applied, so opening the panel shows reality. */
  function openFilters() {
    setDraftMfgCode(mfgCode)
    setDraftDestination(destination)
    setDraftDateFrom(dateFrom)
    setDraftDateTo(dateTo)
    setDraftUniwareStatus(uniwareStatus)
    setDraftMatch(match)
    setShowFilters((v) => !v)
  }

  function applyFilters() {
    setMfgCode(draftMfgCode)
    setDestination(draftDestination)
    setDateFrom(draftDateFrom)
    setDateTo(draftDateTo)
    setUniwareStatus(draftUniwareStatus)
    setMatch(draftMatch)
    setShowFilters(false)
  }

  /** Clears both halves — leaving a stale draft behind would reappear on reopen. */
  function clearFilters() {
    setMfgCode("")
    setDestination("")
    setDateFrom("")
    setDateTo("")
    setUniwareStatus("")
    setMatch("")
    setDraftMfgCode("")
    setDraftDestination("")
    setDraftDateFrom("")
    setDraftDateTo("")
    setDraftUniwareStatus("")
    setDraftMatch("")
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {/* A ROW, deliberately. SearchInput's root is `relative flex-1 max-w-sm`
            — inside a column flex that `flex-1` grows it *vertically*, leaving a
            viewport-tall wrapper with the input pinned to the top and its
            magnifier centred in the empty space below. */}
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search invoice number or manufacturer…"
          />
          <ToggleButton size="lg" pressed={activeFilterCount > 0} onClick={openFilters}>
            <Filter className="h-3.5 w-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
                {activeFilterCount}
              </span>
            )}
          </ToggleButton>
          <div className="ml-auto flex items-center gap-3">
            {/* The live filter, so the sweep covers exactly the invoices being
                looked at. Resolved server-side against the same INVOICE_WHERE
                the list uses, so the two sets cannot drift. */}
            <SyncUniwareButton
              label="Sync these"
              filter={{
                ...(search.trim() ? { search: search.trim() } : {}),
                ...(mfgCode     ? { mfgCode }     : {}),
                ...(destination ? { destination } : {}),
                ...(dateFrom    ? { dateFrom }    : {}),
                ...(dateTo      ? { dateTo }      : {}),
              }}
              onDone={() => setReloadKey((k) => k + 1)}
            />
            <SyncDocumentsButton onDone={() => setReloadKey((k) => k + 1)} />
            {/* The search and filters are component state, not URL params, and
                DownloadButton only reads useSearchParams — extraParams is how
                they reach the export. */}
            <DownloadButton
              endpoint="/api/v1/purchase-orders/invoice/export"
              label="Invoices"
              extraParams={{
                ...(search.trim() ? { search: search.trim() } : {}),
                ...Object.fromEntries(new URLSearchParams(filterQuery)),
              }}
            />
          </div>
        </div>

        {/* ── Filter panel ── */}
        {showFilters && (
          <Card className="border-blue-200 dark:border-blue-900">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">Filters</span>
                <button
                  onClick={() => setShowFilters(false)}
                  aria-label="Close filters"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Manufacturer</Label>
                  <Select
                    value={draftMfgCode}
                    onChange={(e) => setDraftMfgCode(e.target.value)}
                    className="w-full"
                  >
                    <option value="">All Manufacturers</option>
                    {mfgOptions.map((m) => (
                      <option key={m.id} value={m.code}>{m.code} — {m.name}</option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Destination</Label>
                  <Select
                    value={draftDestination}
                    onChange={(e) => setDraftDestination(e.target.value)}
                    className="w-full"
                  >
                    <option value="">All Destinations</option>
                    {destinations.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  {/* The invoice date, not the date it was entered: that's the
                      number finance reconciles against. */}
                  <Label className="text-xs">Invoice Date Range</Label>
                  <DateRangePicker
                    from={draftDateFrom}
                    to={draftDateTo}
                    onChange={(f, t) => {
                      setDraftDateFrom(f)
                      setDraftDateTo(t)
                    }}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="grid gap-1.5">
                  {/* Uniware status, not a local derivation: a PO the warehouse
                      cancelled there is the one case where our own record still
                      reads healthy, so it has to come from what Uniware last
                      told us. */}
                  <Label className="text-xs">Uniware Status</Label>
                  <Select
                    value={draftUniwareStatus}
                    onChange={(e) => setDraftUniwareStatus(e.target.value)}
                    className="w-full"
                  >
                    <option value="">All Uniware Statuses</option>
                    <option value="CANCELLED">Cancelled</option>
                    <option value="CREATED">Created</option>
                    <option value="APPROVED">Approved</option>
                    <option value="COMPLETE">Complete</option>
                    <option value="none">Not synced</option>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Match State</Label>
                  <Select
                    value={draftMatch}
                    onChange={(e) => setDraftMatch(e.target.value as "" | MatchBadge)}
                    className="w-full"
                  >
                    <option value="">All Match States</option>
                    <option value="variance">Variance</option>
                    <option value="unmatched">Unmatched</option>
                    <option value="invoice_matched">Invoice matched</option>
                    <option value="fully_matched">Fully matched</option>
                  </Select>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={clearFilters}>Clear</Button>
                <Button size="sm" onClick={applyFilters}>Apply</Button>
              </div>
            </CardContent>
          </Card>
        )}

        <ThreeWaySummary filterQuery={filterQuery} search={search} reloadKey={reloadKey} />

        {/* max-height, not a fixed height: twelve invoices shouldn't render
            inside a viewport-tall box with dead space underneath. Grows with
            the list, then scrolls internally under the sticky header. */}
        <div className="flex max-h-[70vh] min-h-0 flex-col">
          <InvoiceGroupTable
            search={search}
            filterQuery={filterQuery}
            reloadKey={reloadKey}
            matchFilter={match ? [match] : undefined}
            emptyHint="No invoices yet. They appear here once one is read on PO Inwarding via Add Invoice."
          />
        </div>
      </CardContent>
    </Card>
  )
}
