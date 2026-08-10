import React from "react"
import {
  Document, Page, Text, View, StyleSheet, Font, renderToBuffer,
} from "@react-pdf/renderer"
import { IST } from "@/lib/date"

// react-pdf only wraps text at whitespace by default, so a long unbroken
// token (e.g. a long PO code) overflows its column into the next one.
// Allow breaking at any character when a word doesn't fit.
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
}

// ── Brand constants ────────────────────────────────────────────────────────────
const COMPANY = {
  name:  "Pep Technologies Pvt Ltd, MCaffeine",
  addr1: "A1 304, Kanakia Boomerang, Chandivali, Andheri (E),",
  addr2: "Mumbai 400072",
  gst:   "GST no- 27AAICP2804J1ZC",
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
  bankTx: { fontFamily: "Helvetica-Bold", fontSize: 8 },

  // Declaration
  decl:      { marginHorizontal: 20, marginTop: 8, borderWidth: 1, borderColor: BD, padding: 8 },
  declTitle: { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginBottom: 4 },
  declTxt:   { fontSize: 7, color: "#555", marginBottom: 2 },
})

// ── Document ───────────────────────────────────────────────────────────────────
function PurchaseOrderDoc({ d }: { d: PoEmailData }) {
  const base = num(d.total_amount)
  const gst  = base > 0 ? Math.round(base * GST_RATE) : 0
  const grand = base + gst

  return (
    <Document>
      <Page size="A4" style={S.page}>

        {/* ── Teal header ── */}
        <View style={S.header}>
          <Text style={S.hName}>{COMPANY.name}</Text>
          <Text style={S.hSub}>{COMPANY.addr1}</Text>
          <Text style={S.hSub}>{COMPANY.addr2}</Text>
          <Text style={S.hSub}>{COMPANY.gst}</Text>
        </View>

        {/* ── Date ── */}
        <View style={S.dateBar}>
          <Text style={S.dateTxt}>{fmtDate(d.date)}</Text>
        </View>

        {/* ── 3-column info ── */}
        <View style={S.infoWrap}>

          {/* Billing Address */}
          <View style={S.infoCol}>
            <Text style={S.infoTitle}>Billing Address</Text>
            <Text style={S.infoBold}>{COMPANY.name}</Text>
            <Text style={S.infoLine}>{COMPANY.addr1}</Text>
            <Text style={S.infoLine}>{COMPANY.addr2}</Text>
            <Text style={S.infoLine}>{COMPANY.gst}</Text>
          </View>

          {/* Delivery Address */}
          <View style={S.infoCol}>
            <Text style={S.infoTitle}>Delivery Address</Text>
            {d.destination
              ? <Text style={S.infoBold}>{d.destination}</Text>
              : <Text style={S.infoLine}>—</Text>}
            {d.dest_location ? <Text style={S.infoLine}>{d.dest_location}</Text> : null}
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

          {/* Row 2: (empty) | "GST As applicable" | "18%" */}
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
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8, marginRight: 20 }}>18%</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 9, color: TEAL }}>
              {grand > 0 ? fmtN(grand) : "—"}
            </Text>
          </View>

          {/* Company Bank Details */}
          <View style={S.bankHL}>
            <Text style={S.bankTx}>Company Bank Details</Text>
          </View>
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
