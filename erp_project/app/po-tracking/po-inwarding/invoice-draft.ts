// Crash/close recovery for an in-progress invoice review.
//
// Extraction takes ~60s and the review that follows is real work, so losing it
// to a stray Escape or a closed tab is expensive. The whole review — including
// the PDF itself — is checkpointed to IndexedDB and offered back on reopen.
//
// IndexedDB rather than localStorage because the PDF has to survive too:
// localStorage holds ~5 MB of *strings*, and a 10 MB PDF is ~13 MB once
// base64'd. IndexedDB stores a File directly, no encoding, and has a quota
// measured against free disk.
//
// Every operation is best-effort. Storage can be unavailable (private mode,
// blocked cookies, quota exhausted) and a draft that fails to save must never
// take the invoice flow down with it.

import type { InvoiceForm, Row } from "./invoice-form"

const DB_NAME  = "erp-invoice-draft"
const DB_VER   = 1
const STORE    = "draft"
/** Single-slot: one in-progress invoice at a time, matching the single dialog. */
const KEY      = "current"

export type InvoiceDraft = {
  savedAt:  number
  fileName: string
  file:     File
  form:     InvoiceForm
  rows:     Row[]
  extra:    Record<string, string>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
    // Fires when another tab holds an older version open. Nothing to recover
    // from, so fail fast rather than hang the caller's promise forever.
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror   = () => reject(req.error)
        t.oncomplete  = () => db.close()
      })
  )
}

/** Checkpoint the review. Resolves either way — callers shouldn't have to care. */
export async function saveDraft(draft: Omit<InvoiceDraft, "savedAt">): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put({ ...draft, savedAt: Date.now() }, KEY))
  } catch {
    // Out of quota or storage denied. The review still works, it just won't survive.
  }
}

export async function loadDraft(): Promise<InvoiceDraft | null> {
  try {
    const draft = await tx<InvoiceDraft | undefined>("readonly", (s) => s.get(KEY))
    // A draft without its PDF can't be submitted — the file is what gets
    // uploaded to S3 — so treat a partial record as no draft at all.
    if (!draft?.file) return null
    return draft
  } catch {
    return null
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(KEY))
  } catch {
    // Nothing to do — a stale draft is offered, not forced.
  }
}

/** "2 minutes ago" / "yesterday", for the resume prompt. */
export function savedAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1)    return "just now"
  if (mins === 1)  return "1 minute ago"
  if (mins < 60)   return `${mins} minutes ago`
  const hours = Math.floor(mins / 60)
  if (hours === 1) return "1 hour ago"
  if (hours < 24)  return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}
