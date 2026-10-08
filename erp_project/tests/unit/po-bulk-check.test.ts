// checkBulkRows — every rule a PO bulk row is checked against at upload, run on
// in-memory facts: exact messages, exact flag indexes, exact staged columns.
// See docs/po-bulk-type-plan.md.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkBulkRows, bulkUpdateBlock, type BulkFacts, type BulkUpdateTarget } from "../../lib/po/po-bulk-check"
import type { AgreedRateInput } from "../../lib/po/po-rate-note"

const AT = "2026-10-07T06:00:00.000Z"
const WAREHOUSES: Record<string, { name: string; active: boolean; serves: string[] }> = {
  mumbai: { name: "Mumbai", active: true, serves: ["PEP", "KREATIVE"] },
  ahmedabad: { name: "Ahmedabad", active: true, serves: ["PEP"] },
  guwahati: { name: "Guwahati", active: true, serves: ["KREATIVE"] },
  closedsite: { name: "ClosedSite", active: false, serves: ["PEP"] },
}
const costed = (rate: number, rm = 0, pm = 0): AgreedRateInput => ({ rate, rm_lines_without_rate: rm, pm_lines_without_rate: pm })

/** Facts for two manufacturers; ALP costs SKU-A at 24.31 and SKU-B at 0, NGE costs nothing. */
function facts(over: {
  live?: Record<string, string>
  /** po_type per PO No.; a string or null means a DRAFT PO of that type. */
  pos?: Record<string, string | null>
  /** Full PO rows, for the mailed / closed cases. */
  poRows?: Record<string, Partial<BulkUpdateTarget> & { po_type?: string | null }>
  /** Warehouses, keyed lower-case: canonical name, status, and the entities it serves. */
  warehouses?: Record<string, { name: string; active: boolean; serves: string[] }>
  gst?: Record<string, number | null>
} = {}) {
  const calls: string[] = []
  const mfgs: Record<string, { id: number; code: string }> = { "MFG-ALP": { id: 1, code: "MFG-ALP" }, "MFG-NGE": { id: 5, code: "MFG-NGE" } }
  const skus = new Set(["sku-a", "sku-b", "sku-c"])
  const rates: Record<number, Record<string, AgreedRateInput>> = { 1: { "sku-a": costed(24.31), "sku-b": costed(0), "sku-c": costed(50, 2, 1) } }
  const f: BulkFacts = {
    async mfgByCode(code) { calls.push(`mfg:${code}`); return mfgs[code] ?? null },
    async skuExists(sku) { calls.push(`sku:${sku}`); return skus.has(sku.toLowerCase()) },
    async poByNo(poNo) {
      calls.push(`po:${poNo}`)
      const base = { po_no: poNo, status: "draft", email_sent_at: null, expected_on: null, destination: null, remarks: null, sku_code: "SKU-A" }
      if (over.poRows && poNo in over.poRows) return { ...base, po_type: null, ...over.poRows[poNo] }
      return poNo in (over.pos ?? {}) ? { ...base, po_type: over.pos![poNo] } : null
    },
    async destination(name, sku) {
      calls.push(`dest:${name}|${sku}`)
      const w = (over.warehouses ?? WAREHOUSES)[name.toLowerCase()]
      if (!w) return null
      // SKU-A/B/C belong to entity PEP; an unknown SKU has none to check against.
      const entity = sku ? "PEP" : null
      return { name: w.name, active: w.active, allowed: !entity || w.serves.includes(entity), entity }
    },
    async liveSpecialPo(mfgId, sku, type) {
      calls.push(`live:${mfgId}|${sku}|${type}`)
      return over.live?.[`${mfgId}|${sku.toLowerCase()}|${type}`] ?? null
    },
    async rate(mfgId, sku) {
      calls.push(`rate:${mfgId}|${sku}`)
      const k = sku.toLowerCase()
      return { agreed: rates[mfgId]?.[k], gstPercent: over.gst && k in over.gst ? over.gst[k] : 18 }
    },
  }
  return { f, calls }
}

const row = (o: Record<string, string>) => ({ mfg_code: "MFG-ALP", sku_code: "SKU-A", qty: "1000", destination: "Mumbai", ...o })
const run = (rows: Record<string, string>[], o?: Parameters<typeof facts>[0]) => {
  const { f, calls } = facts(o)
  return checkBulkRows(rows, f, AT).then((r) => ({ ...r, calls }))
}

// ── normal / impromptu ───────────────────────────────────────────────────────

test("a blank type is a normal PO, priced from costing with the SKU's GST", async () => {
  const r = await run([row({})])
  assert.deepEqual(r.flags, {})
  assert.deepEqual(r.info, { 0: ["₹24.31 × 1,000 + 18% GST = ₹28,685.80"] })
  assert.equal(r.staged.length, 1)
  assert.deepEqual(
    { po_type: r.staged[0].po_type, unit_price: r.staged[0].unit_price, gst_percent: r.staged[0].gst_percent,
      amount_pre_gst: r.staged[0].amount_pre_gst, total_amount: r.staged[0].total_amount, priced_at: r.staged[0].priced_at },
    { po_type: "normal", unit_price: "24.31", gst_percent: "18", amount_pre_gst: "24310", total_amount: "28685.8", priced_at: AT },
  )
  assert.equal(r.staged[0].costing_note, r.info[0][0])
})

test("type cells are read case- and spacing-insensitively", async () => {
  const r = await run([row({ po_type: "NORMAL" }), row({ po_type: " Impromptu ", remarks: "x" }), row({ po_type: "Tech Transfer", remarks: "x" }), row({ po_type: "tech-transfer", remarks: "x", mfg_code: "MFG-NGE" })])
  assert.deepEqual(r.flags, {})
  assert.deepEqual(r.staged.map((s) => s.po_type), ["normal", "impromptu", "tech_transfer", "tech_transfer"])
})

test("anything the client sent in a server-written column is overwritten", async () => {
  const r = await run([row({ unit_price: "0.01", total_amount: "1", gst_percent: "0", amount_pre_gst: "1", costing_note: "forged", priced_at: "forged", po_type: "" })])
  const s = r.staged[0]
  assert.equal(s.unit_price, "24.31")
  assert.equal(s.total_amount, "28685.8")
  assert.equal(s.gst_percent, "18")
  assert.equal(s.priced_at, AT)
  assert.notEqual(s.costing_note, "forged")
})

test("impromptu is priced like normal but must carry remarks", async () => {
  const r = await run([row({ po_type: "impromptu", remarks: "urgent" }), row({ po_type: "impromptu", remarks: "   " })])
  assert.equal(r.staged.length, 1)
  assert.equal(r.staged[0].unit_price, "24.31")
  assert.deepEqual(r.flags, { 1: ["Remarks are required for an impromptu PO"] })
})

test("a 5% SKU is totalled at 5%", async () => {
  const r = await run([row({ qty: "30000" })], { gst: { "sku-a": 5 } })
  assert.equal(r.staged[0].total_amount, String(Number((24.31 * 30000 * 1.05).toFixed(2))))
  assert.match(r.info[0][0], /\+ 5% GST/)
})

test("costing notes: zero-costed, partly costed and not-mapped normal rows are uploaded, not blocked", async () => {
  const r = await run([row({ sku_code: "SKU-B" }), row({ sku_code: "SKU-C" }), row({ mfg_code: "MFG-NGE" })])
  assert.deepEqual(r.flags, {})
  assert.equal(r.staged.length, 3)
  assert.equal(r.info[0][0], "Costing totals ₹0 — will be raised unpriced")
  assert.match(r.info[1][0], /costing incomplete: 2 RM, 1 PM lines without rate$/)
  assert.equal(r.info[2][0], "Not mapped at MFG-NGE — no recipe, will be raised unpriced")
  assert.deepEqual([r.staged[0].unit_price, r.staged[2].unit_price], ["", ""])
})

// ── special types ────────────────────────────────────────────────────────────

test("npd / tech_transfer / cpr are staged at a 0 price even on a costed SKU", async () => {
  const r = await run(["npd", "tech_transfer", "cpr"].map((t) => row({ po_type: t, remarks: "x" })))
  assert.deepEqual(r.flags, {})
  for (const s of r.staged) {
    assert.deepEqual([s.unit_price, s.amount_pre_gst, s.total_amount, s.gst_percent], ["0", "0", "0", "0"], s.po_type)
  }
  assert.deepEqual(r.info, {
    0: ["NPD — price 0, pricing to be confirmed"],
    1: ["Tech Transfer — price 0, pricing to be confirmed"],
    2: ["CPR — price 0, pricing to be confirmed"],
  })
})

test("a special SKU with no recipe at the mfg is noted, never blocked", async () => {
  const r = await run([row({ po_type: "cpr", remarks: "x", mfg_code: "MFG-NGE" })])
  assert.deepEqual(r.flags, {})
  assert.equal(r.info[0][0], "CPR — price 0, pricing to be confirmed; not mapped at MFG-NGE (no recipe)")
})

test("special types need remarks", async () => {
  const r = await run([row({ po_type: "npd" }), row({ po_type: "tech_transfer", mfg_code: "MFG-NGE" }), row({ po_type: "cpr", sku_code: "SKU-B" })])
  assert.deepEqual(r.flags, {
    0: ["Remarks are required for a npd PO"],
    1: ["Remarks are required for a tech_transfer PO"],
    2: ["Remarks are required for a cpr PO"],
  })
  assert.equal(r.staged.length, 0)
})

// ── once per (mfg, sku, type) ────────────────────────────────────────────────

test("a live special PO for the pair blocks the row and names it", async () => {
  const r = await run([row({ po_type: "npd", remarks: "x" })], { live: { "1|sku-a|npd": "MCAFF-PO-202610-007" } })
  assert.deepEqual(r.flags, { 0: ["A npd PO is already raised for SKU-A at MFG-ALP: MCAFF-PO-202610-007"] })
  assert.ok(r.calls.includes("live:1|SKU-A|npd"))
})

test("the limit is per type: a live npd doesn't block cpr or tech_transfer on the same pair", async () => {
  const r = await run([row({ po_type: "cpr", remarks: "x" }), row({ po_type: "tech_transfer", remarks: "x" })], { live: { "1|sku-a|npd": "P-1" } })
  assert.deepEqual(r.flags, {})
  assert.equal(r.staged.length, 2)
})

test("in one file the first special row wins; case of the SKU code doesn't matter", async () => {
  const r = await run([
    row({ po_type: "npd", remarks: "x" }),
    row({ po_type: "npd", remarks: "x", sku_code: "sku-a" }),
    row({ po_type: "npd", remarks: "x", mfg_code: "MFG-NGE" }),
    row({ po_type: "cpr", remarks: "x" }),
  ])
  assert.deepEqual(r.flags, { 1: ["Another npd row for sku-a at MFG-ALP is earlier in this file"] })
  assert.equal(r.staged.length, 3, "a different mfg and a different type are separate pairs")
})

test("a flagged special row does not claim its pair — the next valid row passes", async () => {
  // The first row is left out for missing remarks, so it can't block the second.
  const r = await run([row({ po_type: "npd" }), row({ po_type: "npd", remarks: "real one" })])
  assert.deepEqual(r.flags, { 0: ["Remarks are required for a npd PO"] })
  assert.equal(r.staged.length, 1)
  assert.equal(r.staged[0].remarks, "real one")
})

test("a row blocked by a live PO doesn't claim the pair either", async () => {
  const r = await run([row({ po_type: "npd", remarks: "x" }), row({ po_type: "npd", remarks: "y" })], { live: { "1|sku-a|npd": "P-9" } })
  assert.deepEqual(Object.keys(r.flags), ["0", "1"])
  assert.match(r.flags[1][0], /already raised .*P-9$/)
})

test("normal and impromptu rows never ask about live special POs", async () => {
  const r = await run([row({}), row({ po_type: "impromptu", remarks: "x" })])
  assert.equal(r.calls.filter((c) => c.startsWith("live:")).length, 0)
})

// ── unknowns, bad input ──────────────────────────────────────────────────────

test("an unknown SKU is flagged and counted for the toast; an unknown mfg too", async () => {
  const r = await run([row({ sku_code: "ZZ-1" }), row({ sku_code: "ZZ-2", po_type: "npd", remarks: "x" }), row({ mfg_code: "MFG-NOPE" }), row({ mfg_code: "MFG-NOPE", sku_code: "ZZ-3" })])
  assert.deepEqual(r.flags, {
    0: ["SKU ZZ-1 is not in SKU Master"],
    1: ["SKU ZZ-2 is not in SKU Master"],
    2: ["Manufacturer MFG-NOPE not found"],
    3: ["Manufacturer MFG-NOPE not found", "SKU ZZ-3 is not in SKU Master"],
  })
  assert.equal(r.unknownSkus, 3)
  assert.equal(r.staged.length, 0)
})

test("an invalid type is flagged before any lookup", async () => {
  const r = await run([row({ po_type: "crp", remarks: "x" })])
  assert.deepEqual(r.flags, { 0: ['PO type "crp" is not one of normal, impromptu, npd, tech_transfer, cpr'] })
  assert.deepEqual(r.calls, [])
})

test("a new row without mfg, SKU or a positive qty is flagged, not silently staged", async () => {
  const r = await run([row({ qty: "0" }), row({ qty: "-5" }), row({ qty: "abc" }), row({ mfg_code: "" }), row({ sku_code: " " })])
  for (const i of [0, 1, 2, 3, 4]) assert.deepEqual(r.flags[i], ["A new PO needs mfg_code, sku_code and a positive qty"], String(i))
  assert.equal(r.staged.length, 0)
})

// ── update rows ──────────────────────────────────────────────────────────────

test("update rows: never priced, can't change the type, blank type keeps it", async () => {
  const r = await run(
    [
      { po_no: "P-N", po_type: "npd" },
      { po_no: "P-N", po_type: "normal" },
      { po_no: "P-N" },
      { po_no: "P-S", po_type: "" },
      { po_no: "P-S", po_type: "cpr" },
      { po_no: "P-GONE" },
    ],
    { pos: { "P-N": null, "P-S": "npd" } },
  )
  assert.deepEqual(r.flags, {
    0: ["An update can't change the PO type (P-N is normal)"],
    4: ["An update can't change the PO type (P-S is npd)"],
  })
  assert.deepEqual(r.info, {
    1: ["Updates P-N — price unchanged"],
    2: ["Updates P-N — price unchanged"],
    3: ["Updates P-S — price unchanged"],
    5: ["PO P-GONE not found — will be skipped"],
  })
  for (const s of r.staged) assert.equal(s.unit_price, "")
  assert.equal(r.staged.length, 4)
})

// ── shape ────────────────────────────────────────────────────────────────────

test("flags and notes are keyed by the row's own index; staged keeps file order", async () => {
  const r = await run([row({ remarks: "first" }), row({ sku_code: "ZZ" }), row({ remarks: "third" })])
  assert.deepEqual(Object.keys(r.flags), ["1"])
  assert.deepEqual(Object.keys(r.info).sort(), ["0", "2"])
  assert.deepEqual(r.staged.map((s) => s.remarks), ["first", "third"])
})

// ── destination ──────────────────────────────────────────────────────────────

test("a new PO needs a destination", async () => {
  for (const d of ["", "   "]) {
    const r = await run([row({ destination: d })])
    assert.deepEqual(r.flags, { 0: ["Destination is required — name a warehouse"] }, JSON.stringify(d))
  }
})

test("the destination must be a warehouse, active, and serve the SKU's entity", async () => {
  const r = await run([row({ destination: "Atlantis" }), row({ destination: "ClosedSite" }), row({ destination: "Guwahati" }), row({ destination: "Ahmedabad" })])
  assert.deepEqual(r.flags, {
    0: ['Destination "Atlantis" is not a warehouse'],
    1: ["Destination ClosedSite is not an active warehouse"],
    2: ["Guwahati isn't a PEP facility — this SKU's POs can only be sent to PEP's warehouses"],
  })
  assert.equal(r.staged.length, 1)
  assert.equal(r.staged[0].destination, "Ahmedabad")
})

test("the destination is stored in the warehouse's own spelling", async () => {
  const r = await run([row({ destination: "  mUMBAI " })])
  assert.equal(r.staged[0].destination, "Mumbai")
})

test("special types get the same destination rules", async () => {
  const r = await run([row({ po_type: "npd", remarks: "x", destination: "Atlantis" }), row({ po_type: "npd", remarks: "x", destination: "Mumbai" })])
  assert.deepEqual(r.flags, { 0: ['Destination "Atlantis" is not a warehouse'] })
  assert.equal(r.staged.length, 1, "the flagged row didn't claim the pair")
})

test("an unknown SKU still has its destination checked — without an entity", async () => {
  const r = await run([row({ sku_code: "ZZ", destination: "Atlantis" }), row({ sku_code: "ZY", destination: "Guwahati" })])
  assert.deepEqual(r.flags, {
    0: ["SKU ZZ is not in SKU Master", 'Destination "Atlantis" is not a warehouse'],
    1: ["SKU ZY is not in SKU Master"],
  })
  assert.ok(r.calls.includes("dest:Guwahati|null"))
})

test("update rows: a blank destination keeps the PO's; a new one is checked against its SKU", async () => {
  const r = await run(
    [{ po_no: "P-1" }, { po_no: "P-1", destination: "ahmedabad" }, { po_no: "P-1", destination: "Guwahati" }, { po_no: "P-1", destination: "Atlantis" }],
    { pos: { "P-1": null } },
  )
  assert.deepEqual(r.flags, {
    2: ["Guwahati isn't a PEP facility — this SKU's POs can only be sent to PEP's warehouses"],
    3: ['Destination "Atlantis" is not a warehouse'],
  })
  assert.deepEqual(r.staged.map((x) => x.destination ?? ""), ["", "Ahmedabad"])
  assert.ok(r.calls.includes("dest:ahmedabad|SKU-A"), "checked against the PO's own SKU")
})

// ── updates only while the manufacturer hasn't been told ─────────────────────

const MAILED = "2026-10-01T10:00:00.000Z"
const po = (o: Partial<BulkUpdateTarget> = {}): BulkUpdateTarget => ({
  po_no: "P-1", status: "raised", email_sent_at: MAILED, expected_on: "2026-11-15", destination: "Mumbai", remarks: "orig", ...o,
})

test("bulkUpdateBlock: a draft — stored draft, or raised but unmailed — may change anything a CSV can", () => {
  for (const target of [po({ status: "draft", email_sent_at: null }), po({ status: "raised", email_sent_at: null })]) {
    for (const r of [{ expected_on: "2026-12-01" }, { destination: "Gurgaon" }, { remarks: "new" }, { status: "raised" }, { status: "cancelled" }, { status: "short_closed" }]) {
      assert.equal(bulkUpdateBlock(target, r), null, `${target.status}/${JSON.stringify(r)}`)
    }
  }
})

test("bulkUpdateBlock: once mailed, only cancel or short-close", () => {
  const msg = "P-1 has been sent to the manufacturer — a CSV can only cancel or short-close it now"
  assert.equal(bulkUpdateBlock(po(), { status: "cancelled" }), null)
  assert.equal(bulkUpdateBlock(po(), { status: "short_closed" }), null)
  assert.equal(bulkUpdateBlock(po(), { expected_on: "2026-12-01" }), msg)
  assert.equal(bulkUpdateBlock(po(), { destination: "Gurgaon" }), msg)
  assert.equal(bulkUpdateBlock(po(), { remarks: "changed" }), msg)
  assert.equal(bulkUpdateBlock(po({ status: "cancelled" }), { status: "raised" }), msg, "no re-raising a cancelled PO")
  assert.equal(bulkUpdateBlock(po(), { status: "cancelled", remarks: "and a note" }), msg, "a cancel can't carry an edit with it")
})

test("bulkUpdateBlock: unchanged columns don't count — a re-uploaded export may still cancel", () => {
  // Same date in another format, same destination in another case, same remarks.
  assert.equal(bulkUpdateBlock(po(), { status: "cancelled", expected_on: "15-11-2026", destination: " mumbai ", remarks: "orig" }), null)
  assert.equal(bulkUpdateBlock(po(), { status: "raised" }), null, "raised → raised is no change")
  // mysql2 returns a DATE as UTC midnight (lib/db.ts sets timezone +00:00).
  assert.equal(bulkUpdateBlock(po({ expected_on: new Date("2026-11-15T00:00:00Z") }), { expected_on: "2026-11-15" }), null)
})

test("bulkUpdateBlock: a CSV never sets a receipt status, draft or not", () => {
  for (const status of ["punched", "partially_received", "received", "draft"]) {
    assert.equal(bulkUpdateBlock(po({ status: "raised", email_sent_at: null }), { status }),
      `A CSV can only set status to raised, cancelled, short_closed (got "${status}")`, status)
  }
  assert.equal(bulkUpdateBlock(po({ status: "received" }), { status: "received" }), null, "restating the current status is no change")
})

test("bulkUpdateBlock: the message says why — mailed, or past draft without a mail", () => {
  assert.equal(bulkUpdateBlock(po({ status: "received", email_sent_at: null, po_no: "INW-1" }), { remarks: "x" }),
    "INW-1 is received — a CSV can only cancel or short-close it now")
  assert.equal(bulkUpdateBlock(po({ status: "partially_received", email_sent_at: null }), { remarks: "x" }),
    "P-1 is partially received — a CSV can only cancel or short-close it now")
})

test("upload: a mailed PO's edit row is flagged; its cancel row passes", async () => {
  const r = await run(
    [{ po_no: "P-M", expected_on: "2026-12-01" }, { po_no: "P-M", status: "cancelled" }, { po_no: "P-D", expected_on: "2026-12-01" }],
    { poRows: { "P-M": { status: "raised", email_sent_at: MAILED }, "P-D": { status: "raised", email_sent_at: null } } },
  )
  assert.deepEqual(r.flags, { 0: ["P-M has been sent to the manufacturer — a CSV can only cancel or short-close it now"] })
  assert.equal(r.staged.length, 2)
})
