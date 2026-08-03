// Network calls behind the Add Invoice dialog. Kept out of the component so the
// request shapes live in one place and the dialog reads as phases, not fetches.

import type { OpenPoOption, ParsedInvoice } from "@/types/invoice"

/** Thrown with the server's own message so the dialog can show something actionable. */
export class InvoiceApiError extends Error {}

async function messageFrom(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}))
  return data?.error ?? fallback
}

/**
 * Parse a PDF. Posted as multipart straight from the browser — nothing is
 * stored, so an abandoned review leaves no orphaned S3 object behind. Takes
 * ~60s; the caller is responsible for saying so.
 */
export async function parseInvoiceFile(file: File): Promise<ParsedInvoice> {
  const form = new FormData()
  form.append("file", file)

  // No Content-Type header — the browser must set the multipart boundary.
  const res = await fetch("/api/purchase-orders/invoice/parse", { method: "POST", body: form })
  if (!res.ok) throw new InvoiceApiError(await messageFrom(res, "Invoice parsing failed."))

  const data = await res.json()
  return data.parsed as ParsedInvoice
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
  const yyyymm = new Date().toISOString().slice(0, 7)
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
    xhr.open("POST", "/api/upload")
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

export type InwardResult = { count: number; receivedCount: number }

export async function createInwardPos(payload: unknown): Promise<InwardResult> {
  const res = await fetch("/api/purchase-orders/invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new InvoiceApiError(await messageFrom(res, "Failed to create inward POs."))

  const data = await res.json()
  return { count: data.count ?? 0, receivedCount: data.receivedCount ?? 0 }
}

/** Open POs a receipt can be booked against, for one manufacturer. Returns []
 *  rather than throwing — an empty picker degrades fine, a crash doesn't. */
export async function fetchOpenPos(mfgId: string): Promise<OpenPoOption[]> {
  try {
    const res = await fetch(`/api/purchase-orders/open-for-receive?mfg_id=${encodeURIComponent(mfgId)}`)
    const data = await res.json()
    return Array.isArray(data.pos) ? data.pos : []
  } catch {
    return []
  }
}
