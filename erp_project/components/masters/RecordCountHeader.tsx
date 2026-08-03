import { CardHeader, CardTitle } from "@/components/ui/card"

/** "{n} records[, matching "x" | with a Clear filters link]" — the header every
 *  master list table's Card opens with, above the search/filter result set. */
export function RecordCountHeader({
  total,
  matching,
  onClearFilters,
}: {
  total: number
  /** Echoes the active search term (Manufacturers-style: no filter panel, just search). */
  matching?: string
  /** Renders a "Clear filters" link when the caller has an active filter panel. */
  onClearFilters?: () => void
}) {
  return (
    <CardHeader className="pb-2">
      <CardTitle className="text-sm font-medium text-muted-foreground">
        {total} record{total !== 1 ? "s" : ""}
        {matching && (
          <span className="ml-2 text-xs text-muted-foreground">
            matching &ldquo;{matching}&rdquo;
          </span>
        )}
        {onClearFilters && (
          <button onClick={onClearFilters} className="ml-2 text-xs text-primary hover:underline">
            Clear filters
          </button>
        )}
      </CardTitle>
    </CardHeader>
  )
}
