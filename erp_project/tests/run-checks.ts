// Runs the ad-hoc `scripts/_check-*.ts` verification scripts in one command.
//
//   npm run test:checks         pure checks only (no DB, no network)
//   npm run test:checks -- --db adds the ones that query the database
//
// These scripts predate tests/ and are deliberately left as they are — they
// already work. This only gives them a single entry point so they get run
// instead of quietly rotting. New assertions belong in tests/ (node:test).
//
// This file lives in tests/, NOT scripts/, because `.gitignore` has `/scripts/*`
// — anything new added there is silently untracked, so a runner placed beside the
// checks would never reach CI or another developer's clone.
//
// A listed script that isn't present is SKIPPED, not failed, for the same reason:
// some `_check-*` files are gitignored and so exist only on the machine that
// wrote them. See docs/qa-audit-2026-08.md #12.
//
// Scripts needing an external service (Uniware, Nanonets, the SKU data
// warehouse) are listed under EXTERNAL and never run here: they are metered,
// slow, and fail for reasons that have nothing to do with our code.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

/** No DB, no network — safe anywhere, including CI. */
const PURE = [
  "_check-admin-authority",
  "_check-po-status-filter",
  "_check-invoice-mapping",
  "_check-backdated-po",
  "_check-inward-mail-summary",
  "_check-inward-sequence",
]

/** Query the application database. Need .env and network reachability. */
const DB = [
  "_check-role-taxonomy",
  "_check-entity-scope",
  "_check-admin-panel",
  "_check-inward-count",
]

/** Hit a third-party API or the DWH. Run these by hand when touching that code. */
const EXTERNAL = ["_check-uniware-push", "_check-uniware-po-pdf", "_check-sku-dedup"]

const includeDb = process.argv.includes("--db")
const scripts = includeDb ? [...PURE, ...DB] : PURE

const failed: string[] = []
const missing: string[] = []

for (const name of scripts) {
  const path = `scripts/${name}.ts`
  if (!existsSync(path)) {
    console.log(`${name.padEnd(32)} SKIP (not in this checkout)`)
    missing.push(name)
    continue
  }

  process.stdout.write(`${name.padEnd(32)} `)
  // node --import tsx, rather than spawning npx through a shell: no shell means
  // no argument-escaping hazard (and no DEP0190 warning), and it skips npx's
  // per-invocation resolution, which dominates the runtime of short checks.
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--env-file-if-exists=.env", path],
    { encoding: "utf8" }
  )
  if (res.status === 0) {
    console.log("PASS")
  } else {
    console.log("FAIL")
    failed.push(name)
    // Only the tail — these scripts are chatty on success and the useful part of
    // a failure is the assertion at the end.
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd().split("\n").slice(-12)
    for (const line of output) console.log(`    ${line}`)
  }
}

if (!includeDb) console.log(`\n(skipped ${DB.length} DB checks — pass --db to include them)`)
console.log(`(never run here: ${EXTERNAL.join(", ")} — external services)`)
if (missing.length > 0) {
  console.log(`(not in this checkout, likely gitignored: ${missing.join(", ")})`)
}

if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed: ${failed.join(", ")}`)
  process.exit(1)
}
console.log(`\nAll ${scripts.length - missing.length} available checks passed.`)
