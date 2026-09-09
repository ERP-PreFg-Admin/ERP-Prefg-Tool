import type { ReactNode } from "react"

/** RM/PM id → { code, name }, used to resolve a Recipe line's bare mtrl_id.
 *  Split by type since rm/pm ids are independent sequences and can collide. */
export type MaterialMap = {
  rm: Record<number, { code: string | null; name: string }>
  pm: Record<number, { code: string | null; name: string }>
  /** Component SKUs, for a gift kit's contents lines (mtrl_type='sku' — see
   *  lib/masters/kit-sku.ts). Optional because callers that only ever show RM/PM
   *  diffs need not build it; a missing entry renders as "#42", which is why the
   *  Recipe approval card does build it. */
  sku?: Record<number, { code: string | null; name: string }>
}

export type DiffRow = {
  key: string
  label: string
  old: ReactNode
  new: ReactNode
  /** Full-width row (e.g. "line removed") instead of the old/new columns. */
  fullWidth?: ReactNode
}
