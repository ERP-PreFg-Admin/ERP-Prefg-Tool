# `/observability` — an in-app Grafana, built on what already exists

## Context

There was no way to answer "is the app slow / erroring / healthy" from inside the
app. The pieces to answer it were already in place and unused:

| Already there | What it holds |
|---|---|
| `activity_log` | `method, path, status, duration_ms, user_id, ip, request_id` for **every non-GET request** — written from one place, `logActivity` in `lib/gateway/with-gateway.ts:23` |
| CloudWatch log group `/erp/app` | Winston's JSON lines, both app and error streams (`deploy/cloudwatch-agent-config.json`) |
| CloudWatch namespace `ERP/EC2` | cpu / mem / disk per instance, 60s interval |
| IAM | The app's keys already hold `cloudwatch:GetMetricData`, `ListMetrics`, `DescribeAlarms`, `logs:GetLogEvents`, `DescribeLogStreams` — `deploy/iam-policy-erp-app-deploy.json:70` |
| `request_id` on both sides | `activity_log.request_id` and Winston's `requestId` are the same UUID |

That last row is why this is built in-app rather than in the CloudWatch console:
**a row in a table can link to its own log lines**, and Grafana cannot join a
request to `users.name`.

Decided up front: request metrics from SQL over `activity_log`; host metrics and
alarms from CloudWatch; GETs recorded only when slow or failing; top-level
`/observability`, developer-only; four tabs — Requests · Infra · Logs · Business.

---

## Status

| # | Phase | State |
|---|---|---|
| 0 | Governance | **Done and verified** |
| 1 | Requests tab | **Code complete, one fix outstanding** (below) |
| 2 | GET coverage + retention | Not started — **gate revised, see below** |
| 3 | Infra tab | **Done, probed against live CloudWatch** |
| 4 | Logs tab | **Code done — blocked on one IAM change** |
| 5 | Business tab | **Done** |

### Phases 3–5 — built, and what the live probe changed

New files: `lib/aws/cloudwatch.ts` (transport), `lib/services/{infra,logs,business}.ts`,
`lib/queries/observability-business.ts`,
`app/observability/{infra,logs,business}/page.tsx`. Deps added:
`@aws-sdk/client-cloudwatch`, `@aws-sdk/client-cloudwatch-logs`. `tsc` and
`lint:changed` clean.

Three things only a real call could reveal:

1. **`SEARCH` matches `MetricName` as a substring, not exactly.**
   `MetricName="used_percent"` returned `mem_used_percent` *and*
   `disk_used_percent`, so the Disk panel was silently showing memory twice. The
   agent publishes `disk_used_percent`, not the `used_percent` its own config
   names. Every panel now uses the full metric name.
2. **The `AWS/EC2 NetworkIn` panel was dropped.** A SEARCH over that namespace
   returned **all 18 instances in the account** — other teams' infrastructure on
   a page with no business showing it. Doing network properly means adding it to
   `deploy/cloudwatch-agent-config.json` so it publishes under `ERP/EC2` with our
   dimensions; that is an instance reconfiguration, not a code change.
   Series returned per load: 28 → 8.
3. **The stale-ALB alarms named in this plan no longer exist.** The account has
   two alarms (`Email_Alert`, an unrelated EC2 status check), so the footnote
   asserting stale load-balancer alarms was removed rather than shipped as a
   false claim. `DescribeAlarms` is account-wide; the page says so.

**Logs tab is blocked on IAM and fails exactly as designed.** The live probe
returned `AccessDeniedException … not authorized to perform: logs:FilterLogEvents`.
`deploy/iam-policy-erp-app-deploy.json` is updated but **not applied**: the old
single `CloudWatchReadOnly` statement is split into `CloudWatchMetricsReadOnly`
(`Resource: "*"` — `cloudwatch:*` has no resource-level permissions, so that is
the only expressible form) and `ErpLogGroupsReadOnly`, scoped to
`log-group:/erp/*`. Until it is applied the tab renders an inline warning naming
the missing action. Logs Insights is deliberately not granted.

The Requests → Logs cross-link is wired: `request_id` in the problems table now
links to `/observability/logs?requestId=…&w=7d`.

**Business tab counts are tenant-wide.** `UNRESTRICTED` is passed to
`buildStatusCountParams` deliberately and commented as such — a PO total that
changed per viewer is useless as a health number, and the page is developer-only
for exactly this reason. PO status counts reuse `purchaseOrdersSql.statusCounts`
and `summaryStats` so `DISPLAY_STATUS_EXPR` stays in one place; only the
approvals and invoice aggregates are new SQL, and neither carries derived
business logic.

### Phase 0 — done

`lib/pages.ts` slug, `prisma/add_observability_page.sql`, `components/Sidebar.tsx`
nav entry (`hideWhenLocked`), `app/observability/layout.tsx` guard,
`ObservabilityTabs.tsx`.

Grant applied to the dev schema `mcaff_prefg_dev` — `affectedRows: 1`, one
`developer` row, zero `user_page_permissions` overrides. **Not yet applied to prod.**

The access boundary is structural, not conventional: `parentSlug("/observability")`
hits `lastSlash <= 0` and returns `null` (`lib/permissions.ts:21-25`), so
`resolveAccess`'s walk runs exactly once and falls through to `"none"`. With one
`developer` row and no user override, an admin cannot resolve anything else.
Still unconfirmed in a browser: that the sidebar omits it for an admin.

### Phase 1 — code complete, one fix outstanding

| File | Owner |
|---|---|
| `lib/queries/observability.ts` — 4 queries | Ajay |
| `lib/services/observability.ts` — `getRequestMetrics()`: access check, coercion, gap fill | Claude |
| `app/observability/page.tsx` — posture line, 3 sparklines, problems table | Claude |
| `app/observability/RequestsClient.tsx` — sortable route table | Claude |
| `components/observability/Sparkline.tsx` — ~70 lines inline SVG, no chart dep | Claude |

`npx tsc --noEmit --incremental false` and `npm run lint:changed` both clean.

**Correction to this plan's own design.** It said the tab would query directly
from the server component, "following `app/admin/activity/page.tsx`". That
pattern is **banned for new code** by the `erp/ui-data-boundary` rule in
`eslint.config.mjs`: anything under `app/**` (except `app/api/**`) may not import
`@/lib/db`, `@/lib/db-sku`, `@/lib/query-timing` or `@/lib/queries/*`. The 25
existing offenders — `admin/activity` among them — are grandfathered by the
`lint:changed` ratchet, so copying one is exactly how the rule gets circumvented.

So the read moved to **`lib/services/observability.ts`**, the first file in that
directory, following `docs/module-boundaries-and-tally-plan.md` §4.3: one
function per read owning both the query and its authorization. It calls
`resolveAccess` itself and throws `ApiError(403)` — the layout's guard is the
redirect, not the boundary. Signature matches the doc's convention
(`getRequestMetrics(userId, roles, hours)`).

The "no API route" decision still stands and for the original reason: a GET panel
route would be a slow GET and, after Phase 2, log itself into the table it reads.
The boundary rule doesn't require a route, only that UI not touch SQL.

**Phases 3–5 must follow this too** — each tab gets a `lib/services/*` function,
not a direct query. The `try/catch`-per-panel rule for CloudWatch (Phase 3) now
belongs inside that service.

**All four queries verified against `mcaff_prefg_dev`** (652 rows, 30-day window),
~100 ms each:

| Query | Result |
|---|---|
| `routeStats` | 29 route rows, percentiles sane (`p50` 80 ms / `p95` 8373 ms overall) |
| `hourlySeries` | 89 buckets for a 720-hour window — **confirms `fillHours` is required**, not defensive |
| `windowSummary` | 1 row |
| `recentProblems` | ordered 502 first, `request_id` and `user_name` both populated |

**The DECIMAL-as-string hazard is confirmed empirically, not theoretical.**
`err_4xx`, `err_5xx`, `errors` and `avg_ms` all come back as JS *strings*
(`"0"`, `"6"`, `"58"`) because `SUM()`/`AVG()` return DECIMAL; `calls`, `p50_ms`,
`p95_ms`, `max_ms`, `status`, `duration_ms` come back as numbers. The `n()`
coercion in `page.tsx` is load-bearing — a fifth aggregate query without it
breaks silently, since `"0" > 0` is false and `"6" + "1"` is `"61"`.

**It already found something.** `/api/v2/purchase-orders/invoice/parse` shows
p95 88.5 s and max 116 s; `/api/v1/purchase-orders/send-mail` p95 46 s. The parse
route carries `maxDuration = 300` by design, so this is expected rather than
broken — but it is exactly the kind of thing nothing in the app could previously
show.

---

### Design pass — density inside the existing surfaces

Scoped to typography, column choice, emphasis and states **within the tables and
panels already there**: no new sections, summary strips or visualisations, per the
standing rule for this codebase (a dense tool people use all day, where
consistency across modules beats any one page being clever).

One new shared module, `components/observability/format.ts`, so a latency figure
reads and *colours* the same on all four tabs. Colour is spent only on
thresholds worth acting on: latency 300ms / 1s / 5s, error rate 0 / 1% / 5%,
host utilisation 75% / 90%.

| Surface | Added |
|---|---|
| Route table | `methods` (verb-coloured; DELETE reads differently from GET) and `last_at` as "Ago" — a percentile can't say whether a problem is still happening. `4xx` column dropped in favour of one error-rate column with the 4xx/5xx split on hover. Latency renders as `8.4s` but sorts on raw ms |
| Requests header | Route totals moved into the section heading — `DataTable` is shared with masters and has no footer row |
| Sparklines | Area fill, last-point dot, and a range caption (`low … · peak …`) — current value alone hides a spike that already passed |
| Problems table | Relative age column, formatted duration with the latency ladder, and the request-id cell became a labelled "View trace" link |
| Infra | Per-series low/peak, instance id extracted from CloudWatch's verbose Label, alarm state tally in the heading, `ago` for time-in-state |
| Logs | `route` and `ms` lifted out of the JSON onto the summary line, level tally beside the filter hint, request-id as a click-to-isolate link |

`routeStats` gained `GROUP_CONCAT(DISTINCT method ORDER BY method)` and
`MAX(created_on)`; verified live, 29 rows.

---

## Phase 2 — GET coverage + retention (gate revised)

**The revision:** the plan treated unbounded growth in `activity_log` as the
blocking risk. Measured, dev holds **652 rows since 2026-08-11 — about 24 a day**.
Even a 10× increase from recording reads is a few hundred rows a day, which is
nothing. Retention is still worth having, but it is **no longer a gate on Phase 3**.

The gate becomes: **measure the same two numbers on prod before choosing
`SLOW_GET_MS`.** Dev traffic is not a sample of prod traffic, and the dev figure
is low enough to be misleading in the other direction.

**`lib/gateway/with-gateway.ts:29`** — `logActivity` already receives `status`
and `ms`, so nothing needs plumbing:

```ts
if (req.method === "GET" && status < 400 && ms < SLOW_GET_MS) return
```

with `const SLOW_GET_MS = 500`. Update the "GETs are deliberately skipped"
comment on line 20 and the header in `prisma/add_activity_log.sql:10` — both
state a rule this changes.

**Retention** — `prisma/add_activity_log_retention.sql`. Pre-flight
`SHOW VARIABLES LIKE 'event_scheduler'`; if `ON`, no cron and no app code:

```sql
CREATE EVENT IF NOT EXISTS purge_activity_log
  ON SCHEDULE EVERY 1 DAY
  DO DELETE FROM activity_log
     WHERE created_on < NOW() - INTERVAL 90 DAY
     LIMIT 50000;
```

If it is `OFF`, that is an RDS parameter-group change plus the `EVENT` privilege —
your call, and at 24 rows/day it can wait.

---

## Phase 3 — Infra tab

Add `@aws-sdk/client-cloudwatch`. New `lib/aws/cloudwatch.ts` mirroring
`lib/s3.ts:12-24`'s lazy client (a missing AWS var must break only this feature).

- `GetMetricDataCommand` over `ERP/EC2` — `cpu_usage_active`, `mem_used_percent`,
  `used_percent` — plus `AWS/EC2` `NetworkIn`/`NetworkOut` and `AWS/RDS`
  `CPUUtilization` / `DatabaseConnections` / `FreeableMemory`.
- `DescribeAlarmsCommand` for alarm state. Two alarms (`erp-alb-5xx`,
  `erp-unhealthy-hosts`) reference the deleted ALB and will read
  `INSUFFICIENT_DATA` forever — surfacing them is a good reason to delete them.
- **Instance discovery, not configuration** — `ListMetricsCommand` returns the
  `InstanceId` dimensions that exist, so test and prod both appear with no env var.

**No IAM change**; all four actions are already granted.
`export const revalidate = 60` on the page segment.

**Non-negotiable:** every CloudWatch call in a `try/catch` that renders "metrics
unavailable" inline. An observability page that dies when AWS is unhealthy is
backwards. Verify by blanking `ACCESS_KEY_ID_AWS` locally and reloading.

---

## Phase 4 — Logs tab

Add `@aws-sdk/client-cloudwatch-logs`.

**Use `FilterLogEvents`, not Logs Insights.** Insights is a two-call async
protocol (`StartQuery` → poll `GetQueryResults`) needing a polling route and a
spinner. `FilterLogEvents` is one synchronous call and its JSON filter patterns
work directly on Winston's output:

| Want | Pattern |
|---|---|
| One request's whole trace | `{ $.requestId = "…" }` |
| Only errors | `{ $.level = "error" }` |
| Free text | `?"Access denied"` |

Insights earns its complexity only for aggregation over logs — which the Requests
tab already does in SQL, faster and joined to `users`. Leave it unbuilt.

**The cross-link is the feature.** The problems table already renders
`request_id`; Phase 4 turns that cell into a link to
`/observability/logs?requestId=…` (there's a comment marking the spot).

**IAM — the one change.** Add `logs:FilterLogEvents` to
`deploy/iam-policy-erp-app-deploy.json`, and split the `logs:*` actions into
their own statement resourced to
`arn:aws:logs:ap-south-1:157320387454:log-group:/erp/*:*` rather than inheriting
`"Resource": "*"`. These keys already hold `ssm:SendCommand` and every
`/erp-app/*` secret by that file's own admission, so the marginal grant should be
the narrowest that works. Re-run `deploy/test-permissions.ps1` afterwards.

---

## Phase 5 — Business tab

Deliberately thin, and it **reuses existing SQL** — this content arguably belongs
in `/reports`, and duplicating PO status logic would be a second source of truth:

- POs by displayed status via `DISPLAY_STATUS_EXPR` (`lib/queries/purchase-orders.ts`)
  — *not* `raw_status`, per the "displayed status ≠ stored status" rule.
- Approvals pending, and the age of the oldest (`lib/queries/approvals.ts`).
- Invoices inwarded per week (`lib/queries/supplier-invoices.ts`).

---

## Remaining risks

| Risk | Mitigation |
|---|---|
| Observability page fails when AWS is unhealthy | try/catch per panel, verified by blanking the key (Phase 3) |
| Percentile query scans the window | 103 ms at 652 rows. Ceiling ~1M rows; pre-aggregate hourly only if measured slow |
| IAM widening for logs | Scope to `/erp/*`, never `*` (Phase 4) |
| CloudWatch cost / latency | `revalidate = 60` |
| RDS `event_scheduler` may be OFF | Pre-flight check; low urgency at measured volume |
| Prod grant not yet applied | `node --env-file=.env scripts/run-sql.mjs prisma/add_observability_page.sql` with `APP_ENV=prod` |

---

## Verification

**Immediate (Phase 1 close-out)**
1. Apply the two `String(...)` fixes; `npx tsc --noEmit --incremental false` clean.
2. `npm run lint:changed`.
3. `npm run dev` → `/observability`, switch 24h / 7d / 30d. Confirm the sparklines
   show gaps rather than straight slopes across quiet hours, and that the route
   table sorts on every column.
4. Confirm zeroes render plain, not amber — `optional: true` on the metric columns
   is what suppresses `DataTable`'s "not filled in" wash.

**Phase 0 close-out**
5. As an `admin`, confirm the sidebar omits the item **from the DOM** (devtools),
   and that typing `/observability` redirects to `/auth/unauthorized`.
6. Apply the grant SQL to prod.

**Later phases** — as described in each section above; the throwaway
`scripts/run-sql.mjs` (gitignored) takes any `prisma/*.sql` and prints the schema
it resolved before touching anything.

**Shell gotcha, for any further ad-hoc DB checks:** only the *first line* of a
multi-line `-e` string reaches `tsx` on this setup, and `-e` compiles as CJS so
top-level `await` is rejected. One line, wrapped in `(async()=>{…})()`.

---

## Dependencies

`@aws-sdk/client-cloudwatch` (Phase 3), `@aws-sdk/client-cloudwatch-logs`
(Phase 4). **No chart library** — inline SVG covers every trend this tab shows.
