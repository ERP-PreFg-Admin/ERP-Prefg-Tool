// API route for ROLE-based page permissions → table `page_permissions`.
//
// Called by app/admin/permissions/PermissionsClient.tsx (the role x page grid).
//
// GET    → all rows, [{ id, role, page_slug, access_level, created_at }, ...]
// POST   { role, page_slug, access_level } → upsert, returns the stored row
// DELETE { role, page_slug } → removes the grant so the slug inherits from its
//   parent again (an explicit 'none' row blocks that fallback — see
//   lib/permissions.ts). Returns { ok: true }.
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
import { NextResponse } from "next/server"
import { z } from "zod"
import { query, execute } from "@/lib/db"
import { permissions } from "@/lib/queries/permissions"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertNotSelfLockout } from "@/lib/admin-guards"

const upsertPagePermissionSchema = z.object({
  role: z.string().trim().min(1),
  page_slug: z.string().trim().min(1),
  access_level: z.enum(["none", "viewer", "editor"]),
})

const deletePagePermissionSchema = z.object({
  role: z.string().trim().min(1),
  page_slug: z.string().trim().min(1),
})

export const GET = withGateway({
  access: { pageSlug: "/admin", level: "viewer" },
  handler: async () => {
    const rows = await query(permissions.selectPagePermissions)
    return NextResponse.json(rows)
  },
})

export const POST = withGateway({
  schema: upsertPagePermissionSchema,
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ body, session }) => {
    const { role, page_slug, access_level } = body
    assertNotSelfLockout(session, page_slug, access_level, { role })
    await execute(permissions.upsertPagePermission, [role, page_slug, access_level])
    const rows = await query(permissions.selectPagePermissionByRoleAndPage, [role, page_slug])
    return NextResponse.json(rows[0])
  },
})

export const DELETE = withGateway({
  schema: deletePagePermissionSchema,
  access: { pageSlug: "/admin", level: "editor" },
  handler: async ({ body, session }) => {
    const { role, page_slug } = body
    // Clearing the grant is a downgrade to "inherit", which for /admin means
    // no access at all — /admin has no parent slug to inherit from.
    assertNotSelfLockout(session, page_slug, "none", { role })
    await execute(permissions.deletePagePermission, [role, page_slug])
    return NextResponse.json({ ok: true })
  },
})
