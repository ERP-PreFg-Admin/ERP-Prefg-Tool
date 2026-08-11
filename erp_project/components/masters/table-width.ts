/**
 * The minimum width a masters table may shrink to before it scrolls instead.
 *
 * Shared by DataTable and MaterialRateTable. It lived only in DataTable, so
 * MaterialRateTable — the RM/PM Cost Master table — had no floor at all and its
 * columns squeezed without limit until the headers clipped.
 */

/** Trailing action column, shared so the tables line up with each other. */
export const ACTION_WIDTH = 112

/** Narrowest a free-text column may get before its header stops being readable.
 *  Columns that declare no `width` share whatever space is left, so this is the
 *  floor that decides when the table starts scrolling instead of squeezing. */
export const MIN_FLEX_COL = 140

/**
 * `table-layout: fixed` on a `w-full` table makes the table fit its container at
 * ANY width — zoom in far enough and the flexible columns squeeze toward zero
 * while the fixed ones hold their px, so headers collide and the horizontal
 * scroll never engages. A min-width floors that: past this point the table stops
 * shrinking and ScrollFade's edge fade + chevron take over.
 */
export function minTableWidth(
  columns: { width?: string }[],
  hasActions: boolean
): number {
  const declared = (w?: string) => {
    const px = w?.endsWith("px") ? parseInt(w, 10) : NaN
    return Number.isFinite(px) ? px : MIN_FLEX_COL
  }
  return (
    columns.reduce((sum, c) => sum + declared(c.width), 0) +
    (hasActions ? ACTION_WIDTH : 0)
  )
}
