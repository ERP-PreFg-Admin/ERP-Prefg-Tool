import { cn } from "@/lib/utils"

/** The one place the app's old/new diff colors are defined — every diff
 *  renderer (DiffTable, BomLineDiffTable, DocViewButton, ApprovalRow,
 *  HistoryEntry) should import these instead of hand-rolling red-6xx/red-7xx
 *  variants that drift apart over time. Kept out of FieldDiff.tsx (which
 *  imports DocViewButton) so DocViewButton can import these without a cycle. */
export const DIFF_OLD_TEXT_CLASS = "text-red-700 dark:text-red-400"
export const DIFF_NEW_TEXT_CLASS = "text-emerald-700 dark:text-emerald-400"
export const DIFF_OLD_CELL_CLASS = cn("bg-red-50 dark:bg-red-950/30", DIFF_OLD_TEXT_CLASS)
export const DIFF_NEW_CELL_CLASS = cn("bg-emerald-50 dark:bg-emerald-950/30", DIFF_NEW_TEXT_CLASS)
