"use client"

import type { Approval } from "../approvals-types"
import { isNewRecord } from "../approvals-types"
import { DiffTable } from "./DiffTable"
import { formatFieldLabel, DiffFieldValue } from "./FieldDiff"
import type { DiffRow } from "./types"

export function FieldDiffTable({ items }: { items: Approval["items"] }) {
  const newOnly = isNewRecord(items)
  const rows: DiffRow[] = items.map((item) => ({
    key: item.field_name,
    label: formatFieldLabel(item.field_name),
    // plain: DiffTable's own red/emerald table-cell background already
    // carries the color, so the value itself stays unstyled here.
    old: <DiffFieldValue fieldName={item.field_name} value={item.old_value} variant="old" plain />,
    new: <DiffFieldValue fieldName={item.field_name} value={item.new_value} variant="new" plain />,
  }))

  return <DiffTable rows={rows} newOnly={newOnly} />
}
