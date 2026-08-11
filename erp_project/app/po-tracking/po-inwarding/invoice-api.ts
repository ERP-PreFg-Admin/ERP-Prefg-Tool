// Network calls behind the Add Invoice dialog. Kept out of the component so the
// request shapes live in one place and the dialog reads as phases, not fetches.

import type { OpenPoOption, ParsedInvoice } from "@/types/invoice"
import type { DetectedMfg } from "@/lib/invoice-detect"
import { monthIST } from "@/lib/date"
import { tooLargeMessage } from "./invoice-form"

/** Thrown with the server's own message so the dialog can show something actionable. */
export class InvoiceApiError extends Error {}


async function messageFrom(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}))
  return data?.error ?? fallback
}

/**
 * Parse a PDF. Posted as multipart straight from the browser — nothing is
 * stored, so an abandoned review leaves no orphaned S3 object behind.
 *
 * Timing depends on which path answers. Invoices we can read from the PDF's own
 * text layer come back in well under a second; the rest fall through to Nanonets
 * and take ~60s, so the caller still has to warn about the slow case.
 *
 * `source` names the path that answered — "local:<layout>" or "nanonets".
 */
export async function parseInvoiceFile(
  file: File
): Promise<{ parsed: ParsedInvoice; detected: DetectedMfg | null; source: string | null }> {
  // Guard at the transport boundary, not only in the picker: nginx refuses an
  // oversized body with its own HTML error page, which `messageFrom` can't read
  // — so without this the caller gets a bare "Invoice parsing failed".
  const tooLarge = tooLargeMessage(file)
  if (tooLarge) throw new InvoiceApiError(tooLarge)

  const form = new FormData()
  form.append("file", file)

  // No Content-Type header — the browser must set the multipart boundary.
  //
  // v1 remains live and contract-identical: it always calls Nanonets, with no
  // local parse and no detection. If the local parser misreads an invoice in
  // production, changing this one URL back to /api/v1/ restores the old
  // behaviour without a code change anywhere else.
  const res = await fetch("/api/v2/purchase-orders/invoice/parse", { method: "POST", body: form })
  if (!res.ok) throw new InvoiceApiError(await messageFrom(res, "Invoice parsing failed."))

  const data = await res.json()
  return {
    parsed: data.parsed as ParsedInvoice,
    detected: (data.detected ?? null) as DetectedMfg | null,
    source: (data.source ?? null) as string | null,
  }
}

/**
 * Upload the PDF to S3 and resolve its key. Called as the first step of submit,
 * not at pick time, so the file is stored only once the user commits.
 *
 * XHR rather than fetch: fetch still can't report upload progress. `onXhr` hands
 * the request back so the caller can abort it if the dialog closes mid-transfer.
 */
export function uploadInvoice(
  file: File,
  onProgress: (pct: number) => void,
  onXhr: (xhr: XMLHttpRequest | null) => void
): Promise<string> {
  const yyyymm = monthIST()
  // Random suffix rather than the invoice number: two uploads of the same
  // invoice must not collide, and the number is user-editable anyway.
  const field = `${file.name.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`

  const form = new FormData()
  form.append("file", file)
  form.append("folder", `invoices/${yyyymm}`)
  form.append("field", field)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    onXhr(xhr)
    xhr.open("POST", "/api/v1/upload")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      onXhr(null)
      let data: { key?: string; error?: string } = {}
      try { data = JSON.parse(xhr.responseText) } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.key) resolve(data.key)
      else reject(new InvoiceApiError(data.error ?? `Upload failed (${xhr.status}).`))
    }
    xhr.onerror = () => { onXhr(null); reject(new InvoiceApiError("Network error during upload.")) }
    xhr.onabort = () => { onXhr(null); reject(new InvoiceApiError("Upload cancelled.")) }
    xhr.send(form)
  })
}

export type InwardStep = "s3" | "po" | "uniware" | "email"

export type StepEvent = {
  step: InwardStep
  status: "start" | "ok" | "failed" | "skipped"
  message?: string
}

export type InwardOutcome = {
  ok: boolean
  created: { id: number; po_no: string; sku_code: string }[]
  received: { id: number; po_no: string; qty: number; status: string }[]
  uniwarePoCode?: string
  error?: string
  failedStep?: InwardStep
}

/**
 * Commit the reviewed invoice. Posts the PDF and the form together, then reads
 * the server's newline-delimited step events so the caller can report each
 * stage as it lands rather than only at the end.
 *
 * The whole thing is one request on purpose: S3, our rows and the Uniware
 * mirror have to succeed or unwind together, which they can't do if the client
 * drives them as separate calls.
 */
export async function commitInvoice(
  file: File,
  payload: unknown,
  onStep: (e: StepEvent) => void
): Promise<InwardOutcome> {
  const form = new FormData()
  form.append("file", file)
  form.append("payload", JSON.stringify(payload))

  const res = await fetch("/api/v1/purchase-orders/invoice", { method: "POST", body: form })

  // Only pre-stream failures (auth, validation) arrive as a non-200 with a JSON
  // body. Once streaming starts the status is always 200.
  if (!res.ok) throw new InvoiceApiError(await messageFrom(res, "Failed to create inward POs."))
  if (!res.body) throw new InvoiceApiError("The server returned no response body.")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let outcome: InwardOutcome | null = null

  // NDJSON: one JSON object per line. A chunk can split a line, so only whole
  // lines are parsed and the remainder is carried forward.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: StepEvent & { done?: boolean; outcome?: InwardOutcome }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.done) outcome = msg.outcome ?? null
      else onStep(msg)
    }
  }

  if (!outcome) throw new InvoiceApiError("The server closed the connection before finishing.")
  return outcome
}

/** Open POs a receipt can be booked against, for one manufacturer. Returns []
 *  rather than throwing — an empty picker degrades fine, a crash doesn't. */
export async function fetchOpenPos(mfgId: string): Promise<OpenPoOption[]> {
  try {
    const res = await fetch(`/api/v1/purchase-orders/open-for-receive?mfg_id=${encodeURIComponent(mfgId)}`)
    const data = await res.json()
    return Array.isArray(data.pos) ? data.pos : []
  } catch {
    return []
  }
}
