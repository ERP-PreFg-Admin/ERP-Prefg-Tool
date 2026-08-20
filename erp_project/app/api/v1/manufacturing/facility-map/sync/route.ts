// POST /api/v1/manufacturing/facility-map/sync
//
// Pull ONE facility's Vendor Item Master export from Unicommerce and apply it.
//
//   { facility_code: "HYP_B2B_GGN" }
//     -> NDJSON step stream: job -> poll -> download -> apply -> { done, result }
//
// ── Why one facility per request ─────────────────────────────────────────────
// An export is an asynchronous job per facility (create, poll, download), and there
// are 18 of them. `maxDuration` gives one request 300s, which comfortably covers a
// single facility and cannot cover eighteen — and this repo has no queue or worker
// to hand the sequence to. So the BROWSER is the scheduler: the client calls this
// once per facility and keeps its place in localStorage, which also means a closed
// tab resumes instead of restarting.
//
// ── Why a stream ─────────────────────────────────────────────────────────────
// A large facility spends tens of seconds inside the poll loop. Without progress the
// UI is indistinguishable from a hang, so each step is emitted as it happens — the
// same NDJSON pattern as app/api/v1/purchase-orders/invoice/route.ts, whose client
// reader this mirrors.
//
// Status is ALWAYS 200 once streaming starts; later failures travel as events. A
// facility that fails is a normal outcome across 18 and must not fail the request.

import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { getUserScope } from "@/lib/scope"
import { syncFacilityCodeSchema } from "@/lib/validation/manufacturing"
import { syncFacility, type SyncStep } from "@/lib/mfg-facility-sync"
import { recordRawEvent, recordProcessedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

export const runtime = "nodejs"
export const maxDuration = 300

export const POST = withGateway({
  schema: syncFacilityCodeSchema,
  access: { pageSlug: "/manufacturing", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    const facility = body.facility_code.trim()
    if (!facility) throw new ApiError(400, "validation_error", "facility_code is required")

    // Resolved BEFORE streaming starts, so an auth or scope problem is still a real
    // status code rather than an event nobody checks.
    const scope = await getUserScope(userId)

    const eventId = makeEventId("MFG_FACILITY_SYNC", "sync", facility)
    const logCtx = { ...ctx, eventId, module: "MFG_FACILITY_SYNC" }
    recordRawEvent("MFG_FACILITY_SYNC", eventId, { facility })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
        try {
          const result = await syncFacility(
            facility, userId, scope,
            (e: SyncStep) => { send(e) },
          )
          send({ done: true, result })
          logger.info({ ...logCtx, ...result, message: "Facility sync finished" })
          recordProcessedEvent("MFG_FACILITY_SYNC", eventId, { facility, written: result.written })
        } catch (err: unknown) {
          // syncFacility swallows business failures, so reaching here is a genuine
          // defect. It still terminates the stream properly — a client waiting for
          // `done` would otherwise hang.
          const message = err instanceof Error ? err.message : String(err)
          logger.error({ ...logCtx, err: message, message: "Facility sync crashed" })
          send({ done: true, result: { facility, ok: false, read: 0, written: 0, skipped: {}, error: message } })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        // Without this nginx buffers the whole body and the progress arrives all at
        // once at the end, defeating the point. deploy/user-data.sh sets the matching
        // proxy timeouts.
        "X-Accel-Buffering": "no",
      },
    })
  },
})
