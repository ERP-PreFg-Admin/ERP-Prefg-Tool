"use client"

/**
 * CLIENT component for /admin/activity.
 *
 * Filters push to the URL (same convention as PaginationBar) so the server page
 * re-runs the query — nothing is filtered in the browser.
 */

import { useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import type { ActivityRow } from "./page"

const METHODS = ["POST", "PATCH", "PUT", "DELETE"]

const INPUT_CLASS =
  "h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function formatWhen(value: Date | string) {
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" })
}

/** "/api/masters/vendors" → "masters/vendors" — the /api/ prefix is noise here. */
function readablePath(detail: string) {
  return detail.replace(/^\/api\//, "")
}

function statusVariant(status: number) {
  if (status >= 500) return "destructive" as const
  if (status >= 400) return "warning" as const
  return "success" as const
}

export default function ActivityClient({
  rows,
  actors,
  total,
  page,
  pageSize,
  filters,
}: {
  rows: ActivityRow[]
  actors: { id: number; name: string; email: string }[]
  total: number
  page: number
  pageSize: number
  filters: { user: string; method: string; from: string; to: string; q: string }
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  /** Any filter change resets to page 1 — the old offset won't mean anything. */
  function setFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    params.delete("page")
    router.push(`/admin/activity?${params.toString()}`)
  }

  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <>
      <MasterToolbar className="flex-wrap items-center">
        <select
          value={filters.user}
          onChange={(e) => setFilter("user", e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">All users</option>
          {actors.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        <select
          value={filters.method}
          onChange={(e) => setFilter("method", e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">All actions</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <Input
          type="date"
          value={filters.from}
          onChange={(e) => setFilter("from", e.target.value)}
          className="sm:w-40"
          aria-label="From date"
        />
        <Input
          type="date"
          value={filters.to}
          onChange={(e) => setFilter("to", e.target.value)}
          className="sm:w-40"
          aria-label="To date"
        />
        <Input
          defaultValue={filters.q}
          onKeyDown={(e) => {
            if (e.key === "Enter") setFilter("q", (e.target as HTMLInputElement).value)
          }}
          placeholder="Path contains… (press Enter)"
          className="sm:max-w-xs"
        />
        {hasFilters && (
          <Button variant="outline" onClick={() => router.push("/admin/activity")}>
            Clear
          </Button>
        )}
      </MasterToolbar>

      <Card>
        <RecordCountHeader total={total} />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-52">When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="w-24">Result</TableHead>
                <TableHead className="w-20">Time</TableHead>
                <TableHead className="w-32">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                    {hasFilters
                      ? "No activity matches these filters."
                      : "No activity recorded yet."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, i) => (
                  <TableRow key={`${row.at}-${row.user_id}-${i}`}>
                    <TableCell className="text-xs whitespace-nowrap">{formatWhen(row.at)}</TableCell>
                    <TableCell className="text-sm">
                      {row.user_name ?? <span className="text-muted-foreground">Unknown</span>}
                    </TableCell>
                    <TableCell>
                      {row.source === "session" ? (
                        <Badge variant="info" className="capitalize">{row.detail}</Badge>
                      ) : (
                        <span className="font-mono text-xs">
                          <span className="font-semibold">{row.method}</span>{" "}
                          {readablePath(row.detail)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.status == null ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {row.duration_ms == null ? "—" : `${row.duration_ms} ms`}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.ip_address ?? "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <PaginationBar total={total} page={page} pageSize={pageSize} />
        </CardContent>
      </Card>
    </>
  )
}
