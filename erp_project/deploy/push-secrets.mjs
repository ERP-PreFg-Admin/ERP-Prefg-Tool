#!/usr/bin/env node
// Pushes the app's runtime secrets from erp_project/.env into SSM Parameter Store
// under /erp-app/<env>/<KEY>, for whichever env ("test" or "prod") is passed as argv[2].
//
// Written in Node (not bash) deliberately: this repo's .env has previously had
// stray whitespace/quoting around values (e.g. `KEY= "value"`, a trailing space
// after a closing quote) that broke naive shell `source`/sed-based parsing and
// silently corrupted a pushed secret. A small regex parser here is more robust
// and easier to get right than fighting shell quoting.
//
// Usage: node deploy/push-secrets.mjs <test|prod>

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const envName = process.argv[2]
if (envName !== "test" && envName !== "prod") {
  console.error("Usage: node deploy/push-secrets.mjs <test|prod>")
  process.exit(1)
}

const REGION = "ap-south-1"
const AUTH_URL = envName === "prod" ? "https://erp.mcaffeine.com" : "https://dev.erp.mcaffeine.com"

// Keys mirrored from lib/env.ts + AUTH_URL/AUTH_SECRET (read directly by NextAuth,
// not through lib/env.ts) + the Uniware vars used elsewhere via process.env directly.
// DB_NAME is deliberately excluded here — it's env-specific (DB_NAME_TEST /
// DB_NAME_PROD in .env), handled separately below. DB_HOST/DB_USER/DB_PASSWORD
// and the SKU DB creds (same host, separate schema — see lib/db-sku.ts) are
// shared across both environments.
const KEYS = [
  "DB_HOST", "DB_USER", "DB_PASSWORD",
  "DB_USER_SKU", "DB_USER_SKU_PASSWORD", "DB_USER_NAME_SKU",
  "AUTH_SECRET",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GMAIL_USER", "GMAIL_APP_PASSWORD",
  "REGION_AWS", "ACCESS_KEY_ID_AWS", "SECRET_ACCESS_KEY_AWS",
  "S3_BUCKET_FILES_AWS", "S3_BUCKET_EVENTS_AWS",
  "UNIWARE_BASE_URL", "UNIWARE_USER_NAME", "UNIWARE_PASSWORD",
  "NANONET_API_KEY",
]
// Deliberately NOT pushed: UNIWARE_FACILITY and UNIWARE_VENDOR_CODE. They're
// sandbox values (TEST_FACILITY / Test_Vendor) that belong in a local .env only
// — pushing them would point the deployed app at the test facility. Add them
// here once the real facility and mfg -> vendor mapping are settled.

function parseEnvFile(filePath) {
  const text = readFileSync(filePath, "utf8")
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    // Strip one layer of surrounding quotes (handles stray leading/trailing
    // whitespace around the quotes too, e.g. `KEY= "value" `).
    let value = rawValue.trim()
    const quoted = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/)
    if (quoted) value = quoted[1]
    values[key] = value
  }
  return values
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const envValues = parseEnvFile(path.join(projectRoot, ".env"))

// lib/env.ts picks DB_NAME_TEST vs DB_NAME_PROD based on APP_ENV (NODE_ENV can't
// be used for this -- the Docker image hardcodes NODE_ENV=production for every
// deployed container). Push APP_ENV plus whichever raw key name the code expects,
// under its literal name (not a renamed "DB_NAME") so lib/env.ts's own lookup finds it.
const APP_ENV = envName === "prod" ? "prod" : "test"
const dbNameKey = envName === "prod" ? "DB_NAME_PROD" : "DB_NAME_TEST"
const dbNameValue = envValues[dbNameKey]

const toPush = {
  ...Object.fromEntries(KEYS.map((k) => [k, envValues[k]])),
  [dbNameKey]: dbNameValue,
  APP_ENV,
  AUTH_URL,
}

const missing = Object.entries(toPush).filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`Missing values for: ${missing.join(", ")} — check .env`)
  process.exit(1)
}

console.log(`Pushing ${Object.keys(toPush).length} parameters to /erp-app/${envName}/* ...`)
for (const [key, value] of Object.entries(toPush)) {
  const name = `/erp-app/${envName}/${key}`
  try {
    execFileSync("aws", [
      "ssm", "put-parameter",
      "--region", REGION,
      "--name", name,
      "--value", value,
      "--type", "SecureString",
      "--overwrite",
    ], { stdio: ["ignore", "ignore", "inherit"] })
    console.log(`  ok    ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    process.exitCode = 1
  }
}
