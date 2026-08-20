import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"

const CHECK = [
  "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME",
  "REGION_AWS", "ACCESS_KEY_ID_AWS", "SECRET_ACCESS_KEY_AWS",
  "S3_BUCKET_FILES_AWS", "S3_BUCKET_EVENTS_AWS",
  "GMAIL_USER", "GMAIL_APP_PASSWORD",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "AUTH_SECRET",
]

// Was completely unauthenticated — any anonymous caller could see which
// secret env vars are configured on this deployment. Gated the same as the
// other admin/settings routes now.
export const GET = withGateway({
  access: { pageSlug: "/settings", level: "editor" },
  handler: async () => {
    const present = Object.fromEntries(CHECK.map((k) => [k, process.env[k] !== undefined]))
    return NextResponse.json(present)
  },
})
