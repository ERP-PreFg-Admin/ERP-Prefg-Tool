// /observability > Logs — search the /erp-app/{test,prod} CloudWatch groups.
//
// The filter form is a plain GET form, so this page ships no client JS: the
// browser turns it into the same ?requestId=&level=&q= URL the Requests tab
// links to.

import Link from "next/link"
import { redirect } from "next/navigation"
import { Callout } from "@/components/ui/callout"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { count, latencyClass, ms } from "@/components/observability/format"
import { auth } from "@/lib/auth"
import { searchLogs, type LogLevel } from "@/lib/services/logs"
import { IST } from "@/lib/date"
import { cn } from "@/lib/utils"

const WINDOWS = [
  { key: "1h", label: "1h", hours: 1 },
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
] as const
type WindowKey = (typeof WINDOWS)[number]["key"]

const LEVELS: LogLevel[] = ["all", "error", "warn", "info"]

const LEVEL_CLASS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-amber-700 dark:text-amber-400",
  info: "text-muted-foreground",
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "")

export default async function ObservabilityLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  const sp = await searchParams
  const active: WindowKey = WINDOWS.some((w) => w.key === sp.w) ? (sp.w as WindowKey) : "24h"
  const hours = WINDOWS.find((w) => w.key === active)!.hours
  const requestId = str(sp.requestId).trim()
  const level = (LEVELS.includes(str(sp.level) as LogLevel) ? str(sp.level) : "all") as LogLevel
  const q = str(sp.q).trim()

  const result = await searchLogs(Number(session.user.id), session.user.roles ?? [], {
    hours,
    requestId,
    level,
    q,
    group: str(sp.group),
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          CloudWatch group <code className="font-mono">{result.group}</code> — Winston&apos;s JSON lines,
          shipped by the agent.
        </p>
        <SegmentedToggle
          options={WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
          active={active}
          getHref={(key) =>
            `/observability/logs?w=${key}&group=${encodeURIComponent(result.group)}${
              requestId ? `&requestId=${requestId}` : ""
            }${level !== "all" ? `&level=${level}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`
          }
          size="xs"
        />
      </div>

      {/* A GET form, not a client component — the URL IS the state, which also
          makes a search shareable and back-button-able. */}
      <form className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="w" value={active} />
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Request ID</span>
          <Input name="requestId" defaultValue={requestId} placeholder="uuid from the Requests tab" className="w-72 font-mono text-xs" />
        </label>
        {/* One group per environment. Shown only when more than one exists, so
            a single-environment account doesn't get a one-option select. */}
        {result.groups.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Environment</span>
            <select
              name="group"
              defaultValue={result.group}
              className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
            >
              {result.groups.map((g) => (
                <option key={g} value={g}>
                  {g.replace("/erp-app/", "")}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Level</span>
          <select
            name="level"
            defaultValue={level}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Contains</span>
          <Input name="q" defaultValue={q} placeholder="free text" className="w-56 text-xs" />
        </label>
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>

      {/* Stated rather than left to be discovered: the three filters are not
          combined, because CloudWatch takes one filter pattern per call. */}
      <p className="text-xs text-muted-foreground">
        One filter applies at a time, in this order: Request ID, then Level, then Contains.
        {result.ok && result.events.length > 0 && (
          <>
            {" · "}
            {count(result.events.length)} line{result.events.length === 1 ? "" : "s"}
            {(["error", "warn"] as const)
              .map((l) => ({ l, n: result.events.filter((e) => e.level === l).length }))
              .filter(({ n }) => n > 0)
              .map(({ l, n }) => `, ${count(n)} ${l}`)
              .join("")}
          </>
        )}
      </p>

      {!result.ok ? (
        <Callout variant="warning">
          <strong className="font-medium">Log search unavailable.</strong> {result.error}
          <span className="mt-1 block">
            If this says AccessDenied, the app&apos;s IAM user is missing{" "}
            <code className="font-mono">logs:FilterLogEvents</code> — see
            deploy/iam-policy-erp-app-deploy.json.
          </span>
        </Callout>
      ) : result.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching log lines in this window.</p>
      ) : (
        <div className="space-y-1">
          {result.truncated && (
            <Callout variant="info">
              More lines match than are shown — narrow the window or the filter to see the rest.
            </Callout>
          )}
          {result.events.map((e, i) => (
            <details key={i} className="rounded border border-border px-3 py-1.5 open:bg-muted/30">
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
                <span className="shrink-0 text-muted-foreground">
                  {e.at ? e.at.toLocaleString("en-IN", { timeZone: IST }) : "—"}
                </span>
                <span
                  className={cn(
                    "w-10 shrink-0 uppercase",
                    LEVEL_CLASS[e.level ?? ""] ?? "text-foreground/60"
                  )}
                >
                  {e.level ?? "raw"}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{e.message}</span>
                {/* Pulled up from the JSON rather than left to the expander: on a
                    request line these three are what the message actually means. */}
                {typeof e.extra.route === "string" && (
                  <span className="shrink-0 truncate text-[11px] text-muted-foreground">{e.extra.route}</span>
                )}
                {e.extra.ms !== undefined && (
                  <span className={cn("shrink-0 text-[11px] tabular-nums", latencyClass(Number(e.extra.ms)))}>
                    {ms(Number(e.extra.ms))}
                  </span>
                )}
                {e.requestId && (
                  <Link
                    href={`/observability/logs?requestId=${e.requestId}&w=${active}`}
                    title={`Show only ${e.requestId}`}
                    className="shrink-0 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    {e.requestId.slice(0, 8)}
                  </Link>
                )}
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                {e.raw ?? JSON.stringify({ requestId: e.requestId, ...e.extra }, null, 2)}
              </pre>
              {e.stream && <p className="mt-1 text-[11px] text-muted-foreground/70">stream: {e.stream}</p>}
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
