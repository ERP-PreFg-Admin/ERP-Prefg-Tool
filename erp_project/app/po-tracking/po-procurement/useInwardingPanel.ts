"use client"

/**
 * Owns the FG PO Tracking inwarding panel: URL-synced ?inwardFor= selection and
 * the detail fetch, with an in-memory cache so re-opening a PO seen this session
 * is instant.
 *
 * The fetch half of app/masters/recipe-master/useBomDetailPanel.ts. No edit mode —
 * this panel is read-only, so there is no save path, no staged files, and no
 * seeding.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useToast } from "@/components/ui/toast"
import type { InwardingResponse } from "./po-types"

function msgOf(e: unknown) {
  return e instanceof Error ? e.message : "Failed to load inwarding"
}

/**
 * The PO is gone, as opposed to the request having failed.
 *
 * Worth its own type because the two want opposite handling: a failure keeps the
 * panel open with a Retry, while a PO that doesn't exist has nothing to retry —
 * retrying a dead ?inwardFor= just 404s again. The usual source is a stale link:
 * the panel deliberately loads whatever id is in the URL, so a bookmark, a
 * refresh after the row was removed, or a URL pasted from another environment
 * all land here.
 */
class PoGoneError extends Error {}

export function useInwardingPanel() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  // Read once — the initializer runs on mount only. Later selection changes come
  // from openFor()/close(), which write the URL rather than read it back, so
  // there's no round trip to re-parse.
  const [initialPoId] = useState<number | null>(() => {
    const raw = searchParams.get("inwardFor")
    return raw && /^\d+$/.test(raw) ? Number(raw) : null
  })

  const [selectedPoId, setSelectedPoId] = useState<number | null>(initialPoId)
  const [detail, setDetail] = useState<InwardingResponse | null>(null)
  // Seeded true when the URL already names a PO, so the mount fetch below needs
  // no synchronous setState inside its effect.
  const [loading, setLoading] = useState(initialPoId != null)
  const [error, setError] = useState<string | null>(null)

  const cache = useRef<Map<number, InwardingResponse>>(new Map())
  const inFlight = useRef<Map<number, Promise<InwardingResponse>>>(new Map())

  const fetchDetail = useCallback(async (poId: number): Promise<InwardingResponse> => {
    const cached = cache.current.get(poId)
    if (cached) return cached

    // Dedupe concurrent requests for the same PO — a click landing on a row
    // already being prefetched must not fire a second call.
    const pending = inFlight.current.get(poId)
    if (pending) return pending

    const p = (async () => {
      const res = await fetch(`/api/v1/purchase-orders/${poId}/inwarding`)
      const data = await res.json().catch(() => ({}))
      // 404 means no purchase_orders row with this id — the route's own
      // not_found, not a routing miss. Out-of-scope is a 403 and stays an error.
      if (res.status === 404) throw new PoGoneError(data.error ?? "That purchase order no longer exists.")
      if (!res.ok) throw new Error(data.error ?? "Failed to load inwarding")
      cache.current.set(poId, data)
      return data as InwardingResponse
    })()

    inFlight.current.set(poId, p)
    try {
      return await p
    } finally {
      inFlight.current.delete(poId)
    }
  }, [])

  /** Writes ?inwardFor= without touching the page's other filter params. */
  const syncUrl = useCallback(
    (poId: number | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (poId == null) params.delete("inwardFor")
      else params.set("inwardFor", String(poId))
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const close = useCallback(() => {
    setSelectedPoId(null)
    setDetail(null)
    setError(null)
    setLoading(false)
    syncUrl(null)
  }, [syncUrl])

  /**
   * A PO that isn't there: drop the dead ?inwardFor= and say so once.
   *
   * Closing rather than showing the panel's error state is the point — the
   * param is what re-triggers the failed fetch, so leaving it in the URL means
   * every refresh and every copy of that link fails the same way.
   */
  const dropMissing = useCallback(
    (e: PoGoneError) => {
      close()
      toast({ title: "Purchase order not found", description: msgOf(e), variant: "info" })
    },
    [close, toast]
  )

  // Mount only, and only for a ?inwardFor= that was already in the URL — a
  // deep link or a refresh with the panel open. Every later selection change is
  // an event (openFor/close/retry) and loads there, so this effect performs no
  // synchronous state update.
  useEffect(() => {
    if (initialPoId == null) return
    let active = true
    fetchDetail(initialPoId)
      .then((d) => { if (active) setDetail(d) })
      .catch((e) => {
        if (!active) return
        if (e instanceof PoGoneError) dropMissing(e)
        else setError(msgOf(e))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only
  }, [])

  /** Fetch into state. Called from event handlers, never from an effect body. */
  const load = useCallback(
    (poId: number) => {
      setLoading(true)
      setError(null)
      fetchDetail(poId)
        .then(setDetail)
        // Same treatment on a click: the row is on screen but its order is gone
        // (deleted under us, or this page was rendered against another database).
        .catch((e) => { if (e instanceof PoGoneError) dropMissing(e); else setError(msgOf(e)) })
        .finally(() => setLoading(false))
    },
    [fetchDetail, dropMissing]
  )

  /** Clicking the PO whose panel is open closes it, so the same target toggles. */
  const openFor = useCallback(
    (poId: number) => {
      if (selectedPoId === poId) {
        close()
        return
      }
      setSelectedPoId(poId)
      syncUrl(poId)

      // Clear the outgoing PO's data before the new fetch, so a slow response
      // can't leave the previous order's lines under the new order's header.
      const cached = cache.current.get(poId)
      if (cached) {
        setDetail(cached)
        setError(null)
        setLoading(false)
      } else {
        setDetail(null)
        load(poId)
      }
    },
    [selectedPoId, syncUrl, close, load]
  )

  /** Drops the cached copy and refetches — the inline retry after a failure. */
  const retry = useCallback(() => {
    if (selectedPoId == null) return
    cache.current.delete(selectedPoId)
    load(selectedPoId)
  }, [selectedPoId, load])

  return { selectedPoId, detail, loading, error, openFor, close, retry }
}
