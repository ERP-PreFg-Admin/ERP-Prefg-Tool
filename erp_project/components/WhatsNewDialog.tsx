"use client"

import { useEffect, useState } from "react"
import { Sparkles, Wrench } from "lucide-react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import current from "@/lib/release-notes/current.json"

type WhatsNewItem = { kind: "new" | "fixed"; area: string; text: string }
const notes = current as { version: string | null; date: string | null; items: WhatsNewItem[] }

// Per browser, not per user: a second PC or browser shows a release's popup once more.
const SEEN_KEY = "whats-new-seen"

const GROUPS = [
  { kind: "new", label: "New", icon: Sparkles, tone: "text-primary" },
  { kind: "fixed", label: "Fixed", icon: Wrench, tone: "text-emerald-600 dark:text-emerald-400" },
] as const

const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null

// Opens once per release with notes; closing it any way counts as seen.
export default function WhatsNewDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!notes.version || notes.items.length === 0) return
    let seen: string | null = null
    try { seen = localStorage.getItem(SEEN_KEY) } catch { return }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    if (seen !== notes.version) setOpen(true)
  }, [])

  if (!notes.version || notes.items.length === 0) return null

  function dismiss() {
    setOpen(false)
    try { localStorage.setItem(SEEN_KEY, notes.version!) } catch { /* private window: shows again next visit */ }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss() }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-tight">What&apos;s new</DialogTitle>
          <p className="pt-1 text-xs text-muted-foreground">
            <span className="font-mono">{notes.version}</span>
            {fmtDate(notes.date) && <span> · {fmtDate(notes.date)}</span>}
          </p>
        </DialogHeader>

        <div className="space-y-5">
          {GROUPS.map((g) => {
            const items = notes.items.filter((i) => i.kind === g.kind)
            if (items.length === 0) return null
            const Icon = g.icon
            return (
              <section key={g.kind}>
                <h3 className={`mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${g.tone}`}>
                  <Icon className="h-3.5 w-3.5" /> {g.label}
                </h3>
                <ul className="space-y-2.5">
                  {items.map((i, n) => (
                    <li key={n} className="border-l-2 border-border pl-3 text-sm leading-snug">
                      {i.area && <div className="text-[11px] font-medium text-muted-foreground">{i.area}</div>}
                      {i.text}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>

        <DialogFooter>
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
