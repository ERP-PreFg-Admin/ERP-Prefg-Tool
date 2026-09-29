/**
 * Manual trigger for the low open-PO alert.
 *   npx tsx --env-file-if-exists=.env scripts/_check-low-open-po.ts [--threshold=N] [--send]
 *
 * Dry run by default: writes low-open-preview.html and mails nobody.
 * --threshold overrides OPEN_QTY_THRESHOLD, for tuning against real data.
 */
import { writeFileSync } from "node:fs"
import { todayIST } from "../lib/date"
import { buildLowOpenRows, runLowOpenReport } from "../lib/reports/low-open-po"
import { renderLowOpenPo, OPEN_QTY_THRESHOLD } from "../lib/reports/low-open-po-html"

const arg = process.argv.find((a) => a.startsWith("--threshold="))
const threshold = arg ? Number(arg.split("=")[1]) : OPEN_QTY_THRESHOLD

async function main() {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`--threshold must be a positive number, got "${arg}"`)
  }
  if (threshold !== OPEN_QTY_THRESHOLD) {
    console.log(`Threshold overridden: ${threshold} (default ${OPEN_QTY_THRESHOLD})`)
  }

  if (process.argv.includes("--send")) {
    console.log(await runLowOpenReport({ module: "MANUAL" }, threshold))
    return
  }

  const rows = await buildLowOpenRows(Date.now(), threshold)
  console.table(rows.map((r) => ({ sku: r.sku_code, mfg: r.mfg_code, open: r.open_qty, state: r.state })))
  writeFileSync("low-open-preview.html", renderLowOpenPo(todayIST(), rows, threshold))
  console.log(`\n${rows.length} pair(s) under ${threshold}. Wrote low-open-preview.html.`)
  console.log("Dry run — nothing was emailed. Pass --send to deliver it.")
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
