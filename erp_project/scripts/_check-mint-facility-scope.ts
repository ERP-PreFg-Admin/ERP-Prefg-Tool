/**
 * THE PRE-GATE: is the document mint facility-scoped?
 *
 * fetchPurchaseOrderPdf now moves the shared web session's facility on every
 * fetch. The document sync mints on that same session — if minting only works
 * for the session's own facility, the mail change breaks the sync silently.
 *
 *   npx tsx --env-file=.env scripts/_check-mint-facility-scope.ts <UNIWARE_PO_CODE>
 *
 * Run it with the session parked SOMEWHERE ELSE than that PO's facility:
 *   1. switch the browser to GGN_WAREHOUSE
 *   2. re-send the cookie with the ERP Uniware Session extension
 *   3. run this with a MUMBAI PO code
 *
 * No args lists candidate codes and exits.
 */

import { query } from "../lib/db"
import { mintCapability, listDocuments } from "../lib/uniware"

async function main() {
  const code = process.argv[2]

  if (!code) {
    const rows = await query<{ uniware_po_code: string; destination: string; invoice_no: string }>(
      `SELECT uniware_po_code, destination, invoice_no
         FROM invoice_mfg
        WHERE uniware_po_code IS NOT NULL AND uniware_po_code <> ''
        ORDER BY id DESC LIMIT 15`, []
    )
    console.log("Pass one of these as the argument:\n")
    for (const r of rows) console.log(`  ${r.uniware_po_code.padEnd(24)} ${r.destination}  (${r.invoice_no})`)
    return
  }

  console.log(`Minting for ${code} — the session should currently be on a DIFFERENT facility.\n`)

  const cap = await mintCapability(code)
  console.log(`mint    OK   docsHost=${cap.docsHost}`)

  // The mint alone proves little: it succeeds for identifiers no PO uses
  // (verified 2026-09-01). The list is the real test.
  const docs = await listDocuments(cap)
  console.log(`list    ${docs.length} document(s)`)
  for (const d of docs) console.log(`        ${d.fileName}  ${d.uploadedBy ?? "?"}  ${d.created ?? "?"}`)

  console.log(
    docs.length > 0
      ? "\nVERDICT: not facility-scoped — the mail change is safe for the doc sync."
      : "\nVERDICT: INCONCLUSIVE. Empty could mean facility-scoped, or a PO with no documents.\n" +
        "         Re-run with the session switched TO that PO's facility. Documents there and\n" +
        "         none here means it IS scoped, and the sync needs its own switch."
  )
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
  .finally(() => process.exit())
