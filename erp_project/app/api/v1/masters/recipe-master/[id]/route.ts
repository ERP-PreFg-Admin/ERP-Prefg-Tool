// GET /api/v1/masters/recipe-master/[id]
//
// Returns a single Recipe's header + all material lines for the detail side-panel.
//
// TWO gates, and they are not the same thing. The "/masters/recipe-master"
// viewer permission decides whether you may open this screen at all; `scope`
// decides whether THIS recipe is yours to read. Page permission alone was what
// used to guard this route, which guarded nothing: the payload is the full
// formulation, and the id is a guessable integer.

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
  // Brand is the boundary here, same as the list (recipe.ts s.brand_id IN (?))
  // and the write path (assertSkuIdInBrandScope in ../route.ts).
  scope: { type: "recipe", from: ({ params }) => params.id },
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
