"use client"

import { Card, CardContent } from "@/components/ui/card"

/**
 * Placeholder tab — no backend yet. Will eventually let users map a vendor's
 * own ingredient code to the internal RM/PM code, separate from mfg_ing_code
 * (the manufacturer's own internal code for a material).
 */
export default function VendorIngMappingClient({ mfgId }: { mfgId: number }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">Vendor Ing Mapping — coming soon</p>
        <p>
          Will let you map a vendor&apos;s own ingredient code to the internal RM/PM code
          for manufacturer #{mfgId}&apos;s relevant vendors.
        </p>
      </CardContent>
    </Card>
  )
}
