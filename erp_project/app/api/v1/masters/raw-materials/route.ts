import { NextResponse } from "next/server"
import logger from "@/lib/logger"
import { query } from "@/lib/db"
import { getRmDistinctMakes, getRmDistinctInciNames } from "@/lib/cached-reference-data"
import { bom as bomSql } from "@/lib/queries/bom"
import { withGateway } from "@/lib/gateway/with-gateway"
import { rmActionSchema } from "@/lib/validation/raw-materials"
import {
  rmCreate, rmCheckDuplicate, rmCheckVendor,
  rmCreateFull, rmAddRates, rmBulk, rmS3Bulk,
  rmCheckMakeFuzzy, rmCheckDuplicatesBulk, rmGetMaterials,
} from "@/app/api/masters/raw-materials/rm-handler"

export const POST = withGateway({
  schema: rmActionSchema,
  access: { pageSlug: "/masters/raw-materials", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    logger.info({ ...ctx, action: body.action, message: "Raw Materials API request received" })

    switch (body.action) {
      case "create":       return rmCreate(body, userId, ctx)
      case "check-RM":     return rmCheckDuplicate(body, ctx)
      case "check-vendor": return rmCheckVendor(body, ctx)
      case "create-full":  return rmCreateFull(body, userId, ctx)
      case "add-rates":    return rmAddRates(body, userId, ctx)
      case "bulk":         return rmBulk(body, userId, ctx)
      case "bulk_from_s3": return rmS3Bulk(body, userId, ctx)
      case "check-make-fuzzy":  return rmCheckMakeFuzzy(body, ctx)
      case "check_duplicates":  return rmCheckDuplicatesBulk(body, ctx)
      case "get-materials":     return rmGetMaterials(ctx)

      case "get-makes": {
        const rows = await getRmDistinctMakes()
        return NextResponse.json({ makes: rows.map((r) => r.make) })
      }
      case "get-inci-names": {
        const rows = await getRmDistinctInciNames()
        return NextResponse.json({ inciNames: rows.map((r) => r.inci_name) })
      }
      case "material-impact": {
        const { rm_id, scope, mfg_id } = body
        const rows = scope === "mfg" && mfg_id
          ? await query<{ sku_code: string; name: string }>(bomSql.selectActiveSkusUsingMaterialForMfg, [mfg_id, "rm", rm_id])
          : await query<{ sku_code: string; name: string }>(bomSql.selectActiveSkusUsingMaterial, ["rm", rm_id])
        return NextResponse.json({ count: rows.length, skus: rows })
      }
    }
  },
})
