/**
 * The scheduled-job trigger, curled hourly by erp-cron.timer on the host.
 *
 * No withGateway: there is no user, session or page slug, so wrapping it would
 * mean minting a session for cron. Its auth is the x-cron-key secret, plus a
 * 503 when that is unset and an nginx `deny all` on the path.
 *
 * Do not add a shortcut that skips the key "for testing".
 */

import crypto from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { jobsDueAt } from "@/lib/cron/jobs"
import logger from "@/lib/logger"

export const runtime = "nodejs"

let running = false

/** Hashed before comparing so two different lengths can't throw out of timingSafeEqual. */
function keyMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest()
  const b = crypto.createHash("sha256").update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_KEY
  if (!expected) {
    logger.error({ module: "CRON", message: "CRON_KEY is not set — refusing to run" })
    return NextResponse.json({ error: "cron_not_configured" }, { status: 503 })
  }

  if (!keyMatches(req.headers.get("x-cron-key") ?? "", expected)) {
    logger.warn({ module: "CRON", message: "Rejected cron trigger — bad key" })
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  if (running) {
    logger.warn({ module: "CRON", message: "Cron run already in progress — refused" })
    return NextResponse.json({ error: "already_running" }, { status: 409 })
  }

  running = true
  const requestId = crypto.randomUUID()
  // Already IST — the container runs TZ=Asia/Kolkata.
  const hour = new Date().getHours()
  const due = jobsDueAt(hour)

  logger.info({ module: "CRON", requestId, hour, due: due.map((j) => j.name), message: "Cron run starting" })

  const results: { name: string; ok: boolean; ms: number; result?: unknown; error?: string }[] = []
  try {
    // Sequential in array order; one job throwing must not cost the rest.
    for (const job of due) {
      const started = Date.now()
      try {
        const result = await job.run({ module: "CRON", requestId, job: job.name })
        const ms = Date.now() - started
        logger.info({ module: "CRON", requestId, job: job.name, ms, result, message: "Cron job finished" })
        results.push({ name: job.name, ok: true, ms, result })
      } catch (err) {
        const ms = Date.now() - started
        const error = err instanceof Error ? err.message : String(err)
        logger.error({ module: "CRON", requestId, job: job.name, ms, err: error, message: "Cron job failed" })
        results.push({ name: job.name, ok: false, ms, error })
      }
    }
  } finally {
    running = false
  }

  return NextResponse.json({ hour, ran: results.length, results })
}
