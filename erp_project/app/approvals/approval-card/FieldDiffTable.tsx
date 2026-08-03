"use client"

import type { Approval } from "../approvals-types"
import { isNewRecord } from "../approvals-types"
import { DiffTable } from "./DiffTable"
import { DocViewButton, DOC_FIELDS } from "./DocViewButton"
import type { DiffRow } from "./types"

export function FieldDiffTable({ items }: { items: Approval["items"] }) {
  const newOnly = isNewRecord(items)
  const rows: DiffRow[] = items.map((item) => {
    const isDoc = DOC_FIELDS.has(item.field_name)
    const label = item.field_name.replace(/_key$/, "").replace(/_/g, " ")

    return {
      key: item.field_name,
      label,
      old: isDoc && item.old_value ? <DocViewButton s3Key={item.old_value} variant="old" /> : (item.old_value || "—"),
      new: isDoc && item.new_value ? <DocViewButton s3Key={item.new_value} variant="new" /> : (item.new_value || "—"),
    }
  })

  return <DiffTable rows={rows} newOnly={newOnly} />
}
