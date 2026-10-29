import { cn } from "@/lib/utils"

export type Total = { label: string; value: string; tone?: "warn" | "bad" | "good"; title?: string }

const TONE = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
} as const

// One strip of totals over the whole filter, the same on every report (replaces per-report stat cards).
export default function TotalsLine({ items, note }: { items: Total[]; note?: string }) {
  return (
    <div className="mb-4 rounded-lg border bg-muted/30">
      <dl className="flex flex-wrap divide-x divide-border/70">
        {items.map((t) => (
          <div key={t.label} title={t.title} className={cn("min-w-28 flex-1 px-4 py-2.5", t.title && "cursor-help")}>
            <dt className="truncate text-[11px] first-letter:uppercase text-muted-foreground">{t.label}</dt>
            <dd className={cn("font-mono text-base font-semibold tabular-nums", t.tone && TONE[t.tone])}>{t.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  )
}
