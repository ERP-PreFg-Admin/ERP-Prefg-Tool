// GET /api/v1/uniware/explorer/documents?po=CODE            → list the documents
// GET /api/v1/uniware/explorer/documents?po=CODE&filename=X  → stream that file
//
// The read side of the Uniware document feature, exposed on the PO Explorer so a
// pull can be confirmed against a REAL PO before trusting it in the invoice flow.
// This does NOT store anything — it mints, lists, and (with a filename) streams
// the bytes straight through, which is exactly the download path the sweep uses.
//
// Same access as the rest of the explorer: "/uniware", which is tenant-wide and
// granted per person. Minting needs the stored web session (the extension), so a
// missing/expired one comes back as a clear 400, not a 500.

export const runtime = "nodejs"

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { uniwareEnabled } from "@/lib/uniware"
import { mintCapability, listDocuments, downloadDocument } from "@/lib/uniware/document"
import { UniwareSessionStale } from "@/lib/uniware/web-session"

function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return ext === "pdf" ? "application/pdf"
    : ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : "application/octet-stream"
}

export const GET = withGateway({
  access: { pageSlug: "/uniware", level: "viewer" },
  // A mint plus at most one download per call, against a tenant the warehouse is
  // also using. Looser than the PO sweep (which fans out) but still bounded.
  rateLimit: { limit: 60, windowMs: 10 * 60_000, concurrency: 2 },
  handler: async ({ req }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }
    const po = req.nextUrl.searchParams.get("po")?.trim()
    const filename = req.nextUrl.searchParams.get("filename")?.trim()
    if (!po) throw new ApiError(400, "validation_error", "po is required")

    try {
      const cap = await mintCapability(po)

      if (filename) {
        const buf = await downloadDocument(cap, filename)
        // Inline so a PDF opens in the tab; the sanitised name is only for the
        // download-as fallback, never a path.
        const safe = filename.replace(/["\\\r\n]/g, "_")
        return new Response(new Uint8Array(buf), {
          headers: {
            "Content-Type": contentTypeFor(filename),
            "Content-Disposition": `inline; filename="${safe}"`,
            "Cache-Control": "private, no-store",
          },
        })
      }

      return NextResponse.json({ documents: await listDocuments(cap) })
    } catch (err) {
      if (err instanceof UniwareSessionStale) {
        throw new ApiError(
          400, "uniware_session_stale",
          "No live Uniware session. Open Uniware and click the ERP Uniware Session extension, then try again."
        )
      }
      throw err
    }
  },
})
