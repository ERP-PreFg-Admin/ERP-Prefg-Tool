import { z } from "zod"
import { isKnownFacility } from "@/lib/gatepass/facilities"
import { rangeDays } from "@/lib/gatepass/summary"

/**
 * How long a window one request may ask for.
 *
 * A quarter. The cost of a wide range is NOT more export jobs — the range is one
 * `dateRange` on one job per facility either way — it is the size of the CSV and
 * the 300s the request has to fetch and parse it. Ahmedabad returns ~1,100 rows
 * a day, so a quarter is ~100k rows; a year would be ~400k and is where this
 * starts to hurt. One constant to raise if that changes.
 */
export const MAX_RANGE_DAYS = 92

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")

/**
 * One facility's summary over an inclusive IST date range of INVOICE dates.
 *
 * `facility_code` is checked against the roster HERE rather than in the handler:
 * with no DB behind this screen, `lib/gatepass/facilities.ts` is the only thing
 * that defines a valid facility, and without this the route would forward any
 * string a caller invented to Unicommerce under our credentials.
 *
 * Dates stay STRINGS all the way down, deliberately not `z.coerce.date()` — a
 * Date would be parsed as UTC and land the IST window 05:30 early, which is the
 * exact mistake istRangeMs exists to prevent.
 */
export const gatepassSummarySchema = z.object({
  facility_code: z.string().trim().refine(isKnownFacility, {
    message: "Unknown facility — see lib/gatepass/facilities.ts",
  }),
  from: isoDate,
  to: isoDate,
}).superRefine((v, ctx) => {
  let days: number
  try {
    days = rangeDays(v.from, v.to)
  } catch (err) {
    // A real but impossible date (2026-02-30) or a reversed range.
    ctx.addIssue({ code: "custom", path: ["to"], message: (err as Error).message })
    return
  }
  if (days > MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: "custom", path: ["to"],
      message: `Range is ${days} days — the most one request may ask for is ${MAX_RANGE_DAYS}.`,
    })
  }
})

export type GatepassSummaryInput = z.infer<typeof gatepassSummarySchema>

/**
 * Raise ONE facility's gatepass for a window.
 *
 * `confirm` must be the literal `true`. It is not decoration: this route WRITES
 * to Unicommerce and cannot be undone, so an accidental or replayed request with
 * the flag missing is rejected rather than acted on.
 *
 * The window is re-fetched server-side from these three fields. The client never
 * sends the payload — a body built in the browser could name any package type
 * and quantity, and this is the one route where that would print on a document.
 */
export const gatepassCreateSchema = z.object({
  facility_code: z.string().trim().refine(isKnownFacility, {
    message: "Unknown facility — see lib/gatepass/facilities.ts",
  }),
  from: isoDate,
  to: isoDate,
  confirm: z.literal(true, { message: "This creates a real gatepass; confirm must be true." }),
})

export type GatepassCreateInput = z.infer<typeof gatepassCreateSchema>
