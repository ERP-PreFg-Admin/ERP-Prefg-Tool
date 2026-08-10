// GET /api/masters/bom-master/[id]
//
// Returns a single BOM's header + all material lines for the detail side-panel.
// Gated by the same "/masters" viewer permission as the listing page — guards
// against a user reaching another BOM's details by editing the id in the URL.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { bomIdParamSchema } from "@/lib/validation/bom"
import { query } from "@/lib/db"
import { bom } from "@/lib/queries/bom"
import type { BOM, BomArtifact, BomDetailResponse } from "@/types/masters"

export const GET = withGateway({
  paramsSchema: bomIdParamSchema,
  access: { pageSlug: "/masters/bom-master", level: "viewer" },
  handler: async ({ params }) => {
    // Header, lines, and artifacts are independent reads — run them
    // concurrently instead of paying three sequential round-trips to the DB.
    const [headerRows, lines, artifacts] = await Promise.all([
      query<Omit<BomDetailResponse, "lines" | "artifacts">>(bom.selectHeaderById, [params.id]),
      query<BOM>(bom.selectDetailLinesByBomId, [params.id]),
      query<BomArtifact>(bom.selectArtifactsByBomId, [params.id]),
    ])
    const header = headerRows[0]
    if (!header) throw new ApiError(404, "not_found", "BOM not found.")

    const response: BomDetailResponse = { ...header, lines, artifacts }
    return NextResponse.json(response)
  },
})
