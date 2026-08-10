/**
 * Authorization for an S3 object key that arrived from the client.
 *
 * Same reason lib/po-guard.ts exists: withGateway proves *who* is asking, not
 * *what* they may read. /api/v1/files/presign took the key straight from the query
 * string, and keys are enumerable — `attachment_key` and `csv_source_key` come
 * back in ordinary list responses — so any signed-in user could mint a presigned
 * URL for any object in the bucket, including another manufacturer's documents
 * and every supplier invoice PDF. See docs/qa-audit-2026-08.md #5.
 *
 * The old `key.includes("..")` check did nothing here: these are S3 keys, not
 * filesystem paths, so reaching a sibling object never needed traversal.
 *
 * A key is readable two ways:
 *
 *  1. **It belongs to a row the caller can see** — resolved through
 *     `s3FilesSql.selectKeyOwners`. A key owned by nothing is refused, which is
 *     what closes enumeration.
 *
 *  2. **The caller uploaded it themselves and nothing references it yet.** The
 *     Add Vendor / Add Manufacturer dialogs upload a document and immediately
 *     presign it for preview, long before any row is written — so rule 1 alone
 *     would break document previews. /api/v1/upload stamps the uploader's id into
 *     the key (see `buildUploadKey`), so this costs no server-side state.
 */

import { query } from "@/lib/db"
import { s3FilesSql, KEY_OWNER_PARAM_COUNT } from "@/lib/queries/s3-files"
import { getUserScope, inScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"

/**
 * The uploader marker, anchored to the end of the key so only the segment
 * /api/v1/upload appended can match. `field` is caller-supplied, so an unanchored
 * match would let a caller smuggle `-u7-` into the middle of a key of their own
 * choosing; anchoring means the last marker — the real one — is the only one read.
 */
const UPLOADER_RE = /-u(\d+)-[0-9a-f]{12}\.[A-Za-z0-9]+$/

/** The user id stamped into an upload key, or null for a key without a marker
 *  (every key written before this existed). */
export function uploadedBy(key: string): number | null {
  const m = UPLOADER_RE.exec(key)
  return m ? Number(m[1]) : null
}

/**
 * The key /api/v1/upload writes to.
 *
 * The random token means a PutObject can never land on an existing object — the
 * old `${folder}/${field}.${ext}` was fully predictable, so an upload could
 * overwrite an invoice PDF or a vendor document that was already there
 * (docs/qa-audit-2026-08.md #5). Replacing a document now writes a new key and
 * the owning column is repointed at it, rather than the bytes changing underneath
 * whatever else referenced the old one.
 *
 * The `-u<id>-` segment is what `uploadedBy` reads back.
 */
export function buildUploadKey(folder: string, field: string, ext: string, userId: number): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
  return `${folder}/${field}-u${userId}-${token}.${ext}`
}

/** Throws 403 unless this user may read this object. */
export async function assertKeyReadable(userId: number, key: string): Promise<void> {
  if (uploadedBy(key) === userId) return

  const owners = await query<{ mfg_id: number | null; destination: string | null }>(
    s3FilesSql.selectKeyOwners,
    Array(KEY_OWNER_PARAM_COUNT).fill(key)
  )
  if (owners.length === 0) {
    throw new ApiError(403, "forbidden", "You don't have access to this file")
  }

  // One key can be referenced from more than one row (a PO attachment that is
  // also in a pending approval). Any single reachable owner is enough.
  const scope = await getUserScope(userId)
  const reachable = owners.some(
    (o) => inScope(scope, "mfg", o.mfg_id) && inScope(scope, "warehouse", o.destination)
  )
  if (!reachable) {
    throw new ApiError(403, "out_of_scope", "You don't have access to this file")
  }
}
