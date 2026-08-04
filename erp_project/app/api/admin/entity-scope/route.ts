// API route for per-user data scoping → table `user_entity_scope`.
//
// Called by app/admin/data-access/DataAccessClient.tsx.
//
// PUT /api/admin/entity-scope
//   Request  { user_id, entity_type: "mfg"|"vendor"|"warehouse", entity_ids: number[] | null }
//     Process → replaces that ONE (user, entity_type) set in a transaction.
//       `null` (or []) deletes every row for the pair, which means UNRESTRICTED —
//       see prisma/add_user_entity_scope.sql. The other two entity types are
//       untouched, so the UI can save one section at a time.
//     Response 200 { ok, entity_type, entity_ids } · 400 · 404 · 500
//
// Reads happen server-side in app/admin/data-access/page.tsx, like the other
// admin tabs.
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
import { NextResponse } from "next/server"
import { z } from "zod"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { entityScopeSql } from "@/lib/queries/entity-scope"
import { usersSql } from "@/lib/queries/users"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertNotSelfScope } from "@/lib/admin-guards"
import logger from "@/lib/logger"

const putSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  entity_type: z.enum(["mfg", "vendor", "warehouse"]),
  // null is the explicit "unrestricted" signal; [] is treated the same way
  // rather than as "nothing", because a scope of nothing would lock the user
  // out of every screen with no way for them to say so.
  entity_ids: z.array(z.coerce.number().int().positive()).nullable(),
})

export const PUT = withGateway({
  schema: putSchema,
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const { user_id, entity_type } = body
    const entityIds = body.entity_ids ?? []

    assertNotSelfScope(session, user_id)

    const exists = await query<{ id: number }>(usersSql.existsById, [user_id])
    if (exists.length === 0) throw new ApiError(404, "not_found", "User not found")

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      // Replace wholesale — simpler than diffing, and the set is tens of rows.
      await conn.execute(entityScopeSql.deleteForUserAndType, [user_id, entity_type])
      for (const entityId of new Set(entityIds)) {
        await conn.execute(entityScopeSql.insert, [user_id, entity_type, entityId, Number(session.user.id)])
      }
      await conn.commit()

      logger.info({
        ...ctx, module: "ADMIN_ENTITY_SCOPE", targetUserId: user_id, entity_type,
        count: entityIds.length,
        message: entityIds.length === 0
          ? "Entity scope cleared (unrestricted)"
          : "Entity scope replaced",
      })
      return NextResponse.json({ ok: true, entity_type, entity_ids: entityIds })
    } catch (err) {
      await conn.rollback()
      logger.error({ ...ctx, module: "ADMIN_ENTITY_SCOPE", error: (err as Error)?.message, message: "Entity scope update failed" })
      throw err
    } finally {
      conn.release()
    }
  },
})
