// Closed-loop load test for the read APIs. No dependencies — Node's fetch, a
// pool of workers, and a sorted array of latencies.
//
//   npm run test:load                                   # the "core" group
//   npm run test:load -- --group exports                # CSV exports (heavy)
//   npm run test:load -- --group all --dur 4
//   npm run test:load -- --list                         # what each group contains
//   npm run test:load -- --path /api/v1/purchase-orders    # one endpoint
//   npm run test:load -- --conc 25 --dur 15             # harder
//
// GET only, by design. `withGateway` writes an `activity_log` row on every
// non-GET, so load-testing a mutating route means thousands of junk rows and real
// data changes. If you need to load test a write path, point it at a throwaway
// schema and mean it.
//
// ── Read the numbers with these in mind ─────────────────────────────────────
//
//  1. **Never load test `npm run dev`.** Dev mode compiles routes on demand and
//     skips every production optimisation; the numbers are noise. Use
//     `npm run build && npm start`, or a deployed environment.
//
//  2. **The DB pool is the ceiling, not the CPU.** lib/db.ts creates a mysql2
//     pool of DB_POOL_SIZE (default 10) with `queueLimit: 0` — unlimited
//     queueing. So past ~10 concurrent DB-touching requests, latency climbs
//     while throughput flattens: requests are waiting for a connection, not for
//     MySQL. That is the knee this test is for finding. Raising concurrency past
//     it measures the queue, not the app.
//
//  3. **RDS is shared.** This hits a real dev schema over the network. Don't run
//     a long high-concurrency pass while someone else is working.
//
//  4. **Warm up.** The first hit to each route pays compilation and pool
//     connection setup. This discards a warmup pass before measuring, which is
//     why a run takes a couple of seconds longer than --dur.
import { resolveSession } from "./postman/mint-session.mjs"

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = flag("base", "http://localhost:3000").replace(/\/$/, "")
const CONC = Number(flag("conc", 10))
const DUR = Number(flag("dur", 10))
const ONE = flag("path", null)

// Git Bash rewrites a leading-slash argument into a Windows path, so
// `--path /api/v1/approvals` arrives as `C:/Users/.../Git/api/v1/approvals` and every
// request fails with ERR_INVALID_URL — at 25k "req/s", which looks like a
// spectacular result until you read the codes column. Prefix the command with
// MSYS_NO_PATHCONV=1, or use `--path api/approvals`.
if (ONE && !ONE.startsWith("/")) {
  if (/^[A-Za-z]:/.test(ONE)) {
    throw new Error(
      `--path was rewritten to "${ONE}" by the shell. Re-run as:\n` +
        `  MSYS_NO_PATHCONV=1 npm run test:load -- --path /api/v1/...`
    )
  }
  throw new Error(`--path must start with "/" — got "${ONE}"`)
}

// Fail on "the server isn't running" before spending a DB round trip on a token,
// and with a sentence rather than a fetch-failed stack trace.
try {
  await fetch(`${BASE}/api/health`)
} catch (err) {
  if (err.cause?.code !== "ECONNREFUSED") throw err
  throw new Error(
    `Nothing is listening on ${BASE}.\n` +
      `  Production build (what you want to measure):  npm run build && npx next start -p 3100\n` +
      `  Already running dev on 3000:                  npm run test:load   (numbers will be ~40x pessimistic)`
  )
}

const session = await resolveSession({ base: BASE, cookie: flag("cookie", null), as: flag("as", undefined) })
const H = { Cookie: session.cookie }
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
  // A deployed environment shares its RDS with whoever else is working. This is
  // load, not a smoke test — say so out loud before generating it.
  console.log(`\n⚠  ${BASE} is not local. This will generate sustained load on shared`)
  console.log(`   infrastructure (and its RDS). Keep --dur short and tell whoever is using it.`)
}

/**
 * Real ids to hang parameterised routes off, harvested once from the PO list.
 *
 * Load testing with made-up ids measures the 404 path, which is fast and proves
 * nothing. A target whose id couldn't be found is dropped rather than run.
 */
async function harvest() {
  const res = await fetch(`${BASE}/api/v1/purchase-orders`, { headers: H })
  if (!res.ok) throw new Error(`PO list returned ${res.status} — is the server up and the token valid?`)
  const rows = await res.json()
  return {
    poId: rows[0]?.id ?? null,
    mfgId: rows[0]?.mfg_id ?? null,
    key: rows.find((r) => r.attachment_key)?.attachment_key ?? null,
  }
}

/**
 * Route groups. `--group core` is the default; `--group all` runs everything.
 *
 * The split is by what each one actually exercises, so a slow row points
 * somewhere specific rather than just "the app is slow":
 *
 *   core     the layers — no DB, one scoped query, the N+1, the key guard
 *   exports  full-table reads that serialise a CSV per request. The heaviest
 *            thing an ordinary user can trigger, and the most likely to hold a
 *            pool connection long enough to starve everyone else.
 *   po       the per-PO lookups the procurement screens fire on interaction
 *   lookups  small parameterised reads that pages call repeatedly
 */
const GROUPS = (c) => ({
  core: [
    { name: "health (no DB)", path: "/api/health" },
    { name: "PO list (scoped query)", path: "/api/v1/purchase-orders" },
    { name: "approvals queue", path: "/api/v1/approvals" },
    c.key && { name: "presign (key guard + S3 sign)", path: `/api/v1/files/presign?key=${encodeURIComponent(c.key)}` },
  ],
  exports: [
    { name: "export: purchase orders", path: "/api/v1/purchase-orders/export" },
    { name: "export: SKUs", path: "/api/v1/masters/skus/export" },
    { name: "export: material master", path: "/api/v1/masters/material-master/export" },
    { name: "export: BOM master", path: "/api/v1/masters/bom-master/export" },
    { name: "export: vendors", path: "/api/v1/masters/vendors/export" },
    { name: "export: manufacturers", path: "/api/v1/masters/manufacturers/export" },
  ],
  po: [
    { name: "invoice history list", path: "/api/v1/purchase-orders/invoice" },
    c.poId && { name: "PO history (one PO)", path: `/api/v1/purchase-orders/history?po_id=${c.poId}` },
    c.poId && { name: "PO inwarding detail", path: `/api/v1/purchase-orders/${c.poId}/inwarding` },
    c.mfgId && { name: "open POs for receive", path: `/api/v1/purchase-orders/open-for-receive?mfg_id=${c.mfgId}` },
  ],
  lookups: [
    { name: "approvals history", path: "/api/v1/approvals/history" },
    { name: "SKUs for a manufacturer", path: `/api/v1/purchase-orders/mfg-skus?mfg_id=${c.mfgId}` },
    { name: "entity emails", path: "/api/v1/entity-emails" },
  ],
})

const ctx = ONE ? { poId: null, mfgId: null, key: null } : await harvest()
const groups = GROUPS(ctx)
const GROUP = flag("group", "core")

// No process.exit() here: killing the process while undici's keep-alive sockets
// are still closing trips a libuv assertion on Windows. Let the run loop skip
// instead and Node exit on its own.
const LIST_ONLY = args.includes("--list")
if (LIST_ONLY) {
  for (const [g, ts] of Object.entries(groups)) {
    console.log(`\n${g}`)
    ts.filter(Boolean).forEach((t) => console.log(`  ${t.path}`))
  }
}

const TARGETS = ONE
  ? [{ name: ONE, path: ONE }]
  : (GROUP === "all" ? Object.values(groups).flat() : groups[GROUP] ?? []).filter(Boolean)

if (!LIST_ONLY && !TARGETS.length) {
  throw new Error(`No targets. --group must be one of: ${Object.keys(groups).join(", ")}, all. Use --list to see them.`)
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

/**
 * Run `path` with CONC workers for `seconds`. Closed loop: each worker sends one
 * request, waits for it, sends the next — so in-flight requests never exceed CONC
 * and a slow server produces fewer requests rather than an ever-growing backlog.
 */
async function run(path, seconds) {
  const until = Date.now() + seconds * 1000
  const latencies = []
  const codes = {}

  const worker = async () => {
    while (Date.now() < until) {
      const t0 = performance.now()
      try {
        const res = await fetch(BASE + path, { headers: H })
        // Drain the body — leaving it unread keeps the socket busy and makes the
        // next request on that connection wait for it.
        await res.arrayBuffer()
        codes[res.status] = (codes[res.status] ?? 0) + 1
      } catch (err) {
        codes[err.cause?.code ?? "network"] = (codes[err.cause?.code ?? "network"] ?? 0) + 1
      }
      latencies.push(performance.now() - t0)
    }
  }

  await Promise.all(Array.from({ length: CONC }, worker))
  latencies.sort((a, b) => a - b)
  return { latencies, codes, seconds }
}

if (!LIST_ONLY) {
  console.log(`\nbase        ${BASE}`)
  console.log(`as          user ${session.userId} <${session.email}>  scope: ${session.scope.split(" (")[0]}`)
  console.log(`profile     ${CONC} concurrent, ${DUR}s per endpoint, GET only`)
  console.log(`targets     ${ONE ? "--path" : `group "${GROUP}"`} — ${TARGETS.length} endpoint(s)`)
  if (BASE.includes("localhost")) {
    console.log("            ⚠ if this is `npm run dev`, the numbers are meaningless — build first")
  }
}

// Wide enough for a gateway timeout: a 60s latency printed as "60023ms" is 7
// chars and used to run straight into the previous column.
const ms = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`).padStart(9)
if (!LIST_ONLY) {
  console.log(
    `\n${"endpoint".padEnd(34)}${"req/s".padStart(8)}${"p50".padStart(9)}${"p95".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}   codes`
  )
}

for (const t of LIST_ONLY ? [] : TARGETS) {
  await run(t.path, 2) // warmup, discarded
  const { latencies, codes, seconds } = await run(t.path, DUR)
  const rps = latencies.length / seconds
  const codeStr = Object.entries(codes)
    .map(([c, n]) => `${c}:${n}`)
    .join(" ")
  console.log(
    t.name.padEnd(34) +
      rps.toFixed(1).padStart(8) +
      ms(pct(latencies, 50)) +
      ms(pct(latencies, 95)) +
      ms(pct(latencies, 99)) +
      ms(latencies[latencies.length - 1]) +
      `   ${codeStr}`
  )
}

if (!LIST_ONLY) console.log(
  `\nA non-2xx/3xx in the codes column is a failure under load, not a slow response.\n` +
    `If p95 balloons while req/s stays flat, you have found the ${process.env.DB_POOL_SIZE ?? 10}-connection pool queue,\n` +
    `not a slow query — raise DB_POOL_SIZE (and check RDS max_connections) before optimising SQL.\n` +
    `\n504s clustered at ~60s are the load balancer's idle timeout, not the app being slow:\n` +
    `every in-flight request stalled at once and the ALB cut them. The pool is configured\n` +
    `waitForConnections + queueLimit: 0 (lib/db.ts), so a stalled pool queues forever with no\n` +
    `acquisition timeout — a brief RDS blip becomes a 60s hang for whatever was in flight.\n` +
    `Check CloudWatch for ETIMEDOUT/ECONNRESET at that timestamp before blaming the endpoint.`
)
