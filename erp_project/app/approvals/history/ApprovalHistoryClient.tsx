"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { ArrowLeft, History as HistoryIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PaginationBar } from "@/components/ui/pagination-bar"
import type { Approval } from "../approvals-types"
import { MODULE_LABEL } from "../approvals-types"
import ApprovalCard, { type MaterialMap } from "../ApprovalCard"
import CsvPreviewDialog from "../CsvPreviewDialog"

export default function ApprovalHistoryClient({
  approvals,
  total,
  page,
  pageSize,
  currentModule,
  currentStatus,
  materialMap,
}: {
  approvals:     Approval[]
  total:         number
  page:          number
  pageSize:      number
  currentModule: string
  currentStatus: string
  materialMap:   MaterialMap
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const [expanded,       setExpanded]       = useState<number | null>(null)
  const [csvPreview,     setCsvPreview]     = useState<{ s3Key: string; filename: string } | null>(null)

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }

  function openCsvFile(_approvalId: number, s3Key: string, filename: string) {
    setCsvPreview({ s3Key, filename })
  }

  // Draft filter state — selects only update these locally; the actual
  // server refetch fires only when "Apply" is clicked.
  const [draftModule, setDraftModule] = useState(currentModule)
  const [draftStatus, setDraftStatus] = useState(currentStatus)
  useEffect(() => setDraftModule(currentModule), [currentModule])
  useEffect(() => setDraftStatus(currentStatus), [currentStatus])
  const draftDirty = draftModule !== currentModule || draftStatus !== currentStatus

  const hasFilters = Boolean(currentModule || currentStatus)

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between mb-5 px-6 pt-6">
        <div>
          <div className="flex items-center gap-2.5">
            <HistoryIcon className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Approval History</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every approved or rejected master-data change
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push("/approvals")}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Pending
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-6 mb-4">
        <select
          value={draftModule || "all"}
          onChange={(e) => setDraftModule(e.target.value === "all" ? "" : e.target.value)}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="all">All Modules</option>
          {Object.entries(MODULE_LABEL).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>

        <select
          value={draftStatus || "all"}
          onChange={(e) => setDraftStatus(e.target.value === "all" ? "" : e.target.value)}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="all">Approved + Rejected</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>

        <button
          onClick={() => navigate({ module: draftModule, status: draftStatus })}
          disabled={!draftDirty}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Apply
        </button>

        {hasFilters && (
          <button
            onClick={() => {
              setDraftModule("")
              setDraftStatus("")
              navigate({ module: "", status: "" })
            }}
            className="text-xs text-primary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Empty state */}
      {approvals.length === 0 ? (
        <Card className="mx-6 mb-6">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="rounded-full bg-muted p-4">
              <HistoryIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">No history yet</p>
            <p className="text-sm text-muted-foreground">Approved and rejected edits will show up here.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3 px-4">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                isExpanded={expanded === approval.id}
                isApprover={false}
                loading={false}
                onToggle={() => setExpanded((prev) => (prev === approval.id ? null : approval.id))}
                onApprove={() => {}}
                onReject={() => {}}
                onOpenCsvFile={openCsvFile}
                materialMap={materialMap}
              />
            ))}
          </div>
          <Card className="mx-4 mt-3 mb-6">
            <PaginationBar total={total} page={page} pageSize={pageSize} />
          </Card>
        </>
      )}

      <CsvPreviewDialog
        open={csvPreview !== null}
        s3Key={csvPreview?.s3Key ?? null}
        filename={csvPreview?.filename ?? ""}
        onClose={() => setCsvPreview(null)}
      />
    </>
  )
}
