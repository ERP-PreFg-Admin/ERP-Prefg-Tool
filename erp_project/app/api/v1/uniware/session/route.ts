// POST /api/v1/uniware/session — where the "ERP Uniware Session" Chrome
// extension drops the tenant web cookie so the document sweeps can mint tokens.
//
// ── WHY THIS IS NOT A withGateway ROUTE ──────────────────────────────────────
// withGateway requires a NextAuth session. The caller here is an extension popup
// on a chrome-extension:// origin, and NextAuth's cookie is SameSite=Lax, so it
// would not ride along on this cross-site POST. There is no ERP session to check.
//
// ── HOW IT AUTHORISES INSTEAD ────────────────────────────────────────────────
// By USING the cookie before trusting it: isWebCookieValid mints a token against
// a throwaway healthcheck identifier. Only a live Uniware session mints
// successfully, so possessing a working cookie IS the authorization — someone
// without Uniware access cannot produce one. Rate-limited per IP as a floor
// against blind POSTs, and HTTPS is assumed in front (ALB).
//
// SECURITY: the cookie is a live login. It is validated, stored, and never
// logged, never echoed, never returned.

export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { execute } from "@/lib/db"
import { uniwareDocsSql } from "@/lib/queries/uniware-documents"
import { isWebCookieValid } from "@/lib/uniware/document"
import { uniwareEnabled } from "@/lib/uniware"
import { acquire } from "@/lib/gateway/rate-limit"
import logger from "@/lib/logger"

// A cookie refresh is a rare, deliberate act — a handful a day at most. This is
// a floor against a script hammering the mint endpoint, not a real workload gate.
const RULE = { limit: 20, windowMs: 60_000 }

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown"
  const verdict = acquire(`uniware-session:${ip}`, 0, RULE)
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: "Too many requests — try again shortly." }, { status: 429 })
  }

  try {
    if (!uniwareEnabled()) {
      return NextResponse.json({ ok: false, error: "Uniware is not configured on this environment." }, { status: 400 })
    }

    const body = await req.json().catch(() => ({})) as { cookie?: unknown }
    const cookie = typeof body.cookie === "string" ? body.cookie.trim() : ""
    // A pep session is at least IS_LOGIN + JSESSIONID; anything without the
    // latter is not a session at all.
    if (!cookie || !/JSESSIONID=/.test(cookie)) {
      return NextResponse.json({ ok: false, error: "No Uniware session cookie in the request." }, { status: 400 })
    }

    // The authorization step: prove the cookie actually works before storing it.
    const valid = await isWebCookieValid(cookie)
    if (!valid) {
      return NextResponse.json(
        { ok: false, error: "This Uniware session is not valid — sign in to Uniware again, then retry." },
        { status: 400 }
      )
    }

    // Uniware's tenant session runs ~10h; stamp an advisory expiry. Staleness is
    // still ultimately decided by a failed mint, not this value.
    const expiresAt = new Date(Date.now() + 10 * 60 * 60 * 1000)
    await execute(uniwareDocsSql.insertSession, [cookie, expiresAt, "extension"])
    // Keep the table from growing a row per refresh.
    await execute(uniwareDocsSql.pruneSessions, [])

    logger.info({ module: "UNIWARE_DOC", ip, message: "Uniware web session stored via extension" })
    return NextResponse.json({ ok: true })
  } catch (err) {
    // Never include the cookie in the log line.
    logger.error({ module: "UNIWARE_DOC", ip, err: err instanceof Error ? err.message : String(err), message: "Uniware session store failed" })
    return NextResponse.json({ ok: false, error: "Could not store the session." }, { status: 500 })
  } finally {
    verdict.release()
  }
}
