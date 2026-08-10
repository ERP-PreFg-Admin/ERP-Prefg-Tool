"use client"

/**
 * Dialog for managing a manufacturer's reference documents — GST certificate,
 * cancelled cheque, PAN card, misc. Each file uploads to S3 as soon as it's
 * picked (not deferred to Save) so the manufacturer already exists — no risk
 * of orphaning S3 objects the way a not-yet-created Add dialog would. Submit
 * for Approval stays disabled while any file is still mid-upload.
 * No approval flow on the docs themselves — these are reference docs, not
 * audited field edits.
 */

import { useEffect, useState } from "react"
import { Tabs } from "radix-ui"
import { AlertCircle, CheckCircle2, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { FileUpload } from "@/components/ui/FileUpload"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { Mfg } from "@/types/masters"

type DocKey = "gst_certificate_key" | "cancelled_cheque_key" | "pan_card_key" | "misc_document_key"

const DOC_TABS: { key: DocKey; label: string; field: string }[] = [
  { key: "gst_certificate_key",  label: "GST Certificate",  field: "gst_certificate" },
  { key: "cancelled_cheque_key", label: "Cancelled Cheque", field: "cancelled_cheque" },
  { key: "pan_card_key",         label: "PAN Card",         field: "pan_card" },
  { key: "misc_document_key",    label: "Misc",             field: "misc_document" },
]

const EMPTY_DOCS: Record<DocKey, null> = {
  gst_certificate_key:  null,
  cancelled_cheque_key: null,
  pan_card_key:         null,
  misc_document_key:    null,
}

const EMPTY_UPLOADING: Record<DocKey, boolean> = {
  gst_certificate_key:  false,
  cancelled_cheque_key: false,
  pan_card_key:         false,
  misc_document_key:    false,
}

export function ManufacturerDocumentsDialog({
  mfg,
  onClose,
  onSuccess,
}: {
  mfg: Mfg | null
  onClose: () => void
  onSuccess?: () => void
}) {
  const { toast } = useToast()
  const [docs, setDocs]               = useState<Record<DocKey, string | null>>(EMPTY_DOCS)
  const [uploadingTabs, setUploadingTabs] = useState<Record<DocKey, boolean>>(EMPTY_UPLOADING)
  const [loading, setLoading]         = useState(false)
  const [submitted, setSubmitted]     = useState(false)
  const [error, setError]             = useState("")

  const anyUploading = Object.values(uploadingTabs).some(Boolean)

  useEffect(() => {
    if (!mfg) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets doc state to the newly-opened manufacturer's files
    setDocs({
      gst_certificate_key:  mfg.gst_certificate_key,
      cancelled_cheque_key: mfg.cancelled_cheque_key,
      pan_card_key:         mfg.pan_card_key,
      misc_document_key:    mfg.misc_document_key,
    })
    setUploadingTabs(EMPTY_UPLOADING)
    setSubmitted(false)
    setError("")
  }, [mfg])

  if (!mfg) return null

  async function handleSave() {
    if (!mfg) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/v1/masters/manufacturers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_docs", mfg_id: mfg.mfg_id, ...docs }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save documents")
      setSubmitted(true)
      toast({ title: "Submitted for approval", description: `${mfg.name}'s documents are now awaiting approval.`, variant: "success" })
      onSuccess?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong"
      setError(message)
      toast({ title: "Submission failed", description: message, variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={!!mfg} onOpenChange={(o) => !loading && !anyUploading && !o && onClose()}>
      <DialogContent className="w-lg">
        <DialogHeader>
          <DialogTitle>Documents — {mfg.name}</DialogTitle>
        </DialogHeader>

        {submitted && (
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 mb-4 text-sm text-green-800 dark:border-green-900/40 dark:bg-green-950/30 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Documents submitted for approval. The manufacturer is locked until the approval is resolved.
          </div>
        )}

        {!submitted && mfg.status === "in_review" && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 mb-4 text-sm text-blue-800 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-400">
            <Clock className="h-4 w-4 shrink-0" />
            A change is pending approval. Documents cannot be updated until it is resolved.
          </div>
        )}

        <Tabs.Root defaultValue={DOC_TABS[0].key}>
          <Tabs.List className="flex gap-1 border-b border-border mb-4">
            {DOC_TABS.map((tab) => (
              <Tabs.Trigger
                key={tab.key}
                value={tab.key}
                className={cn(
                  "px-3 py-2 text-sm font-medium text-muted-foreground border-b-2 border-transparent -mb-px",
                  "data-[state=active]:text-foreground data-[state=active]:border-primary",
                  "hover:text-foreground transition-colors"
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {DOC_TABS.map((tab) => (
            <Tabs.Content key={tab.key} value={tab.key}>
              <FileUpload
                currentKey={docs[tab.key]}
                folder={`manufacturers/${mfg.mfg_id}`}
                field={tab.field}
                label={tab.label}
                accept="document"
                disabled={loading || mfg.status === "in_review" || submitted}
                onChange={(key) => setDocs((d) => ({ ...d, [tab.key]: key }))}
                onUploadingChange={(isUploading) =>
                  setUploadingTabs((u) => ({ ...u, [tab.key]: isUploading }))
                }
              />
            </Tabs.Content>
          ))}
        </Tabs.Root>

        {error && (
          <p className="mt-3 text-sm text-destructive flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={loading || anyUploading}>
            {submitted ? "Close" : "Cancel"}
          </Button>
          {!submitted && mfg.status !== "in_review" && (
            <Button type="button" onClick={handleSave} disabled={loading || anyUploading}>
              {anyUploading ? "Uploading document…" : loading ? "Submitting…" : "Submit for Approval"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
