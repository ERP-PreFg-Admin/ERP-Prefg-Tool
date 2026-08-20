// Extraction evidence pass — runs real sample invoices through the real
// pipeline and reports what came back, so per-manufacturer strategies can be
// written from what actually fails instead of from guesswork.
//
// This is the missing half of the profiles work. tests/_check-invoice-detect.ts
// answers "does detection resolve the seller?" (free, local). This one answers
// "does the BASE extraction get the fields right for that seller?" — which is
// the only thing that justifies adding an entry to STRATEGIES.
//
//   docs/superpowers/specs/2026-08-07-per-manufacturer-extraction-profiles.md
//   "The registry starts empty and gains an entry only where a sample proves
//    the base rules fail."
//
// ⚠️ COSTS MONEY AND TIME. Each invoice is a real Nanonets extraction: ~50-70s
// and one API call. All 15 is ~15 minutes. Default is therefore ONE invoice —
// pass --all deliberately.
//
// Raw responses are written to .invoice-samples/<folder>.json (gitignored, see
// below) so a profile can be written against the actual output later without
// paying for extraction again.
//
// Run:
//   npx tsx --env-file-if-exists=.env tests/_check-invoice-extract.ts
//   npx tsx --env-file-if-exists=.env tests/_check-invoice-extract.ts --folder "REVE PHARMA"
//   npx tsx --env-file-if-exists=.env tests/_check-invoice-extract.ts --all

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { detectFromPdf } from "../lib/invoice/invoice-detect"
import { parseInvoice, strategyFor, configFor } from "../lib/nanonets"
import type { ParsedInvoice } from "../types/invoice"

const SAMPLES = resolve(process.cwd(), "..", "Invoices")
const OUT = resolve(process.cwd(), ".invoice-samples")

/** The fields a profile would exist to fix. Reported per invoice as present or
 *  missing — a column of blanks across every supplier means the BASE prompt is
 *  wrong, not that eleven suppliers each need a profile. */
const HEADER_FIELDS = [
  "invoice_number", "date", "from", "seller_gstin", "total_amount",
] as const

const LINE_FIELDS = [
  "sku_code", "sku_name", "qty", "rate", "amount", "total_amount", "mrp", "discount", "gst_percent",
] as const

type Report = {
  folder: string
  file: string
  strategy: string
  detected: string | null
  ms: number
  error?: string
  header: Record<string, boolean>
  lines: number
  /** Per line-field: how many of the invoice's lines had a non-null value. */
  lineFill: Record<string, string>
  sumMatches: string
}

function samplesIn(root: string) {
  const out: { folder: string; path: string }[] = []
  for (const e of readdirSync(root)) {
    const d = join(root, e)
    if (!statSync(d).isDirectory()) continue
    for (const f of readdirSync(d)) {
      if (f.toLowerCase().endsWith(".pdf")) out.push({ folder: e, path: join(d, f) })
    }
  }
  return out
}

/**
 * Does the sum of the line amounts reconcile with the stated invoice total?
 *
 * The spec found one invoice where the ratio was exactly 1.18 — GST applied
 * once in the footer rather than per line, so null line-level tax fields were
 * *correct output*, not an extraction failure. Reporting the ratio makes that
 * distinction visible instead of leaving it to be rediscovered per supplier.
 */
function reconcile(p: ParsedInvoice): string {
  const sum = p.line_items.reduce((s, l) => s + (Number(l.total_amount ?? l.amount ?? 0) || 0), 0)
  if (!p.total_amount || !sum) return "—"
  const ratio = p.total_amount / sum
  if (Math.abs(ratio - 1) < 0.005) return "exact"
  // Common Indian GST slabs, applied once at the footer.
  for (const gst of [1.05, 1.12, 1.18, 1.28]) {
    if (Math.abs(ratio - gst) < 0.005) return `+${Math.round((gst - 1) * 100)}% GST in footer`
  }
  return `ratio ${ratio.toFixed(4)}`
}

async function run(folder: string, path: string): Promise<Report> {
  const buffer = readFileSync(path)
  const file = path.split(/[\\/]/).pop()!
  const started = Date.now()

  const { gstins, mfg } = await detectFromPdf(buffer)
  const strategy = strategyFor(gstins)

  const base: Omit<Report, "header" | "lines" | "lineFill" | "sumMatches"> = {
    folder, file,
    strategy: strategy ? strategy.label : "(base)",
    detected: mfg ? `${mfg.code} — ${mfg.name}` : null,
    ms: 0,
  }

  try {
    const parsed = await parseInvoice(buffer, file, configFor(strategy))
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${folder.replace(/[^\w.-]+/g, "_")}.json`),
      JSON.stringify({ folder, file, gstins, detected: mfg, parsed }, null, 2))

    const n = parsed.line_items.length
    const lineFill: Record<string, string> = {}
    for (const f of LINE_FIELDS) {
      const got = parsed.line_items.filter((l) => (l as Record<string, unknown>)[f] != null).length
      lineFill[f] = n === 0 ? "—" : got === n ? "all" : got === 0 ? "none" : `${got}/${n}`
    }

    return {
      ...base,
      ms: Date.now() - started,
      header: Object.fromEntries(
        HEADER_FIELDS.map((f) => [f, (parsed as Record<string, unknown>)[f] != null])
      ),
      lines: n,
      lineFill,
      sumMatches: reconcile(parsed),
    }
  } catch (err: unknown) {
    return {
      ...base,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      header: {}, lines: 0, lineFill: {}, sumMatches: "—",
    }
  }
}

async function main() {
  if (!existsSync(SAMPLES)) {
    console.log(`No samples at ${SAMPLES} — nothing to check.`)
    process.exit(0)
  }

  const all = samplesIn(SAMPLES)
  const folderArg = process.argv.includes("--folder")
    ? process.argv[process.argv.indexOf("--folder") + 1]
    : null
  const runAll = process.argv.includes("--all")

  let picked = all
  if (folderArg) picked = all.filter((s) => s.folder.toLowerCase().includes(folderArg.toLowerCase()))
  else if (!runAll) picked = all.slice(0, 1)

  if (picked.length === 0) {
    console.log(`No sample matched --folder "${folderArg}". Available:`)
    for (const s of all) console.log(`  ${s.folder}`)
    process.exit(0)
  }

  console.log(`Extracting ${picked.length} of ${all.length} invoice(s). ~50-70s each — this calls Nanonets.`)
  if (!runAll && !folderArg) console.log("Pass --all to do every sample, or --folder <name> for one.\n")

  const reports: Report[] = []
  for (const [i, s] of picked.entries()) {
    process.stdout.write(`  [${i + 1}/${picked.length}] ${s.folder} … `)
    const r = await run(s.folder, s.path)
    reports.push(r)
    console.log(r.error ? `FAILED (${Math.round(r.ms / 1000)}s)` : `${r.lines} lines, ${Math.round(r.ms / 1000)}s`)
  }

  console.log("\n── Header fields ──")
  console.log("folder".padEnd(34) + HEADER_FIELDS.map((f) => f.slice(0, 12).padEnd(14)).join("") + "total ratio")
  for (const r of reports) {
    if (r.error) { console.log(r.folder.slice(0, 33).padEnd(34) + `ERROR: ${r.error.slice(0, 60)}`); continue }
    console.log(
      r.folder.slice(0, 33).padEnd(34) +
      HEADER_FIELDS.map((f) => (r.header[f] ? "ok" : "MISSING").padEnd(14)).join("") +
      r.sumMatches
    )
  }

  console.log("\n── Line-item fill (how many lines carried each field) ──")
  console.log("folder".padEnd(34) + LINE_FIELDS.map((f) => f.slice(0, 10).padEnd(12)).join(""))
  for (const r of reports) {
    if (r.error) continue
    console.log(
      r.folder.slice(0, 33).padEnd(34) +
      LINE_FIELDS.map((f) => (r.lineFill[f] ?? "—").padEnd(12)).join("")
    )
  }

  // A field empty on EVERY supplier is a base-prompt problem. A field empty on
  // one is what a profile is for. Saying which is the whole point of the run.
  const ok = reports.filter((r) => !r.error)
  if (ok.length > 1) {
    const alwaysEmpty = LINE_FIELDS.filter((f) => ok.every((r) => r.lineFill[f] === "none" || r.lineFill[f] === "—"))
    const sometimes = LINE_FIELDS.filter((f) =>
      !alwaysEmpty.includes(f) && ok.some((r) => r.lineFill[f] === "none"))
    console.log("")
    if (alwaysEmpty.length) {
      console.log(`Empty on EVERY supplier -> fix the BASE prompt/schema, not a profile: ${alwaysEmpty.join(", ")}`)
    }
    if (sometimes.length) {
      console.log(`Empty on SOME suppliers -> candidates for a per-manufacturer profile: ${sometimes.join(", ")}`)
    }
    if (!alwaysEmpty.length && !sometimes.length) {
      console.log("Every line field populated on every supplier — no profile is justified yet.")
    }
  }

  console.log(`\nRaw responses written to ${OUT}`)
  process.exit(0)
}

main()
