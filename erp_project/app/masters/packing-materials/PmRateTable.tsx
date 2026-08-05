"use client"

/**
 * PM-specific config wrapper around the shared MaterialRateTable — see that
 * file for the actual filter/sort/table implementation. Both child
 * components (VendorPackingMaterialsClient / ManufacturerPackingMaterialsClient)
 * render THIS and pass their own rows + column config.
 */

import { MaterialRateTable, fmtDate, statusBadge, type AnyRow, type ColumnDef } from "@/components/masters/MaterialRateTable"
import { AddPackingMaterialWizard } from "./AddPackingMaterialWizard"
import { PM_VRM_BULK_FIELDS } from "./pm-vrm-bulk-fields"
import { PM_MRM_BULK_FIELDS } from "./pm-mrm-bulk-fields"
import type { Vendor, Mfg } from "@/types/masters"

export { fmtDate, statusBadge }
export type { AnyRow, ColumnDef }

export function PmRateTable(props: Omit<
  Parameters<typeof MaterialRateTable>[0],
  "entityLabel" | "searchPlaceholder" | "downloadEndpoint" | "vrmBulk" | "mrmBulk" | "AddWizard" | "emptyMessage" | "makeFieldLabel" | "combineTypeIntoMake"
> & { vendors: Vendor[]; manufacturers: Mfg[] }) {
  return (
    <MaterialRateTable
      {...props}
      entityLabel="Packing Materials"
      searchPlaceholder="Search by code, name, type…"
      downloadEndpoint="/api/masters/packing-materials/export"
      vrmBulk={{
        endpoint: "/api/masters/packing-materials/vrm-bulk",
        templateFilename: "pm_vendor_rate_template.csv",
        fields: PM_VRM_BULK_FIELDS,
      }}
      mrmBulk={{
        endpoint: "/api/masters/packing-materials/mrm-bulk",
        templateFilename: "pm_manufacturer_rate_template.csv",
        fields: PM_MRM_BULK_FIELDS,
      }}
      AddWizard={AddPackingMaterialWizard}
      makeFieldLabel="Make / Type"
      combineTypeIntoMake
      emptyMessage="No packing materials match your filters."
    />
  )
}
