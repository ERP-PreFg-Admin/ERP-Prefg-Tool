/**
 * Standard "nothing to show" content for a table body — one line of copy,
 * automatically switching between the filtered and unfiltered message so
 * every master/list table reads the same way instead of each inventing its
 * own empty-state wording. Renders just the message (not the surrounding
 * <TableRow>/<TableCell colSpan>), since colSpan is table-shape-specific.
 */
export function EmptyState({
  hasFilters,
  filteredMessage,
  message = "No records found.",
}: {
  /** True when a search/filter is active — swaps in `filteredMessage`. */
  hasFilters?: boolean
  /** Shown when `hasFilters` is true, e.g. "No vendors match your filters." */
  filteredMessage?: string
  /** Shown when there's no active filter — defaults to the standard copy. */
  message?: string
}) {
  return (
    <span className="text-muted-foreground">
      {hasFilters && filteredMessage ? filteredMessage : message}
    </span>
  )
}
