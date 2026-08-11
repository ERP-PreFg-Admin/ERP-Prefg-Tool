// TEMPORARY — dev-only comparison harness for the local parser vs Nanonets.
// Returns 404 in production. Delete once the local parser is wired into the
// parse route and this has served its purpose.

export const runtime = "nodejs"
export const maxDuration = 300

import { NextResponse } from "next/server"
import { parseInvoice, strategyFor, configFor } from "@/lib/nanonets"
import { detectFromPdf } from "@/lib/invoice-detect"
import { parseLocallyVerbose } from "@/lib/invoice-local"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"

const MAX_BYTES = 10 * 1024 * 1024

const HEADER_FIELDS = [
  "invoice_number", "date", "from", "total_amount", "seller_gstin", "buyer_gstin",
  "eway_bill_number", "purchase_order", "destination", "vehicle_number",
  "bill_to_name", "bill_to_gstin", "bill_to_state", "ship_to_name",
] as const

const LINE_FIELDS = [
  "sku_code", "sku_name", "qty", "rate", "amount", "hsn", "mrp",
  "gst_percent", "batch", "mfg_date", "expiry", "total_amount",
] as const

type Cell = { field: string; local: unknown; remote: unknown; same: boolean }

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v))
const same = (a: unknown, b: unknown) => show(a).trim().toLowerCase() === show(b).trim().toLowerCase()

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!))
}

function headerCells(local: ParsedInvoice | null, remote: ParsedInvoice | null): Cell[] {
  return HEADER_FIELDS.map((f) => ({
    field: f,
    local: local?.[f] ?? null,
    remote: remote?.[f] ?? null,
    same: same(local?.[f], remote?.[f]),
  }))
}

function lineCells(local?: ParsedLineItem, remote?: ParsedLineItem): Cell[] {
  return LINE_FIELDS.map((f) => ({
    field: f,
    local: local?.[f] ?? null,
    remote: remote?.[f] ?? null,
    same: same(local?.[f], remote?.[f]),
  }))
}

function table(cells: Cell[], showRemote: boolean) {
  const head = showRemote
    ? "<tr><th>field</th><th>local (free)</th><th>Nanonets</th><th></th></tr>"
    : "<tr><th>field</th><th>local (free)</th></tr>"

  const body = cells.map((c) => {
    const cls = !showRemote ? "" : c.same ? "ok" : "bad"
    return showRemote
      ? `<tr class="${cls}"><td>${esc(c.field)}</td><td>${esc(show(c.local))}</td><td>${esc(show(c.remote))}</td><td>${c.same ? "=" : "≠"}</td></tr>`
      : `<tr><td>${esc(c.field)}</td><td>${esc(show(c.local))}</td></tr>`
  }).join("")

  return `<table>${head}${body}</table>`
}

const STYLE = `
  body { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 68rem; margin: 2rem auto; padding: 0 1rem; }
  h1, h2 { font-family: system-ui, sans-serif; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
  th, td { border: 1px solid #ddd; padding: .3rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-family: system-ui, sans-serif; }
  tr.bad td { background: #fef2f2; }
  tr.bad td:first-child { font-weight: 600; }
  tr.ok td { background: #f0fdf4; }
  .note { font-family: system-ui, sans-serif; background: #f4f4f5; padding: .75rem 1rem; border-radius: 6px; }
  .fail { background: #fef2f2; }
  a { font-family: system-ui, sans-serif; }
`

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found.", { status: 404 })
  }

  return new NextResponse(
    `<!doctype html>
<meta charset="utf-8">
<title>Invoice parser comparison</title>
<style>${STYLE}
  label { display: block; margin: .75rem 0; font-family: system-ui, sans-serif; }
  button { padding: .5rem 1rem; font-size: 1rem; cursor: pointer; }
</style>
<h1>Invoice parser comparison</h1>
<form method="POST" enctype="multipart/form-data">
  <label>Invoice PDF<br><input type="file" name="file" accept=".pdf" required></label>
  <label><input type="checkbox" name="nanonets" value="1"> Also run Nanonets — costs one metered call and ~60s</label>
  <button type="submit">Compare</button>
</form>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  )
}

export const POST = withGateway({
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ req }) => {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(404, "not_found", "Not found.")
    }

    const form = await req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) throw new ApiError(400, "validation_error", "No PDF was received.")
    if (file.size === 0) throw new ApiError(400, "validation_error", "That file is empty.")
    if (file.size > MAX_BYTES) throw new ApiError(400, "validation_error", "That file is over the 10 MB limit.")

    const filename = file.name || "invoice.pdf"
    const buffer = Buffer.from(await file.arrayBuffer())
    const withNanonets = String(form?.get("nanonets") ?? "") === "1"

    const t0 = Date.now()
    const { text, sellerGstins, mfg } = await detectFromPdf(buffer)
    const strategy = strategyFor(sellerGstins)
    const detectMs = Date.now() - t0

    const t1 = Date.now()
    const localResult = parseLocallyVerbose(text)
    const localMs = Date.now() - t1
    const local = localResult.ok ? localResult.parsed : null

    let remote: ParsedInvoice | null = null
    let remoteMs = 0
    let remoteError: string | null = null

    if (withNanonets) {
      const t2 = Date.now()
      try {
        remote = await parseInvoice(buffer, filename, configFor(strategy))
      } catch (err) {
        remoteError = err instanceof Error ? err.message : String(err)
      }
      remoteMs = Date.now() - t2
    }

    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html")

    if (!wantsHtml) {
      return NextResponse.json({
        filename,
        detected: { mfg: mfg ? `${mfg.code} — ${mfg.name}` : null, strategy: strategy?.label ?? "base", ms: detectMs },
        local: { ...localResult, ms: localMs },
        nanonets: remote ? { parsed: remote, ms: remoteMs } : null,
        nanonetsError: remoteError,
        header: headerCells(local, remote),
      })
    }

    const localRows = local?.line_items ?? []
    const remoteRows = remote?.line_items ?? []
    const rowCount = Math.max(localRows.length, remoteRows.length)

    const banner = localResult.ok
      ? `<p class="note"><b>Local parse succeeded</b> in ${localMs} ms — ${localRows.length} line items. This invoice would cost nothing.</p>`
      : `<p class="note fail"><b>Local parse rejected</b> after ${localMs} ms — ${esc(localResult.reason)}.<br>
         This invoice falls back to Nanonets, which is the designed behaviour, not a crash.</p>`

    const cost = withNanonets
      ? `<p class="note">Nanonets took ${(remoteMs / 1000).toFixed(1)}s${remoteError ? ` and FAILED: ${esc(remoteError)}` : ""}. Local took ${localMs} ms — <b>${remoteMs > 0 ? Math.round(remoteMs / Math.max(localMs, 1)) : "?"}× faster</b>.</p>`
      : `<p class="note">Nanonets not run (free mode). Tick the box on the form to compare against it.</p>`

    const rowsHtml = Array.from({ length: rowCount }, (_, i) =>
      `<h2>Line ${i + 1}${localRows[i] ? "" : " (local: missing)"}${withNanonets && !remoteRows[i] ? " (Nanonets: missing)" : ""}</h2>
       ${table(lineCells(localRows[i], remoteRows[i]), withNanonets && !!remote)}`
    ).join("")

    return new NextResponse(
      `<!doctype html>
<meta charset="utf-8">
<title>Comparison — ${esc(filename)}</title>
<style>${STYLE}</style>
<h1>${esc(filename)}</h1>
<p class="note">Detected: <b>${esc(mfg ? `${mfg.code} — ${mfg.name}` : "none")}</b> · strategy <b>${esc(strategy?.label ?? "base")}</b> · detection ${detectMs} ms · ${text.length} chars of text</p>
${banner}
${cost}
<h2>Header fields</h2>
${table(headerCells(local, remote), withNanonets && !!remote)}
${rowsHtml || "<p class='note'>No line items on either side.</p>"}
<p><a href="./compare">← compare another</a></p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )
  },
})
