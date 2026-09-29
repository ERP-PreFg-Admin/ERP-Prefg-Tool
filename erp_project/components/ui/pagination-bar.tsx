"use client"

/**
 * PaginationBar — reusable footer for every master table.
 *
 * Layout:
 *   Left  — rows-per-page selector (10 / 20 / 50 / 100 / All)
 *   Right — "X–Y of Z records" count  +  Prev / Next buttons
 *
 * Navigation strategy: all URL changes are merged into the existing
 * URLSearchParams so that ?view=, ?search=, ?type=, ?status= etc. survive
 * across page turns. Changing page size resets to page 1 automatically.
 *
 * Drop this inside any <CardContent> right below the closing </Table> tag.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { MAX_PAGE_SIZE } from "@/lib/constants"

export function PaginationBar({
  total,
  page,
  pageSize,
}: {
  total:    number
  page:     number
  pageSize: number
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  /**
   * Merge key/value overrides into the current URL params and navigate.
   * Empty-string values delete the param (clean URL — no ?key= noise).
   */
  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // 1-based display range, e.g. "21–40 of 87"
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, total)

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">

      {/* ── Rows-per-page selector ── */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs">Rows per page</span>
        <select
          value={pageSize}
          onChange={(e) => navigate({ size: e.target.value, page: "1" })}
          className="h-7 rounded border border-input bg-background px-2 text-xs"
        >
          {[10, 20, 50, 100].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
          {/* "All" is MAX_PAGE_SIZE, the same ceiling parsePaginationParams and
              the invoice list already use — every query behind this bar takes it
              as a LIMIT, so it has to be a real number rather than "no limit". */}
          <option value={MAX_PAGE_SIZE}>All</option>
        </select>
        {/* Only when it bites. A set past the ceiling would otherwise look like
            the whole list, which is the one thing "All" must not do. */}
        {pageSize >= MAX_PAGE_SIZE && total > MAX_PAGE_SIZE && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            showing the first {MAX_PAGE_SIZE} — narrow the filters to see the rest
          </span>
        )}
      </div>

      {/* ── Count label + Prev / Next ── */}
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="text-xs tabular-nums">
          {total === 0 ? "No records" : `${from}–${to} of ${total}`}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => navigate({ page: String(page - 1) })}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= totalPages}
            onClick={() => navigate({ page: String(page + 1) })}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

    </div>
  )
}
