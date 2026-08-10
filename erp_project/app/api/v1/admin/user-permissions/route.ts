// API route for PER-USER page permission overrides → table `user_page_permissions`.
//
// Called by app/admin/permissions/PermissionsClient.tsx (the overrides panel).
// An override wins outright over every role grant at that slug — see
// lib/permissions.ts' resolveAccess.
//
// GET ?user_id=<int> → that user's overrides (all rows when omitted)
// POST   { user_id, page_slug, access_level } → upsert, returns the stored row
// DELETE { user_id, page_slug } → { ok: true }, access falls back to the roles
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
import { NextResponse } from "next/server"
import { z } from "zod"
import { query, execute } from "@/lib/db"
import { permissions } from "@/lib/queries/permissions"
import { usersSql } from "@/lib/queries/users"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertNotSelfLockout } from "@/lib/admin-guards"

const userIdQuerySchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
})

const upsertUserPagePermissionSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  page_slug: z.string().trim().min(1),
  access_level: z.enum(["none", "viewer", "editor"]),
})

const deleteUserPagePermissionSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  page_slug: z.string().trim().min(1),
})

/** An override for a user id that doesn't exist is unreachable dead data. */
async function assertUserExists(userId: number) {
  const rows = await query<{ id: number }>(usersSql.existsById, [userId])
  if (rows.length === 0) throw new ApiError(404, "not_found", "User not found")
}

export const GET = withGateway({
  access: { pageSlug: "/admin", level: "viewer" },
  handler: async ({ req }) => {
    const parsed = userIdQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
    const userId = parsed.success ? parsed.data.user_id : undefined
    const rows = userId
      ? await query(permissions.selectUserPagePermissionsByUserId, [userId])
      : await query(permissions.selectUserPagePermissions)
    return NextResponse.json(rows)
  },
})

export const POST = withGateway({
  schema: upsertUserPagePermissionSchema,
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ body, session }) => {
    const { user_id, page_slug, access_level } = body
    assertNotSelfLockout(session, page_slug, access_level, { userId: user_id })
    await assertUserExists(user_id)
    await execute(permissions.upsertUserPagePermission, [user_id, page_slug, access_level])
    const rows = await query(permissions.selectUserPagePermissionByUserAndPage, [user_id, page_slug])
    return NextResponse.json(rows[0])
  },
})

export const DELETE = withGateway({
  schema: deleteUserPagePermissionSchema,
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ body, session }) => {
    const { user_id, page_slug } = body
    // Removing an override falls back to the role grant, which may well be
    // nothing — treat it as a downgrade for the caller's own /admin row.
    assertNotSelfLockout(session, page_slug, "none", { userId: user_id })
    await execute(permissions.deleteUserPagePermission, [user_id, page_slug])
    return NextResponse.json({ ok: true })
  },
})
