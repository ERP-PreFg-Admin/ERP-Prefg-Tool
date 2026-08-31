"use client"

/**
 * Ask the Unicommerce tenant what POs it holds at a facility, and what has been
 * received against them.
 *
 * Read-only, and nothing is stored — this is the in-app equivalent of
 * check_uniware_apis/po_grn.py, which is a scratch script on one laptop.
 *
 * The column that earns this screen is GRNs. Our own views only show POs WE
 * mirrored and only what the invoice claimed, so "which POs actually have a
 * goods receipt, and did anything get rejected" has no answer anywhere else.
 * Expanding a row shows that receipt UNMAPPED — the field names exactly as
 * Uniware returns them.
 */

import { Fragment, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { IST } from "@/lib/date"

export type FacilityOption = { code: string; label: string }

type ExploredPo = {
  code: string
  status: string | null
  createdAt: string | null
  grnCount: number
  lineCount: number
  qty: number
  pendingQty: number
  receivedQty: number
  qcPassQty: number
  rejectedQty: number
  skus: string[]
  vendorCode: string | null
  error?: string
}

type ExploreResult = {
  requestedFacility: string
  effectiveFacility: string
  days: number
  totalCodes: number
  truncated: boolean
  limit: number
  pos: ExploredPo[]
}

type RawPoDetail = {
  code: string
  headerKeys: string[]
  itemKeys: string[]
  header: Record<string, unknown>
  items: Record<string, unknown>[]
}

type PoPayload = { detail: RawPoDetail | null; grns: RawGrn[] }

type RawGrn = {
  code: string
  headerKeys: string[]
  itemKeys: string[]
  header: Record<string, unknown>
  items: Record<string, unknown>[]
}

const fmtInt = (v: number) => Number(v ?? 0).toLocaleString("en-IN")

function fmtWhen(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: IST,
  })
}

/** Renders any JSON scalar/shape compactly — this screen shows unmapped data. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/**
 * Fields Uniware returns as epoch MILLISECONDS. Shown as a date beside the raw
 * number rather than instead of it: the number is the thing to quote when
 * something is wrong, and treating it as an ISO string silently yields nonsense
 * — which is how po_grn.py's FINDINGS came to record it in the first place.
 */
const MILLIS_FIELDS = new Set(["created", "updated", "receivedOn", "statusUpdated"])

/**
 * The fields worth reading by default, in the order they make sense in.
 *
 * The endpoints return 31 header fields and ~50 per line — tax splits, image
 * URLs, tolerance settings, approval audits. Almost none of it is what anyone
 * opens this screen for, and burying `rejectedQuantity` among fifty columns is
 * the same as not showing it.
 *
 * A shortlist, NOT a mapper: everything else is one click away, and a field
 * missing from the payload is called out rather than silently omitted (see
 * `absent` below). That is what keeps this safe while the receipt shape is
 * still unconfirmed — hiding a renamed field is exactly the failure the strict
 * mapper in lib/uniware/grn-map.ts exists to prevent.
 */
const PO_HEADER_FIELDS = [
  "code", "statusCode", "vendorCode", "vendorName", "created", "createdBy",
  "deliveryDate", "inflowReceiptsCount", "tolerancePercentage",
]
const PO_ITEM_FIELDS = [
  "itemSKU", "itemTypeName", "quantity", "pendingQuantity",
  "receivedQuantity", "qcPassQuantity", "rejectedQuantity", "unitPrice", "total",
]

/** Per the FINDINGS block in check_uniware_apis/po_grn.py — still unconfirmed live. */
const GRN_HEADER_FIELDS = ["statusCode", "vendorInvoiceNumber", "created"]
const GRN_ITEM_FIELDS = [
  "itemSKU", "quantity", "rejectedQuantity", "batchCode", "expiry", "manufacturingDate",
]

/**
 * One record: its header fields, then its lines.
 *
 * Shared by the purchase order and each goods receipt — they are the same shape
 * of thing, a header plus an item array, and showing them identically is what
 * makes the pair comparable.
 *
 * Shows the shortlist by default and everything on request. Neither view maps
 * or renames anything: the keys are Uniware's own, which is what makes this
 * usable for confirming a shape as well as reading a number.
 */
function RawBlock({
  title, subtitle, itemKeys, header, items, itemsLabel,
  headerFields, itemFields,
}: {
  title: string
  subtitle: string
  itemKeys: string[]
  header: Record<string, unknown>
  items: Record<string, unknown>[]
  itemsLabel: string
  headerFields: string[]
  itemFields: string[]
}) {
  const [showAll, setShowAll] = useState(false)

  const allHeaderKeys = Object.keys(header)
  const shownHeader = showAll
    ? allHeaderKeys
    : headerFields.filter((k) => k in header)
  const shownItemCols = showAll
    ? itemKeys
    : itemFields.filter((k) => itemKeys.includes(k))

  // Expected but not returned. The whole reason the shortlist is safe: a
  // renamed field shows up here instead of quietly disappearing.
  const absent = [
    ...headerFields.filter((k) => !(k in header)),
    ...(items.length > 0 ? itemFields.filter((k) => !itemKeys.includes(k)) : []),
  ]

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs font-medium">{title}</span>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:bg-accent hover:text-foreground"
        >
          {showAll
            ? "Show key fields"
            : `Show all fields (${allHeaderKeys.length} header · ${itemKeys.length} per line)`}
        </button>
      </div>

      {absent.length > 0 && (
        <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-400">
          Expected but not returned: <span className="font-mono">{absent.join(", ")}</span>
          {" — the field may have been renamed."}
        </p>
      )}

      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {shownHeader.map((k) => (
          <div key={k} className="flex items-baseline gap-1.5 text-[11px]">
            <span className="shrink-0 text-muted-foreground">{k}</span>
            <span className="truncate font-mono" title={cell(header[k])}>
              {cell(header[k])}
              {MILLIS_FIELDS.has(k) && Number(header[k]) > 0 && (
                <span className="ml-1 text-muted-foreground">
                  ({fmtWhen(new Date(Number(header[k])).toISOString())})
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {items.length > 0 && shownItemCols.length > 0 && (
        <>
          <div className="mt-3 mb-1.5 text-[11px] font-medium text-muted-foreground">
            {itemsLabel} ({items.length})
          </div>
          {/* Its own scroller: the full view is 40+ columns, and letting the page
              scroll sideways instead would drag the whole table with it. */}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[11px]">
              <thead className="bg-muted/50">
                <tr>
                  {shownItemCols.map((k) => (
                    <th key={k} className="whitespace-nowrap px-2 py-1 text-left font-medium">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-border">
                    {shownItemCols.map((k) => (
                      <td key={k} className="whitespace-nowrap px-2 py-1 font-mono">{cell(it[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export default function UniwareExplorerClient() {
  // A shortcut for the input, never a restriction — the tenant has facilities
  // our warehouse master does not know about, so the box stays free text.
  // Failing to load it is not worth an error: you can still type a code.
  const [facilities, setFacilities] = useState<FacilityOption[]>([])
  useEffect(() => {
    fetch("/api/v1/uniware/explorer/facilities")
      .then((r) => (r.ok ? r.json() : { facilities: [] }))
      .then((d) => setFacilities(d.facilities ?? []))
      .catch(() => {})
  }, [])

  const [facility, setFacility] = useState("")
  const [days, setDays] = useState("30")
  const [limit, setLimit] = useState("25")

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<ExploreResult | null>(null)

  // Fetched per PO on expand, not with the list: the full field set is large
  // and the receipt walk is 1+N more round trips on top.
  const [openPo, setOpenPo] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, PoPayload | "loading" | { error: string }>>({})

  async function run() {
    setLoading(true)
    setError("")
    setResult(null)
    setDetail({})
    setOpenPo(null)
    try {
      const qs = new URLSearchParams({ facility, days, limit })
      const res = await fetch(`/api/v1/uniware/explorer?${qs}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Uniware did not answer."); return }
      setResult(data as ExploreResult)
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function toggleDetail(code: string) {
    if (openPo === code) { setOpenPo(null); return }
    setOpenPo(code)
    if (detail[code] && detail[code] !== "loading") return

    setDetail((d) => ({ ...d, [code]: "loading" }))
    try {
      const qs = new URLSearchParams({ facility, po: code })
      const res = await fetch(`/api/v1/uniware/explorer?${qs}`)
      const data = await res.json()
      setDetail((d) => ({
        ...d,
        [code]: res.ok
          ? { detail: (data.detail as RawPoDetail) ?? null, grns: (data.grns as RawGrn[]) ?? [] }
          : { error: data.error ?? "Failed to read this purchase order." },
      }))
    } catch {
      setDetail((d) => ({ ...d, [code]: { error: "Network error." } }))
    }
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ue-facility">Facility</Label>
            <Input
              id="ue-facility"
              list="ue-facilities"
              value={facility}
              onChange={(e) => setFacility(e.target.value)}
              placeholder="e.g. MUM_WAREHOUSE2"
              className="w-64 font-mono text-xs"
            />
            {/* A datalist, not a Select: the tenant has facilities our warehouse
                master does not know about, so the list is a shortcut and never
                a restriction. */}
            <datalist id="ue-facilities">
              {facilities.map((f) => (
                <option key={f.code} value={f.code}>{f.label}</option>
              ))}
            </datalist>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ue-days">Days</Label>
            <Input
              id="ue-days" type="number" min={1} max={400}
              value={days} onChange={(e) => setDays(e.target.value)}
              className="w-24 tabular-nums"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ue-limit">Detail limit</Label>
            <Input
              id="ue-limit" type="number" min={1} max={100}
              value={limit} onChange={(e) => setLimit(e.target.value)}
              className="w-28 tabular-nums"
            />
          </div>

          <Button onClick={run} disabled={loading}>
            {loading
              ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Asking Uniware…</>
              : <><Search className="mr-1.5 h-3.5 w-3.5" /> Fetch</>}
          </Button>

          <p className="w-full text-[11px] text-muted-foreground">
            One outbound call per PO, so <span className="font-medium">Detail limit</span> is
            this run&apos;s budget. The window itself is not capped — anything beyond the
            limit is reported, never silently dropped. The facility is sent exactly as
            typed, on every environment: this screen reads and never writes, so it is
            not subject to the sandbox pin the write paths use.
          </p>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border py-2 text-xs">
            <span>
              <span className="font-mono text-sm tabular-nums">{fmtInt(result.totalCodes)}</span>
              <span className="ml-1.5 text-muted-foreground">
                PO{result.totalCodes === 1 ? "" : "s"} in {result.days} days at{" "}
                <span className="font-mono">{result.effectiveFacility}</span>
              </span>
            </span>
            {result.truncated && (
              <span className="text-amber-700 dark:text-amber-400">
                showing the first {result.limit} — raise the detail limit to see more
              </span>
            )}
            <span className="text-muted-foreground">
              {result.pos.filter((p) => p.grnCount > 0).length} with a goods receipt
            </span>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/40 [&_tr]:border-b [&_tr]:border-border">
                  <TableRow>
                    <TableHead className="w-7 px-1" />
                    <TableHead>PO Code</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    {/* Straight off the PO's own line items — no GRN needed. */}
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">QC Pass</TableHead>
                    <TableHead className="text-right">Rejected</TableHead>
                    <TableHead className="text-right">GRNs</TableHead>
                    <TableHead>SKUs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.pos.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={13} className="py-10 text-center">
                        <EmptyState message="No purchase orders in that window at this facility." />
                      </TableCell>
                    </TableRow>
                  ) : result.pos.map((p) => {
                    const open = openPo === p.code
                    const payload = detail[p.code]
                    return (
                      // The Fragment carries the key: the array element is the
                      // PO row PLUS its expanded receipts, not a single row, and
                      // the <> shorthand cannot take one — which is how the key
                      // ended up on the inner rows where React never looks.
                      // Same shape as PoTable.tsx's master + split children.
                      <Fragment key={p.code}>
                        <TableRow className={cn(p.error && "opacity-60")}>
                          <TableCell className="w-7 px-1">
                            {/* Every row expands, not only those with receipts:
                                the PO's own fields are worth reading on their
                                own, and a chevron that appears only sometimes
                                reads as "nothing here" for the rest. */}
                            <button
                              type="button"
                              onClick={() => toggleDetail(p.code)}
                              aria-expanded={open}
                              aria-label={`${open ? "Hide" : "Show"} the full detail of ${p.code}`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs font-medium">{p.code}</TableCell>
                          <TableCell className="text-xs">
                            {p.error
                              ? <span className="text-destructive" title={p.error}>error</span>
                              : <Badge variant="secondary">{p.status ?? "—"}</Badge>}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{fmtWhen(p.createdAt)}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{p.vendorCode ?? "—"}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{p.lineCount}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{fmtInt(p.qty)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtInt(p.pendingQty)}</TableCell>
                          <TableCell className={cn(
                            "text-right text-xs tabular-nums",
                            p.receivedQty > 0 ? "font-medium" : "text-muted-foreground"
                          )}>
                            {fmtInt(p.receivedQty)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtInt(p.qcPassQty)}</TableCell>
                          {/* The number this screen exists to surface — coloured
                              only when there is something to see. */}
                          <TableCell className={cn(
                            "text-right text-xs tabular-nums",
                            p.rejectedQty > 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                          )}>
                            {fmtInt(p.rejectedQty)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {p.grnCount > 0
                              ? <Badge variant="success">{p.grnCount}</Badge>
                              : <span className="text-muted-foreground">0</span>}
                          </TableCell>
                          <TableCell className="max-w-48 truncate font-mono text-[11px] text-muted-foreground" title={p.skus.join(", ")}>
                            {p.skus.join(", ") || "—"}
                          </TableCell>
                        </TableRow>

                        {open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={13} className="p-4">
                              {payload === "loading" && (
                                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading from Uniware…
                                </span>
                              )}
                              {payload && typeof payload === "object" && "error" in payload && (
                                <span className="text-xs text-destructive">{payload.error}</span>
                              )}
                              {payload && typeof payload === "object" && "detail" in payload && (
                                <div className="space-y-4">
                                  {/* ── The purchase order itself ──────────────
                                      Every field Uniware returns, as it names
                                      them. This screen reports rather than
                                      judges — lib/uniware/grn-map.ts is the
                                      strict one, and mapping here would hide
                                      exactly the fields you opened this to see. */}
                                  {payload.detail && (
                                    <RawBlock
                                      title="Purchase order"
                                      subtitle={`${payload.detail.items.length} line(s)`}
                                      itemKeys={payload.detail.itemKeys}
                                      headerFields={PO_HEADER_FIELDS}
                                      itemFields={PO_ITEM_FIELDS}
                                      header={payload.detail.header}
                                      items={payload.detail.items}
                                      itemsLabel="Line items"
                                    />
                                  )}

                                  {/* ── Goods receipts ────────────────────────
                                      Absent is a real answer, and a common one:
                                      inflowReceiptsCount 0 means nothing has
                                      been received, however approved the PO
                                      looks. Saying so beats an empty space. */}
                                  <div>
                                    <div className="mb-1.5 text-xs font-semibold">
                                      Goods receipts
                                      <span className="ml-1.5 font-normal text-muted-foreground">
                                        {payload.grns.length === 0
                                          ? "none — nothing has been received against this PO yet"
                                          : `${payload.grns.length} receipt(s)`}
                                      </span>
                                    </div>
                                    {payload.grns.map((g) => (
                                      <RawBlock
                                        key={g.code}
                                        title={g.code}
                                        subtitle={`${g.items.length} line(s)`}
                                        itemKeys={g.itemKeys}
                                        headerFields={GRN_HEADER_FIELDS}
                                        itemFields={GRN_ITEM_FIELDS}
                                        header={g.header}
                                        items={g.items}
                                        itemsLabel="Receipt lines"
                                      />
                                    ))}
                                  </div>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
