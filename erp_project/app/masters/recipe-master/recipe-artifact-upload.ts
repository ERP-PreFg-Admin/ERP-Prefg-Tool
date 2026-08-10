/**
 * Uploads staged BOM artifact files to S3 right before a create-full submit —
 * shared by useBomWizard.handleSubmit (mode: "new-version") and
 * useBomDetailPanel.saveEdit (mode: "update-existing"). Mirrors the
 * pick-now-upload-on-submit pattern AddMfgDialog.tsx already uses for
 * manufacturer docs, just for an arbitrary-length file list instead of 4
 * fixed slots.
 *
 * Returns the {s3_key, file_name} pairs to send as create-full's
 * `artifact_adds` — the actual bom_artifacts rows are only written once the
 * submission is approved (see lib/approvals/module-handlers.ts).
 */
export async function uploadPendingArtifacts(
  files: File[],
  folder: string
): Promise<{ s3_key: string; file_name: string }[]> {
  const uploaded: { s3_key: string; file_name: string }[] = []
  for (const file of files) {
    const field = `artifact-${crypto.randomUUID()}`
    const form = new FormData()
    form.append("file", file)
    form.append("folder", folder)
    form.append("field", field)
    const res = await fetch("/api/upload", { method: "POST", body: form })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `Failed to upload "${file.name}"`)
    uploaded.push({ s3_key: data.key, file_name: file.name })
  }
  return uploaded
}
