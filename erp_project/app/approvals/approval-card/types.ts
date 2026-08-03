import type { ReactNode } from "react"

/** RM/PM id → { code, name }, used to resolve a BOM line's bare mtrl_id.
 *  Split by type since rm/pm ids are independent sequences and can collide. */
export type MaterialMap = {
  rm: Record<number, { code: string | null; name: string }>
  pm: Record<number, { code: string | null; name: string }>
}

export type DiffRow = {
  key: string
  label: string
  old: ReactNode
  new: ReactNode
  /** Full-width row (e.g. "line removed") instead of the old/new columns. */
  fullWidth?: ReactNode
}
