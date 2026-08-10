// GET /api/v1/files/presign?key=…[&view=1][&expiresIn=…]
//
// Mints a short-lived S3 URL for one object. Shared by every screen that shows a
// document — approvals, PO tracking, invoice history, Recipe artifacts, the masters
// dialogs — so it carries no `access` page rule: no single page slug fits, and
// the object-level check in assertKeyReadable is the stronger gate anyway. It
// authorizes the *object*, not merely the session.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertKeyReadable } from "@/lib/s3-guard"
import { getPresignedDownloadUrl, getPresignedViewUrl } from "@/lib/s3"

export const GET = withGateway({
  handler: async ({ req, session }) => {
    const key = req.nextUrl.searchParams.get("key")
    if (!key?.trim()) {
      return NextResponse.json({ error: "key is required" }, { status: 400 })
    }

    // Throws 403 unless the key belongs to a row this user can see, or they
    // uploaded it themselves. Replaces a `key.includes("..")` check that could
    // never have caught anything — S3 keys are not paths.
    await assertKeyReadable(Number(session.user.id), key)

    const expiresInParam = req.nextUrl.searchParams.get("expiresIn")
    const expiresIn = expiresInParam ? Math.min(Math.max(parseInt(expiresInParam), 60), 3600) : 300

    const view = req.nextUrl.searchParams.get("view") === "1"

    try {
      const url = view
        ? await getPresignedViewUrl(key, expiresIn)
        : await getPresignedDownloadUrl(key, expiresIn)
      return NextResponse.json({ url, expiresIn })
    } catch (err: unknown) {
      console.error("[presign] failed key=%s", key, err)
      return NextResponse.json({ error: "Could not generate URL" }, { status: 500 })
    }
  },
})
