import { Card, CardContent } from "@/components/ui/card"

/**
 * Placeholder tab — no backend yet. Will eventually list raw materials used
 * across 2+ SKUs produced at this manufacturer, to help spot consolidation
 * opportunities (fewer distinct RMs to negotiate/stock for the same output).
 */
export default function CommonRmsTable({ mfgId }: { mfgId: number }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">Common RMs — coming soon</p>
        <p>
          Will show raw materials shared across multiple SKUs produced at this manufacturer
          (mfg #{mfgId}), to help identify consolidation opportunities.
        </p>
      </CardContent>
    </Card>
  )
}
