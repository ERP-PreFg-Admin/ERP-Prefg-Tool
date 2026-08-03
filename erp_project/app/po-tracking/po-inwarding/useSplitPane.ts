"use client"

import { useCallback, useEffect, useRef, useState } from "react"

const MIN_PCT = 20
const MAX_PCT = 80

/**
 * Horizontal drag-to-resize split, as a percentage width for the left pane.
 *
 * Pointer listeners live on `window` rather than the handle so the drag survives
 * the pointer outrunning a few-pixel-wide divider. `dragging` is exposed because
 * the caller has to disable pointer events on any iframe in either pane — an
 * iframe swallows the pointer and the drag stalls halfway across otherwise.
 */
export function useSplitPane(defaultPct = 50) {
  const [pct, setPct] = useState(defaultPct)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current || !containerRef.current) return
      const r = containerRef.current.getBoundingClientRect()
      const next = ((e.clientX - r.left) / r.width) * 100
      setPct(Math.min(MAX_PCT, Math.max(MIN_PCT, next)))
    }
    function onUp() {
      if (!draggingRef.current) return
      draggingRef.current = false
      setDragging(false)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [])

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
  }, [])

  const reset = useCallback(() => setPct(defaultPct), [defaultPct])

  return { containerRef, pct, dragging, startDrag, reset }
}
