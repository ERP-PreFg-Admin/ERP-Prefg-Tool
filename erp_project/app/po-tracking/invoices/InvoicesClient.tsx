"use client"

import { useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { SearchInput } from "@/components/masters/SearchInput"
import { DownloadButton } from "@/components/masters/DownloadButton"
import type { MfgOption } from "../po-procurement/po-types"
import InvoiceGroupTable from "./InvoiceGroupTable"

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
  const [search, setSearch] = useState("")
  const [mfgCode, setMfgCode] = useState("")
  const [destination, setDestination] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  // Built as a query string, not an object: the table takes it as a prop and
  // refetches when it changes, and a string compares by value — an object would
  // be a new identity every render and refetch forever.
  const filterQuery = new URLSearchParams(
    Object.entries({ mfgCode, destination, dateFrom, dateTo }).filter(([, v]) => v)
  ).toString()

  function clearFilters() {
    setMfgCode("")
    setDestination("")
    setDateFrom("")
    setDateTo("")
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
          <Select
            value={mfgCode}
            onChange={(e) => setMfgCode(e.target.value)}
            aria-label="Filter by manufacturer"
          >
            <option value="">All Manufacturers</option>
            {mfgOptions.map((m) => (
              <option key={m.id} value={m.code}>{m.code} — {m.name}</option>
            ))}
          </Select>
          <Select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            aria-label="Filter by destination"
          >
            <option value="">All Destinations</option>
            {destinations.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
          {/* Native date inputs — the invoice date, not the date it was entered:
              that's the number finance reconciles against. */}
          <Input
            type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 w-36 text-sm" title="Invoice date from" aria-label="Invoice date from"
          />
          <Input
            type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="h-9 w-36 text-sm" title="Invoice date to" aria-label="Invoice date to"
          />
          {filterQuery && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
          <div className="ml-auto">
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

        {/* max-height, not a fixed height: twelve invoices shouldn't render
            inside a viewport-tall box with dead space underneath. Grows with
            the list, then scrolls internally under the sticky header. */}
        <div className="flex max-h-[70vh] min-h-0 flex-col">
          <InvoiceGroupTable
            search={search}
            filterQuery={filterQuery}
            emptyHint="No invoices yet. They appear here once one is read on PO Inwarding via Add Invoice."
          />
        </div>
      </CardContent>
    </Card>
  )
}
