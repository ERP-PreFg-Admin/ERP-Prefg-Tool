import { cn } from "@/lib/utils"
import type { BarTone } from "@/lib/reports/trace/contracts"

const TONE: Record<BarTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-400",
  bad: "bg-red-500",
  info: "bg-blue-400",
  muted: "bg-muted-foreground/40",
}

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 })

// One segmented bar for a row's quantities; the title spells out every part.
export default function QtyBar({ total, parts, className }: {
  total: number
  parts: { label: string; value: number; tone: BarTone }[]
  className?: string
}) {
  const shown = parts.map((p) => ({ ...p, value: Math.max(p.value, 0) }))
  const scale = Math.max(total, shown.reduce((s, p) => s + p.value, 0))
  const title = [`of ${fmt(total)}`, ...shown.filter((p) => p.value > 0).map((p) => `${fmt(p.value)} ${p.label}`)].join(" · ")
  return (
    <div className={cn("flex h-2 w-28 overflow-hidden rounded-full bg-muted", className)} title={title} aria-label={title}>
      {scale > 0 && shown.map((p) => p.value > 0 && (
        <div key={p.label} className={TONE[p.tone]} style={{ width: `${(p.value / scale) * 100}%` }} />
      ))}
    </div>
  )
}
