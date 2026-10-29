"use client"

import { useEffect, useRef, type ReactNode } from "react"

// Keeps every report table's header row in view while the page scrolls. CSS sticky can't do this here:
// each table sits in a sideways-scrolling wrapper, which captures sticky. So the thead is slid down instead.
export default function StickyHeads({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = document.querySelector("main")?.getBoundingClientRect().top ?? 0
      root.querySelectorAll("thead").forEach((head) => {
        const table = head.closest("table")
        // Tables nested in an expanded row scroll with their parent row.
        if (!table || table.parentElement?.closest("table")) return
        const rect = table.getBoundingClientRect()
        const max = rect.height - head.offsetHeight
        const shift = Math.min(Math.max(top - rect.top, 0), Math.max(max, 0))
        head.style.transform = shift > 0 ? `translateY(${shift}px)` : ""
        head.style.position = "relative"
        head.style.zIndex = "20"
        head.style.boxShadow = shift > 0 ? "0 1px 0 var(--color-border), 0 4px 8px -6px rgb(0 0 0 / 0.25)" : ""
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }

    // scroll doesn't bubble; capture catches the main area's scroller and every table wrapper.
    document.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    const mo = new MutationObserver(schedule)
    mo.observe(root, { childList: true, subtree: true })
    schedule()
    return () => {
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      mo.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return <div ref={ref}>{children}</div>
}
