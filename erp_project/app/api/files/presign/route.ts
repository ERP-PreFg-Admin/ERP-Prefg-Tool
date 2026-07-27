import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getPresignedDownloadUrl, getPresignedViewUrl } from "@/lib/s3"

export const GET = withGateway({
  handler: async ({ req }) => {
  const key = req.nextUrl.searchParams.get("key")
  if (!key?.trim()) {
    return NextResponse.json({ error: "key is required" }, { status: 400 })
  }
  if (key.includes("..")) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 })
  }

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
