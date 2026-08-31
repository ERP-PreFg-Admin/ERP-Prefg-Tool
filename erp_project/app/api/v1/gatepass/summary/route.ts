// POST /api/v1/gatepass/summary
//
// Shipping-package-type summary for ONE facility over an IST invoice-date range,
// plus the gatepass that would be created from it.
//
//   { facility_code: "mCaff_Ahmedabad", from: "2026-08-01", to: "2026-08-27" }
//     -> NDJSON step stream: job -> poll -> download -> { done, result }
//
// The range is ONE export job, not one per day — it becomes a single `dateRange`
// on the job's invoicedOn filter. The summary and the gatepass plan are built
// from the same download, so planning costs no extra Uniware traffic.
//
// ── Why one facility per request ─────────────────────────────────────────────
// A Unicommerce export is an asynchronous job per facility (create, poll,
// download), and there are twenty of them. `maxDuration` gives one request 300s,
// which comfortably covers a single facility and cannot cover twenty — and this
// repo has no queue or worker to hand the sequence to. So the BROWSER is the
// scheduler: the client calls this once per facility, sequentially. Twenty jobs
// fired at once is also how an integration gets throttled.
//
// The same reasoning, and the same shape, as
// app/api/v1/manufacturing/facility-map/sync/route.ts.
//
// ── Why a stream ─────────────────────────────────────────────────────────────
// A facility spends tens of seconds inside the poll loop. Without progress the
// UI is indistinguishable from a hang, so each step is emitted as it happens.
//
// Status is ALWAYS 200 once streaming starts; later failures travel as events. A
// facility that fails is a normal outcome across twenty and must not fail the
// request — the other nineteen still have to run.
//
// ── Nothing is stored ────────────────────────────────────────────────────────
// No table, no query, not even a read. The export is summarised in memory and
// dropped. See the header of lib/gatepass/fetch.ts.

import { withGateway } from "@/lib/gateway/with-gateway"
import { gatepassSummarySchema } from "@/lib/validation/gatepass"
import { fetchFacilitySummary, type GatepassStep } from "@/lib/gatepass/fetch"
import logger from "@/lib/logger"

export const runtime = "nodejs"
export const maxDuration = 300

export const POST = withGateway({
  schema: gatepassSummarySchema,
  access: { pageSlug: "/gatepass", level: "viewer" },
  // No `scope`: this route is not addressed by an entity id, and with the DB
  // deliberately out of the picture a facility code cannot be resolved to a
  // warehouse name to check it against. /gatepass is gated by page permission
  // alone — see the ponytail note in lib/gatepass/facilities.ts.
  handler: async ({ body, ctx }) => {
    const { facility_code: facility, from, to } = body

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
        try {
          const result = await fetchFacilitySummary(
            facility, from, to, (e: GatepassStep) => { send(e) },
          )
          send({ done: true, result })
          logger.info({
            ...ctx, module: "GATEPASS", facility, from, to,
            ok: result.ok, rows: result.rows, types: result.summary.length,
            items: result.plan?.items.length ?? 0,
            message: "Gatepass summary finished",
          })
        } catch (err: unknown) {
          // fetchFacilitySummary swallows business failures, so reaching here is
          // a genuine defect. It still terminates the stream properly — a client
          // waiting for `done` would otherwise hang.
          const message = err instanceof Error ? err.message : String(err)
          logger.error({ ...ctx, module: "GATEPASS", facility, from, to, err: message,
            message: "Gatepass summary crashed" })
          send({ done: true, result: {
            facility, from, to, ok: false, rows: 0, summary: [], plan: null, error: message,
          } })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        // Without this nginx buffers the whole body and the progress arrives all
        // at once at the end, defeating the point.
        "X-Accel-Buffering": "no",
      },
    })
  },
})
