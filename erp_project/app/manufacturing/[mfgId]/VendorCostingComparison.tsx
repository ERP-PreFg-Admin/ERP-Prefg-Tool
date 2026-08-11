import FinalCostingComparisonTable from "./FinalCostingComparisonTable"
import type { FinalCostingComparisonRow } from "@/types/masters"

/**
 * The three vendor-rate scenarios, stacked.
 *
 * They share a column set exactly — which is the point: stacked, the same row
 * reads straight down across approved / cheapest / priciest, so the three are
 * compared against each other as well as against the agreed MRM rate above.
 * A toggle would have hidden two-thirds of that comparison behind a click.
 *
 * No client state, so no "use client" — this renders on the server with the
 * rows the page already computed.
 */
export default function VendorCostingComparison({
  approvedRows, minRows, maxRows, exportEndpoint,
}: {
  approvedRows: FinalCostingComparisonRow[]
  minRows: FinalCostingComparisonRow[]
  maxRows: FinalCostingComparisonRow[]
  exportEndpoint: string
}) {
  return (
    <div className="space-y-6">
      <FinalCostingComparisonTable
        scenarioLabel="Approved vendor rate"
        title="Approved Vendor Rate"
        subtitle="Recomputed using the approved vendor's currently-effective rate per RM/PM component, compared against the agreed MRM rate above. PM has no approved-vendor column, so its rate is the same best-effort pick the Approved Vendor Rates tab makes."
        rows={approvedRows}
      />
      <FinalCostingComparisonTable
        scenarioLabel="Cheapest available vendor rate"
        title="Cheapest Available Vendor Rate"
        subtitle="Recomputed using the lowest currently-effective vendor (VRM) rate per RM/PM component, compared against the agreed MRM rate above."
        rows={minRows}
      />
      {/* One workbook covers all three scenarios, so the export hangs off the
          last table — i.e. below the stack — rather than repeating on each. */}
      <FinalCostingComparisonTable
        scenarioLabel="Most expensive available vendor rate"
        title="Most Expensive Available Vendor Rate"
        subtitle="Recomputed using the highest currently-effective vendor (VRM) rate per RM/PM component, compared against the agreed MRM rate above."
        rows={maxRows}
        exportEndpoint={exportEndpoint}
      />
    </div>
  )
}
