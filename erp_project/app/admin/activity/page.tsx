/**
 * SERVER component for /admin/activity.
 *
 * URL-driven like every masters list page: ?user, ?method, ?q, ?from, ?to,
 * ?page, ?size are read here and pushed into the SQL, so only the visible slice
 * is fetched. No API route — the read happens server-side.
 *
 * Rows come from lib/queries/activity.ts' UNION of activity_log (API mutations,
 * written by withGateway) and session_history (logins/logouts).
 *
 * Access is guarded in app/admin/layout.tsx.
 */

import { timedQuery } from "@/lib/query-timing"
import { parsePaginationParams } from "@/lib/pagination"
import { activitySql } from "@/lib/queries/activity"
import ActivityClient from "./ActivityClient"

export type ActivityRow = {
  at: Date | string
  user_id: number | null
  user_name: string | null
  source: "request" | "session"
  method: string | null
  detail: string
  status: number | null
  duration_ms: number | null
  ip_address: string | null
}

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)

  const userId = Number(sp.user) > 0 ? Number(sp.user) : null
  const method = sp.method ? String(sp.method) : null
  const from = sp.from ? `${String(sp.from)} 00:00:00` : null
  const to = sp.to ? `${String(sp.to)} 23:59:59` : null
  const q = sp.q ? String(sp.q).trim() : ""
  const like = q ? `%${q}%` : null

  // Each `? IS NULL OR col = ?` pair needs the value twice — see activitySql.
  const filterParams = [userId, userId, from, from, to, to, method, method, like, like]

  const [rows, countRows, actors] = await Promise.all([
    timedQuery<ActivityRow>(activitySql.selectPaginated, [...filterParams, size, offset], { label: "activity.selectPaginated" }),
    timedQuery<{ total: number }>(activitySql.countFiltered, filterParams, { label: "activity.countFiltered" }),
    timedQuery<{ id: number; name: string; email: string }>(activitySql.selectActors, [], { label: "activity.selectActors" }),
  ])

  return (
    <ActivityClient
      rows={rows}
      actors={actors}
      total={Number(countRows[0]?.total ?? 0)}
      page={page}
      pageSize={size}
      filters={{
        user: userId ? String(userId) : "",
        method: method ?? "",
        from: sp.from ? String(sp.from) : "",
        to: sp.to ? String(sp.to) : "",
        q,
      }}
    />
  )
}
