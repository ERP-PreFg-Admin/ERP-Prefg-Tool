// GET /api/v1/masters/recipe-master/history/[id]
//
// Returns a single Recipe's header + its ARCHIVED material lines (history_recipe)
// for the read-only History detail panel. Same access rule and response
// shape as /api/v1/masters/recipe-master/[id] — only the line source differs.

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
  // Same brand boundary as ../../[id] — an archived formulation is no less
  // sensitive than the live one.
  scope: { type: "recipe", from: ({ params }) => params.id },
  handler: async ({ params }) => {
    // Artifacts are current-state, not archived — same set the live detail
    // route (../[id]/route.ts) returns, since artifacts_recipe rows are never
    // versioned per Recipe revision. RecipeDetailPanel.tsx renders detail.artifacts
    // unconditionally, so this must always be an array, never undefined.
    const [headerRows, lines, artifacts] = await Promise.all([
      query<Omit<RecipeDetailResponse, "lines" | "artifacts">>(bom.selectHeaderById, [params.id]),
      query<Recipe>(bom.selectHistoryLinesByBomId, [params.id]),
      query<RecipeArtifact>(bom.selectArtifactsByBomId, [params.id]),
      
    ])
    const header = headerRows[0]
    if (!header) throw new ApiError(404, "not_found", "Recipe not found.")
    if (lines.length === 0) throw new ApiError(404, "no_history", "This Recipe has no archived revisions.")

    const response: RecipeDetailResponse = { ...header, lines, artifacts }
    return NextResponse.json(response)
  },
})
