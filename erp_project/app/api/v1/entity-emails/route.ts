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
import { entityEmailCreateSchema, entityEmailUpdateSchema } from "@/lib/validation/entity-emails"

export const POST = withGateway({
  schema: entityEmailCreateSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body, session }) => {
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

    // One address per entity. uq_entity_email enforces it (see
    // prisma/add_entity_email_unique.sql) — this pre-check exists to say WHICH
    // address collided, because the constraint violation alone reaches the user
    // as an opaque database error.
    //
    // Checked against the DB and against the rest of this submission: pasting the
    // same address into two rows of the form would otherwise pass every
    // individual check and then fail mid-loop, leaving the earlier rows inserted.
    const seen = new Set<string>()
    for (const { email } of body.emails) {
      const key = email.toLowerCase()
      if (seen.has(key)) {
        throw new ApiError(409, "duplicate_email", `'${email}' appears twice in this submission.`)
      }
      seen.add(key)

      const dupe = await query<{ id: number }>(entityEmails.findDuplicate, [
        body.entity_type, body.entity_code, legalEntityCode, email, 0,
      ])
      if (dupe.length > 0) {
        throw new ApiError(
          409, "duplicate_email",
          `'${email}' is already on file for this contact.`
        )
      }
    }

    // Who added it, from the session rather than the body — a client-supplied
    // author is not an audit trail.
    const createdBy = Number(session.user.id)

    for (const { email, recipient_type, purpose } of body.emails) {
      await execute(entityEmails.insert, [
        body.entity_type, body.entity_code, legalEntityCode, email, recipient_type,
        purpose || null, body.status, createdBy,
      ])
    }
    return NextResponse.json({ ok: true })
},
})

/**
 * PATCH /api/v1/entity-emails → one row, by id.
 *
 * Edits a single address rather than replacing an entity's whole set: the list
 * shows one address per line, so that is the unit a user acts on.
 */
export const PATCH = withGateway({
  schema: entityEmailUpdateSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body }) => {
    const existing = await query<{ id: number }>(entityEmails.selectById, [body.id])
    if (existing.length === 0) {
      throw new ApiError(404, "not_found", "That contact no longer exists.")
    }

    const legalEntityCode = body.legal_entity_code?.trim() || null

    // Same three guards as create, for the same reasons — an edit can introduce
    // exactly the problems a create can.
    if (legalEntityCode) {
      const rows = await query<{ id: number }>(warehouseSql.selectEntityIdByCode, [legalEntityCode])
      if (rows.length === 0) {
        throw new ApiError(400, "unknown_entity", `Unknown legal entity '${legalEntityCode}'.`)
      }
    }

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

    if (body.entity_type === "warehouse" && body.entity_code !== "*") {
      const wh = await query<{ id: number }>(entityEmails.warehouseExistsByName, [body.entity_code])
      if (wh.length === 0) {
        throw new ApiError(400, "unknown_entity", `Unknown warehouse '${body.entity_code}'.`)
      }
    }

    // Excludes this row, so re-saving without changing the address is not a
    // collision with itself.
    const dupe = await query<{ id: number }>(entityEmails.findDuplicate, [
      body.entity_type, body.entity_code, legalEntityCode, body.email, body.id,
    ])
    if (dupe.length > 0) {
      throw new ApiError(409, "duplicate_email", `'${body.email}' is already on file for this contact.`)
    }

    await execute(entityEmails.updateById, [
      body.entity_type, body.entity_code, legalEntityCode,
      body.email, body.recipient_type, body.purpose || null, body.status, body.id,
    ])
    return NextResponse.json({ ok: true })
  },
})
