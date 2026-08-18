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
// ── Nanonets (invoice extraction) ────────────────────────────────────────────

export const NANONET_API_KEY = required("NANONET_API_KEY")

// ── Outbound mail ────────────────────────────────────────────────────────────
//
// Two transports live side by side for the Gmail → SES cutover. MAIL_PROVIDER
// picks one at module load; rollback is flipping this value in SSM and
// redeploying, with no code change. See ~/.claude/plans/ses-migration.md.
//
// Once SES has run clean for a full cycle of PO and inward mail, delete
// MAIL_PROVIDER, GMAIL_USER and GMAIL_APP_PASSWORD — here, in lib/mailer.ts,
// and from SSM /erp-app/{test,prod}.

export const MAIL_PROVIDER = process.env.MAIL_PROVIDER === "ses" ? "ses" : "gmail"

// Gmail SMTP — the outgoing transport. Not `required()` any more: once
// MAIL_PROVIDER=ses these are unset, and a missing-var error on every boot would
// train people to ignore the env warnings that still matter.
export const GMAIL_USER         = process.env.GMAIL_USER ?? ""
export const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? ""

// SES. MAIL_FROM must match the ses:FromAddress condition in
// deploy/iam-policy-erp-app-runtime-ses.json exactly — a mismatch is
// AccessDenied on every send, so changing the sender is an IAM change too.
export const MAIL_FROM      = process.env.MAIL_FROM ?? "erp.prefg@mcaffeine.com"
export const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME ?? "mcaffeine ERP"

// Attaches every send to the configuration set whose event destination feeds
// bounce/complaint events to SNS. Without it SES emits no events at all and the
// suppression list stays silently empty.
export const SES_CONFIG_SET = process.env.SES_CONFIG_SET ?? "erp-app"

// Job title printed under the sender's name on inward-invoice emails. The name
// itself comes from whoever filed the invoice, so only the title is configured.
export const MAIL_SIGNATURE_TITLE = process.env.MAIL_SIGNATURE_TITLE ?? "MIS Executive"

// ── Google OAuth ─────────────────────────────────────────────────────────────

export const GOOGLE_CLIENT_ID     = required("GOOGLE_CLIENT_ID")
export const GOOGLE_CLIENT_SECRET = required("GOOGLE_CLIENT_SECRET")

// ── Uniware (Unicommerce) ────────────────────────────────────────────────────
// Optional: if these are unset the app simply doesn't push POs to Uniware
// (see uniwareEnabled() in lib/uniware.ts), rather than failing at boot.

export const UNIWARE_BASE_URL  = process.env.UNIWARE_BASE_URL  ?? ""
export const UNIWARE_USER_NAME = process.env.UNIWARE_USER_NAME ?? ""
export const UNIWARE_PASSWORD  = process.env.UNIWARE_PASSWORD  ?? ""
// Unicommerce's stock public OAuth client — no per-tenant value to configure.
export const UNIWARE_CLIENT_ID = process.env.UNIWARE_CLIENT_ID ?? "my-trusted-client"
// purchaseOrder/create is facility-scoped, so this decides where a PO lands.
// Defaults to the sandbox until the flow is signed off.
export const UNIWARE_FACILITY  = process.env.UNIWARE_FACILITY  ?? "TEST_FACILITY"
// Uniware vendors are configured per facility and are NOT the same identifier
// as master_mfgs.code — falling back to the manufacturer code fails with
// "Vendor [MFG-002-AJA] is not configured for the facility". Until a real
// mfg → vendor mapping exists this pins every push to the sandbox vendor, which
// pairs with UNIWARE_FACILITY above. MUST be overridden before going live, or
// every PO lands against the test vendor.
export const UNIWARE_VENDOR_CODE = process.env.UNIWARE_VENDOR_CODE ?? "Test_Vendor"

// ── App base URL ─────────────────────────────────────────────────────────────
// Used to build absolute links back into the app (e.g. PO links in emails).
// Optional — falls back to localhost so a missing var only breaks link
// correctness, not the feature using it.

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"


// ── Nanonets quota ───────────────────────────────────────────────────────────
// The monthly call allowance from the Nanonets billing page. 0 (the default)
// disables the guard entirely, so this ships before the number is known.
export const NANONETS_MONTHLY_CALLS = Number(process.env.NANONETS_MONTHLY_CALLS ?? 0)

// A 20-working-day month at full tilt. Deriving the daily cap rather than
// configuring it means one runaway day can burn at most ~5% of the month.
export const NANONETS_DAILY_CALLS = Math.floor(NANONETS_MONTHLY_CALLS / 20)