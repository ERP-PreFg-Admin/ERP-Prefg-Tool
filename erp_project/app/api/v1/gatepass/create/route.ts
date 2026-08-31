// POST /api/v1/gatepass/create
//
// Raise ONE facility's gatepass in Unicommerce for an invoice-date window.
//
//   { facility_code, from, to, confirm: true }
//     -> NDJSON: serial -> create -> item xN -> { done, result }
//
// ── This route WRITES, and cannot be undone ──────────────────────────────────
// Unicommerce has no delete for a gatepass. Three things guard that:
//
//   1. `confirm: true` is required by the schema — a replayed or malformed
//      request does nothing.
//   2. ONE facility per request. There is no "create for all" here; the browser
//      calls this once per facility, which is also what makes each one a
//      separate deliberate act rather than a single click over twenty sites.
//   3. The payload is rebuilt SERVER-SIDE from a fresh export. The client sends
//      only a facility and a window — never package types or quantities, which
//      a browser could otherwise invent and have printed on a document.
//
// The cost of (3) is one export job per create. That is deliberate: it also
// guarantees the gatepass matches what the data actually says at the moment it
// is raised, rather than what a tab happened to be showing.
//
// Status is ALWAYS 200 once streaming starts; failures travel as events. A
// partial run — gatepass created, some lines rejected — is a real outcome and is
// reported as such, never as a plain failure, because the document exists and a
// second attempt would duplicate it.

import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { gatepassCreateSchema } from "@/lib/validation/gatepass"
import { fetchFacilitySummary } from "@/lib/gatepass/fetch"
import { createFacilityGatepass, type CreateStep } from "@/lib/gatepass/create"
import { blockers } from "@/lib/gatepass/plan"
import logger from "@/lib/logger"

export const runtime = "nodejs"
export const maxDuration = 300

export const POST = withGateway({
  schema: gatepassCreateSchema,
  access: { pageSlug: "/gatepass", level: "editor" },
  handler: async ({ body, ctx }) => {
    const { facility_code: facility, from, to } = body

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
        try {
          // Rebuilt here, not taken from the client. See the header.
          send({ step: "export", status: "start" })
          const summary = await fetchFacilitySummary(facility, from, to)
          if (!summary.ok || !summary.plan) {
            throw new ApiError(502, "export_failed", summary.error ?? "Could not read the export")
          }
          // `to`, not the range: the reference reads "Till <date>", and the document
          // covers everything invoiced up to and including that day.
          const plan = { ...summary.plan, window: to }
          send({ step: "export", status: "ok", boxes: plan.items.length })

          // The same refusals the dry run shows. Checked again here because the
          // dialog hiding a button is never the guard.
          const stop = blockers([plan])
          if (stop.length > 0) throw new ApiError(409, "blocked", stop.join(" "))

          const result = await createFacilityGatepass(plan, (e: CreateStep) => { send(e) })
          send({ done: true, result })
          logger.info({ ...ctx, module: "GATEPASS", facility, from, to,
            gatePassCode: result.gatePassCode, added: result.added,
            failed: result.failed.length, message: "Gatepass create route finished" })
        } catch (err: unknown) {
          const message = err instanceof ApiError ? err.message
            : err instanceof Error ? err.message : String(err)
          logger.error({ ...ctx, module: "GATEPASS", facility, err: message,
            message: "Gatepass create crashed" })
          send({ done: true, result: {
            facility, ok: false, gatePassCode: null, added: 0, failed: [], error: message,
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
        "X-Accel-Buffering": "no",
      },
    })
  },
})
