"use client"

import { useRef, useState } from "react"
import { Plus, AlertCircle, ChevronRight, ChevronLeft } from "lucide-react"
import { Tabs } from "radix-ui"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { FileUpload } from "@/components/ui/FileUpload"
import { ZONE_OPTIONS } from "@/components/masters/field-config"
import { FormField } from "@/components/masters/FormField"
import { cn } from "@/lib/utils"

// ── Types ─────────────────────────────────────────────────────────────────────

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

const TYPE_OPTIONS = [
  { value: "rm",   label: "RM"   },
  { value: "pm",   label: "PM"   },
  { value: "both", label: "BOTH" },
]

const DETAIL_FIELDS = [
  { key: "name",            label: "Name",            required: true,  colSpan: 1, placeholder: "Vendor name" },
  { key: "type",            label: "Type",            required: true,  colSpan: 1, isSelect: true, options: TYPE_OPTIONS, noBlankOption: true },
  { key: "registered_name", label: "Registered Name", required: true, colSpan: 1, placeholder: "Legal registered name" },
  { key: "location",        label: "Location",        required: false, colSpan: 1, placeholder: "e.g. Mumbai" },
  { key: "zone",            label: "Zone",            required: true, colSpan: 1, isSelect: true, options: ZONE_OPTIONS },
  { key: "gst_number",      label: "GST Number",      required: false, colSpan: 1, placeholder: "e.g. 27AAEPM1234C1Z5" },
  { key: "bank_name",       label: "Bank Name",       required: false, colSpan: 1, placeholder: "e.g. HDFC Bank" },
  { key: "ifsc_number",     label: "IFSC Number",     required: false, colSpan: 1, placeholder: "e.g. HDFC0001234" },
  { key: "account_number",  label: "Account Number",  required: false, colSpan: 1, placeholder: "e.g. 12345678901234" },
] as const

type Step = "details" | "documents"

// ── Component ─────────────────────────────────────────────────────────────────

export function AddVendorDialog({ onSuccess }: { onSuccess?: () => void }) {
  const [open, setOpen]               = useState(false)
  const [step, setStep]               = useState<Step>("details")
  const [form, setForm]               = useState<Record<string, string>>({ type: "rm" })
  const [pendingFiles, setPendingFiles] = useState<Record<DocKey, File | null>>(EMPTY_DOCS)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState("")

  // Unique folder prefix per dialog session so concurrent opens don't collide in S3
  const sessionFolder = useRef("")

  function openDialog() {
    sessionFolder.current = `vendors/tmp/${crypto.randomUUID()}`
    setStep("details")
    setForm({ type: "rm" })
    setPendingFiles(EMPTY_DOCS)
    setError("")
    setOpen(true)
  }

  function handleNext() {
    const missing = DETAIL_FIELDS.filter(
      (f) => f.required && !String(form[f.key] ?? "").trim()
    )
    if (missing.length) {
      setError(`${missing.map((f) => f.label).join(", ")} ${missing.length > 1 ? "are" : "is"} required.`)
      return
    }
    setError("")
    setStep("documents")
  }

  async function handleSubmit() {
    setLoading(true)
    setError("")
    try {
      // Upload any pending files to S3 now that the user has confirmed
      const docKeys: Record<DocKey, string | null> = { ...EMPTY_DOCS }
      for (const tab of DOC_TABS) {
        const file = pendingFiles[tab.key]
        if (!file) continue
        const fd = new FormData()
        fd.append("file",   file)
        fd.append("folder", sessionFolder.current)
        fd.append("field",  tab.field)
        const up = await fetch("/api/upload", { method: "POST", body: fd })
        const upData = await up.json()
        if (!up.ok) throw new Error(upData.error || `Failed to upload ${tab.label}`)
        docKeys[tab.key] = upData.key
      }

      const res = await fetch("/api/masters/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", ...form, ...docKeys }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to add vendor")
      setOpen(false)
      onSuccess?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  const pendingCount = DOC_TABS.filter((t) => pendingFiles[t.key]).length

  return (
    <>
      <Button size="sm" onClick={openDialog}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add Vendor
      </Button>

      <Dialog open={open} onOpenChange={(o) => !loading && setOpen(o)}>
        <DialogContent className="w-lg">
          <DialogHeader>
            <DialogTitle>
              Add Vendor —{" "}
              <span className="text-muted-foreground font-normal">
                {step === "details" ? "Details" : "Documents"}
              </span>
            </DialogTitle>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span className={cn("font-medium", step === "details" && "text-foreground")}>
              1 Details
            </span>
            <ChevronRight className="h-3 w-3" />
            <span className={cn("font-medium", step === "documents" && "text-foreground")}>
              2 Documents
            </span>
          </div>

          {/* ── Step 1: Details ── */}
          {step === "details" && (
            <div className="grid grid-cols-3 gap-4">
              {DETAIL_FIELDS.map((f) => (
                <FormField
                  key={f.key}
                  field={f}
                  value={form[f.key] ?? ""}
                  onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))}
                />
              ))}
            </div>
          )}

          {/* ── Step 2: Documents ── */}
          {step === "documents" && (
            <div>
              <p className="text-xs text-muted-foreground mb-3">
                Optional — upload reference documents. You can also add these later.
              </p>
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
                      {pendingFiles[tab.key] && (
                        <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                      )}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>

                {/* eslint-disable-next-line react-hooks/refs -- reads the upload session folder generated once on dialog open, not a value driving this render's output */}
                {DOC_TABS.map((tab) => (
                  <Tabs.Content key={tab.key} value={tab.key}>
                    <FileUpload
                      currentKey={null}
                      folder={sessionFolder.current}
                      field={tab.field}
                      label={tab.label}
                      accept="document"
                      disabled={loading}
                      deferred
                      pendingFile={pendingFiles[tab.key]}
                      onFileSelected={(file) =>
                        setPendingFiles((p) => ({ ...p, [tab.key]: file }))
                      }
                      onChange={() => {}}
                    />
                  </Tabs.Content>
                ))}
              </Tabs.Root>
            </div>
          )}

          {error && (
            <p className="mt-2 text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}

          <DialogFooter>
            {step === "details" ? (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleNext}>
                  Next — Documents <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setStep("details"); setError("") }}
                  disabled={loading}
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Back
                </Button>
                <Button type="button" onClick={handleSubmit} disabled={loading}>
                  {loading
                    ? "Submitting…"
                    : pendingCount > 0
                      ? `Submit for Approval (${pendingCount} doc${pendingCount > 1 ? "s" : ""})`
                      : "Submit for Approval"
                  }
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
