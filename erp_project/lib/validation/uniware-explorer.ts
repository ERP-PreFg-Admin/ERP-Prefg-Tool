import { z } from "zod"

/**
 * GET /api/v1/admin/uniware-explorer
 *
 * Two modes on one route, because they are one screen: without `po` it lists a
 * facility's POs for a window; with `po` it returns that PO's GRNs unmapped.
 */
export const uniwareExplorerQuerySchema = z.object({
  /**
   * Uniware facility code. Optional: blank falls back to UNIWARE_FACILITY, and
   * off prod uniwareFacility() pins everything to TEST_FACILITY anyway — the
   * response reports which facility actually answered.
   */
  facility: z.string().trim().max(50).optional().default(""),

  /**
   * Window size. getPurchaseOrders has no sort parameter, so a date window is
   * the only way to ask for "the latest".
   *
   * Capped at 400 rather than left open: counts scale monotonically with the
   * window (2,507 at 300 days for one facility, 3,122 at 380), and past a year
   * the extra rows are history nobody is looking for from this screen.
   */
  days: z.coerce.number().int().min(1).max(400).optional().default(30),

  /**
   * Explicit PO date range (YYYY-MM-DD). When both are set they win over `days`
   * and drive the getPurchaseOrders `createdBetween` / `approvedBetween` filter;
   * left blank, the rolling `days` window is used.
   */
  dateFrom: z.string().trim().optional().default(""),
  dateTo: z.string().trim().optional().default(""),

  /**
   * Which Uniware timestamp the range filters on. `both` sends createdBetween AND
   * approvedBetween (an AND — narrower). Default `created`, matching the days window.
   */
  dateBasis: z.enum(["created", "approved", "both"]).optional().default("created"),

  /**
   * How many POs to fetch details for. Each costs one round trip, so this is one
   * request's budget — the list itself is not capped, and what was cut off is
   * reported.
   */
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),

  /** Drill into one PO's GRNs instead of listing. */
  po: z.string().trim().max(120).optional(),
})

export type UniwareExplorerQuery = z.infer<typeof uniwareExplorerQuerySchema>
