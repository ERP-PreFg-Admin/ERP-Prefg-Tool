import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_FILES, AWS_S3_BUCKET_EVENTS } from "@/lib/env"
import logger from "./logger"

// Constructed lazily (not at module load) so a missing AWS env var only
// breaks S3-dependent requests, not every route that transitively imports
// this file -- matching lib/env.ts's "warn, don't crash on import" design.
// The AWS SDK throws synchronously if `region` is empty, which would
// otherwise fail Next.js's build-time page-data collection and any cold
// start where these vars aren't set yet.
let _s3: S3Client | undefined
function getClient(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId:     AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    })
  }
  return _s3
}

const FILES_BUCKET  = AWS_S3_BUCKET_FILES
const EVENTS_BUCKET = AWS_S3_BUCKET_EVENTS

// ---Logger integration -------
const ctx = {
  module: "S3",
  requestId: crypto.randomUUID(),
}

// ── Files bucket (CSV/Excel/PDF uploads, PO attachments) ─────────────────────

export async function uploadFile(buffer: Buffer, key: string, mimeType: string): Promise<string> {
  await getClient().send(new PutObjectCommand({
    Bucket:      FILES_BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
  }))
  logger.info({ ...ctx, message: "File uploaded", key, size: buffer.length })
  return key
}

export async function deleteFile(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: FILES_BUCKET, Key: key }))
  logger.info({ ...ctx, message: "File deleted", key })
}

export async function getPresignedUploadUrl(key: string, mimeType: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: FILES_BUCKET, Key: key, ContentType: mimeType }),
    { expiresIn }
  )
}

export async function getPresignedDownloadUrl(key: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: FILES_BUCKET, Key: key }),
    { expiresIn }
  )
}

/**
 * Presigned URL that displays the object in the browser instead of downloading it.
 *
 * Only Content-Disposition is overridden. It used to also send
 * `ResponseContentType: "text/plain"` to coax CSVs into rendering inline, but
 * S3's response-content-type overrides the object's stored type for *every*
 * caller — so a PDF came back labelled text/plain and the browser rendered the
 * raw PDF source (`%PDF-1.4`, the ASCII85 streams) as text instead of opening
 * its viewer.
 *
 * Every object is stored with a correct ContentType already (see uploadFile
 * callers), so letting the stored type through is both simpler and right. CSVs
 * no longer need the hack either: they're previewed as a table by
 * /api/v1/files/preview, which parses them server-side.
 */
export async function getPresignedViewUrl(key: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket:                     FILES_BUCKET,
      Key:                        key,
      ResponseContentDisposition: "inline",
    }),
    { expiresIn }
  )
}

export async function getFileBuffer(key: string): Promise<Buffer> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: FILES_BUCKET, Key: key }))
  const chunks: Uint8Array[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ── Events bucket (raw-events, processed-events, failed-events) ──────────────

export async function putEvent(key: string, payload: unknown): Promise<void> {
  try {
    await getClient().send(new PutObjectCommand({
      Bucket:      EVENTS_BUCKET,
      Key:         key,
      Body:        JSON.stringify(payload),
      ContentType: "application/json",
    }))
    logger.info({ ...ctx, message: "Event recorded", key })
  } catch (err) {
    // Fire-and-forget — never let event logging block the main request
    console.error(`[s3:events] failed to record key=${key}`, err)
    logger.error({ ...ctx, message: "Failed to record event", key, error: (err as Error).message })
  }
}

export async function getEvent(key: string): Promise<unknown> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: EVENTS_BUCKET, Key: key }))
  const chunks: Uint8Array[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
}
