// Logs > By user — per-person activity from this environment's activity_log + session_history.
// Server component; every control is a link, so the URL is the state.

import Link from "next/link"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import { Callout } from "@/components/ui/callout"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { ago, count, latencyClass, ms, pct, rateClass } from "@/components/observability/format"
import {
  getUserActivityDetail,
  getUserActivityList,
  TIMELINE_LIMIT,
  type UserActivityRow,
} from "@/lib/services/user-activity"
import { MODULE_LABEL, type ModuleKey } from "@/lib/observability/modules"
import { IST } from "@/lib/date"
import { cn } from "@/lib/utils"

type Props = {
  viewerId: number
  roles: string[]
  hours: number
  windowKey: string
  group: string
  selectedUser: number | null
  errorsOnly: boolean
}

const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { timeZone: IST }) : "—")

const statusClass = (s: number | null) =>
  s === null
    ? "text-muted-foreground"
    : s >= 500
      ? "text-destructive"
      : s >= 400
        ? "text-amber-700 dark:text-amber-400"
        : "text-muted-foreground"

function ModulePill({ m }: { m: ModuleKey }) {
  return (
    <span className="inline-block whitespace-nowrap rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
      {MODULE_LABEL[m]}
    </span>
  )
}

function Scope({ env, schema }: { env: string; schema: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Reads the <strong className="font-medium text-foreground">{env}</strong> database (
      <code className="font-mono">{schema}</code>), whatever environment is picked above. Only changes,
      sign-ins and failing or slow GETs are recorded — fast successful page loads are not. A failure
      shows its status here; open its request for the error message.
    </p>
  )
}

function Errors({ u }: { u: Pick<UserActivityRow, "err_4xx" | "err_5xx"> }) {
  if (u.err_4xx + u.err_5xx === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="tabular-nums">
      <span className={u.err_4xx ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{u.err_4xx}</span>
      <span className="text-muted-foreground"> / </span>
      <span className={u.err_5xx ? "text-destructive font-medium" : "text-muted-foreground"}>{u.err_5xx}</span>
    </span>
  )
}

export default async function UserView(props: Props) {
  const { viewerId, roles, hours, windowKey, group, selectedUser, errorsOnly } = props
  const base = `/observability/logs?view=user&w=${windowKey}&group=${encodeURIComponent(group)}`
  const logsFor = (rid: string) =>
    `/observability/logs?requestId=${encodeURIComponent(rid)}&w=${windowKey}&group=${encodeURIComponent(group)}`

  if (selectedUser === null) {
    const { env, schema, users } = await getUserActivityList(viewerId, roles, hours)
    return (
      <div className="space-y-3">
        <Scope env={env} schema={schema} />
        <div className="overflow-x-auto">
          <Table className="table-fixed min-w-[960px]">
            <TableHeader>
              <TableRow>
                <StaticTableHead>User</StaticTableHead>
                <StaticTableHead width="70px">Calls</StaticTableHead>
                <StaticTableHead width="110px">Errors (4xx / 5xx)</StaticTableHead>
                <StaticTableHead width="85px">Error rate</StaticTableHead>
                <StaticTableHead width="80px">Slowest</StaticTableHead>
                <StaticTableHead width="260px">Modules touched</StaticTableHead>
                <StaticTableHead width="150px">Last sign-in (IST)</StaticTableHead>
                <StaticTableHead width="80px">Last seen</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableEmpty colSpan={8}>Nobody made a recorded call or signed in during this window.</TableEmpty>
              ) : (
                users.map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="overflow-hidden text-ellipsis text-xs">
                      <Link
                        href={`${base}&user=${u.user_id}`}
                        className="font-medium underline decoration-dotted underline-offset-2 hover:text-foreground"
                      >
                        {u.user_name ?? `User #${u.user_id}`}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{u.calls ? count(u.calls) : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Errors u={u} />
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {u.calls ? <span className={rateClass(u.err_rate)}>{pct(u.err_rate)}</span> : "—"}
                    </TableCell>
                    <TableCell className={cn("font-mono text-xs tabular-nums", latencyClass(u.max_ms))}>
                      {ms(u.max_ms)}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {u.modules.length ? u.modules.map((m) => <ModulePill key={m} m={m} />) : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{when(u.last_sign_in)}</TableCell>
                    <TableCell
                      className="font-mono text-[11px] tabular-nums text-muted-foreground"
                      title={when(u.last_seen)}
                    >
                      {ago(u.last_seen)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    )
  }

  const d = await getUserActivityDetail(viewerId, roles, hours, selectedUser, errorsOnly)
  const s = d.summary
  const name = d.user?.name ?? `User #${selectedUser}`

  return (
    <div className="space-y-3">
      <Link
        href={base}
        className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        ← All users
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {name}
          {d.user?.email && <span className="ml-2 text-xs font-normal text-muted-foreground">{d.user.email}</span>}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {s ? (
              <>
                {count(s.calls)} call{s.calls === 1 ? "" : "s"} · {s.err_4xx + s.err_5xx} error
                {s.err_4xx + s.err_5xx === 1 ? "" : "s"} ({s.err_4xx} 4xx / {s.err_5xx} 5xx)
                {s.modules.length > 0 && ` · ${s.modules.map((m) => MODULE_LABEL[m]).join(", ")}`}
                {s.last_sign_in && ` · last sign-in ${when(s.last_sign_in)}`}
              </>
            ) : (
              "no recorded activity in this window"
            )}
          </span>
        </h2>
        <SegmentedToggle
          options={[
            { key: "all", label: "All activity" },
            { key: "errors", label: "Errors only" },
          ]}
          active={errorsOnly ? "errors" : "all"}
          getHref={(k) => `${base}&user=${selectedUser}${k === "errors" ? "&errors=1" : ""}`}
          size="xs"
        />
      </div>

      <Scope env={d.env} schema={d.schema} />

      {d.truncated && (
        <Callout variant="info">
          Showing the newest {TIMELINE_LIMIT} entries — narrow the window to see older ones.
        </Callout>
      )}

      <div className="overflow-x-auto">
        <Table className="table-fixed min-w-[900px]">
          <TableHeader>
            <TableRow>
              <StaticTableHead width="70px">Ago</StaticTableHead>
              <StaticTableHead width="150px">When (IST)</StaticTableHead>
              <StaticTableHead width="70px">Method</StaticTableHead>
              <StaticTableHead>Route / event</StaticTableHead>
              <StaticTableHead width="150px">Module</StaticTableHead>
              <StaticTableHead width="70px">Status</StaticTableHead>
              <StaticTableHead width="80px">Took</StaticTableHead>
              <StaticTableHead width="100px">Logs</StaticTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.timeline.length === 0 ? (
              <TableEmpty colSpan={8}>
                {errorsOnly ? "No failed calls in this window." : "No recorded activity in this window."}
              </TableEmpty>
            ) : (
              d.timeline.map((e, i) => {
                const failed = e.status !== null && e.status >= 400
                return (
                  <TableRow
                    key={i}
                    className={cn(
                      failed && (e.status! >= 500 ? "bg-red-50/60 dark:bg-red-950/20" : "bg-amber-50/60 dark:bg-amber-950/20")
                    )}
                  >
                    <TableCell className="font-mono text-[11px] tabular-nums text-muted-foreground">{ago(e.at)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{when(e.at)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.method ?? "—"}</TableCell>
                    <TableCell
                      className={cn(
                        "overflow-hidden text-ellipsis text-xs",
                        e.source === "request" ? "font-mono" : "italic text-muted-foreground"
                      )}
                      title={e.detail}
                    >
                      {e.source === "session" ? `Session: ${e.detail.replace("_", " ")}` : e.detail}
                    </TableCell>
                    <TableCell>{e.module ? <ModulePill m={e.module} /> : null}</TableCell>
                    <TableCell className={cn("font-mono text-xs tabular-nums", statusClass(e.status), failed && "font-medium")}>
                      {e.status ?? "—"}
                    </TableCell>
                    <TableCell className={cn("font-mono text-xs tabular-nums", latencyClass(e.duration_ms))}>
                      {ms(e.duration_ms)}
                    </TableCell>
                    <TableCell className="overflow-hidden text-ellipsis text-[11px]">
                      {e.request_id ? (
                        <Link
                          href={logsFor(e.request_id)}
                          title={`Open the log lines for ${e.request_id}`}
                          className="font-mono text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                        >
                          {e.request_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
