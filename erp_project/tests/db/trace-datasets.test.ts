// Traceability datasets T1–T6 (docs/reporting/dataset-contracts.md) against one fixture that has every trap:
// a split PO, a FIFO-split printed line, two batches, a GRN with a loose batch, a rejection and an unlinked
// case-drifted line, a reverted invoice and a manual receipt. Every case is rolled back.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { traceSql, buildTraceParams, type TraceFilters } from "../../lib/queries/trace"
import { UNRESTRICTED, type UserScope } from "../../lib/scope"
import { withRollback, anchors, makePo, makeInvoice, closePool, num, testPoNo, type Anchors } from "../helpers/db"

after(closePool)

const none: TraceFilters = { mfgCode: null, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null }

async function rows(conn: PoolConnection, sql: string, f: TraceFilters, scope: UserScope = UNRESTRICTED) {
  const [r] = await conn.query(sql, [...buildTraceParams(f, scope), 1000, 0])
  return r as Record<string, unknown>[]
}

async function traceFixture(conn: PoolConnection, a: Anchors) {
  const prefix = testPoNo("TRC")
  const mail = (id: number) => conn.execute("UPDATE purchase_orders SET email_sent_at = NOW() WHERE id = ?", [id])
  const master = await makePo(conn, a, { po_no: `${prefix}-M`, qty: 1000, unit_price: 100 })
  const child = await makePo(conn, a, { po_no: `${prefix}-C`, qty: 300, unit_price: 100 })
  await conn.execute("UPDATE purchase_orders SET reference_po = ? WHERE id = ?", [master.po_no, child.id])
  const other = await makePo(conn, a, { po_no: `${prefix}-P`, qty: 500, unit_price: 100 })
  for (const p of [master, child, other]) await mail(p.id)

  // One printed line (B-26/1) FIFO-split across master and other; a second batch against the split child.
  const inv = await makeInvoice(conn, a, {
    invoice_no: `${prefix}-INV`, uniware_po_code: `${prefix}-UPO`,
    lines: [{ against: master, qty: 200 }, { against: other, qty: 100 }, { against: child, qty: 50 }],
  })
  const setLine = (n: number, batch: string, expiry: string) => conn.execute(
    "UPDATE invoice_items_mfg SET batch = ?, expiry = ?, rate = 100 WHERE invoice_id = ? AND line_no = ?", [batch, expiry, inv.invoiceId, n])
  await setLine(1, "B-26/1", "Jun-2026")
  await setLine(2, "B-26/1", "Jun-2026")
  await setLine(3, "B2", "Jul-2026")

  // GRN: batch spelled differently (loose), 10 rejected; plus a case-drifted SKU nobody billed, left unlinked.
  const [g] = await conn.execute<ResultSetHeader>(
    `INSERT INTO grn_uniware (grn_code, uniware_po_code, invoice_id, status_code, vendor_invoice_no, grn_created_at, total_qty)
     VALUES (?, ?, ?, 'COMPLETE', ?, NOW(), 320)`, [`${prefix}-GRN`, `${prefix}-UPO`, inv.invoiceId, `${prefix}/inv`])
  const inward = inv.inwardIds[0]
  await conn.execute(
    `INSERT INTO grn_items_uniware (grn_id, line_no, sku_code, po_id, quantity, rejected_qty, batch_code, expiry) VALUES
     (?, 1, ?, ?, 300, 10, 'b261', '2026-06-30'),
     (?, 2, ?, NULL, 20, 0, 'B9', NULL)`,
    [g.insertId, a.sku, inward, g.insertId, a.sku.toLowerCase()])

  // A reverted invoice, and a manual receipt on the master.
  const reverted = await makeInvoice(conn, a, { invoice_no: `${prefix}-REV`, lines: [{ against: master, qty: 30 }] })
  await conn.execute("UPDATE invoice_mfg SET reverted_at = NOW() WHERE id = ?", [reverted.invoiceId])
  await conn.execute("UPDATE purchase_orders SET received_qty = received_qty - 30 WHERE id = ?", [master.id])
  const { receivePo } = await import("../../lib/po/po-receive")
  await receivePo(conn, master.id, 25, a.userId)

  return { prefix, master, child, other, inv, reverted, inward }
}

test("T1: one row per allocation; FIFO rows flagged, child rolled to master, reverted kept and flagged", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)

    const r = await rows(conn, traceSql.t1Rows, { ...none, invoiceNo: fx.prefix })
    assert.equal(r.length, 4)
    const live = r.filter((x) => x.reverted_at == null)
    assert.equal(live.reduce((s, x) => s + num(x.qty as number), 0), 350)
    assert.deepEqual(live.map((x) => num(x.printed_line_rows as number)).sort(), [1, 2, 2])
    const childLine = live.find((x) => x.po_no === fx.child.po_no)!
    assert.equal(childLine.master_po_no, fx.master.po_no)
    assert.ok(r.some((x) => x.invoice_no === `${fx.prefix}-REV` && x.reverted_at != null))

    // Filtering by the master PO finds its own lines and its split child's.
    const byMaster = await rows(conn, traceSql.t1Rows, { ...none, poNo: fx.master.po_no })
    assert.ok(byMaster.some((x) => x.po_no === fx.child.po_no))

    const [[c]] = (await conn.query(traceSql.t1Count, buildTraceParams({ ...none, invoiceNo: fx.prefix }, UNRESTRICTED))) as never as [[Record<string, unknown>]]
    assert.equal(num(c.live_qty as number), 350, "reverted lines never count")
  })
})

test("T5: every GRN line kept, unlinked case-drift flagged, procurement POs listed", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)

    const r = await rows(conn, traceSql.t5Rows, { ...none, invoiceNo: fx.prefix })
    assert.equal(r.length, 2)
    const linked = r.find((x) => x.inward_po_id != null)!
    const unlinked = r.find((x) => x.inward_po_id == null)!
    assert.equal(num(linked.gross_qty as number) - num(linked.rejected_qty as number), 290)
    assert.ok(String(linked.procurement_po_nos).includes(fx.master.po_no))
    assert.ok(String(linked.procurement_po_nos).includes(fx.other.po_no))
    assert.equal(unlinked.batch, "B9")

    // Batch filter uses the loose key on both sides.
    assert.equal((await rows(conn, traceSql.t5Rows, { ...none, invoiceNo: fx.prefix, batchKey: "B261" })).length, 1)
    assert.equal((await rows(conn, traceSql.t1Rows, { ...none, invoiceNo: fx.prefix, batchKey: "B261" })).length, 2)
  })
})

const runOn = (conn: PoolConnection) => async (sql: string, params: unknown[]) =>
  (await conn.query(sql, params))[0] as Record<string, unknown>[]

test("T2: batch rows fold FIFO rows, match loosely, and give each status", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getT2 } = await import("../../lib/services/reports/trace/batches")

    const out = await getT2(UNRESTRICTED, { ...none, invoiceNo: fx.prefix, status: null }, 100, 0, runOn(conn))
    const by = (k: string) => out.rows.find((r) => r.batch_key === k)!
    assert.equal(out.rows.length, 3, "B261, B2, B9 — the reverted invoice is not in the ledger")

    // B-26/1 billed as two FIFO rows (200 + 100); GRN spelled b261: 300 arrived, 10 rejected.
    assert.equal(by("B261").billed_qty, 300)
    assert.equal(by("B261").grn_accepted_qty, 290)
    assert.equal(by("B261").batch_match, "loose")
    assert.equal(by("B261").status, "matched")
    assert.equal(by("B261").expiry_mismatch, false)

    assert.equal(by("B2").status, "billed_not_received")
    assert.equal(by("B9").status, "received_not_billed")
    assert.equal(by("B9").grn_unmatched_po, true)

    // Nothing lost or doubled in the merge.
    assert.equal(out.billedQty, 350)
    assert.equal(out.grnGrossQty, 320)

    const onlyMissing = await getT2(UNRESTRICTED, { ...none, invoiceNo: fx.prefix, status: "billed_not_received" }, 100, 0, runOn(conn))
    assert.deepEqual(onlyMissing.rows.map((r) => r.batch_key), ["B2"])
  })
})

test("T3: every received unit has a source; split child stays its own row", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getT3 } = await import("../../lib/services/reports/trace/receipts")

    const out = await getT3(UNRESTRICTED, { ...none, poNo: fx.master.po_no }, 100, 0, runOn(conn))
    const m = out.rows.find((r) => r.po_no === fx.master.po_no)!
    const c = out.rows.find((r) => r.po_no === fx.child.po_no)!

    // Master: 200 via the live invoice, 30 via the reverted one (taken back), 25 by hand.
    assert.equal(m.received_own, 225)
    assert.equal(m.invoiced_live, 200)
    assert.equal(m.invoiced_reverted, 30)
    assert.equal(m.received_without_invoice, 25)
    assert.equal(m.provenance, "partly_without_invoice")
    assert.equal(m.received_incl_children, 275, "the child's 50 rolls up to the master")
    assert.equal(c.is_split_child, true)
    assert.equal(c.master_po_no, fx.master.po_no)
    if (c.provenance !== "all_invoiced") console.log("CHILD", JSON.stringify(c))
    assert.equal(c.provenance, "all_invoiced")
    for (const r of out.rows) {
      assert.equal(r.invoiced_live + r.received_without_invoice, r.received_own)
      assert.equal(r.history_delta + r.opening_balance, r.received_own)
    }
  })
})

test("T4: each receipt event is matched to its invoice line or classified", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getT4 } = await import("../../lib/services/reports/trace/receipts")

    const out = await getT4(UNRESTRICTED, { ...none, poNo: fx.master.po_no }, 100, 0, runOn(conn))
    const master = out.rows.filter((r) => r.po_no === fx.master.po_no)
    // Receipts on the master: 200 (live invoice), 30 (reverted invoice's original receipt), 25 (manual).
    const bySize = (d: number) => master.find((r) => r.delta === d)!
    assert.equal(bySize(200).source, "invoice")
    assert.equal(bySize(200).invoice_no, `${fx.prefix}-INV`)
    assert.equal(bySize(30).source, "invoice")
    assert.equal(bySize(30).invoice_no, `${fx.prefix}-REV`)
    assert.equal(bySize(25).source, "manual")
    assert.equal(bySize(25).confidence, "none")
  })
})

test("T6: one SKU row; splits roll in, GRN counted once per invoice, month view drops GRN", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getT6 } = await import("../../lib/services/reports/trace/skus")
    // Only the fixture's masters: filter on the shared invoice (master and other both settled it).
    const f = { ...none, invoiceNo: `${fx.prefix}-INV`, byMonth: false }

    const out = await getT6(UNRESTRICTED, f, 100, 0, runOn(conn))
    assert.equal(out.rows.length, 1)
    const r = out.rows[0]
    assert.equal(r.po_count, 2, "master + other; the split child is not a row of its own")
    assert.equal(r.ordered_qty, 1500)
    assert.equal(r.invoiced_qty, 350, "200 + 100 + the child's 50, reverted 30 excluded")
    assert.equal(r.received_qty, 375, "225 + 50 on the master, 100 on other")
    assert.equal(r.grn_gross_qty, 320, "the invoice's GRN for this SKU, once")
    assert.equal(r.grn_accepted_qty, 310)
    assert.equal(r.invoice_count, 1)
    assert.equal(r.batch_count, 2)

    const monthly = await getT6(UNRESTRICTED, { ...f, byMonth: true }, 100, 0, runOn(conn))
    assert.ok(monthly.rows.every((x) => x.grn_gross_qty == null && x.month != null))
  })
})

test("contract v1: every dataset's rows carry every contract column; CSV headers are the keys", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getTraceDataset } = await import("../../lib/services/reports/trace")
    const { exportColumns } = await import("../../lib/services/reports/trace/export")
    const { TRACE_DATASETS, TRACE_TABS } = await import("../../lib/reports/trace/contracts")
    const { buildCsv } = await import("../../lib/export")

    for (const tab of TRACE_TABS) {
      const filters = tab === "t3" || tab === "t4" ? { ...none, poNo: fx.master.po_no } : { ...none, invoiceNo: fx.prefix }
      const d = await getTraceDataset(UNRESTRICTED, tab, { tab, filters, status: null, byMonth: false }, 100, 0, runOn(conn))
      assert.ok(d.rows.length > 0, `${tab} has rows`)
      const missing = TRACE_DATASETS[tab].columns.map((c) => c.key).filter((k) => !(k in d.rows[0]))
      assert.deepEqual(missing, [], `${tab} rows lack contract keys`)
      const header = buildCsv(exportColumns(tab, "key"), d.rows).replace(/^﻿/, "").split("\r\n")[0]
      assert.equal(header, TRACE_DATASETS[tab].columns.map((c) => `"${c.key}"`).join(","))
    }
  })
})

test("row expand: each hop lands exactly on the rows it should", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getTraceDataset } = await import("../../lib/services/reports/trace")
    const { nextHops } = await import("../../lib/reports/trace/hops")
    const { parseTraceQuery } = await import("../../lib/reports/trace/params")
    const follow = async (hop: { tab: string; params: Record<string, string> }) => {
      const q = parseTraceQuery({ tab: hop.tab, ...hop.params })
      return (await getTraceDataset(UNRESTRICTED, q.tab, q, 100, 0, runOn(conn))).rows
    }

    const ledger = await getTraceDataset(UNRESTRICTED, "t2",
      { tab: "t2", filters: { ...none, invoiceNo: fx.prefix }, status: null, byMonth: false }, 100, 0, runOn(conn))
    const b261 = ledger.rows.find((r) => r.batch_key === "B261")!
    const [toLines, toGrn] = nextHops("t2", b261)
    const lines = await follow(toLines)
    assert.equal(lines.length, 2, "the two FIFO rows of B-26/1, nothing else")
    assert.equal(lines.reduce((s, r) => s + Number(r.qty), 0), 300)
    assert.equal((await follow(toGrn)).length, 1)

    const ledger3 = await getTraceDataset(UNRESTRICTED, "t3",
      { tab: "t3", filters: { ...none, poNo: fx.master.po_no }, status: null, byMonth: false }, 100, 0, runOn(conn))
    const masterRow = ledger3.rows.find((r) => r.po_no === fx.master.po_no)!
    const masterLines = await follow(nextHops("t3", masterRow)[0])
    assert.ok(masterLines.some((r) => r.po_no === fx.child.po_no), "a master's lines include its split child's")

    // An exact invoice match must not catch invoices that merely contain the number.
    const exact = await follow({ tab: "t1", params: { inv: `${fx.prefix}-INV`, exact: "1" } })
    assert.ok(exact.every((r) => r.invoice_no === `${fx.prefix}-INV`))
  })
})

test("PO timeline: events in date order from every source; out-of-scope PO gets none", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const { getPoTimeline } = await import("../../lib/services/reports/trace/timeline")

    const tl = await getPoTimeline(UNRESTRICTED, fx.master.po_no, runOn(conn))
    assert.ok(tl, "the master is visible unrestricted")
    const labels = tl!.events.map((e) => e.label)
    assert.ok(labels.includes("Mailed to the manufacturer"))
    assert.ok(labels.includes(`Invoice ${fx.prefix}-INV inwarded`))
    assert.ok(labels.includes(`Invoice ${fx.prefix}-REV reverted`))
    assert.ok(labels.some((l) => l.startsWith("GRN ")))
    assert.ok(labels.includes("Received 25"), "the manual receipt")
    assert.ok(tl!.events.some((e) => e.detail?.includes(`against split ${fx.child.po_no}`)), "the split child's invoice shows on the master")
    const stamps = tl!.events.map((e) => e.at)
    assert.deepEqual(stamps, [...stamps].sort(), "date order")
    assert.ok(tl!.gaps.some((g) => g.startsWith("No creation record")), "makePo writes no create row")

    assert.equal(await getPoTimeline({ ...UNRESTRICTED, mfgIds: [0] }, fx.master.po_no, runOn(conn)), null)
  })
})

test("nightly extract keys are unreadable through the app's file routes", async () => {
  // assertKeyReadable allows a key only if a row owns it or it carries the uploader marker; these have neither.
  const { s3FilesSql, KEY_OWNER_PARAM_COUNT } = await import("../../lib/queries/s3-files")
  const { uploadedBy } = await import("../../lib/s3-guard")
  const { traceExtractPrefix } = await import("../../lib/reports/trace-extract")
  const { TRACE_DATASETS, TRACE_TABS } = await import("../../lib/reports/trace/contracts")
  await withRollback(async (conn) => {
    const keys = [...TRACE_TABS.map((t) => `${traceExtractPrefix("2026-10-27")}${TRACE_DATASETS[t].file}.csv`),
      `${traceExtractPrefix("2026-10-27")}manifest.json`]
    for (const key of keys) {
      assert.equal(uploadedBy(key), null, key)
      const [owners] = await conn.query(s3FilesSql.selectKeyOwners, Array(KEY_OWNER_PARAM_COUNT).fill(key))
      assert.equal((owners as unknown[]).length, 0, key)
    }
  })
})

test("scope: another manufacturer's viewer sees no lines and no GRN lines", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors in this schema")
    const fx = await traceFixture(conn, a)
    const other: UserScope = { ...UNRESTRICTED, mfgIds: [0] }
    assert.equal((await rows(conn, traceSql.t1Rows, { ...none, invoiceNo: fx.prefix }, other)).length, 0)
    assert.equal((await rows(conn, traceSql.t5Rows, { ...none, invoiceNo: fx.prefix }, other)).length, 0)
  })
})
