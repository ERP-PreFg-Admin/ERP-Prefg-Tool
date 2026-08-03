"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ShieldCheck, History, ChevronDown, ChevronRight, CheckCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody } from "@/components/ui/table"
import { useToast } from "@/components/ui/toast"
import type { Approval } from "./approvals-types"
import { MODULE_LABEL, MODULE_COLOR, BULK_MODULES, groupKeyFor, isNewRecord } from "./approvals-types"
import ApprovalCard, { ApprovalRow, type MaterialMap } from "./ApprovalCard"
import RejectDialog from "./RejectDialog"
import BulkApproveDialog from "./BulkApproveDialog"
import CsvPreviewDialog from "./CsvPreviewDialog"

/** Groups pending approvals by module — busiest module first — so the list
 *  reads as one light row per module instead of every approval stacked flat.
 *  Bulk-upload modules (e.g. MFG_BULK) fold into their base module's group
 *  (MFG) via groupKeyFor, so "Bulk Manufacturer Upload" and "Manufacturer"
 *  read as one "Manufacturer" section instead of two. */
function groupByModule(approvals: Approval[]) {
  const map = new Map<string, Approval[]>()
  for (const a of approvals) {
    const key  = groupKeyFor(a.module)
    const list = map.get(key) ?? []
    list.push(a)
    map.set(key, list)
  }
  return [...map.entries()]
    .map(([module, items]) => ({ module, items }))
    .sort((a, b) => b.items.length - a.items.length)
}

/** Within a module group, splits approvals into "New" (brand-new records —
 *  every changed field has no prior value), "Edits" (existing records
 *  changed), and "Bulk Uploads" (CSV batch approvals), so each reads as its
 *  own condensed section instead of one undifferentiated stack. */
function splitGroupItems(items: Approval[]) {
  const bulkItems: Approval[] = []
  const newItems:  Approval[] = []
  const editItems: Approval[] = []
  for (const a of items) {
    if (BULK_MODULES.has(a.module)) bulkItems.push(a)
    else if (isNewRecord(a.items)) newItems.push(a)
    else editItems.push(a)
  }
  return { bulkItems, newItems, editItems }
}

export default function ApprovalsClient({
  approvals: initialApprovals,
  isApprover,
  materialMap,
}: {
  approvals:   Approval[]
  isApprover:  boolean
  materialMap: MaterialMap
}) {
  const router = useRouter()
  const { toast } = useToast()

  const [approvals,      setApprovals]      = useState<Approval[]>(initialApprovals)
  const [expanded,       setExpanded]       = useState<number | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [rejectTarget,   setRejectTarget]   = useState<Approval | null>(null)
  const [bulkTarget,     setBulkTarget]     = useState<string | null>(null)
  const [bulkLoading,    setBulkLoading]    = useState(false)
  const [loading,        setLoading]        = useState(false)
  const [actionError,    setActionError]    = useState<Record<number, string>>({})
  const [csvPreview,     setCsvPreview]     = useState<{ s3Key: string; filename: string } | null>(null)

  function clearError(id: number) {
    setActionError(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  function toggleExpand(id: number) {
    setExpanded(prev => prev === id ? null : id)
    clearError(id)
  }

  function toggleGroup(module: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(module)) next.delete(module)
      else next.add(module)
      return next
    })
  }

  const groupedApprovals = useMemo(() => groupByModule(approvals), [approvals])

  function openCsvFile(_approvalId: number, s3Key: string, filename: string) {
    setCsvPreview({ s3Key, filename })
  }

  async function handleApprove(approval: Approval) {
    setLoading(true); clearError(approval.id)
    try {
      const res  = await fetch(`/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? "Failed to approve"
        setActionError(prev => ({ ...prev, [approval.id]: message }))
        toast({ title: "Approval failed", description: message, variant: "error" })
        return
      }
      setApprovals(prev => prev.filter(a => a.id !== approval.id))
      setExpanded(null)
      toast({
        title: "Approved",
        description: `${MODULE_LABEL[approval.module] ?? approval.module} change has been approved.`,
        variant: "success",
      })
      router.refresh()
    } catch {
      setActionError(prev => ({ ...prev, [approval.id]: "Network error" }))
      toast({ title: "Approval failed", description: "Network error — please try again.", variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  async function handleReject(approval: Approval, remarks: string) {
    setLoading(true)
    try {
      const res  = await fetch(`/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", remarks }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to reject")
      setApprovals(prev => prev.filter(a => a.id !== approval.id))
      setExpanded(null)
      setRejectTarget(null)
      toast({
        title: "Rejected",
        description: `${MODULE_LABEL[approval.module] ?? approval.module} change has been rejected.`,
        variant: "info",
      })
      router.refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error — please try again."
      toast({ title: "Rejection failed", description: message, variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  async function handleBulkApprove(module: string) {
    const targets = approvals.filter(a => groupKeyFor(a.module) === module)
    setBulkLoading(true)
    const succeededIds: number[] = []
    let failedCount = 0

    for (const a of targets) {
      try {
        const res = await fetch(`/api/approvals/${a.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        })
        if (res.ok) succeededIds.push(a.id)
        else failedCount++
      } catch {
        failedCount++
      }
    }

    setApprovals(prev => prev.filter(a => !succeededIds.includes(a.id)))
    setBulkLoading(false)
    setBulkTarget(null)
    toast({
      title: failedCount === 0 ? "All approved" : "Finished with errors",
      description: `${succeededIds.length} approved${failedCount > 0 ? `, ${failedCount} failed` : ""}.`,
      variant: failedCount === 0 ? "success" : "error",
    })
    if (succeededIds.length > 0) router.refresh()
  }

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between mb-5 px-6 pt-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">Pending Approvals</h1>
            {approvals.length > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-[11px] font-bold text-amber-700">
                {approvals.length}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {approvals.length === 0
              ? "All caught up — no pending edits."
              : "The following data changes are awaiting your review"}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {!isApprover && (
            <div className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              View only — admin or manager role required
            </div>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push("/approvals/history")}>
            <History className="h-3.5 w-3.5" />
            View History
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {approvals.length === 0 ? (
        <Card className="mx-6 mb-6">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="rounded-full bg-emerald-50 p-4">
              <Check className="h-6 w-6 text-emerald-600" />
            </div>
            <p className="font-medium">No pending approvals</p>
            <p className="text-sm text-muted-foreground">All edits have been reviewed.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5 px-4 pb-6">
          {groupedApprovals.map(({ module, items }) => {
            const isGroupOpen = expandedGroups.has(module)
            const moduleColor = MODULE_COLOR[module] ?? "bg-slate-50 text-slate-700 border-slate-200"

            return (
              <div
                key={module}
                className={`rounded-lg border border-border/60 overflow-hidden ${isGroupOpen ? "bg-muted/30" : ""}`}
              >
                <div className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 hover:bg-muted/40 transition-colors">
                  <button
                    onClick={() => toggleGroup(module)}
                    className="flex flex-1 items-center gap-2 text-left min-w-0"
                  >
                    {isGroupOpen
                      ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    }
                    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${moduleColor}`}>
                      {MODULE_LABEL[module] ?? module}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {items.length} pending
                    </span>
                  </button>
                  {isApprover && (
                    <Button
                      size="sm"
                      className="h-6 shrink-0 gap-1 bg-emerald-800 hover:bg-emerald-900 text-white border-0 px-2 text-[11px]"
                      onClick={(e) => { e.stopPropagation(); setBulkTarget(module) }}
                    >
                      <CheckCheck className="h-3 w-3" /> Approve All
                    </Button>
                  )}
                </div>

                {isGroupOpen && (() => {
                  const { bulkItems, newItems, editItems } = splitGroupItems(items)
                  const sections = [
                    { label: "New",          list: newItems },
                    { label: "Edits",        list: editItems },
                    { label: "Bulk Uploads", list: bulkItems },
                  ].filter(s => s.list.length > 0)
                  // BOM diffs span multiple materials × fields and can't collapse into
                  // one table row, so BOM keeps the card layout; everything else renders
                  // as a condensed table, one row per approval.
                  const isBomGroup = module === "BOM"

                  return (
                    <div className="space-y-3 pt-1.5 pb-2 pl-2 pr-2">
                      {sections.map(({ label, list }) => (
                        <div key={label} className="space-y-1.5">
                          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground pl-1">
                            {label} ({list.length})
                          </p>
                          {isBomGroup ? (
                            list.map((approval) => (
                              <ApprovalCard
                                key={approval.id}
                                approval={approval}
                                isExpanded={expanded === approval.id}
                                alwaysExpanded
                                isApprover={isApprover}
                                loading={loading}
                                error={actionError[approval.id]}
                                onToggle={() => toggleExpand(approval.id)}
                                onApprove={() => handleApprove(approval)}
                                onReject={() => setRejectTarget(approval)}
                                onOpenCsvFile={openCsvFile}
                                materialMap={materialMap}
                              />
                            ))
                          ) : (
                            <div className="rounded-lg border border-border bg-card overflow-hidden">
                              <Table>
                                <TableBody>
                                  {list.map((approval) => (
                                    <ApprovalRow
                                      key={approval.id}
                                      approval={approval}
                                      isApprover={isApprover}
                                      loading={loading}
                                      error={actionError[approval.id]}
                                      onApprove={() => handleApprove(approval)}
                                      onReject={() => setRejectTarget(approval)}
                                      onOpenCsvFile={openCsvFile}
                                    />
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}

      <RejectDialog
        open={rejectTarget !== null}
        loading={loading}
        onClose={() => setRejectTarget(null)}
        onConfirm={(remarks) => rejectTarget && handleReject(rejectTarget, remarks)}
      />

      <BulkApproveDialog
        open={bulkTarget !== null}
        moduleLabel={bulkTarget ? (MODULE_LABEL[bulkTarget] ?? bulkTarget) : ""}
        count={bulkTarget ? approvals.filter(a => groupKeyFor(a.module) === bulkTarget).length : 0}
        loading={bulkLoading}
        onClose={() => setBulkTarget(null)}
        onConfirm={() => bulkTarget && handleBulkApprove(bulkTarget)}
      />

      <CsvPreviewDialog
        open={csvPreview !== null}
        s3Key={csvPreview?.s3Key ?? null}
        filename={csvPreview?.filename ?? ""}
        onClose={() => setCsvPreview(null)}
      />
    </>
  )
}
