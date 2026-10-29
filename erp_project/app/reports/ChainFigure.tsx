import { cn } from "@/lib/utils"
import type { Figure } from "@/lib/services/reports/chain-figures"

const TONE = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
} as const

const DOT = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-destructive" } as const

/** A station's live figure: awaited inside its own Suspense, so the page never waits for the slowest one. */
export default async function ChainFigure({ load }: { load: () => Promise<Figure> }) {
  let f: Figure
  try {
    f = await load()
  } catch {
    return <p className="text-xs text-muted-foreground">Figure unavailable</p>
  }
  // "12 overdue POs" → a large 12 with its words beside it.
  const m = f.text.match(/^([\d,.]+)\s+(.*)$/)
  return (
    <div className="leading-tight">
      <p className="flex items-baseline gap-1.5">
        <span aria-hidden className={cn("h-2 w-2 shrink-0 self-center rounded-full", DOT[f.tone])} />
        {m ? (
          <>
            <span className={cn("font-mono text-2xl font-semibold tabular-nums", TONE[f.tone])}>{m[1]}</span>
            <span className="text-xs text-muted-foreground">{m[2]}</span>
          </>
        ) : (
          <span className={cn("text-sm font-medium", TONE[f.tone])}>{f.text}</span>
        )}
      </p>
      {f.sub && <p className="mt-0.5 pl-3.5 text-[11px] text-muted-foreground">{f.sub}</p>}
    </div>
  )
}

export function FigureSkeleton() {
  return (
    <div className="space-y-1.5" aria-label="Loading figure">
      <div className="h-7 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
    </div>
  )
}
