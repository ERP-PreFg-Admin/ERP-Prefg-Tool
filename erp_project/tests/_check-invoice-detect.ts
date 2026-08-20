// Invoice detection baseline — what GSTIN detection actually does on real
// supplier invoices, before any extraction strategy is written for them.
//
// docs/superpowers/specs/2026-08-07-per-manufacturer-extraction-profiles.md
// blocked its Step 0 on sample invoices. This reads them and answers the three
// questions that decide whether a per-manufacturer profile is even reachable:
//
//   1. Does the PDF have a text layer at all? No text -> no GSTIN -> detection
//      can never fire for that supplier, so no strategy can ever apply.
//   2. Does the seller's GSTIN resolve to a manufacturer? An unmapped GSTIN is
//      a one-row data fix (details_mfg.gst_number), not a code change.
//   3. Which GSTIN wins? Every invoice carries at least two — the supplier's
//      and PEP's. lookupMfgByGstin takes the first that matches a manufacturer,
//      which is only correct because PEP isn't in master_mfgs. The full list is
//      printed so a wrong-match is visible rather than silent.
//
// Local only: ~190ms of PDF text extraction per file plus one DB lookup. No
// Nanonets calls, no API spend.
//
// The samples live OUTSIDE the repo (ERP Project\Invoices\) on purpose — they
// are real supplier documents carrying rates and quantities. This skips
// cleanly when the folder isn't there, so it never fails on another machine.
//
// Run:  npx tsx --env-file-if-exists=.env tests/_check-invoice-detect.ts [dir]

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { findGstins, extractPdfText, lookupMfgByGstin } from "../lib/invoice/invoice-detect"
import { panOf } from "../lib/invoice/gstin"

const DEFAULT_DIR = resolve(process.cwd(), "..", "Invoices")

type Verdict = "ok" | "NO TEXT LAYER" | "ONLY BUYER GSTIN" | "GSTIN NOT IN DB" | "NO GSTIN FOUND"

/**
 * A GSTIN appearing on invoices from several different suppliers is ours, not
 * theirs — the buyer is the one party present on every document. Detected by
 * frequency rather than hardcoded, so this keeps working if PEP registers in
 * another state or the group invoices under a second entity.
 *
 * This matters because `lookupMfgByGstin` cannot tell buyer from seller: it
 * takes the first GSTIN that matches ANY manufacturer. A file whose only
 * extractable GSTIN is the buyer's is a text-layer problem, and "add this GSTIN
 * to details_mfg" would be exactly the wrong fix — it would make every invoice
 * resolve to that manufacturer.
 */
function buyerGstins(perFile: { folder: string; gstins: string[] }[]): Set<string> {
  const folders = new Map<string, Set<string>>()
  for (const { folder, gstins } of perFile) {
    for (const g of gstins) {
      if (!folders.has(g)) folders.set(g, new Set())
      folders.get(g)!.add(folder)
    }
  }

  // Seen under two or more supplier folders => not a supplier's own number.
  const repeated = [...folders.entries()].filter(([, f]) => f.size > 1).map(([g]) => g)

  // Then widen to the PAN. A GSTIN is <2-digit state><10-char PAN><entity>Z<check>,
  // so the same company in a different state differs only in the first two
  // characters. Without this, a buyer registration that happens to appear on
  // just one sample reads as an unmapped supplier and invites exactly the wrong
  // "add it to details_mfg" fix.
  const buyerPans = new Set(repeated.map(panOf))

  return new Set(
    [...folders.keys()].filter((g) => buyerPans.has(panOf(g)))
  )
}

type Row = {
  folder: string
  file: string
  chars: number
  gstins: string[]
  matched: string | null
  verdict: Verdict
}

/** Every PDF one level down, as (folder, fullPath). Folder name is the
 *  manufacturer the file is *claimed* to belong to — the point of the run is
 *  checking that claim against what the PDF itself says. */
function findSamples(root: string): { folder: string; path: string }[] {
  const out: { folder: string; path: string }[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().endsWith(".pdf")) out.push({ folder: entry, path: join(dir, f) })
    }
  }
  return out
}

function truncate(s: string, n: number) {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + "…"
}

async function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIR

  if (!existsSync(root)) {
    console.log(`No samples at ${root} — nothing to check.`)
    console.log("Pass a folder as the first argument if they live elsewhere.")
    process.exit(0)
  }

  const samples = findSamples(root)
  if (samples.length === 0) {
    console.log(`No PDFs under ${root}.`)
    process.exit(0)
  }

  console.log(`Reading ${samples.length} invoice(s) from ${root}\n`)

  // Text pass first, so buyer GSTINs can be identified across the whole set
  // before any single file is judged.
  const scanned: { folder: string; file: string; text: string; gstins: string[] }[] = []
  for (const { folder, path } of samples) {
    const text = await extractPdfText(readFileSync(path))
    scanned.push({ folder, file: path.split(/[\\/]/).pop()!, text, gstins: findGstins(text) })
  }
  const buyers = buyerGstins(scanned)

  const rows: Row[] = []
  for (const s of scanned) {
    // Only ask the DB when there's something to ask about.
    const mfg = s.gstins.length ? await lookupMfgByGstin(s.gstins) : null
    const sellerCandidates = s.gstins.filter((g) => !buyers.has(g))

    const verdict: Verdict =
      s.text.trim().length === 0     ? "NO TEXT LAYER"
      : s.gstins.length === 0        ? "NO GSTIN FOUND"
      : mfg                          ? "ok"
      : sellerCandidates.length === 0 ? "ONLY BUYER GSTIN"
      :                                "GSTIN NOT IN DB"

    rows.push({
      folder: s.folder,
      file: s.file,
      chars: s.text.length,
      gstins: s.gstins,
      matched: mfg ? `${mfg.code} — ${mfg.name}` : null,
      verdict,
    })
  }

  console.log(
    truncate("folder", 34) + truncate("file", 30) +
    "chars".padStart(6) + "  gst  " + truncate("matched", 22) + "verdict"
  )
  console.log("-".repeat(110))
  for (const r of rows) {
    console.log(
      truncate(r.folder, 34) + truncate(r.file, 30) +
      String(r.chars).padStart(6) + "  " + String(r.gstins.length).padStart(3) + "  " +
      truncate(r.matched ?? "—", 22) + r.verdict
    )
  }

  const by = (v: Verdict) => rows.filter((r) => r.verdict === v).length
  console.log(
    `\n${by("ok")} detected · ${by("GSTIN NOT IN DB")} unmapped · ` +
    `${by("ONLY BUYER GSTIN")} seller GSTIN not in text · ` +
    `${by("NO TEXT LAYER")} no text layer · ${by("NO GSTIN FOUND")} no GSTIN`
  )

  if (buyers.size) {
    console.log(`\nTreated as OUR GSTINs (each seen under >1 supplier folder): ${[...buyers].join(", ")}`)
  }

  // A folder whose matched manufacturer doesn't look like its own name is the
  // interesting failure — detection "worked" but picked the wrong party, most
  // likely the buyer. Loose comparison on purpose: folders carry full legal
  // names ("CHERYL LABORATORIES PRIVATE LIMITED"), the DB carries short ones.
  const suspicious = rows.filter((r) => {
    if (!r.matched) return false
    const name = r.matched.split("—")[1]?.trim().toLowerCase() ?? ""
    return name.length > 2 && !r.folder.toLowerCase().includes(name.split(/\s+/)[0])
  })
  if (suspicious.length) {
    console.log("\nMatched a manufacturer whose name doesn't resemble the folder:")
    for (const r of suspicious) console.log(`  ${r.folder}  ->  ${r.matched}`)
  }

  const unmapped = rows.filter((r) => r.verdict === "GSTIN NOT IN DB")
  if (unmapped.length) {
    console.log("\nSeller GSTIN present but no manufacturer claims it — a DATA fix:")
    for (const r of unmapped) {
      console.log(`  ${r.folder}: ${r.gstins.filter((g) => !buyers.has(g)).join(", ")}`)
    }
    console.log("  UPDATE details_mfg SET gst_number = '<seller gstin>' WHERE mfg_id = <id>;")
  }

  const buyerOnly = rows.filter((r) => r.verdict === "ONLY BUYER GSTIN")
  if (buyerOnly.length) {
    console.log("\nOnly OUR GSTIN is extractable — a TEXT-LAYER problem, not a data one:")
    for (const r of buyerOnly) console.log(`  ${r.folder}: ${r.gstins.join(", ")}`)
    console.log("  Do NOT add these to details_mfg: they are ours, and every invoice")
    console.log("  carries them, so any manufacturer holding one would match everything.")
    console.log("  The seller's number is in an image or a glyph-encoded font here;")
    console.log("  detection cannot fire without OCR.")
  }

  process.exit(0)
}

main()
