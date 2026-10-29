"use client"

import { useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import { ArrowRight, ChevronRight, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { STATIONS, type ChainEntry, type Placement } from "@/lib/reports/stations"

/** Server-rendered live figures, keyed by place on the chain (streamed in their own Suspense). */
export type FigureSlots = Partial<Record<Placement, ReactNode>>

const eyebrow = "font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function Row({ e, dim }: { e: ChainEntry; dim: boolean }) {
  return (
    <li className={cn("transition-opacity", dim && "opacity-30")}>
      <Link href={e.href} className={cn("group -mx-2 flex items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-accent", ring)}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{e.name}</span>
          <span className="block text-xs leading-snug text-muted-foreground">{e.question}</span>
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </Link>
    </li>
  )
}

function Tile({ e, dim }: { e: ChainEntry; dim: boolean }) {
  return (
    <li className={cn("transition-opacity", dim && "opacity-30")}>
      <Link href={e.href}
        className={cn("group flex h-full flex-col rounded-lg border bg-card p-4 transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-sm", ring)}>
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{e.name}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </span>
        <span className="mt-1 text-xs leading-snug text-muted-foreground">{e.question}</span>
      </Link>
    </li>
  )
}

// The Reports landing: the chain goods move along, with each report under the stretch it covers.
export default function ChainCatalogue({ intro, entries, figures }: { intro: ReactNode; entries: ChainEntry[]; figures: FigureSlots }) {
  const [q, setQ] = useState("")
  const match = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (e: ChainEntry) => !needle || `${e.name} ${e.question}`.toLowerCase().includes(needle)
  }, [q])
  const at = (p: Placement) => entries.filter((e) => e.place === p)
  const any = (p: Placement) => at(p).some(match)
  const stations = STATIONS.filter((s) => at(s.id).length > 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-2xl">{intro}</div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a report…" className="pl-9" aria-label="Find a report" />
        </div>
      </div>

      {at("overview").length > 0 && (
        <section aria-labelledby="chain-overview" className={cn("transition-opacity", !any("overview") && "opacity-40")}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <h2 id="chain-overview" className={eyebrow}>Start here</h2>
            {figures.overview}
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {at("overview").map((e) => <Tile key={e.key} e={e} dim={!match(e)} />)}
          </ul>
        </section>
      )}

      {stations.length > 0 && (
        <section aria-label="Reports along the chain: ordered, invoiced, inwarded, received" className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className={eyebrow}>Along the chain</h2>
            <span className="hidden text-xs text-muted-foreground sm:inline">Goods move left to right</span>
          </div>

          <ol className="grid divide-y md:grid-cols-4 md:divide-x md:divide-y-0">
            {stations.map((s, i) => (
              <li key={s.id} className={cn("relative flex flex-col p-5 transition-opacity", !any(s.id) && "opacity-40")}>
                {/* The track: a segment per station, drawn once on load, joining the nodes across columns. */}
                <span aria-hidden className={cn("chain-draw absolute top-[31px] hidden h-0.5 bg-primary/25 md:block",
                  i === 0 ? "left-1/2 right-0" : i === stations.length - 1 ? "left-0 right-1/2" : "inset-x-0")}
                  style={{ animationDelay: `${i * 180}ms` }} />
                <div className="relative flex items-center gap-3 md:flex-col md:items-center">
                  <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background font-mono text-[11px] font-semibold text-primary">
                    {i + 1}
                  </span>
                  <h3 className="font-heading text-lg leading-none md:mt-1 md:text-center">{s.label}</h3>
                </div>
                <div className="mt-4 min-h-12 rounded-lg bg-muted/40 px-3 py-2.5">{figures[s.id] ?? <span className="text-xs text-muted-foreground">—</span>}</div>
                <ul className="mt-3 space-y-0.5">
                  {at(s.id).map((e) => <Row key={e.key} e={e} dim={!match(e)} />)}
                </ul>
              </li>
            ))}
          </ol>

          {at("span").length > 0 && (
            <div className="border-t bg-muted/30 px-5 py-4">
              <div className="mb-2 flex items-center gap-3">
                <span aria-hidden className="h-3 w-0.5 rounded bg-primary/50" />
                <h3 className={eyebrow}>Across the whole chain</h3>
                <span aria-hidden className="h-0.5 flex-1 rounded bg-primary/20" />
                <span aria-hidden className="h-3 w-0.5 rounded bg-primary/50" />
              </div>
              <ul className="grid gap-x-6 sm:grid-cols-3">
                {at("span").map((e) => <Row key={e.key} e={e} dim={!match(e)} />)}
              </ul>
            </div>
          )}
        </section>
      )}

      {at("upkeep").length > 0 && (
        <section aria-labelledby="chain-upkeep" className={cn("transition-opacity", !any("upkeep") && "opacity-40")}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <h2 id="chain-upkeep" className={eyebrow}>Upkeep</h2>
            {figures.upkeep}
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {at("upkeep").map((e) => <Tile key={e.key} e={e} dim={!match(e)} />)}
          </ul>
        </section>
      )}

      {entries.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No reports are open to you yet. Each report follows access to the page its data comes from; ask an admin for that page.
        </p>
      )}
    </div>
  )
}
