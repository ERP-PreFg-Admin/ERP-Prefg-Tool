
/**
 * Uniware PO documents — the whole client, plain server-side fetch.
 *
 * Trust model is NOT the REST API's. Read this before touching it:
 *
 *   1. mintCapability  POST tenant /data/document/auth/details/get  — needs the
 *      WEB COOKIE (bearer → 500, anonymous → 401). Returns a token+checksum pair
 *      plus the docs host to use. This is the ONLY step that needs the cookie and
 *      the ONLY step that can tell the session has died.
 *   2. everything else runs against that host (docs.unicommerce.com) and is
 *      authorised by token+checksum ALONE — no cookie, no bearer — and the pair
 *      never expires.
 *
 * SECURITY: token/checksum grant read AND write on that PO to anyone holding
 * them. Never log them, never return them to a browser, never put them in a URL
 * the client sees.
 */

import { UNIWARE_USER_NAME } from "../env"
import { BASE, DOC_AUTH_PATH, DOCS_DOWNLOAD_PATH, DOCS_LIST_PATH, DOCS_UPLOAD_ACK_PATH, DOCS_UPLOAD_PATH, TIMEOUT_MS } from "./endpoints"
import { requireUniwareWebCookie, UniwareSessionStale } from "./web-session"

export const DOC_MAX_BYTES = 2 * 1024 * 1024

// Slef authorization for single PO
export type DocCapability = {
    identifier : string
    token : string 
    checksum :string
    docsHost : string
}

// one row of document/item
export type UniwareDocument = {
  fileName: string
  documentLocation: string | null
  uploadedBy: string | null
  created: string | null
}

function docsQuery(cap:DocCapability ,  extra: Record<string , string> = {}) {
    return new URLSearchParams({
        identifier : cap.identifier , 
        token : cap.token ,
        checksum : cap.checksum,
        username : UNIWARE_USER_NAME,
        ... extra,
    })
}

/** A throwaway identifier for validating a cookie — mint succeeds for any
 *  identifier, even one no PO uses (verified 2026-09-01), so this touches
 *  nothing real. */
const HEALTHCHECK_IDENTIFIER = "PO-ERP-SESSION-HEALTHCHECK"

/**
 * Mint against a specific cookie. The core of mintCapability, split out so the
 * session-store endpoint can validate a SUBMITTED cookie before storing it,
 * rather than only ever using the one already in the DB.
 */
async function mintWithCookie(cookie: string, identifier: string): Promise<DocCapability> {
    const res = await fetch(`${BASE}${DOC_AUTH_PATH}` , {
        method:"POST",
        headers : {
            "Content-Type" : "application/json",
            "X-Requested-With" : "XMLHttpRequest",
            Cookie : cookie
        },
        body : JSON.stringify({identifier}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    const text = await res.text()
    let data :{
        successful?:boolean ;
        token?:string;
        checksum?:string;
        url?:string;
        identifier?:string;
        errors?: {
            message?: string
        }[]
    }
    try {
        data = JSON.parse(text)
    } catch {
        throw new UniwareSessionStale()
    }

    if(!data.successful) {
        const msg = (data.errors ?? []).map((e) => e.message).filter(Boolean).join("; ")
        if (/USER_NOT_LOGGED_IN/i.test(msg) || res.status === 401) throw new UniwareSessionStale()
        throw new Error(`Uniware document auth failed for ${identifier}: ${msg || res.status}`)
    }
    // Narrows every field to string, so a partial payload throws here rather
    // than flowing through as undefined.
    if(!data.token || !data.checksum || !data.url || !data.identifier) {
        throw new Error(`Uniware document auth returned an incomplete capability for ${identifier}`)
    }
    return {
        identifier:data.identifier,
        token :data.token,
        checksum:data.checksum,
        docsHost:data.url.replace(/\/+$/ , ""),
    }
}

export async function mintCapability(uniwarePoCode : string) : Promise<DocCapability> {
    const cookie = await requireUniwareWebCookie()
    return mintWithCookie(cookie, `PO-${uniwarePoCode}`)
}

/**
 * Does this cookie hold a live Uniware session? Used by the store endpoint as
 * its authorization: only a working cookie is accepted, so possessing one IS the
 * credential. A stale/garbage cookie returns false rather than throwing.
 */
export async function isWebCookieValid(cookie: string): Promise<boolean> {
    try {
        await mintWithCookie(cookie, HEALTHCHECK_IDENTIFIER)
        return true
    } catch {
        return false
    }
}

export async function listDocuments(cap:DocCapability): Promise<UniwareDocument[]> {
    const res = await fetch(`${cap.docsHost}${DOCS_LIST_PATH}?${docsQuery(cap)}` , {
        signal:AbortSignal.timeout(TIMEOUT_MS)
    })
    const data = await res.json().catch(() => null)
    if(!Array.isArray(data)){
        throw new Error(`Uniware docuemnt list for ${cap.identifier} was not an array`)
    }
    return data.map((d: Record<string, unknown>) => ({
        fileName: String(d.fileName ?? ""),
        documentLocation: d.documentLocation ? String(d.documentLocation) : null,
        uploadedBy: d.uploadedBy ? String(d.uploadedBy) : null,
        created: d.created ? String(d.created) : null,
    })).filter((d) => d.fileName)
}

export async function downloadDocument(cap: DocCapability, filename: string): Promise<Buffer> {
  const res = await fetch(`${cap.docsHost}${DOCS_DOWNLOAD_PATH}?${docsQuery(cap, { filename })}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await res.json().catch(() => null) as Record<string, unknown> | null
  const url = data?.preSignedDownloadUrl ?? data?.presignedDownloadUrl ?? data?.preSignedUrl
  if (typeof url !== "string" || !url) {
    throw new Error(
      `Uniware download for "${filename}" returned no presigned URL — keys were ${JSON.stringify(Object.keys(data ?? {}))}`
    )
  }
  const bytes = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!bytes.ok) throw new Error(`Uniware document "${filename}": S3 fetch HTTP ${bytes.status}`)
  return Buffer.from(await bytes.arrayBuffer())
}

/**
 * Push one file onto the PO. Idempotent: if a document of this name is already
 * there, Uniware returns a null upload URL with DOCUMENT_ALREADY_EXIST — and
 * since the postcondition ("this file is on the PO") already holds, that is
 * treated as success, not an error. Returns true if a new file was uploaded,
 * false if it was already present. A retry or double-submit is therefore safe.
 */
export async function uploadDocument(
  cap: DocCapability, filename: string, body: Buffer, contentType = "application/pdf"
): Promise<boolean> {
  if (body.length > DOC_MAX_BYTES) {
    throw new Error(`"${filename}" is ${body.length} bytes; Uniware's ceiling is ${DOC_MAX_BYTES}`)
  }

  const step1 = await fetch(
    `${cap.docsHost}${DOCS_UPLOAD_PATH}?${docsQuery(cap, { filename, maxFileSize: "2" })}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  ).then((r) => r.json()).catch(() => null) as
    { preSignedUploadUrl?: unknown; errors?: { code?: number; message?: string }[] } | null
  const put = step1?.preSignedUploadUrl
  if (typeof put !== "string" || !put) {
    // Already on the PO is the goal, not a failure — the sweep's dedup normally
    // prevents reaching here, but a retry or a double-submit can.
    const already = (step1?.errors ?? []).some(
      (e) => e.code === 1003 || /DOCUMENT_ALREADY_EXIST/i.test(e.message ?? "")
    )
    if (already) return false
    throw new Error(`Uniware upload-url for "${filename}" returned no presigned URL — keys were ${JSON.stringify(Object.keys(step1 ?? {}))}`)
  }

  // Buffer isn't in the fetch BodyInit types; Uint8Array is, and Buffer already is one.
  const putRes = await fetch(put, { method: "PUT", body: new Uint8Array(body), headers: { "Content-Type": contentType }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!putRes.ok) throw new Error(`Uniware upload PUT for "${filename}": HTTP ${putRes.status}`)

  const ack = await fetch(
    `${cap.docsHost}${DOCS_UPLOAD_ACK_PATH}?${docsQuery(cap, { filename, maxFileSize: "2" })}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(TIMEOUT_MS) }
  ).then((r) => r.json()).catch(() => null) as { successful?: boolean } | null
  if (!ack?.successful) throw new Error(`Uniware upload acknowledge for "${filename}" failed`)
  return true
}
