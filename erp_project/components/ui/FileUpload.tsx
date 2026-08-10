"use client"

import { useEffect, useRef, useState } from "react"
import { Upload, FileIcon, ExternalLink, X, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

const ACCEPT_MAP = {
  image:    "image/jpeg,image/png,image/webp",
  document: "application/pdf,image/png,image/jpeg",
  any:      "image/jpeg,image/png,image/webp,application/pdf,.xlsx,.csv",
}

type FileUploadProps = {
  currentKey:      string | null
  folder:          string
  field:           string
  label:           string
  accept:          "image" | "document" | "any"
  disabled?:       boolean
  onChange:        (key: string | null) => void
  /** When true, file is NOT uploaded on pick — held client-side until parent decides to upload. */
  deferred?:       boolean
  /** Controlled pending file (parent holds it; shown as local preview in deferred mode). */
  pendingFile?:    File | null
  /** Called in deferred mode when user picks or removes a file. */
  onFileSelected?: (file: File | null) => void
  /** Fires true when a live (non-deferred) upload starts, false when it settles.
   *  Parents use this to keep a submit button disabled mid-upload. */
  onUploadingChange?: (uploading: boolean) => void
}

export function FileUpload({
  currentKey, folder, field, label, accept, disabled, onChange,
  deferred, pendingFile, onFileSelected, onUploadingChange,
}: FileUploadProps) {
  const inputRef               = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress]   = useState(0)
  const [error, setError]         = useState<string | null>(null)
  const [localKey, setLocalKey]   = useState<string | null>(currentKey)

  // `currentKey` can change after this component has already mounted (e.g. the
  // Manufacturer Documents dialog stays mounted across different manufacturers
  // and only learns the right key via an effect one render after opening) — the
  // useState initializer above only runs once, so re-sync on every prop change.
  useEffect(() => setLocalKey(currentKey), [currentKey])

  // In deferred mode the parent controls the pending file; derive display state from it.
  const hasPending = deferred && !!pendingFile
  const hasFile    = hasPending || !!localKey

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    e.target.value = ""

    const MAX = 10 * 1024 * 1024
    if (file.size > MAX) { setError("File exceeds 10 MB limit"); return }

    if (deferred) {
      // Hold client-side — no S3 upload yet
      onFileSelected?.(file)
      return
    }

    const form = new FormData()
    form.append("file",   file)
    form.append("folder", folder)
    form.append("field",  field)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/v1/upload")

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100))
    }

    xhr.onloadstart = () => { setUploading(true); setProgress(0); onUploadingChange?.(true) }

    xhr.onload = () => {
      setUploading(false)
      onUploadingChange?.(false)
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText)
        setLocalKey(data.key)
        onChange(data.key)
      } else {
        const data = JSON.parse(xhr.responseText ?? "{}")
        setError(data.error ?? "Upload failed")
      }
    }

    xhr.onerror = () => {
      setUploading(false)
      onUploadingChange?.(false)
      setError("Upload failed — check your connection")
    }

    xhr.send(form)
  }

  async function handleView() {
    if (!localKey) return
    try {
      const res  = await fetch(`/api/v1/files/presign?key=${encodeURIComponent(localKey)}`)
      const data = await res.json()
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
    } catch {
      setError("Could not open file")
    }
  }

  function handleRemove() {
    if (hasPending) {
      onFileSelected?.(null)
    } else {
      setLocalKey(null)
      onChange(null)
    }
    setError(null)
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>

      {!hasFile && !uploading && (
        <label
          className={cn(
            "flex flex-col items-center justify-center h-20 rounded-lg border-2 border-dashed border-border",
            "cursor-pointer hover:border-primary transition-colors",
            disabled && "opacity-50 pointer-events-none"
          )}
        >
          <Upload className="h-5 w-5 text-muted-foreground mb-1" />
          <span className="text-xs text-muted-foreground">Choose file</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_MAP[accept]}
            className="sr-only"
            onChange={handleFileChange}
            disabled={disabled}
          />
        </label>
      )}

      {uploading && (
        <div className="h-20 rounded-lg border flex flex-col items-center justify-center gap-2 px-4">
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> {progress}% uploading…
          </span>
        </div>
      )}

      {hasFile && !uploading && (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
          <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-foreground flex-1 truncate">
            {hasPending ? pendingFile!.name : localKey!.split("/").pop()}
          </span>
          {hasPending && (
            <Badge variant="warning" className="rounded px-1.5 py-0.5 shrink-0">
              Pending
            </Badge>
          )}
          {!hasPending && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              onClick={handleView}
              title="View file"
              type="button"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {!disabled && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
              onClick={handleRemove}
              title="Remove file"
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
