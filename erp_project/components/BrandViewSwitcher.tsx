"use client"

/**
 * The platform-view picker. Multi-select, persisted, in the top bar.
 *
 * ── Draft, then Apply ──────────────────────────────────────────────────────
 * Ticks mutate LOCAL state only; nothing hits the server until Apply. The first
 * version committed on every toggle, so choosing three brands meant three server
 * actions and three full re-renders of whatever page you were on — the switcher
 * felt slower the more you changed. This mirrors FilterPanel's existing
 * draft-then-Apply contract (components/masters/FilterPanel.tsx), which every
 * master table already uses, so the interaction is the one users know.
 *
 * Closing without applying discards the draft — an abandoned menu must not
 * silently change what you are looking at.
 *
 * Renders nothing below two selectable brands: with one grant there is nothing to
 * switch between, and a picker with a single fixed option is noise.
 *
 * This is a VIEW control, not a permission control. The server intersects the
 * cookie with the grant on every request (lib/brand-view.ts), so this component
 * cannot widen access however it is driven.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown, Layers } from "lucide-react"
import { setBrandView } from "@/app/actions/brand-view"
import { Button } from "@/components/ui/button"
import type { SelectableBrand } from "@/lib/brand-view"
import { cn } from "@/lib/utils"

/** Order-insensitive set comparison — [1,2] and [2,1] are the same view. */
function sameSet(a: number[], b: number[]) {
  return a.length === b.length && a.every((x) => b.includes(x))
}

export function BrandViewSwitcher({
  brands,
  active,
}: {
  brands: SelectableBrand[]
  /** The resolved view — already intersected with the grant server-side. */
  active: number[] | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  // null = unrestricted, shown as every brand ticked: "no filter" and "all
  // brands" are the same thing to a user, and zero ticks would read as
  // "nothing selected, so why am I seeing everything".
  const committed = active ?? brands.map((b) => b.id)
  const [draft, setDraft] = useState<number[]>(committed)

  if (brands.length < 2) {
    return brands.length === 1 ? (
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        {brands[0].name}
      </span>
    ) : null
  }

  const label =
    committed.length === brands.length
      ? "All brands"
      : committed.length === 1
        ? (brands.find((b) => b.id === committed[0])?.name ?? "1 brand")
        : `${committed.length} brands`

  const dirty = !sameSet(draft, committed)

  /**
   * Seed the draft when the menu opens, not in an effect.
   *
   * `committed` is a fresh array every render, so an effect syncing it would
   * either loop or need a dependency lie. The draft is only meaningful while the
   * menu is open, so opening is the correct — and only — moment to seed it. It
   * also means a view changed elsewhere is picked up on next open for free.
   */
  function openMenu() {
    setDraft(committed)
    setOpen(true)
  }

  function close() {
    setOpen(false)
  }

  function apply() {
    if (!dirty) return close()
    startTransition(async () => {
      // Selecting everything IS "no filter" — send [] so the action clears the
      // cookie rather than storing a list that would freeze the view if a brand
      // were added later.
      await setBrandView(draft.length === brands.length ? [] : draft)
      // One refresh, for the current route only. The action deliberately does no
      // revalidatePath; see the note there.
      router.refresh()
      setOpen(false)
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : openMenu())}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-1 text-xs font-medium",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          pending && "opacity-60"
        )}
      >
        <Layers className="h-3.5 w-3.5" />
        {pending ? "Applying…" : label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <>
          {/* Click-away. Before the panel in the DOM so the options sit above it. */}
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div className="absolute right-0 z-50 mt-1 w-56 rounded-lg border border-border bg-background shadow-lg">
            <div className="flex items-center justify-between px-2 pt-2 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Brands
              </span>
              <button
                type="button"
                onClick={() => setDraft(draft.length === brands.length ? [] : brands.map((b) => b.id))}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {draft.length === brands.length ? "Clear" : "Select all"}
              </button>
            </div>

            <ul role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto p-1">
              {brands.map((b) => {
                const on = draft.includes(b.id)
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() =>
                        setDraft(on ? draft.filter((x) => x !== b.id) : [...draft, b.id])
                      }
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    >
                      <Check className={cn("h-3.5 w-3.5", on ? "opacity-100" : "opacity-0")} />
                      <span className="flex-1">{b.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{b.po_code}</span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <div className="flex items-center justify-between gap-2 border-t border-border p-2">
              {/* Zero ticks would leave nothing visible, and an empty selection is
                  how "no filter" is expressed to the action — two different things
                  from one state. Blocked here rather than silently reinterpreted. */}
              <span className="text-[11px] text-muted-foreground">
                {draft.length === 0 ? "Pick at least one" : `${draft.length} of ${brands.length}`}
              </span>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={close} disabled={pending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={apply} disabled={pending || !dirty || draft.length === 0}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
