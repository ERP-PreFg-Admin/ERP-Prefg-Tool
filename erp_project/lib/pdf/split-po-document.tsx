/**
 * The purchase order document for a SPLIT PO.
 *
 * A variant of lib/pdf/po-document.tsx, not a second design: same letterhead, same
 * three info columns, same totals band, same bank block and declaration. Three
 * things differ, all of them from the printed sample this was built against
 * (MPO-OO113186-2_MUM_HAIR_SPRAY_20ML.pdf):
 *
 *   1. The PO number sits in the header beside the date, not in a table column —
 *      a split's table has one line and the number belongs to the document.
 *   2. `Split of <parent PO>` under it. This is the whole reason the split gets
 *      its own document: the manufacturer already holds paperwork for the order
 *      this came off, and that number is what lets them reconcile the two.
 *   3. The SKU column is headed `Description`, matching the sample.
 *
 * The colours, GST rate, padding-row count and number/date helpers are IMPORTED
 * from po-document.tsx rather than restated. Two copies of GST_RATE is how one
 * document silently stops agreeing with the other about a total.
 *
 * Like its sibling this file only renders: `letterhead` and `ship_to` arrive
 * already resolved by lib/pdf/po-letterhead.ts, which stays the only place the
 * fallback ladder lives.
 *
 * The sample also carries a `CIN NO.` on the vendor block. There is no CIN column
 * anywhere — details_mfg has registered_name, gst_number and location — so it is
 * omitted rather than printed as an empty label. Adding it is a details_mfg
 * change first.
 */

import React from "react"
import {
  Document, Page, Text, View, StyleSheet, Font, renderToBuffer,
} from "@react-pdf/renderer"
import {
  type PoEmailData,
  TEAL, YELLOW, BD, GST_RATE, EMPTY_ROWS,
  num, fmtN, fmtDate,
} from "@/lib/pdf/po-document"

// Same reason as the ordinary document: react-pdf only breaks at whitespace, so
// one long unbroken token (a PO code, an account number) overflows its column.
Font.registerHyphenationCallback((word) => Array.from(word))

const S = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 8, color: "#222", backgroundColor: "#fff" },

  header:  { backgroundColor: TEAL, paddingVertical: 12, paddingHorizontal: 20, alignItems: "center" },
  hName:   { fontFamily: "Helvetica-Bold", fontSize: 11, color: "#fff", marginBottom: 2 },
  hSub:    { fontSize: 8, color: "#cde8e8", marginBottom: 1 },

  // PO number left, date right — the sample's own arrangement. The parent PO goes
  // on its own line beneath, where it can't be mistaken for this PO's number.
  refBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 6,
  },
  refPo:   { fontFamily: "Helvetica-Bold", fontSize: 9 },
  refDate: { fontFamily: "Helvetica-Bold", fontSize: 8 },
  splitOf: {
    paddingHorizontal: 20, paddingTop: 2, paddingBottom: 5,
    borderBottomWidth: 1, borderBottomColor: BD,
  },
  splitOfTx: { fontSize: 7.5, color: TEAL, fontFamily: "Helvetica-Bold" },

  infoWrap: {
    flexDirection: "row", marginHorizontal: 20, marginTop: 8,
    borderWidth: 1, borderColor: BD,
  },
  infoCol:   { flex: 1, padding: 8, borderRightWidth: 1, borderRightColor: BD },
  infoColL:  { flex: 1, padding: 8 },
  infoTitle: { fontFamily: "Helvetica-Bold", fontSize: 8, marginBottom: 4, borderBottomWidth: 0.5, borderBottomColor: BD, paddingBottom: 2 },
  infoLine:  { fontSize: 7.5, marginBottom: 1.5 },
  infoBold:  { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginBottom: 1.5 },

  tbl: { marginHorizontal: 20, marginTop: 10, borderWidth: 1, borderColor: BD },
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

  // Wider goods column than the ordinary document: dropping the PO Number column
  // frees 15% and the product description is what actually needs the room.
  cSr: { width: "6%",  paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cDs: { width: "38%", paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cSk: { width: "20%", paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.5, borderRightColor: BD },
  cQt: { width: "11%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right", borderRightWidth: 0.5, borderRightColor: BD },
  cPr: { width: "12%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right", borderRightWidth: 0.5, borderRightColor: BD },
  cAm: { width: "13%", paddingHorizontal: 4, paddingVertical: 3, textAlign: "right" },
  thTx: { fontFamily: "Helvetica-Bold", fontSize: 7.5 },
  tdTx: { fontSize: 7.5 },

  btm: { marginHorizontal: 20, marginTop: 8, borderWidth: 1, borderColor: BD },
  btmRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5, borderBottomColor: BD, minHeight: 22,
  },
  btmLeft:  { flex: 3, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.5, borderRightColor: BD },
  btmMid:   { flex: 2, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.5, borderRightColor: BD },
  btmRight: { flex: 2, paddingHorizontal: 8, paddingVertical: 5 },
  btmLabel: { fontFamily: "Helvetica-Bold", fontSize: 7.5 },
  btmVal:   { fontSize: 7.5 },

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

  decl:      { marginHorizontal: 20, marginTop: 8, borderWidth: 1, borderColor: BD, padding: 8 },
  declTitle: { fontFamily: "Helvetica-Bold", fontSize: 7.5, marginBottom: 4 },
  declTxt:   { fontSize: 7, color: "#555", marginBottom: 2 },
})

function SplitPurchaseOrderDoc({ d }: { d: PoEmailData }) {
  const base  = num(d.total_amount)
  const gst   = base > 0 ? Math.round(base * GST_RATE) : 0
  const grand = base + gst
  const lh    = d.letterhead
  const ship  = d.ship_to

  return (
    <Document>
      <Page size="A4" style={S.page}>

        <View style={S.header}>
          <Text style={S.hName}>{lh.name}</Text>
          {lh.address_lines.map((line, i) => (
            <Text key={i} style={S.hSub}>{line}</Text>
          ))}
          {lh.gstin ? <Text style={S.hSub}>GST no- {lh.gstin}</Text> : null}
        </View>

        <View style={S.refBar}>
          <Text style={S.refPo}>{d.po_no}</Text>
          <Text style={S.refDate}>{fmtDate(d.date)}</Text>
        </View>
        <View style={S.splitOf}>
          {/* Rendered even when reference_po is somehow null: this template is
              only ever used for a split, so a missing parent is a data problem
              worth showing rather than a line to quietly drop. */}
          <Text style={S.splitOfTx}>Split of {d.reference_po ?? "—"}</Text>
        </View>

        <View style={S.infoWrap}>
          <View style={S.infoCol}>
            <Text style={S.infoTitle}>Billing Address</Text>
            <Text style={S.infoBold}>{lh.name}</Text>
            {lh.address_lines.map((line, i) => (
              <Text key={i} style={S.infoLine}>{line}</Text>
            ))}
            {lh.gstin ? <Text style={S.infoLine}>GST no- {lh.gstin}</Text> : null}
          </View>

          {/* The consignee's own GSTIN, which is deliberately not necessarily this
              entity's — Pep operates most sites, so Kreative rows usually ship
              under Pep's registration for that state. */}
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

          <View style={S.infoColL}>
            <Text style={S.infoTitle}>Purchase Order to -</Text>
            <Text style={S.infoBold}>{d.mfg_name}</Text>
            {d.registered_name ? <Text style={S.infoLine}>{d.registered_name}</Text> : null}
            {d.location        ? <Text style={S.infoLine}>{d.location}</Text>        : null}
            {d.gst_number      ? <Text style={S.infoLine}>GSTIN: {d.gst_number}</Text> : null}
            {d.mfg_email       ? <Text style={S.infoLine}>{d.mfg_email}</Text>       : null}
          </View>
        </View>

        <View style={S.tbl}>
          <View style={S.tHead}>
            <Text style={[S.cSr, S.thTx]}>Sr No</Text>
            <Text style={[S.cDs, S.thTx]}>Description of Goods</Text>
            <Text style={[S.cSk, S.thTx]}>Description</Text>
            <Text style={[S.cQt, S.thTx]}>Quantity</Text>
            <Text style={[S.cPr, S.thTx]}>Price</Text>
            <Text style={[S.cAm, S.thTx]}>Amount</Text>
          </View>

          <View style={S.tRow}>
            <Text style={[S.cSr, S.tdTx]}>1</Text>
            <Text style={[S.cDs, S.tdTx]}>{d.sku_name ?? "—"}</Text>
            <Text style={[S.cSk, S.tdTx]}>{d.sku_code}</Text>
            <Text style={[S.cQt, S.tdTx]}>{num(d.qty).toLocaleString("en-IN")}</Text>
            <Text style={[S.cPr, S.tdTx]}>{d.unit_price ? fmtN(d.unit_price) : "—"}</Text>
            <Text style={[S.cAm, S.tdTx]}>{base > 0 ? fmtN(base) : "—"}</Text>
          </View>

          {Array.from({ length: EMPTY_ROWS }).map((_, i) => (
            <View key={i} style={S.tRow}>
              <Text style={S.cSr}> </Text>
              <Text style={S.cDs}> </Text>
              <Text style={S.cSk}> </Text>
              <Text style={S.cQt}> </Text>
              <Text style={S.cPr}> </Text>
              <Text style={S.cAm}> </Text>
            </View>
          ))}

          <View style={S.tTotalRow}>
            <Text style={[S.cSr, S.tdTx]}> </Text>
            <Text style={[S.cDs, S.tdTx]}> </Text>
            <Text style={[S.cSk, S.thTx]}>Total</Text>
            <Text style={[S.cQt, S.thTx]}>{num(d.qty).toLocaleString("en-IN")}</Text>
            <Text style={[S.cPr, S.tdTx]}> </Text>
            <Text style={[S.cAm, S.thTx]}>{base > 0 ? fmtN(base) : "—"}</Text>
          </View>
        </View>

        <View style={S.btm}>
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

          <View style={S.totalHL}>
            <Text style={{ flex: 1, fontFamily: "Helvetica-Bold", fontSize: 8 }}>Total</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8, marginRight: 20 }}>{GST_RATE * 100}%</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 9, color: TEAL }}>
              {grand > 0 ? fmtN(grand) : "—"}
            </Text>
          </View>

          {/* Heading always, block only when resolveBank returned something — it
              is all-or-nothing by design, so a half-filled bank block can't print. */}
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

export async function generateSplitPoPdf(data: PoEmailData): Promise<Buffer> {
  const buf = await renderToBuffer(<SplitPurchaseOrderDoc d={data} />)
  return Buffer.from(buf)
}
