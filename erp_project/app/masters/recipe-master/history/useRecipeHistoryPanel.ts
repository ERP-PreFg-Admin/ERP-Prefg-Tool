"use client"

/**
 * Read-only counterpart to ../useBomDetailPanel.ts — owns just the URL-synced
 * ?bomId= selection and the detail fetch (with cache + hover-prefetch). No
 * edit-mode state at all, since /masters/bom-master/history never allows
 * editing.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { isRmTotalValid } from "@/lib/validation/bom"
import type { BomDetailResponse } from "@/types/masters"

export function useBomHistoryPanel() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const [selectedBomId, setSelectedBomId] = useState<number | null>(() => {
    const raw = searchParams.get("bomId")
    return raw && /^\d+$/.test(raw) ? Number(raw) : null
  })
  const [detail, setDetail]                 = useState<BomDetailResponse | null>(null)
  const [detailLoading, setDetailLoading]   = useState(false)
  const [detailError, setDetailError]       = useState<string | null>(null)
  const [activeMtrlType, setActiveMtrlType] = useState<"rm" | "pm">("rm")

  const detailCache = useRef<Map<number, BomDetailResponse>>(new Map())
  const inFlight     = useRef<Map<number, Promise<BomDetailResponse>>>(new Map())
  const hoverTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }
  }, [])

  const fetchDetail = useCallback((bomId: number) => {
    const cached = detailCache.current.get(bomId)
    if (cached) return Promise.resolve(cached)

    const pending = inFlight.current.get(bomId)
    if (pending) return pending

    const req = fetch(`/api/masters/bom-master/history/${bomId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || "Failed to load BOM history")
        }
        return res.json() as Promise<BomDetailResponse>
      })
      .then((data) => {
        detailCache.current.set(bomId, data)
        return data
      })
      .finally(() => { inFlight.current.delete(bomId) })

    inFlight.current.set(bomId, req)
    return req
  }, [])

  /** Debounced — sweeping the cursor across many rows only fires a request
   *  for the one it actually settles on. */
  function prefetchDetail(bomId: number | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (bomId == null) return
    hoverTimer.current = setTimeout(() => {
      fetchDetail(bomId).catch(() => {})
    }, 200)
  }

  useEffect(() => {
    if (selectedBomId == null) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    setActiveMtrlType("rm")

    const cached = detailCache.current.get(selectedBomId)
    if (cached) {
      setDetail(cached)
      setDetailError(null)
      setDetailLoading(false)
      return
    }

    setDetailLoading(true)
    setDetailError(null)
    fetchDetail(selectedBomId)
      .then((data) => { if (!cancelled) setDetail(data) })
      .catch((err) => { if (!cancelled) setDetailError(err.message) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedBomId, fetchDetail])

  const rmLines       = detail?.lines.filter((l) => l.mtrl_type === "rm") ?? []
  const pmLines        = detail?.lines.filter((l) => l.mtrl_type === "pm") ?? []
  const rmDetailTotal  = rmLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  const rmIsBalanced   = rmLines.length > 0 && isRmTotalValid(rmDetailTotal)
  const visibleLines   = activeMtrlType === "rm" ? rmLines : pmLines

  function handleRowClick(bomId: number) {
    const nextId = selectedBomId === bomId ? null : bomId
    setSelectedBomId(nextId)

    const params = new URLSearchParams(searchParams.toString())
    if (nextId == null) params.delete("bomId")
    else                params.set("bomId", String(nextId))
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function closeDetail() {
    setSelectedBomId(null)
    const params = new URLSearchParams(searchParams.toString())
    params.delete("bomId")
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return {
    selectedBomId,
    detail,
    detailLoading,
    detailError,
    activeMtrlType,
    setActiveMtrlType,
    rmLines,
    pmLines,
    rmDetailTotal,
    rmIsBalanced,
    visibleLines,
    prefetchDetail,
    handleRowClick,
    closeDetail,
  }
}
