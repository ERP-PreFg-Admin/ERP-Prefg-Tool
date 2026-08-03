"use client"

/**
 * Step-wise BOM creation wizard: SKU select -> existing-active-BOM check ->
 * entry method (manual/CSV) -> RM+PM line entry -> review & submit.
 *
 * All step state/handlers live in useBomWizard; step bodies live in
 * BomWizardSteps.tsx. This file is just dialog chrome, close-confirm, and
 * footer nav.
 */

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { type BomMaterialOption } from "./BomLineEditorGrid"
import { useBomWizard } from "./useBomWizard"
import {
  Step1SkuSelect,
  Step2ExistingBom,
  Step3EntryMethod,
  Step4LineEntry,
  Step5Review,
} from "./BomWizardSteps"
import type { Sku } from "@/types/masters"

export function BomCreationWizard({
  skus,
  rmMaterials,
  pmMaterials,
  onSuccess,
  onEditExisting,
}: {
  skus: Sku[]
  rmMaterials: BomMaterialOption[]
  pmMaterials: BomMaterialOption[]
  onSuccess: () => void
  onEditExisting: (bomId: number) => void
}) {
  const wizard = useBomWizard({ rmMaterials, pmMaterials, onSuccess, onEditExisting })
  const { step, loading, canProceedFromLines } = wizard

  return (
    <>
      <Button size="sm" onClick={() => wizard.setOpen(true)}>
        <Plus className="h-4 w-4 mr-1.5" />
        Create BOM
      </Button>

      <Dialog open={wizard.open} onOpenChange={(v) => { if (!v) wizard.requestClose() }}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Create BOM — Step {step} of 5</DialogTitle>
          </DialogHeader>

          {wizard.showCloseConfirm ? (
            <div className="py-6 text-center space-y-4">
              <p className="text-sm text-muted-foreground">You have unsaved changes. Close and discard?</p>
              <div className="flex justify-center gap-3">
                <Button variant="outline" size="sm" onClick={() => wizard.setShowCloseConfirm(false)}>
                  Keep editing
                </Button>
                <Button variant="destructive" size="sm" onClick={wizard.closeWizard}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <>
              {wizard.error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                  {wizard.error}
                </div>
              )}

              {/*
                Steps 1-3 are short (a single field / a couple of buttons) and
                must NOT scroll -- overflow-y-auto clips absolutely-positioned
                popups (e.g. Step1SkuSelect's searchable dropdown) at its own
                box edge, which is barely taller than the field itself here.
                Steps 4/5 (line grid, review) can genuinely get long, so they
                keep the scrolling wrapper.
              */}
              <div className={cn("flex-1 min-h-0", (step === 4 || step === 5) && "overflow-y-auto")}>
                {step === 1 && (
                  <Step1SkuSelect
                    skus={skus}
                    skuId={wizard.skuId}
                    loading={loading}
                    onSelect={wizard.handleSelectSku}
                  />
                )}

                {step === 2 && (
                  <Step2ExistingBom
                    existingBomCode={wizard.existingBomCode}
                    onUpdateExisting={wizard.handleUpdateExisting}
                    onCreateNewVersion={wizard.handleCreateNewVersion}
                  />
                )}

                {step === 3 && <Step3EntryMethod onChoose={wizard.chooseEntryMethod} />}

                {step === 4 && (
                  <Step4LineEntry
                    effectiveFrom={wizard.effectiveFrom}
                    onChangeEffectiveFrom={wizard.setEffectiveFrom}
                    entryMethod={wizard.entryMethod}
                    csvParsed={wizard.csvParsed}
                    csvErrors={wizard.csvErrors}
                    onCsvFile={wizard.handleCsvFile}
                    rmRows={wizard.rmRows}
                    pmRows={wizard.pmRows}
                    onChangeRm={wizard.setRmRows}
                    onChangePm={wizard.setPmRows}
                    rmMaterials={rmMaterials}
                    pmMaterials={pmMaterials}
                    pendingArtifactFiles={wizard.pendingArtifactFiles}
                    onChangePendingArtifactFiles={wizard.setPendingArtifactFiles}
                  />
                )}

                {step === 5 && (
                  <Step5Review
                    skus={skus}
                    skuId={wizard.skuId}
                    effectiveFrom={wizard.effectiveFrom}
                    rmRows={wizard.rmRows}
                    pmRows={wizard.pmRows}
                    rmMaterials={rmMaterials}
                    pmMaterials={pmMaterials}
                  />
                )}
              </div>

              {/* Footer nav */}
              <div className="flex items-center justify-between pt-2 border-t shrink-0">
                <div>
                  {step > 1 && step !== 2 && (
                    <Button variant="outline" size="sm" onClick={wizard.goBack} disabled={loading}>
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={wizard.requestClose} disabled={loading}>
                    Cancel
                  </Button>
                  {step === 4 && (
                    <Button size="sm" onClick={() => wizard.setStep(5)} disabled={loading || !canProceedFromLines}>
                      Next →
                    </Button>
                  )}
                  {step === 5 && (
                    <Button size="sm" onClick={wizard.handleSubmit} disabled={loading}>
                      {loading ? "Submitting…" : "Submit for Approval"}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
