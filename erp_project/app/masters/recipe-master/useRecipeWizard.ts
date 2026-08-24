"use client"

/**
 * Owns all step/form state and submit handlers for RecipeCreationWizard:
 * SKU select -> existing-active-Recipe check -> entry method (manual/CSV) ->
 * RM+PM line entry -> review & submit.
 *
 * "Update Existing Recipe" (step 2, shown when the picked SKU already has an
 * active Recipe) never submits from here — it closes the wizard and hands off
 * to the listing's edit-mode detail panel (onEditExisting), since editing in
 * place is a different surface (useBomDetailPanel.ts). This wizard otherwise
 * only ever submits mode:"new-version". Editing an existing Recipe directly
 * (without going through "Create Recipe" first) is also available via the
 * table's per-row Edit button, wired to the same onEditExisting.
 */

import { useState } from "react"
import { useToast } from "@/components/ui/toast"
import { isRmTotalValid } from "@/lib/validation/recipe"
import { rmTotal, type RecipeLineRow, type RecipeMaterialOption } from "./RecipeLineEditorGrid"
import { parseBomCsv } from "./recipe-csv"
import { uploadPendingArtifacts } from "./recipe-artifact-upload"
import type { RmLock } from "@/lib/masters/variant-rm-lock"

export type WizardStep = 1 | 2 | 3 | 4 | 5
export type EntryMethod = "manual" | "csv"

/** A sibling variant that a base-SKU RM change will re-version on approval. */
export type PropagationTarget = { sku_id: number; sku_code: string; bom_code: string | null }

export function useBomWizard({
  rmMaterials,
  pmMaterials,
  onSuccess,
  onEditExisting,
}: {
  rmMaterials: RecipeMaterialOption[]
  pmMaterials: RecipeMaterialOption[]
  onSuccess: () => void
  onEditExisting: (bomId: number) => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<WizardStep>(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const [skuId, setSkuId] = useState<number | null>(null)
  const [existingBomId, setExistingBomId] = useState<number | null>(null)
  const [existingBomCode, setExistingBomCode] = useState<string | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [entryMethod, setEntryMethod] = useState<EntryMethod | null>(null)
  const [csvParsed, setCsvParsed] = useState(false)
  const [csvErrors, setCsvErrors] = useState<string[]>([])
  const [rmRows, setRmRows] = useState<RecipeLineRow[]>([])
  const [pmRows, setPmRows] = useState<RecipeLineRow[]>([])
  const [pendingArtifactFiles, setPendingArtifactFiles] = useState<File[]>([])
  // Only required when existingBomId != null — i.e. Step 2 found this SKU
  // already has an active Recipe, so "Create New Recipe Version" here is really an
  // edit to an established recipe. Not required for a SKU's very first Recipe.
  const [reason, setReason] = useState("")
  const [changeType, setChangeType] = useState<("rm" | "pm")[]>([])
  // Variant-family RM rule, resolved server-side by check-existing the moment a
  // SKU is picked. Advisory here — create-full re-resolves it and rejects an
  // altered RM regardless of what this client did.
  const [rmLock, setRmLock] = useState<RmLock | null>(null)
  const [propagationTargets, setPropagationTargets] = useState<PropagationTarget[]>([])

  const rmLocked = rmLock?.locked === true

  const isDirty = skuId != null || rmRows.length > 0 || pmRows.length > 0 || pendingArtifactFiles.length > 0

  function resetAll() {
    setStep(1)
    setError(null)
    setShowCloseConfirm(false)
    setSkuId(null)
    setExistingBomId(null)
    setExistingBomCode(null)
    setEffectiveFrom("")
    setEntryMethod(null)
    setCsvParsed(false)
    setCsvErrors([])
    setRmRows([])
    setPmRows([])
    setPendingArtifactFiles([])
    setReason("")
    setChangeType([])
    setRmLock(null)
    setPropagationTargets([])
    setLoading(false)
  }

  function closeWizard() {
    setOpen(false)
    resetAll()
  }

  function requestClose() {
    if (isDirty) setShowCloseConfirm(true)
    else closeWizard()
  }

  async function handleSelectSku(id: number) {
    setError(null)
    setSkuId(id)
    setLoading(true)
    try {
      const res = await fetch("/api/v1/masters/recipe-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-existing", sku_id: id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to check existing Recipes")

      setRmLock(data.rm_lock ?? null)
      setPropagationTargets(data.propagation_targets ?? [])

      // A locked SKU's RM is not its own to enter — seed the read-only grid from
      // the family's owner so the submitter sees the formulation they're
      // packaging, and so an untouched submit matches what the server expects.
      if (data.rm_lock?.locked && (data.inherited_rm_lines ?? []).length > 0) {
        setRmRows(
          (data.inherited_rm_lines as { mtrl_id: number; amount: number; uom: string | null }[]).map((l) => ({
            mtrl_type: "rm" as const,
            mtrl_id: l.mtrl_id,
            amount: String(l.amount),
            uom: l.uom ?? "",
          }))
        )
      }

      if (data.hasActive) {
        setExistingBomId(data.recipe_id)
        setExistingBomCode(data.bom_code)
        setStep(2)
      } else if (data.rm_lock?.locked) {
        // No recipe of its own, but the family already owns an RM — Step 2 is
        // still where that has to be explained, before any lines are entered.
        setStep(2)
      } else {
        setStep(3)
      }
    } catch (e: any) {
      setError(e.message || "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  function handleUpdateExisting() {
    if (existingBomId == null) return
    onEditExisting(existingBomId)
    closeWizard()
  }

  function handleCreateNewVersion() {
    setStep(3)
  }

  function chooseEntryMethod(method: EntryMethod) {
    setEntryMethod(method)
    setCsvParsed(method === "manual") // manual entry has no separate "parsed" gate
    setStep(4)
  }

  function handleCsvFile(file: File) {
    setCsvErrors([])
    file.text().then((text) => {
      const { rows, errors } = parseBomCsv(text, rmMaterials, pmMaterials)
      if (errors.length > 0) {
        setCsvErrors(errors)
        return
      }
      // A locked SKU keeps its inherited RM even if the CSV carries RM rows —
      // importing them would propose an RM change create-full then rejects,
      // with the user left guessing which half of their file was the problem.
      // Only the PM half of the file is theirs to set; the RM section renders
      // locked with the inherited values, which is where that reads.
      if (!rmLocked) setRmRows(rows.filter((r) => r.mtrl_type === "rm"))
      setPmRows(rows.filter((r) => r.mtrl_type === "pm"))
      setCsvParsed(true)
    })
  }

  // Step 2 is shown for either reason: this SKU already has a Recipe, or its
  // variant family already owns the RM this one must inherit.
  const step2Shown = existingBomId != null || rmLocked

  function goBack() {
    setError(null)
    // Step 3's "back" skips Step 2 if it was never shown — otherwise every
    // other step just steps back by 1. Step 1 is the first step, so it has no
    // back target.
    if (step === 3) setStep(step2Shown ? 2 : 1)
    else setStep((s) => (s - 1) as WizardStep)
  }

  const rmValid = rmRows.length > 0 && isRmTotalValid(rmTotal(rmRows))
  // Number(), not truthiness: r.amount is a STRING, and "0" is truthy — a line
  // left at 0 sailed past this check and only died on the server's
  // z.coerce.number().positive() as a generic 400.
  const allRmFieldsFilled = rmRows.every((r) => r.mtrl_id && Number(r.amount) > 0)
  const allPmFieldsFilled = pmRows.every((r) => r.mtrl_id && Number(r.amount) > 0)
  // effective_from is deliberately absent: it's optional, so a recipe can be
  // drafted before its start date is decided.
  const canProceedFromLines =
    rmValid && allRmFieldsFilled && allPmFieldsFilled && effectiveFrom.trim().length > 0 &&
    (existingBomId == null || (reason.trim().length > 0 && changeType.length > 0))

  async function handleSubmit() {
    setError(null)
    if (!skuId) { setError("Select a SKU first."); return }
    if (!effectiveFrom.trim()) { setError("Effective From is required."); return }
    if (rmRows.length === 0) { setError("At least one RM line is required."); return }
    if (!isRmTotalValid(rmTotal(rmRows))) {
      setError(`RM percentages must total between 99.9% and 100.1% (currently ${rmTotal(rmRows).toFixed(2)}%).`)
      return
    }
    for (const r of [...rmRows, ...pmRows]) {
      if (!r.mtrl_id || !(Number(r.amount) > 0)) {
        setError("Every line requires a material and an amount greater than 0.")
        return
      }
    }
    if (existingBomId != null && (!reason.trim() || changeType.length === 0)) {
      setError("A reason and at least one type of change (RM/PM) are required when revising an existing Recipe.")
      return
    }

    setLoading(true)
    try {
      const artifactAdds = await uploadPendingArtifacts(
        pendingArtifactFiles,
        `boms/tmp/${crypto.randomUUID()}`
      )

      const toLine = (r: RecipeLineRow) => ({
        mtrl_type: r.mtrl_type,
        mtrl_id: r.mtrl_id,
        amount: Number(r.amount),
        uom: r.uom || null,
      })
      const res = await fetch("/api/v1/masters/recipe-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-full",
          mode: "new-version",
          sku_id: skuId,
          effective_from: effectiveFrom.trim(),
          source: entryMethod === "csv" ? "csv" : "manual",
          rm_lines: rmRows.map(toLine),
          pm_lines: pmRows.map(toLine),
          artifact_adds: artifactAdds,
          reason: existingBomId != null ? reason.trim() : undefined,
          change_type: existingBomId != null ? changeType : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to submit Recipe")
      closeWizard()
      toast({ title: "Recipe submitted for approval", description: data.bom_code ?? undefined, variant: "success" })
      onSuccess()
    } catch (e: any) {
      setError(e.message || "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return {
    open,
    setOpen,
    step,
    setStep,
    loading,
    error,
    showCloseConfirm,
    setShowCloseConfirm,
    skuId,
    existingBomId,
    existingBomCode,
    effectiveFrom,
    setEffectiveFrom,
    entryMethod,
    csvParsed,
    csvErrors,
    rmRows,
    setRmRows,
    pmRows,
    setPmRows,
    pendingArtifactFiles,
    setPendingArtifactFiles,
    reason,
    setReason,
    changeType,
    setChangeType,
    rmLock,
    rmLocked,
    propagationTargets,
    step2Shown,
    requestClose,
    closeWizard,
    handleSelectSku,
    handleUpdateExisting,
    handleCreateNewVersion,
    chooseEntryMethod,
    handleCsvFile,
    goBack,
    canProceedFromLines,
    handleSubmit,
  }
}
