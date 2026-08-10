"use client"

/**
 * Auto-pulls the per-unit PO rate for a SKU + Manufacturer combination from
 * /api/v1/purchase-orders/quote-rate (the same Final Costing formula used by
 * Manufacturing → Final Costing). Replaces the old manually-typed rate field.
 */

import { useEffect, useState } from "react"

export function useQuotedRate(skuCode: string, mfgId: string) {
  const [rate, setRate] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!skuCode || !mfgId) { setRate(null); setError(""); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    fetch(`/api/v1/purchase-orders/quote-rate?sku_code=${encodeURIComponent(skuCode)}&mfg_id=${mfgId}`)
      .then(async (res) => {
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) { setRate(null); setError(data.error ?? "Could not compute rate."); return }
        setRate(data.rate); setError("")
      })
      .catch(() => { if (!cancelled) { setRate(null); setError("Could not compute rate.") } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [skuCode, mfgId])

  return { rate, loading, error }
}
