import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { parseS3Import } from "@/lib/import-s3"

/** Parses a bulk-upload CSV/Excel file server-side (reusing the same
 *  parser the bulk-approval import uses) and returns it as headers + rows,
 *  so approvers can view the file as a table instead of opening a raw CSV
 *  download that isn't legible to non-technical reviewers. */
export const GET = withGateway({
  handler: async ({ req }) => {
    const key = req.nextUrl.searchParams.get("key")
    if (!key?.trim()) {
      return NextResponse.json({ error: "key is required" }, { status: 400 })
    }
    if (key.includes("..")) {
      return NextResponse.json({ error: "Invalid key" }, { status: 400 })
    }

    try {
      const rows    = await parseS3Import(key)
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      return NextResponse.json({ headers, rows })
    } catch (err) {
      console.error("[files/preview] failed key=%s", key, err)
      return NextResponse.json({ error: "Could not read file" }, { status: 500 })
    }
  },
})
