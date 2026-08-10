// GET /api/v1/masters/recipe-master/[id]
//
// Returns a single Recipe's header + all material lines for the detail side-panel.
// Gated by the same "/masters" viewer permission as the listing page — guards
// against a user reaching another Recipe's details by editing the id in the URL.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { bomIdParamSchema } from "@/lib/validation/recipe"
import { query } from "@/lib/db"
import { bom } from "@/lib/queries/recipe"
import type { Recipe, RecipeArtifact, RecipeDetailResponse } from "@/types/masters"

export const GET = withGateway({
  paramsSchema: bomIdParamSchema,
  access: { pageSlug: "/masters/recipe-master", level: "viewer" },
  handler: async ({ params }) => {
    // Header, lines, and artifacts are independent reads — run them
    // concurrently instead of paying three sequential round-trips to the DB.
    const [headerRows, lines, artifacts] = await Promise.all([
      query<Omit<RecipeDetailResponse, "lines" | "artifacts">>(bom.selectHeaderById, [params.id]),
      query<Recipe>(bom.selectDetailLinesByBomId, [params.id]),
      query<RecipeArtifact>(bom.selectArtifactsByBomId, [params.id]),
    ])
    const header = headerRows[0]
    if (!header) throw new ApiError(404, "not_found", "Recipe not found.")

    const response: RecipeDetailResponse = { ...header, lines, artifacts }
    return NextResponse.json(response)
  },
})
