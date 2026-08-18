/**
 * The purchase order document. ONE template, for every legal entity.
 *
 * Everything that differs between Pep and Kreative is DATA, not layout: the legal
 * name, the address, the GSTIN and the bank block all arrive resolved on
 * `d.letterhead`, and the delivery address on `d.ship_to`.
 *
 * ── Where those values come from ────────────────────────────────────────────
 *   purchase_orders.sku_code → master_skus.brand_id → master_brand.entity_id
 *     → master_entity            (legal name, bank)
 *   + purchase_orders.destination → master_warehouse
 *     → details_warehouse_entity (bill-to and ship-to, per site AND entity)
 *
 * The bill-to is per (site, entity) rather than per entity because GST
 * registration is state-wise: a Guwahati delivery must bill under the Guwahati
 * registration, not the head office's. See lib/pdf/po-letterhead.ts for the
 * resolution and its fallbacks, and purchaseOrdersSql.selectForEmail for the joins.
 *
 * Resolved at RENDER time, not stamped at creation — so attributing a SKU's brand
 * or filling in a site's bill-to fixes the PDF of every existing PO, without
 * touching a single purchase_orders row.
 *
 * This file renders. It resolves nothing and holds no fallbacks of its own.
 */

import React from "react"
import {
  Document, Page, Text, View, StyleSheet, Font, renderToBuffer,
} from "@react-pdf/renderer"
import { IST } from "@/lib/date"
import type { PoLetterhead, PoShipTo } from "@/lib/pdf/po-letterhead"

// react-pdf only breaks lines at whitespace, so one long unbroken token (a PO
// code, an account number) overflows its column into the neighbouring one.
Font.registerHyphenationCallback((word) => Array.from(word))

export type PoEmailData = {
  po_no: string
  date: string | null
  expected_on: string | null
  destination: string | null
  dest_location: string | null
  sku_code: string
  sku_name: string | null
  qty: number
  unit_price: number | null
  total_amount: number | null
  mfg_name: string
  mfg_code: string
  registered_name: string | null
  gst_number: string | null
  location: string | null
  mfg_email: string | null
  raised_by_name: string
  /** Who the PO is from — resolved, never a raw row. See po-letterhead.ts. */
  letterhead: PoLetterhead
  /** Where the goods go. */
  ship_to: PoShipTo
}

const TEAL   = "#1e7a7a"
const YELLOW = "#FFE500"
const BD     = "#cccccc"
const GST_RATE = 0.18
const EMPTY_ROWS = 8

// ── Helpers ────────────────────────────────────────────────────────────────────
function num(v: number | null | undefined) { return v ? Number(v) : 0 }
function fmtN(v: number | null | undefined) {
  if (!v) return "—"
  return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })
}
function fmtDate(d: string | null | undefined) {
  if (!d) return "—"
  try {
    return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST })
  } catch { return String(d) }
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 8, color: "#222", backgroundColor: "#fff" },

  // Header
  header:  { backgroundColor: TEAL, paddingVertical: 12, paddingHorizontal: 20, alignItems: "center" },
  hName:   { fontFamily: "Helvetica-Bold", fontSize: 11, color: "#fff", marginBottom: 2 },
  hSub:    { fontSize: 8, color: "#cde8e8", marginBottom: 1 },

  // Date row
  dateBar: {
    flexDirection: "row", justifyContent: "flex-end",
    paddingHorizontal: 20, paddingVertical: 5,
    borderBottomWidth: 1, borderBottomColor: BD,
  },
  dateTxt: { fontFamily: "Helvetica-Bold", fontSize: 8 },

  // 3-column info block
  infoWrap: {
    flexDirection: "row", marginHorizontal: 20, marginTop: 8,
    borderWidth: 1, borderColor: BD,
  },
  infoCol:   { flex: 1, padding: 8, borderRightWidth: 1, borderRightColor: BD },
  infoColL:  { flex: 1, padding: 8 },
  infoTitle: { fontFamily: "Helvetica-Bold", fontSize: 8, marginBottom: 4, borderBottomWidth: 0.5, borderBottomColor: BD, paddingBottom: 2 },
  infoLine:  { fontSize: 7.5, marginBottom: 1.5 },
  infoBold:  { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginBottom: 1.5 },

  // Table wrapper
  tbl: { marginHorizontal: 20, marginTop: 10, borderWidth: 1, borderColor: BD },

  // Rows
  tHead: {
    flexDirection: "row", backgroundColor: YELLOW,
    borderBottomWidth: 1, borderBottomColor: BD,
    minHeight: 22, alignItems: "center",
  },
  tRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5, borderBottomColor: BD,
    minHeight: 22, alignItems: "center",
  },
  tTotalRow: {
    flexDirection: "row",
    borderTopWidth: 1, borderTopColor: "#888",
    minHeight: 24, alignItems: "center",
  },

  // Table columns
  cSr:  { width: "5%",  paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cPo:  { width: "15%", paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cDs:  { width: "30%", paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cSk:  { width: "15%", paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cQt:  { width: "10%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right", borderRightWidth: 0.5, borderRightColor: BD },
  cPr:  { width: "12%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right", borderRightWidth: 0.5, borderRightColor: BD },
  cAm:  { width: "13%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right" },
  thTx: { fontFamily: "Helvetica-Bold", fontSize: 7.5 },
  tdTx: { fontSize: 7.5 },

  // Bottom section
  btm: { marginHorizontal: 20, marginTop: 8, borderWidth: 1, borderColor: BD },
  btmRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5, borderBottomColor: BD, minHeight: 22,
  },
  btmLeft:   { flex: 3, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.5, borderRightColor: BD },
  btmMid:    { flex: 2, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.5, borderRightColor: BD },
  btmRight:  { flex: 2, paddingHorizontal: 8, paddingVertical: 5 },
  btmLabel:  { fontFamily: "Helvetica-Bold", fontSize: 7.5 },
  btmVal:    { fontSize: 7.5 },

  totalHL: {
    flexDirection: "row", backgroundColor: YELLOW, alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: "#888",
  },
  bankHL: {
    backgroundColor: YELLOW, paddingHorizontal: 8, paddingVertical: 5,
    borderTopWidth: 0.5, borderTopColor: BD,
  },
  bankTx:   { fontFamily: "Helvetica-Bold", fontSize: 8 },
  bankBody: { paddingHorizontal: 8, paddingVertical: 5 },
  bankRow:  { flexDirection: "row", marginBottom: 1.5 },
  bankKey:  { fontFamily: "Helvetica-Bold", fontSize: 7.5, width: 70 },
  bankVal:  { fontSize: 7.5, flex: 1 },

  // Declaration
  decl:      { marginHorizontal: 20, marginTop: 8, borderWidth: 1, borderColor: BD, padding: 8 },
  declTitle: { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginBottom: 4 },
  declTxt:   { fontSize: 7, color: "#555", marginBottom: 2 },
})

// ── Document ───────────────────────────────────────────────────────────────────
function PurchaseOrderDoc({ d }: { d: PoEmailData }) {
  const base  = num(d.total_amount)
  const gst   = base > 0 ? Math.round(base * GST_RATE) : 0
  const grand = base + gst
  const lh    = d.letterhead
  const ship  = d.ship_to

  return (
    <Document>
      <Page size="A4" style={S.page}>

        {/* ── Teal header ── */}
        <View style={S.header}>
          <Text style={S.hName}>{lh.name}</Text>
          {lh.address_lines.map((line, i) => (
            <Text key={i} style={S.hSub}>{line}</Text>
          ))}
          {lh.gstin ? <Text style={S.hSub}>GST no- {lh.gstin}</Text> : null}
        </View>

        {/* ── Date ── */}
        <View style={S.dateBar}>
          <Text style={S.dateTxt}>{fmtDate(d.date)}</Text>
        </View>

        {/* ── 3-column info ── */}
        <View style={S.infoWrap}>

          {/* Billing Address — this entity's registration for THIS destination.
              GST is state-wise, so it is per (site, entity), not per entity. */}
          <View style={S.infoCol}>
            <Text style={S.infoTitle}>Billing Address</Text>
            <Text style={S.infoBold}>{lh.name}</Text>
            {lh.address_lines.map((line, i) => (
              <Text key={i} style={S.infoLine}>{line}</Text>
            ))}
            {lh.gstin ? <Text style={S.infoLine}>GST no- {lh.gstin}</Text> : null}
          </View>

          {/* Delivery Address — the consignee. Its GSTIN is deliberately not
              necessarily this entity's: Pep operates most sites, so Kreative
              usually ships under Pep's registration for that state. */}
          <View style={S.infoCol}>
            <Text style={S.infoTitle}>Delivery Address</Text>
            {ship.name
              ? <Text style={S.infoBold}>{ship.name}</Text>
              : <Text style={S.infoLine}>—</Text>}
            {ship.address_lines.map((line, i) => (
              <Text key={i} style={S.infoLine}>{line}</Text>
            ))}
            {ship.gstin ? <Text style={S.infoLine}>GSTIN: {ship.gstin}</Text> : null}
          </View>

          {/* Purchase Order To */}
          <View style={S.infoColL}>
            <Text style={S.infoTitle}>Purchase Order to -</Text>
            <Text style={S.infoBold}>{d.mfg_name}</Text>
            {d.registered_name ? <Text style={S.infoLine}>{d.registered_name}</Text> : null}
            {d.location        ? <Text style={S.infoLine}>{d.location}</Text>        : null}
            {d.gst_number      ? <Text style={S.infoLine}>GSTIN: {d.gst_number}</Text> : null}
            {d.mfg_email       ? <Text style={S.infoLine}>{d.mfg_email}</Text>       : null}
          </View>
        </View>

        {/* ── Table ── */}
        <View style={S.tbl}>

          {/* Header row — yellow */}
          <View style={S.tHead}>
            <Text style={[S.cSr, S.thTx]}>Sr No</Text>
            <Text style={[S.cPo, S.thTx]}>PO Number</Text>
            <Text style={[S.cDs, S.thTx]}>Description of Goods</Text>
            <Text style={[S.cSk, S.thTx]}>SKU Code</Text>
            <Text style={[S.cQt, S.thTx]}>Quantity</Text>
            <Text style={[S.cPr, S.thTx]}>Price</Text>
            <Text style={[S.cAm, S.thTx]}>Amount</Text>
          </View>

          {/* Data row */}
          <View style={S.tRow}>
            <Text style={[S.cSr, S.tdTx]}>1</Text>
            <Text style={[S.cPo, S.tdTx]}>{d.po_no}</Text>
            <Text style={[S.cDs, S.tdTx]}>{d.sku_name ?? "—"}</Text>
            <Text style={[S.cSk, S.tdTx]}>{d.sku_code}</Text>
            <Text style={[S.cQt, S.tdTx]}>{num(d.qty).toLocaleString("en-IN")}</Text>
            <Text style={[S.cPr, S.tdTx]}>{d.unit_price ? fmtN(d.unit_price) : "—"}</Text>
            <Text style={[S.cAm, S.tdTx]}>{base > 0 ? fmtN(base) : "—"}</Text>
          </View>

          {/* Empty rows */}
          {Array.from({ length: EMPTY_ROWS }).map((_, i) => (
            <View key={i} style={S.tRow}>
              <Text style={S.cSr}> </Text>
              <Text style={S.cPo}> </Text>
              <Text style={S.cDs}> </Text>
              <Text style={S.cSk}> </Text>
              <Text style={S.cQt}> </Text>
              <Text style={S.cPr}> </Text>
              <Text style={S.cAm}> </Text>
            </View>
          ))}

          {/* Total row */}
          <View style={S.tTotalRow}>
            <Text style={[S.cSr, S.tdTx]}> </Text>
            <Text style={[S.cPo, S.tdTx]}> </Text>
            <Text style={[S.cDs, S.tdTx]}> </Text>
            <Text style={[S.cSk, S.thTx]}>Total</Text>
            <Text style={[S.cQt, S.thTx]}>{num(d.qty).toLocaleString("en-IN")}</Text>
            <Text style={[S.cPr, S.tdTx]}> </Text>
            <Text style={[S.cAm, S.thTx]}>{base > 0 ? fmtN(base) : "—"}</Text>
          </View>
        </View>

        {/* ── Bottom: Dispatch / GST ── */}
        <View style={S.btm}>

          {/* Row 1: Dispatch Date | "Value" | "Tax" */}
          <View style={S.btmRow}>
            <View style={S.btmLeft}>
              <Text style={S.btmLabel}>Dispatch Date</Text>
              <Text style={S.btmVal}>{fmtDate(d.expected_on)}</Text>
            </View>
            <View style={S.btmMid}>
              <Text style={S.btmLabel}>Value</Text>
            </View>
            <View style={S.btmRight}>
              <Text style={S.btmLabel}>Tax</Text>
            </View>
          </View>

          {/* Row 2: (empty) | "GST As applicable" | 18% amount */}
          <View style={S.btmRow}>
            <View style={S.btmLeft} />
            <View style={S.btmMid}>
              <Text style={S.btmVal}>GST As applicable</Text>
            </View>
            <View style={S.btmRight}>
              <Text style={[S.btmVal, { textAlign: "right", fontFamily: "Helvetica-Bold", color: TEAL }]}>
                {gst > 0 ? fmtN(gst) : "—"}
              </Text>
            </View>
          </View>

          {/* Row 3: Total — yellow highlight */}
          <View style={S.totalHL}>
            <Text style={{ flex: 1, fontFamily: "Helvetica-Bold", fontSize: 8 }}>Total</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8, marginRight: 20 }}>{GST_RATE * 100}%</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 9, color: TEAL }}>
              {grand > 0 ? fmtN(grand) : "—"}
            </Text>
          </View>

          {/* Company Bank Details — the heading alone when the entity has no bank on
              file, which is how this band shipped for months. resolveBank returns
              null unless name, A/C and IFSC are all present, so a half-filled block
              is never printed. */}
          <View style={S.bankHL}>
            <Text style={S.bankTx}>Company Bank Details</Text>
          </View>
          {lh.bank ? (
            <View style={S.bankBody}>
              <View style={S.bankRow}>
                <Text style={S.bankKey}>Bank</Text>
                <Text style={S.bankVal}>{lh.bank.name}</Text>
              </View>
              <View style={S.bankRow}>
                <Text style={S.bankKey}>A/C No.</Text>
                <Text style={S.bankVal}>{lh.bank.account_no}</Text>
              </View>
              <View style={S.bankRow}>
                <Text style={S.bankKey}>IFSC</Text>
                <Text style={S.bankVal}>{lh.bank.ifsc}</Text>
              </View>
              {lh.bank.branch ? (
                <View style={S.bankRow}>
                  <Text style={S.bankKey}>Branch</Text>
                  <Text style={S.bankVal}>{lh.bank.branch}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* ── Declaration ── */}
        <View style={S.decl}>
          <Text style={S.declTitle}>Declaration</Text>
          <Text style={S.declTxt}>
            We declare that this purchase order the actual price of the goods described
            and that all particulars are true and correct.
          </Text>
        </View>

      </Page>
    </Document>
  )
}

export async function generatePoPdf(data: PoEmailData): Promise<Buffer> {
  const buf = await renderToBuffer(<PurchaseOrderDoc d={data} />)
  return Buffer.from(buf)
}
