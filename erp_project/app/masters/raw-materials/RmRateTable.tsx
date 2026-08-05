"use client"

/**
 * RM-specific config wrapper around the shared MaterialRateTable — see that
 * file for the actual filter/sort/table implementation. Both child
 * components (VendorRawMaterialsClient / ManufacturerRawMaterialsClient)
 * render THIS and pass their own rows + column config.
 */

import { MaterialRateTable, fmtDate, statusBadge, type AnyRow, type ColumnDef } from "@/components/masters/MaterialRateTable"
import { AddRawMaterialWizard } from "./AddRawMaterialWizard"
import { RM_VRM_BULK_FIELDS } from "./rm-vrm-bulk-fields"
import { RM_MRM_BULK_FIELDS } from "./rm-mrm-bulk-fields"
import type { Vendor, Mfg } from "@/types/masters"

export { fmtDate, statusBadge }
export type { AnyRow, ColumnDef }

export function RmRateTable(props: Omit<
  Parameters<typeof MaterialRateTable>[0],
  "entityLabel" | "searchPlaceholder" | "downloadEndpoint" | "vrmBulk" | "mrmBulk" | "AddWizard" | "emptyMessage"
> & { vendors: Vendor[]; manufacturers: Mfg[] }) {
  return (
    <MaterialRateTable
      {...props}
      entityLabel="Raw Materials"
      searchPlaceholder="Search by code, name, make…"
      downloadEndpoint="/api/masters/raw-materials/export"
      vrmBulk={{
        endpoint: "/api/masters/raw-materials/vrm-bulk",
        templateFilename: "rm_vendor_rate_template.csv",
        fields: RM_VRM_BULK_FIELDS,
      }}
      mrmBulk={{
        endpoint: "/api/masters/raw-materials/mrm-bulk",
        templateFilename: "rm_manufacturer_rate_template.csv",
        fields: RM_MRM_BULK_FIELDS,
      }}
      AddWizard={AddRawMaterialWizard}
      makeFieldLabel="Make"
      emptyMessage="No raw materials match your filters."
    />
  )
}
