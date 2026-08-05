"use client"

import { useState } from "react"
import { cva } from "class-variance-authority"
import { ExternalLink, Loader2 as SpinIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { DIFF_OLD_CELL_CLASS, DIFF_NEW_CELL_CLASS } from "./diff-colors"

/** Doc key fields — rendered as view buttons instead of raw S3 keys. */
export const DOC_FIELDS = new Set([
  "gst_certificate_key", "cancelled_cheque_key", "pan_card_key", "misc_document_key",
])

/** Same red/emerald tokens as every other diff renderer (see diff-colors.ts),
 *  applied to a clickable chip instead of a static label. */
const docViewButtonVariants = cva(
  "flex-1 min-w-0 flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60",
  {
    variants: {
      variant: {
        old: cn(DIFF_OLD_CELL_CLASS, "border-red-100 hover:bg-red-100 dark:border-red-900/40 dark:hover:bg-red-950/50"),
        new: cn(DIFF_NEW_CELL_CLASS, "border-emerald-100 hover:bg-emerald-100 dark:border-emerald-900/40 dark:hover:bg-emerald-950/50"),
      },
    },
  }
)

export function DocViewButton({ s3Key, variant }: { s3Key: string; variant: "old" | "new" }) {
  const [opening, setOpening] = useState(false)
  const [failed,  setFailed]  = useState(false)

  async function handleView() {
    setOpening(true)
    setFailed(false)
    try {
      const res  = await fetch(`/api/files/presign?key=${encodeURIComponent(s3Key)}`)
      const data = await res.json()
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  const filename = s3Key.split("/").pop() ?? s3Key

  return (
    <button
      onClick={handleView}
      disabled={opening}
      title={s3Key}
      className={cn(docViewButtonVariants({ variant }))}
    >
      {opening
        ? <SpinIcon className="h-3 w-3 shrink-0 animate-spin" />
        : <ExternalLink className="h-3 w-3 shrink-0" />
      }
      <span className="truncate">{failed ? "Error opening" : filename}</span>
    </button>
  )
}
