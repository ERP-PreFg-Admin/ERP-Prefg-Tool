"use client"

// Finds Uniware POs no ERP invoice owns and fixes them: preview first (written then rolled back), apply on a second yes.
// One request per facility so each fits maxDuration. See docs/uniware-manual-po-autofix-plan.md.

import { useState } from "react"
import { Loader2, SearchCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { apiErrorMessage } from "@/lib/api-error-message"
import { EXTERNAL_PO_WINDOW_DAYS, type FixAction, type FixResult } from "@/lib/uniware/external-po"

type Stage = "idle" | "confirm" | "working" | "review" | "done"

const GROUPS: { action: FixAction; title: (n: number, done: boolean) => string }[] = [
  { action: "create", title: (n, d) => `${n} new invoice${n === 1 ? "" : "s"} ${d ? "created" : "to create"} from Uniware POs` },
  { action: "relink", title: (n, d) => `${n} invoice${n === 1 ? "" : "s"} ${d ? "relinked" : "to relink"} to the corrected Uniware PO` },
  { action: "revert_request", title: (n, d) => `${n} revert${n === 1 ? "" : "s"} ${d ? "requested" : "to request"}, for someone else to approve` },
  { action: "manual", title: (n) => `${n} to do by hand in Uniware` },
  { action: "skip", title: (n) => `${n} could not be fixed` },
]
const WRITES: FixAction[] = ["create", "relink", "revert_request"]

async function post(facility: string, mode: "preview" | "apply", codes?: string[]) {
  const res = await fetch("/api/v1/purchase-orders/uniware-external", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facility, mode, codes }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${facility}: ${apiErrorMessage(data, "failed")}`)
  return data as { fixes?: FixResult[]; partial?: boolean }
}

export default function FindUniwareOnlyButton() {
  const [stage, setStage] = useState<Stage>("idle")
  const [progress, setProgress] = useState("")
  const [fixes, setFixes] = useState<FixResult[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [partial, setPartial] = useState(false)

  async function loop(facilities: string[], mode: "preview" | "apply", codesFor?: (facility: string) => string[]) {
    const out: FixResult[] = []
    const errs: string[] = []
    let cut = false
    for (const [i, facility] of facilities.entries()) {
      setProgress(`${mode === "preview" ? "Checking" : "Fixing"} ${i + 1}/${facilities.length} · ${facility}`)
      try {
        const data = await post(facility, mode, codesFor?.(facility))
        out.push(...(data.fixes ?? []))
        if (data.partial) cut = true
      } catch (e) {
        errs.push(e instanceof Error ? e.message : String(e))
      }
    }
    setFixes(out)
    setErrors(errs)
    setPartial(cut)
  }

  async function preview() {
    setStage("working")
    try {
      const res = await fetch("/api/v1/purchase-orders/uniware-external?facilities=1")
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(apiErrorMessage(data, "Couldn't list facilities."))
      await loop(data.facilities ?? [], "preview")
    } catch (e) {
      setFixes([])
      setErrors([e instanceof Error ? e.message : "Couldn't reach Uniware."])
    }
    setStage("review")
  }

  async function apply() {
    setStage("working")
    const writes = fixes.filter((f) => WRITES.includes(f.action))
    const facilities = [...new Set(writes.map((f) => f.facility_code))]
    await loop(facilities, "apply", (fac) => writes.filter((f) => f.facility_code === fac).map((f) => f.uniware_po_code))
    setStage("done")
  }

  const toWrite = fixes.filter((f) => WRITES.includes(f.action)).length
  const done = stage === "done"
  const count = (a: FixAction) => fixes.filter((f) => f.action === a && (!WRITES.includes(a) || f.done)).length
  const tally = [
    `${count("create")} invoice${count("create") === 1 ? "" : "s"} created`,
    `${count("relink")} relinked`,
    `${count("revert_request")} revert${count("revert_request") === 1 ? "" : "s"} requested`,
    `${count("manual") + count("skip")} not fixed`,
  ].join(" · ")

  return (
    <>
      <Dialog open={stage === "confirm"} onOpenChange={(o) => !o && setStage("idle")}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Fix POs that are only in Uniware?</DialogTitle>
            <DialogDescription>
              Checks every facility&apos;s Uniware POs from the last {EXTERNAL_PO_WINDOW_DAYS} days for ones no ERP
              invoice owns — mostly POs keyed by hand in Uniware — and works out how to fix each.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Nothing is written yet. You see every fix first and choose whether to apply.</li>
            <li>Nothing is ever created, changed or cancelled in Uniware.</li>
            <li>Takes a few minutes. Keep this tab open until it finishes.</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStage("idle")}>No, cancel</Button>
            <Button onClick={() => void preview()}>Yes, check</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stage === "review" || done} onOpenChange={(o) => !o && setStage("idle")}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{done ? "Fixing done" : toWrite ? `Apply ${toWrite} fix${toWrite === 1 ? "" : "es"}?` : "Nothing to fix"}</DialogTitle>
            <DialogDescription>
              {done
                ? "Below is everything written in the ERP. Anything not fixed is listed with the reason."
                : "Each fix below was tried and rolled back, so these are exactly the writes Apply will make."}
            </DialogDescription>
          </DialogHeader>
          {done && <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">{tally}</p>}
          {!done && toWrite > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>New invoices credit received qty on the open FG POs, oldest first, and carry no PDF, GST or batch until someone adds them.</li>
              <li>A relink moves an invoice to the Uniware PO the warehouse actually used; quantities don&apos;t change.</li>
              <li>A revert request only goes to Approvals. Once approved, the next run re-adds the invoice from the right PO.</li>
            </ul>
          )}
          {(errors.length > 0 || partial) && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {errors.map((e) => <li key={e}>{e}</li>)}
              {partial && <li>Some facilities ran out of time; run this again for the rest.</li>}
            </ul>
          )}
          {GROUPS.map(({ action, title }) => {
            const list = fixes.filter((f) => f.action === action && (!done || !WRITES.includes(action) || f.done))
            if (!list.length) return null
            return (
              <section key={action} className="space-y-1">
                <h3 className="text-sm font-medium">{title(list.length, done)}</h3>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {list.map((f) => (
                    <li key={`${f.uniware_po_code}-${action}`} className="break-words">
                      <span className="font-mono text-foreground">{f.uniware_po_code}</span>
                      {` · ${f.mfg_code ?? "?"} · ${f.facility_code} · `}{f.summary}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          <DialogFooter>
            {done || !toWrite ? (
              <Button onClick={() => setStage("idle")}>OK</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setStage("idle")}>No, don&apos;t apply</Button>
                <Button onClick={() => void apply()}>Yes, apply {toWrite}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button variant="outline" size="lg" onClick={() => setStage("confirm")} disabled={stage === "working"}>
        {stage === "working" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SearchCheck className="h-3.5 w-3.5" />}
        {stage === "working" ? progress : "Fix Uniware-only POs"}
      </Button>
    </>
  )
}
