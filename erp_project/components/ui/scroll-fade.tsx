"use client"

import * as React from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Scroll container with the native scrollbar hidden.
 *
 * The scrollbar is the only built-in "there is more content this way" cue, so
 * hiding it hides information. This draws the cue back: an edge fade plus a
 * chevron, shown only while there is still content past that edge.
 *
 * `className` lands on the outer (positioning) element, so it takes whatever
 * layout role the plain scroll container had.
 */
export function ScrollFade({
  axis,
  className,
  children,
}: {
  axis: "x" | "y"
  className?: string
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [more, setMore] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () =>
      setMore(
        axis === "x"
          ? el.scrollWidth - el.clientWidth - el.scrollLeft > 1
          : el.scrollHeight - el.clientHeight - el.scrollTop > 1
      )
    check()
    el.addEventListener("scroll", check, { passive: true })
    // Both the viewport and the content resize independently (window resize,
    // sidebar collapse, rows loading in) — watch each.
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener("scroll", check)
      ro.disconnect()
    }
  }, [axis])

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        className="h-full w-full overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {more &&
        (axis === "x" ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-linear-to-l from-background to-transparent"
          >
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
        ) : (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-linear-to-t from-background to-transparent"
          >
            <ChevronDown className="mb-1 size-4 text-muted-foreground" />
          </div>
        ))}
    </div>
  )
}
