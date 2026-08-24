// GET /api/v2/files/preview?key=…
// Parse a bulk-upload CSV/Excel file server-side (reusing the same parser the
// bulk-approval import uses) and return it as headers + rows, so approvers can
// read the file as a table instead of a raw CSV download.
//
// What v2 adds over v1: authorization. v1 checked only that *someone* was
// signed in, then parsed whatever key it was given and returned the contents as
// JSON — every bulk upload ever staged, including vendor rate sheets and cost
// masters, to any authenticated user. v2 gates on the /approvals page (its only
// caller is the approval queue's CSV preview) and, more importantly, on the
// object itself via assertKeyReadable. The old `key.includes("..")` check is
// gone: S3 keys are not filesystem paths, so it could never have fired.
//
// v1 stays live and has had the same guard back-ported — it is a security fix,
// not a version-worthy contract change. Nothing should point at v1 regardless.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertKeyReadable } from "@/lib/s3-guard"
import { parseS3Import } from "@/lib/import-s3"
import logger from "@/lib/logger"

/** Above this the preview stops being a preview. See the comment at the slice. */
const MAX_PREVIEW_ROWS = 5000

export const GET = withGateway({
  access: { pageSlug: "/approvals", level: "viewer" },
  handler: async ({ req, session, ctx }) => {
    const key = req.nextUrl.searchParams.get("key")
    if (!key?.trim()) {
      throw new ApiError(400, "validation_error", "key is required")
    }

    await assertKeyReadable(Number(session.user.id), key)

    try {
      const rows    = await parseS3Import(key)
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = rows.length > MAX_PREVIEW_ROWS
      return NextResponse.json({
        headers,
        rows: truncated ? rows.slice(0, MAX_PREVIEW_ROWS) : rows,
        total: rows.length,
        truncated,
        limit: MAX_PREVIEW_ROWS,
      })
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err
      logger.warn({
        ...ctx, key, err: err instanceof Error ? err.message : String(err),
        message: "Bulk-upload preview could not be parsed",
      })
      throw new ApiError(502, "parse_failed", "Could not read file")
    }
  },
})
