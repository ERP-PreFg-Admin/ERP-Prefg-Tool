// Usage: npx tsx --env-file=.env tests/sim-po-bulk.ts <file.csv>   (dev schema; everything rolled back)
// Runs every row of po_bulk_full_test.csv through the browser checks, the upload
// checks and the approval step (rolled back), and compares with its expect column.
import { readFileSync } from "node:fs"
import { parseCSV, isFlagged, rowRemark, type ParsedRow } from "../components/masters/field-config"
import { PO_BULK_CSV_FIELDS } from "../app/po-tracking/po-procurement/po-bulk-fields"
import { priceBulkRows } from "../lib/po/po-bulk-pricing"
import { createBulkPoRow } from "../lib/approvals/handlers/purchase-orders"
import { makePoRateResolver } from "../lib/po/po-rate"
import { withRollback, anchors, closePool } from "./helpers/db"
import { query } from "../lib/db"

const text = readFileSync(process.argv[2], "utf8")
// The expect cell is "CODE[@Warehouse] optional description"; only the first word is compared.
const expects = text.trim().split(/\r?\n/).slice(1).map((l) => l.slice(l.lastIndexOf(",") + 1).split(" ")[0])
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const strip = ({ _error, _remarks, _info, _edit, ...r }: ParsedRow) => r as Record<string, string>

async function main() {
  const parsed: ParsedRow[] = parseCSV(text, PO_BULK_CSV_FIELDS)
  const clientOk = parsed.map((r: ParsedRow, i: number) => (isFlagged(r) ? -1 : i)).filter((i: number) => i >= 0)
  const preview = await priceBulkRows(clientOk.map((i) => strip(parsed[i])))   // checkValidRowsOnly
  const pFlag = new Map(clientOk.map((orig, k) => [orig, preview.flags[k]]))
  const pInfo = new Map(clientOk.map((orig, k) => [orig, preview.info[k]]))
  const validIdx = clientOk.filter((i) => !pFlag.get(i))
  const upload = await priceBulkRows(validIdx.map((i) => strip(parsed[i])))    // the upload sends valid rows only
  const stagedByIdx = new Map<number, Record<string, string>>()
  { let s = 0; validIdx.forEach((orig, k) => { if (!upload.flags[k]) stagedByIdx.set(orig, upload.staged[s++]) }) }
  const out: { line: number; expect: string; got: string; detail: string }[] = []

  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const ctx = { s3Key: "imports/po-bulk/sim.csv", approverId: a!.userId, resolvePoRate: makePoRateResolver() }
    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i]
      let got = "", detail = ""
      if (isFlagged(r)) { got = "CLIENT_FLAG"; detail = rowRemark(r) }
      else if (pFlag.get(i)) { got = "SERVER_FLAG"; detail = pFlag.get(i)!.join("; ") }
      else {
        const st = stagedByIdx.get(i)
        if (!st) { got = "PREVIEW_UPLOAD_DISAGREE"; detail = "ok in preview, flagged at upload" }
        else if (st.po_no) {
          const [po] = await query<{ id: number }>("SELECT id FROM purchase_orders WHERE po_no = ?", [st.po_no])
          got = po ? "UPDATE" : "UPDATE_SKIP"; detail = (pInfo.get(i)?.[0] ?? "") + (st.destination ? ` | destination=${st.destination}` : "")
        } else {
          const res = await createBulkPoRow(conn, st, ctx)
          if ("skip" in res) { got = "APPROVAL_SKIP"; detail = res.skip }
          else {
            const [[po]] = (await conn.query("SELECT po_no, po_type, destination, unit_price, amount_pre_gst, total_amount FROM purchase_orders WHERE id = ?", [res.poId])) as unknown as [Record<string, string | null>[]]
            const special = ["npd", "tech_transfer", "cpr"].includes(po.po_type ?? "")
            got = special ? (Number(po.unit_price) === 0 && Number(po.total_amount) === 0 ? "SPECIAL0" : "SPECIAL_BAD_PRICE")
              : po.unit_price == null ? "UNPRICED" : po.po_type === "impromptu" ? (/-IMP-/.test(po.po_no ?? "") ? "PRICED_IMP" : "IMP_BAD_NO") : "PRICED"
            detail = `${po.po_no} [${po.po_type}] dest=${po.destination} rate=${po.unit_price ?? "-"} total=${po.total_amount ?? "-"} | ${pInfo.get(i)?.[0] ?? ""}`
          }
        }
      }
      out.push({ line: i + 2, expect: expects[i], got, detail })
    }
    const e01 = [...stagedByIdx.entries()].find(([i]) => parsed[i].remarks === "E01 NPD trial batch")?.[1]
    const again = await createBulkPoRow(conn, { ...e01! }, ctx)
    out.push({ line: 0, expect: "APPROVAL_SKIP", got: "skip" in again ? "APPROVAL_SKIP" : "CREATED", detail: "a later file repeating E01: " + ("skip" in again ? again.skip : again.poNo) })
  })

  let bad = 0
  for (const o of out) {
    // "CODE@Warehouse" also pins the destination that was stored.
    const [code, dest] = o.expect.split("@")
    const ok = o.got === code && (!dest || new RegExp(`(dest|destination)=${dest}( |$)`).test(o.detail)); if (!ok) bad++
    console.log(`${ok ? "PASS" : "FAIL"} ${String(o.line || "x").padStart(2)} ${o.expect.padEnd(13)} ${o.got.padEnd(13)} ${o.detail.slice(0, 140)}`)
  }
  console.log(`\n${out.length - bad}/${out.length} as expected | toast: ${preview.unknownSkus} unknown SKUs | staged for approval: ${upload.staged.length}`)
  await closePool(); process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
