"use client"

/**
 * Cost-change impact alert for RM/PM rate-edit dialogs.
 *
 * Fetches the SKUs whose active Recipe references this material as soon as it
 * mounts, and renders a small "this will impact N SKUs" banner with a hover
 * tooltip listing them. Renders nothing while loading or if the impact is
 * zero — this is informational context, not a warning that always needs to
 * take up space.
 *
 * scope="vendor" shows every SKU in the portfolio that uses the material.
 * scope="mfg" narrows to only the SKUs that one manufacturer produces.
 */

import { useEffect, useState } from "react"
import { AlertCircle, HelpCircle } from "lucide-react"

type ImpactedSku = { sku_code: string; name: string }

export function CostImpactAlert({
  endpoint,
  materialIdField,
  materialId,
  scope,
  mfgId,
}: {
  endpoint: "/api/v1/masters/raw-materials" | "/api/v1/masters/packing-materials"
  materialIdField: "rm_id" | "pm_id"
  materialId: number
  scope: "vendor" | "mfg"
  mfgId?: number | null
}) {
  const [skus, setSkus] = useState<ImpactedSku[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results before the new material/mfg's fetch resolves
    setSkus(null)
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "material-impact", [materialIdField]: materialId, scope, mfg_id: mfgId }),
    })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setSkus(data.skus ?? []) })
      .catch(() => { if (!cancelled) setSkus([]) })
    return () => { cancelled = true }
  }, [endpoint, materialIdField, materialId, scope, mfgId])

  if (!skus || skus.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-300">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      <span>This change will impact {skus.length} SKU{skus.length !== 1 ? "s" : ""}.</span>
      <span className="group relative inline-flex items-center">
        <HelpCircle className="h-3.5 w-3.5 cursor-help text-blue-500" />
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-64 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-[11px] leading-relaxed text-foreground shadow-md group-hover:block">
          {skus.map((s) => `${s.sku_code} — ${s.name}`).join(", ")}
        </span>
      </span>
    </div>
  )
}
