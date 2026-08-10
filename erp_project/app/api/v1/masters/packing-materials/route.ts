import { NextResponse } from "next/server"
import logger from "@/lib/logger"
import { query } from "@/lib/db"
import { bom as bomSql } from "@/lib/queries/recipe"
import { withGateway } from "@/lib/gateway/with-gateway"
import { pmActionSchema } from "@/lib/validation/packing-materials"
import {
  pmCreate, pmCheckDuplicate, pmCheckVendor,
  pmCreateFull, pmAddRates, pmBulk, pmS3Bulk, pmGetMaterials, pmCheckDuplicatesBulk,
} from "@/app/api/v1/masters/packing-materials/pm-handler"

export const POST = withGateway({
  schema: pmActionSchema,
  access: { pageSlug: "/masters/packing-materials", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    logger.info({ ...ctx, action: body.action, message: "Packing Material API request received" })

    switch (body.action) {
      case "create":       return pmCreate(body, userId, ctx)
      case "check-PM":     return pmCheckDuplicate(body, ctx)
      case "check-vendor": return pmCheckVendor(body, ctx)
      case "create-full":  return pmCreateFull(body, userId, ctx)
      case "add-rates":    return pmAddRates(body, userId, ctx)
      case "bulk":         return pmBulk(body, userId, ctx)
      case "bulk_from_s3": return pmS3Bulk(body, userId, ctx)
      case "check_duplicates": return pmCheckDuplicatesBulk(body, ctx)
      case "get-materials": return pmGetMaterials(ctx)

      case "material-impact": {
        const { pm_id, scope, mfg_id } = body
        const rows = scope === "mfg" && mfg_id
          ? await query<{ sku_code: string; name: string }>(bomSql.selectActiveSkusUsingMaterialForMfg, [mfg_id, "pm", pm_id])
          : await query<{ sku_code: string; name: string }>(bomSql.selectActiveSkusUsingMaterial, ["pm", pm_id])
        return NextResponse.json({ count: rows.length, skus: rows })
      }
    }
  },
})
