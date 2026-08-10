"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { SearchInput } from "@/components/masters/SearchInput"
import { DownloadButton } from "@/components/masters/DownloadButton"
import InvoiceGroupTable from "./InvoiceGroupTable"

export default function InvoicesClient() {
  // Local, not URL-synced: InvoiceGroupTable fetches client-side, so there's no
  // server render to drive with a search param the way the masters pages do.
  const [search, setSearch] = useState("")

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
          <div className="ml-auto">
            {/* The search is component state, not a URL param, and
                DownloadButton only reads useSearchParams — extraParams is how
                it reaches the export. */}
            <DownloadButton
              endpoint="/api/v1/purchase-orders/invoice/export"
              label="Invoices"
              extraParams={search.trim() ? { search: search.trim() } : undefined}
            />
          </div>
        </div>

        {/* max-height, not a fixed height: twelve invoices shouldn't render
            inside a viewport-tall box with dead space underneath. Grows with
            the list, then scrolls internally under the sticky header. */}
        <div className="flex max-h-[70vh] min-h-0 flex-col">
          <InvoiceGroupTable
            search={search}
            emptyHint="No invoices yet. They appear here once one is read on PO Inwarding via Add Invoice."
          />
        </div>
      </CardContent>
    </Card>
  )
}
