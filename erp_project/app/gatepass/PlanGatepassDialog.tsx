"use client"

// The dry run: what gatepasses WOULD be created from the summary on screen.
//
// The plan is also the confirmation step: it shows the exact request body before
// anything is sent, and the button names how many documents it will raise.
//
// Creating is TWO Uniware calls per facility — an empty gatepass, then one
// addItem per package type — so each stage toasts as it lands. Without that a
// twenty-line gatepass is indistinguishable from a hang.
//
// Nothing here re-fetches. The plans were built from the same export download
// that produced the summary, so opening this dialog costs no Uniware traffic.

import { useState } from "react"
import { AlertTriangle, Ban, Loader2, Send } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { blockers, buildGatepassPayload, type GatepassPlan } from "@/lib/gatepass/plan"
import { dryGatepassCode } from "@/lib/gatepass/gatepass-code"
import { useToast } from "@/components/ui/toast"
import { apiErrorMessage } from "@/lib/api-error-message"

const n = (v: number) => v.toLocaleString("en-IN")

type CreateOutcome = {
  facility: string
  gatePassCode: string | null
  added: number
  failed: { sku: string; error: string }[]
  error?: string
}

export default function PlanGatepassDialog({
  open, onOpenChange, plans, from, to,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  plans: GatepassPlan[]
  from: string
  to: string
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [doneCodes, setDoneCodes] = useState<string[]>([])
  // Outcomes are KEPT, not just toasted. A toast fades in seconds; a rejected
  // line is the one thing someone needs to read carefully and probably paste to
  // somebody else, so the reason has to stay on screen.
  const [results, setResults] = useState<CreateOutcome[]>([])
  const stop = blockers(plans)
  const window = from === to ? from : `${from} → ${to}`

  /**
   * One facility at a time, sequentially. Each stage toasts as it lands, which
   * is the only way the operator can tell "still adding lines" from "hung" — a
   * gatepass with twenty package types is twenty separate calls.
   */
  async function create() {
    if (busy) return
    setBusy(true)
    setDoneCodes([])
    try {
      setResults([])
      for (const p of plans) {
        const res = await fetch("/api/v1/gatepass/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facility_code: p.facility, from, to, confirm: true }),
        })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}))
          toast({ variant: "error", title: `${p.facility} — not created`,
                  description: apiErrorMessage(data, `Request failed (HTTP ${res.status})`) ?? undefined })
          continue
        }

        // NDJSON: carry the partial line forward, a chunk can split an object.
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            const msg = JSON.parse(line)

            if (msg.step === "export" && msg.status === "start") {
              toast({ variant: "info", title: `${p.facility} — reading the export` })
            } else if (msg.step === "serial" && msg.status === "ok") {
              toast({ variant: "info", title: `Next code ${msg.code}` })
            } else if (msg.step === "create" && msg.status === "ok") {
              toast({ variant: "success", title: "Gatepass created", description: msg.code })
            } else if (msg.step === "item" && msg.status === "ok") {
              toast({ variant: "success", title: `Item added — ${msg.sku} x${msg.quantity}`,
                      description: `${msg.index} of ${msg.total}` })
            } else if (msg.step === "item" && msg.status === "failed") {
              toast({ variant: "error", title: `Item rejected — ${msg.sku}`, description: msg.error })
            } else if (msg.done) {
              const r = msg.result ?? {}
              if (r.gatePassCode) setDoneCodes((c) => [...c, r.gatePassCode])
              setResults((c) => [...c, {
                facility: p.facility, gatePassCode: r.gatePassCode ?? null,
                added: r.added ?? 0, failed: r.failed ?? [], error: r.error,
              }])
              // A partial run is NOT a failure: the document exists, and calling
              // it failed would invite a second one for the same boxes.
              toast({
                variant: r.ok ? "success" : r.gatePassCode ? "info" : "error",
                title: r.gatePassCode
                  ? `${r.gatePassCode} — ${r.added} item${r.added === 1 ? "" : "s"} added`
                  : `${p.facility} — nothing created`,
                description: r.error ?? undefined,
              })
            }
          }
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Gatepass plan — dry run</DialogTitle>
          <DialogDescription>
            One gatepass per facility for invoice dates {window}. Nothing is sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border max-h-64 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Facility</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>toParty</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Package types</TableHead>
                  <TableHead className="text-right">Boxes</TableHead>
                  <TableHead>Code prefix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.facility}>
                    <TableCell className="font-medium">{p.facility}</TableCell>
                    <TableCell className="text-muted-foreground">{p.type}</TableCell>
                    {/* Unset is a blocker, not a blank — say so where it is read. */}
                    <TableCell className={p.toParty ? "" : "text-destructive"}>
                      {p.toParty ?? "not set"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{n(p.orders)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${p.items.length ? "" : "text-destructive"}`}>
                      {n(p.items.length)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {n(p.items.reduce((s, i) => s + i.quantity, 0))}
                    </TableCell>
                    <TableCell className={`font-mono text-xs ${p.prefix ? "text-muted-foreground" : "text-destructive"}`}>
                      {p.prefix ?? "unmapped"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* The request body is the point of the dry run — the exact bytes that
              would go out, so they can be read before anything does. */}
          {plans[0] && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                First request body — {plans[0].facility}
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-3 text-xs">
{JSON.stringify(buildGatepassPayload({ ...plans[0], window: to }, dryGatepassCode(plans[0].facility, 1)), null, 2)}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                This call creates an <strong>empty</strong> gatepass. Each package type is
                then added as a real line through <code>addItem</code>, one call each — so a
                five-type gatepass is six requests in total. <code>code</code> is this
                automation&apos;s own <code>/DRY/</code> series, shown at serial 0001; the real
                one is read from Unicommerce at create time.
              </p>
            </details>
          )}

          {/* What actually happened, kept until the next run. Uniware's own wording
              is shown verbatim — it is the only copy of why a line was refused. */}
          {results.map((r) => (
            <div key={r.facility} className="rounded-md border p-3 text-xs">
              <p className="text-sm font-medium">
                {r.gatePassCode ?? r.facility}
                <span className="ml-2 font-normal text-muted-foreground">
                  {r.added} added{r.failed.length > 0 && `, ${r.failed.length} rejected`}
                </span>
              </p>
              {r.error && <p className="mt-1 text-destructive">{r.error}</p>}
              {r.failed.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {r.failed.map((f) => (
                    <li key={f.sku} className="break-words">
                      <span className="font-mono">{f.sku}</span>
                      <span className="text-destructive"> — {f.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {stop.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Refusing to create {plans.length === 1 ? "this gatepass" : "these gatepasses"}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {stop.map((s) => <li key={s}>· {s}</li>)}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          {doneCodes.length > 0 && (
            <span className="mr-auto font-mono text-xs text-muted-foreground">
              created: {doneCodes.join(", ")}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
          {/* The count is in the label on purpose. This writes to Unicommerce and
              cannot be undone, so "Create 12 gatepasses" must never be able to
              read as "Create". Disabled only while a blocker stands. */}
          <Button onClick={() => void create()} disabled={busy || stop.length > 0}
                  title={stop[0] ?? undefined}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : stop.length > 0 ? <Ban className="h-3.5 w-3.5" />
                  : <Send className="h-3.5 w-3.5" />}
            {busy ? "Creating…"
                  : `Create ${plans.length} gatepass${plans.length === 1 ? "" : "es"} in Unicommerce`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
