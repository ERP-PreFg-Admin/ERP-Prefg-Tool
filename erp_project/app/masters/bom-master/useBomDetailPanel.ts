"use client"

/**
 * Owns the BOM master detail panel: URL-synced ?bomId= selection, the
 * permission-checked detail fetch (with an in-memory cache + hover-prefetch),
 * and the shared edit-mode surface used by both "Update Existing BOM" and the
 * listing's per-row Edit button.
 *
 * Editing here always creates a NEW BOM version (new bom_code, new
 * effective_from) seeded from the current lines — never an in-place
 * overwrite. saveEdit() submits mode:"new-version", not "update-existing".
 *
 * Split out of BOMMasterComponent so the component itself only wires this
 * state into the table + detail panel views.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useToast } from "@/components/ui/toast"
import { isRmTotalValid } from "@/lib/validation/bom"
import { rmTotal, type BomLineRow } from "./BomLineEditorGrid"
import { uploadPendingArtifacts } from "./bom-artifact-upload"
import type { BomDetailResponse } from "@/types/masters"

export function useBomDetailPanel() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const { toast }    = useToast()

  const [selectedBomId, setSelectedBomId] = useState<number | null>(() => {
    const raw = searchParams.get("bomId")
    return raw && /^\d+$/.test(raw) ? Number(raw) : null
  })
  const [detail, setDetail]               = useState<BomDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError]     = useState<string | null>(null)
  const [activeMtrlType, setActiveMtrlType] = useState<"rm" | "pm">("rm")

  const [editMode, setEditMode]           = useState(false)
  const [editSeededFor, setEditSeededFor] = useState<number | null>(null)
  const [editRmRows, setEditRmRows]       = useState<BomLineRow[]>([])
  const [editPmRows, setEditPmRows]       = useState<BomLineRow[]>([])
  // Effective From for the NEW version being created — defaults to today,
  // editable before submit. Not seeded from the predecessor's own date.
  const [editEffectiveFrom, setEditEffectiveFrom] = useState("")
  const [saving, setSaving]               = useState(false)
  const [saveError, setSaveError]         = useState<string | null>(null)

  // Status is edited/saved independently of the RM/PM lines above — it's a
  // direct, immediate change (no approval gate), unlike the line edits.
  const [editStatus, setEditStatus]       = useState<string>("")
  const [statusSaving, setStatusSaving]   = useState(false)
  const [statusError, setStatusError]     = useState<string | null>(null)

  // Artifacts are staged client-side and bundled into saveEdit's create-full
  // submission — see BomArtifactsEditor.tsx and bom-artifact-upload.ts.
  const [pendingArtifactFiles, setPendingArtifactFiles] = useState<File[]>([])
  const [pendingArtifactRemoveIds, setPendingArtifactRemoveIds] = useState<number[]>([])

  // In-memory cache of fetched BOM details, keyed by bom_id, so re-opening a
  // BOM already seen this session (or one warmed by hover-prefetch) is
  // instant instead of re-hitting the API.
  const detailCache = useRef<Map<number, BomDetailResponse>>(new Map())
  const inFlight     = useRef<Map<number, Promise<BomDetailResponse>>>(new Map())
  const hoverTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }
  }, [])

  const fetchDetail = useCallback((bomId: number, opts?: { skipCache?: boolean }) => {
    if (!opts?.skipCache) {
      const cached = detailCache.current.get(bomId)
      if (cached) return Promise.resolve(cached)
    } else {
      detailCache.current.delete(bomId)
    }

    const pending = inFlight.current.get(bomId)
    if (pending && !opts?.skipCache) return pending

    const req = fetch(`/api/masters/bom-master/${bomId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || "Failed to load BOM detail")
        }
        return res.json() as Promise<BomDetailResponse>
      })
      .then((data) => {
        detailCache.current.set(bomId, data)
        return data
      })
      .finally(() => { inFlight.current.delete(bomId) })

    inFlight.current.set(bomId, req)
    return req
  }, [])

  /** Warm the cache on hover so the click a moment later is instant. Debounced
   *  — sweeping the cursor across many rows only fires a request for the one
   *  it actually settles on, not one per row it passed over. */
  function prefetchDetail(bomId: number | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (bomId == null) return
    hoverTimer.current = setTimeout(() => {
      fetchDetail(bomId).catch(() => {})
    }, 200)
  }

  // Fetch the selected BOM's detail from the permission-checked API route.
  // Runs whenever selectedBomId changes, including on initial load from a
  // deep-linked ?bomId= — the server enforces access, not the URL.
  useEffect(() => {
    if (selectedBomId == null) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    setActiveMtrlType("rm")

    const cached = detailCache.current.get(selectedBomId)
    if (cached) {
      setDetail(cached)
      setDetailError(null)
      setDetailLoading(false)
      return
    }

    setDetailLoading(true)
    setDetailError(null)
    fetchDetail(selectedBomId)
      .then((data) => { if (!cancelled) setDetail(data) })
      .catch((err) => { if (!cancelled) setDetailError(err.message) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedBomId, fetchDetail])

  // Seed the editable row state once, the first time detail loads while in
  // edit mode for this BOM — not on every detail change, or in-progress
  // edits would get clobbered.
  useEffect(() => {
    if (!editMode || !detail || detail.bom_id == null) return
    if (editSeededFor === detail.bom_id) return
    const toRow = (l: (typeof detail.lines)[number]): BomLineRow => ({
      mtrl_type: (l.mtrl_type as "rm" | "pm") ?? "rm",
      mtrl_id: l.mtrl_id,
      amount: l.amount != null ? String(l.amount) : "",
      uom: l.uom ?? "",
    })
    setEditRmRows(detail.lines.filter((l) => l.mtrl_type === "rm").map(toRow))
    setEditPmRows(detail.lines.filter((l) => l.mtrl_type === "pm").map(toRow))
    setEditStatus(detail.status ?? "")
    setEditEffectiveFrom(new Date().toISOString().slice(0, 10))
    setStatusError(null)
    setEditSeededFor(detail.bom_id)
  }, [editMode, detail, editSeededFor])

  // RM lines are expected to add up to a full 100% formulation.
  const rmLines      = detail?.lines.filter((l) => l.mtrl_type === "rm") ?? []
  const pmLines      = detail?.lines.filter((l) => l.mtrl_type === "pm") ?? []
  const rmDetailTotal = rmLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  const rmIsBalanced  = rmLines.length > 0 && isRmTotalValid(rmDetailTotal)
  const visibleLines  = activeMtrlType === "rm" ? rmLines : pmLines

  /** Toggle selection. */
  function handleRowClick(bomId: number) {
    if (editMode) return // don't let a stray row click abandon an in-progress edit
    const nextId = selectedBomId === bomId ? null : bomId
    setSelectedBomId(nextId)

    const params = new URLSearchParams(searchParams.toString())
    if (nextId == null) params.delete("bomId")
    else                params.set("bomId", String(nextId))
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function closeDetail() {
    setEditMode(false)
    setEditSeededFor(null)
    setSaveError(null)
    setStatusError(null)
    setPendingArtifactFiles([])
    setPendingArtifactRemoveIds([])
    setSelectedBomId(null)
    const params = new URLSearchParams(searchParams.toString())
    params.delete("bomId")
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  /** Opens the shared edit surface for a BOM — used by both the wizard's
   *  "Update Existing BOM" option and the listing's per-row Edit button. */
  function openEditMode(bomId: number) {
    setSelectedBomId(bomId)
    setEditMode(true)
    setEditSeededFor(null)
    setSaveError(null)
    setStatusError(null)
    setPendingArtifactFiles([])
    setPendingArtifactRemoveIds([])
    const params = new URLSearchParams(searchParams.toString())
    params.set("bomId", String(bomId))
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function cancelEdit() {
    setEditMode(false)
    setEditSeededFor(null)
    setSaveError(null)
    setStatusError(null)
    setPendingArtifactFiles([])
    setPendingArtifactRemoveIds([])
  }

  async function saveEdit() {
    setSaveError(null)

    // detail normally arrives well before the user finishes editing, but for
    // a BOM that was never pre-viewed (direct per-row Edit click, or the
    // wizard's Update/Modify Existing flows) a fast edit can beat the async
    // fetch. Await the same in-flight/cached request instead of failing —
    // it resolves almost immediately since the fetch was already kicked off
    // by openEditMode's effect.
    let bomId = detail?.bom_id ?? null
    let skuId = detail?.sku_id ?? null
    if (bomId == null || skuId == null) {
      if (selectedBomId == null) {
        setSaveError("No BOM selected.")
        return
      }
      let fresh: BomDetailResponse
      try {
        fresh = await fetchDetail(selectedBomId)
      } catch (e: any) {
        setSaveError(e.message || "Failed to load BOM details. Please try again.")
        return
      }
      setDetail(fresh)
      bomId = fresh.bom_id
      skuId = fresh.sku_id
      if (bomId == null || skuId == null) {
        setSaveError("This BOM is missing its SKU link and cannot be submitted for approval.")
        return
      }
    }

    // No Effective From check: it's optional here too. Editing creates a new
    // version, so requiring it here but not in the creation wizard would make
    // the same field mandatory in one place and not the other.
    if (editRmRows.length === 0) {
      setSaveError("At least one RM line is required.")
      return
    }
    if (!isRmTotalValid(rmTotal(editRmRows))) {
      setSaveError(`RM percentages must total between 99.9% and 100.1% (currently ${rmTotal(editRmRows).toFixed(2)}%).`)
      return
    }
    for (const r of [...editRmRows, ...editPmRows]) {
      if (!r.mtrl_id || !r.amount) {
        setSaveError("Every line requires a material and an amount.")
        return
      }
    }

    setSaving(true)
    try {
      // Editing an existing BOM always creates a NEW version — the server
      // computes its <sku_code>RM<n>PM<n> code (independent RM/PM version
      // bump vs. the SKU's prior BOM), not this client.
      const artifactAdds = await uploadPendingArtifacts(
        pendingArtifactFiles,
        `boms/tmp/${crypto.randomUUID()}`
      )

      const toLine = (r: BomLineRow) => ({
        mtrl_type: r.mtrl_type,
        mtrl_id: r.mtrl_id,
        amount: Number(r.amount),
        uom: r.uom || null,
      })
      const res = await fetch("/api/masters/bom-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-full",
          mode: "new-version",
          sku_id: skuId,
          effective_from: editEffectiveFrom.trim(),
          source: "manual",
          rm_lines: editRmRows.map(toLine),
          pm_lines: editPmRows.map(toLine),
          artifact_adds: artifactAdds,
          artifact_removes: pendingArtifactRemoveIds,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to submit new BOM version")
      setEditMode(false)
      setEditSeededFor(null)
      setPendingArtifactFiles([])
      setPendingArtifactRemoveIds([])
      // Switch the panel over to the newly created version, not the
      // predecessor it's replacing.
      const newBomId: number = data.bom_id
      setSelectedBomId(newBomId)
      fetchDetail(newBomId, { skipCache: true }).then(setDetail).catch(() => {})
      const params = new URLSearchParams(searchParams.toString())
      params.set("bomId", String(newBomId))
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
      toast({ title: "New BOM version submitted for approval", description: data.bom_code ?? undefined, variant: "success" })
      router.refresh()
    } catch (e: any) {
      const message = e.message || "An error occurred"
      setSaveError(message)
      toast({ title: "Failed to submit new BOM version", description: message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  /** Direct, immediate status change — separate from saveEdit's line-diff
   *  approval submit. Only guarded server-side by "no pending approval". */
  async function saveStatus() {
    setStatusError(null)
    const bomId = detail?.bom_id ?? selectedBomId
    if (bomId == null) { setStatusError("No BOM selected."); return }
    if (!editStatus) { setStatusError("Select a status."); return }

    setStatusSaving(true)
    try {
      const res = await fetch("/api/masters/bom-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-status", bom_id: bomId, status: editStatus }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to update BOM status")
      fetchDetail(bomId, { skipCache: true }).then(setDetail).catch(() => {})
      toast({ title: "BOM status updated", description: editStatus, variant: "success" })
      router.refresh()
    } catch (e: any) {
      const message = e.message || "An error occurred"
      setStatusError(message)
      toast({ title: "Failed to update BOM status", description: message, variant: "error" })
    } finally {
      setStatusSaving(false)
    }
  }

  return {
    selectedBomId,
    detail,
    detailLoading,
    detailError,
    activeMtrlType,
    setActiveMtrlType,
    editMode,
    editRmRows,
    setEditRmRows,
    editPmRows,
    setEditPmRows,
    editEffectiveFrom,
    setEditEffectiveFrom,
    saving,
    saveError,
    editStatus,
    setEditStatus,
    statusSaving,
    statusError,
    saveStatus,
    pendingArtifactFiles,
    setPendingArtifactFiles,
    pendingArtifactRemoveIds,
    setPendingArtifactRemoveIds,
    rmLines,
    pmLines,
    rmDetailTotal,
    rmIsBalanced,
    visibleLines,
    prefetchDetail,
    handleRowClick,
    closeDetail,
    openEditMode,
    cancelEdit,
    saveEdit,
  }
}
