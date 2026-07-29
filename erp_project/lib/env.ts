/**
 * Central environment configuration.
 *
 * Env vars are read here at module load time. On Amplify Hosting Compute the
 * whole app runs as one shared Lambda across all routes, so throwing here
 * would crash cold start for every route -- including ones that never touch
 * the missing var. Instead we warn and fall back to an empty string, so a
 * single misconfigured var only breaks the feature that actually uses it.
 *
 * Usage:
 *   import { DB_HOST, AWS_REGION, GMAIL_USER } from "@/lib/env"
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[env] Missing environment variable: ${name}`)
    return ""
  }
  return value
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export const NODE_ENV = process.env.NODE_ENV ?? "development"

// ── Database (MariaDB / AWS RDS) ─────────────────────────────────────────────
// DB_NAME is split into a dev/prod schema pair; pick the right one for APP_ENV.
// NODE_ENV can't be used for this -- the Docker image hardcodes NODE_ENV=production
// for every deployed container (test and prod alike), so it can't distinguish which
// environment is actually running. APP_ENV ("test" | "prod") is set explicitly per
// deployment instead (see deploy/push-secrets.mjs).

export const APP_ENV      = process.env.APP_ENV === "prod" ? "prod" : "test"
export const DB_HOST      = required("DB_HOST")
export const DB_PORT      = Number(process.env.DB_PORT ?? 3306)
export const DB_USER      = required("DB_USER")
export const DB_PASSWORD  = required("DB_PASSWORD")
export const DB_NAME      = required(APP_ENV === "prod" ? "DB_NAME_PROD" : "DB_NAME_TEST")
export const DB_POOL_SIZE = Number(process.env.DB_POOL_SIZE ?? 10)

// ── Database (SKU data warehouse — separate schema/credentials, same host) ──

export const DB_USER_SKU          = required("DB_USER_SKU")
export const DB_USER_SKU_PASSWORD = required("DB_USER_SKU_PASSWORD")
export const DB_NAME_SKU          = required("DB_USER_NAME_SKU")

// ── AWS S3 ───────────────────────────────────────────────────────────────────

export const AWS_REGION            = required("REGION_AWS")
export const AWS_ACCESS_KEY_ID     = required("ACCESS_KEY_ID_AWS")
export const AWS_SECRET_ACCESS_KEY = required("SECRET_ACCESS_KEY_AWS")
export const AWS_S3_BUCKET_FILES   = required("S3_BUCKET_FILES_AWS")
export const AWS_S3_BUCKET_EVENTS  = required("S3_BUCKET_EVENTS_AWS")
// ── Gmail SMTP ───────────────────────────────────────────────────────────────

export const GMAIL_USER         = required("GMAIL_USER")
export const GMAIL_APP_PASSWORD = required("GMAIL_APP_PASSWORD")

// ── Google OAuth ─────────────────────────────────────────────────────────────

export const GOOGLE_CLIENT_ID     = required("GOOGLE_CLIENT_ID")
export const GOOGLE_CLIENT_SECRET = required("GOOGLE_CLIENT_SECRET")

// ── App base URL ─────────────────────────────────────────────────────────────
// Used to build absolute links back into the app (e.g. PO links in emails).
// Optional — falls back to localhost so a missing var only breaks link
// correctness, not the feature using it.

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
