// API route for the entity_emails contact list (vendor/manufacturer/warehouse
// email by purpose — a warehouse is keyed by its master_warehouse.name).
//
// POST /api/v1/entity-emails → { entity_type, entity_code, emails: [{ email, recipient_type?, purpose? }, ...] }
//   entity_type 'employee' is a person to loop in — ours or an outside party —
//   and entity_code is the warehouse name or manufacturer code they are attached
//   to, or '*' for every manufacturer.
//   — direct insert (one row per email, same entity), no approval flow (this is an
//   auxiliary contact list, not a master-record edit). Lets one manufacturer/vendor
//   have several emails on file (e.g. one per purpose).
// Listing happens server-side in app/po-tracking/po-procurement/entity-emails/page.tsx.
import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { entityEmails } from "@/lib/queries/entity-emails"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { entityEmailCreateSchema } from "@/lib/validation/entity-emails"

export const POST = withGateway({
  schema: entityEmailCreateSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body }) => {
    // Empty string, not just undefined, becomes NULL: the form's "All entities"
    // option submits "" and a literal '' would match no entity in
    // selectByWarehouseForEntity, so those addresses would silently never be
    // mailed — the exact failure this column exists to avoid.
    const legalEntityCode = body.legal_entity_code?.trim() || null

    // The column has no foreign key (entity_code points at three different
    // tables depending on entity_type, so neither column can carry one), which
    // means a typo would be accepted and then match nothing at send time.
    if (legalEntityCode) {
      const rows = await query<{ id: number }>(warehouseSql.selectEntityIdByCode, [legalEntityCode])
      if (rows.length === 0) {
        throw new ApiError(400, "unknown_entity", `Unknown legal entity '${legalEntityCode}'.`)
      }
    }

    // Same reasoning as the legal-entity check above, for the same reason:
    // entity_code has no FK (it points at three different tables), so a code
    // that matches nothing is accepted here and then silently mails no one.
    // '*' is the deliberate exception — every manufacturer, including future ones.
    //
    // The ADDRESS is deliberately unchecked: an employee row is anyone who needs
    // looping in, including outside parties (3PL, CHA, consultant) who hold no
    // login here. Only what it is attached to has to resolve.
    if (body.entity_type === "employee" && body.entity_code !== "*") {
      const [wh, mfg] = await Promise.all([
        query<{ id: number }>(entityEmails.warehouseExistsByName, [body.entity_code]),
        query<{ id: number }>(entityEmails.mfgExistsByCode, [body.entity_code]),
      ])
      if (wh.length === 0 && mfg.length === 0) {
        throw new ApiError(
          400, "unknown_entity",
          `'${body.entity_code}' is neither a warehouse nor a manufacturer.`
        )
      }
    }

    for (const { email, recipient_type, purpose } of body.emails) {
      await execute(entityEmails.insert, [
        body.entity_type, body.entity_code, legalEntityCode, email, recipient_type, purpose || null,
      ])
    }
    return NextResponse.json({ ok: true })
},
})
