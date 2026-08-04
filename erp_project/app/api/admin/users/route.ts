// API route for user administration → tables `users` + `user_roles`.
//
// Called by app/admin/UsersClient.tsx / UserDialog.tsx.
//
// Reads are NOT here: the admin pages query lib/queries/users.ts server-side,
// the same way every masters page does. This route is mutations only.
//
// POST /api/admin/users
//   Request  { name, email, status, roles: string[] }
//     Process → INSERT users + one user_roles row per role, in one transaction.
//       The person can then sign in with Google: lib/auth.ts' signIn callback
//       whitelists on this row's email + status. Nothing is emailed.
//     Response 200 { ok, user } · 409 { error } duplicate email · 400 · 500
//
// PATCH /api/admin/users
//   Request  { id, name, status, roles: string[] }
//     Process → UPDATE users, then replace the user's roles wholesale.
//     Response 200 { ok, user } · 404 · 400 · 500
//
// There is intentionally no DELETE: users.id is referenced by approvals,
// sessions, session_history, master_* and supplier_invoices. Setting
// status = 'inactive' is the deactivation — signIn refuses those at login.
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
import { NextResponse } from "next/server"
import { z } from "zod"
import type { ResultSetHeader, PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { usersSql, type AdminUser } from "@/lib/queries/users"
import { STATUS } from "@/lib/constants"
import { EMAIL_REGEX } from "@/lib/validation/shared"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"

const ADMIN_PAGE = "/admin"

/** Roles are free text; normalize so "Admin" and " admin " can't become two roles. */
const rolesField = z
  .array(z.string().trim().min(1))
  .default([])
  .transform((roles) => [...new Set(roles.map((r) => r.toLowerCase()))])

const createSchema = z.object({
  name: z.string().trim().min(1),
  // Lowercased because signIn looks the email up verbatim — a stray capital
  // would silently lock the person out of a whitelisted account.
  email: z.string().trim().toLowerCase().refine((v) => EMAIL_REGEX.test(v), {
    message: "Invalid email address",
  }),
  status: z.enum([STATUS.ACTIVE, STATUS.INACTIVE]).default(STATUS.ACTIVE),
  roles: rolesField,
})

const updateSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1),
  status: z.enum([STATUS.ACTIVE, STATUS.INACTIVE]),
  roles: rolesField,
})

async function replaceRoles(conn: PoolConnection, userId: number, roles: string[]) {
  await conn.execute(usersSql.deleteRoles, [userId])
  for (const role of roles) {
    await conn.execute(usersSql.insertRole, [userId, role])
  }
}

export const POST = withGateway({
  schema: createSchema,
  access: { pageSlug: ADMIN_PAGE, level: "editor" },
  handler: async ({ body, ctx }) => {
    const conn = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const [res] = await conn.execute<ResultSetHeader>(usersSql.insertUser, [
        body.name,
        body.email,
        body.status,
      ])
      await replaceRoles(conn, res.insertId, body.roles)
      await conn.commit()

      logger.info({ ...ctx, module: "ADMIN_USERS", userIdCreated: res.insertId, email: body.email, message: "User created" })
      const rows = await query<AdminUser>(usersSql.selectById, [res.insertId])
      return NextResponse.json({ ok: true, user: rows[0] })
    } catch (err) {
      await conn.rollback()
      const e = err as { code?: string; message?: string }
      // users.email is UNIQUE — surface that as a 409 the dialog can show
      // instead of a generic 500.
      if (e.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "duplicate", `A user with the email ${body.email} already exists`)
      }
      logger.error({ ...ctx, module: "ADMIN_USERS", error: e.message, message: "User create failed" })
      throw err
    } finally {
      conn.release()
    }
  },
})

export const PATCH = withGateway({
  schema: updateSchema,
  access: { pageSlug: ADMIN_PAGE, level: "editor" },
  handler: async ({ body, ctx }) => {
    const existing = await query<{ id: number }>(usersSql.existsById, [body.id])
    if (existing.length === 0) throw new ApiError(404, "not_found", "User not found")

    const conn = await pool.getConnection()
    await conn.beginTransaction()
    try {
      await conn.execute(usersSql.updateUser, [body.name, body.status, body.id])
      await replaceRoles(conn, body.id, body.roles)
      await conn.commit()

      logger.info({ ...ctx, module: "ADMIN_USERS", targetUserId: body.id, status: body.status, message: "User updated" })
      const rows = await query<AdminUser>(usersSql.selectById, [body.id])
      return NextResponse.json({ ok: true, user: rows[0] })
    } catch (err) {
      await conn.rollback()
      logger.error({ ...ctx, module: "ADMIN_USERS", error: (err as Error)?.message, message: "User update failed" })
      throw err
    } finally {
      conn.release()
    }
  },
})
