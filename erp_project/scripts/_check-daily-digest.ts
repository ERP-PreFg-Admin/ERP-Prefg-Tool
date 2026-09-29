/**
 * Manual trigger for the ops digest.
 *   npx tsx --env-file-if-exists=.env scripts/_check-daily-digest.ts [YYYY-MM-DD] [--send]
 *
 * Dry run by default: writes digest-preview.html and mails nobody.
 * Not in tests/run-checks.ts — it can send email.
 */

import { writeFileSync } from "node:fs"
import { buildDigestData, runDailyDigest } from "../lib/reports/daily-digest"
import { renderDigest } from "../lib/reports/digest-html"
import { todayIST } from "../lib/date"

const args = process.argv.slice(2)
const send = args.includes("--send")
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? todayIST()

async function main() {
  if (send) {
    console.log(`Sending the digest for ${day} to the 'report' recipients on file...`)
    console.log(await runDailyDigest({ module: "MANUAL" }, day))
    return
  }

  const data = await buildDigestData({ module: "MANUAL" }, day)
  const failed = Object.entries(data).filter(([, v]) => v && typeof v === "object" && "ok" in v && !v.ok)

  console.log(JSON.stringify(data, null, 2))
  writeFileSync("digest-preview.html", renderDigest(data))
  console.log(`\nWrote digest-preview.html — open it in a browser.`)
  console.log(failed.length === 0
    ? "All sections loaded."
    : `FAILED sections: ${failed.map(([k]) => k).join(", ")}`)
  console.log("Dry run — nothing was emailed. Pass --send to deliver it.")
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
