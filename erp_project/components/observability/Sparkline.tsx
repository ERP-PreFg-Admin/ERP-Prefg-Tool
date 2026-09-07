// Inline SVG trend line — no chart library for a 36px sparkline.
//
// Three marks, each earning its place: the line for shape, a faint fill so a
// flat-but-busy series still reads as volume, and a dot on the last point
// because "where is it now" is the question the big number answers.

import { cn } from "@/lib/utils"

const W = 260
const H = 36

export default function Sparkline({
  values,
  label,
  current,
  hint,
  tone = "quiet",
}: {
  values: number[]
  label: string
  current: string
  /** Range or context caption under the chart — "12ms – 4.2s", "2 instances". */
  hint?: string
  tone?: "quiet" | "bad"
}) {
  // Scaled to the series' own peak, not a fixed ceiling: these are unrelated
  // units and only the shape is comparable across panels.
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? W / (values.length - 1) : 0
  const pt = (v: number, i: number) => [i * step, H - (v / max) * (H - 3)] as const
  const points = values.map((v, i) => pt(v, i).map((x) => x.toFixed(1)).join(",")).join(" ")
  const last = values.length > 0 ? pt(values[values.length - 1], values.length - 1) : null

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground" title={label}>
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-sm tabular-nums",
            tone === "bad" ? "text-destructive" : "text-foreground"
          )}
        >
          {current}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${current}${hint ? `, ${hint}` : ""}`}
        className={cn("mt-1 h-9 w-full", tone === "bad" ? "text-destructive" : "text-foreground/50")}
      >
        {values.length > 1 && (
          <>
            <polygon points={`0,${H} ${points} ${W},${H}`} fill="currentColor" opacity="0.08" />
            <polyline
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {last && <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" vectorEffect="non-scaling-stroke" />}
        <line
          x1="0"
          y1={H - 0.5}
          x2={W}
          y2={H - 0.5}
          stroke="currentColor"
          strokeWidth="1"
          className="text-border"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {hint && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  )
}
