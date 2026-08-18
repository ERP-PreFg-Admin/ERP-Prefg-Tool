"use client"

import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"

type EntityType = "vendor" | "mfg" | "warehouse" | "employee"
type EntityOption = { id: number; code: string; name: string }
/** What an employee row hangs off. "all_mfgs" is stored as entity_code '*'. */
type AttachTo = "warehouse" | "mfg" | "all_mfgs"

const TYPE_LABEL: Record<EntityType, string> = {
  mfg: "Manufacturer",
  vendor: "Vendor",
  // Warehouses are keyed by name, not a code — that's what
  // purchase_orders.destination stores, and what the inward mail looks up.
  warehouse: "Warehouse",
  employee: "Employee",
}

/** The wildcard entity_code meaning "every manufacturer, including future ones". */
const ALL_MFGS = "*"

type EmailRow = { email: string; recipient_type: "to" | "cc"; purpose: string }

const emptyRow = (): EmailRow => ({ email: "", recipient_type: "to", purpose: "" })

export default function AddEntityEmailDialog({
  open, onClose, onSaved, vendorOptions, mfgOptions, warehouseOptions, legalEntityOptions,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  vendorOptions: EntityOption[]
  mfgOptions: EntityOption[]
  warehouseOptions: EntityOption[]
  /** Our own legal entities, for the warehouse-only entity selector. */
  legalEntityOptions: { code: string; legal_name: string }[]
}) {
  const [entityType, setEntityType] = useState<EntityType>("mfg")
  const [entityCode, setEntityCode] = useState("")
  /** "" means every legal entity — the pre-existing behaviour of every row. */
  const [legalEntityCode, setLegalEntityCode] = useState("")
  const [rows, setRows] = useState<EmailRow[]>([emptyRow()])
  /** Employee only: what the addresses are attached to. */
  const [attachTo, setAttachTo] = useState<AttachTo>("all_mfgs")
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
    setEntityType("mfg")
    setEntityCode("")
    setLegalEntityCode("")
    setRows([emptyRow()])
    setAttachTo("all_mfgs")
    setApiError("")
  }, [open])

  const isEmployee = entityType === "employee"

  const codeOptions =
    entityType === "vendor" ? vendorOptions
    : entityType === "warehouse" ? warehouseOptions
    : mfgOptions

  function updateRow(i: number, patch: Partial<EmailRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function addRow() {
    setRows((r) => [...r, emptyRow()])
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i))
  }

  async function handleSubmit() {
    setApiError("")

    // "All manufacturers" is the one code the user doesn't pick from a list.
    const code = isEmployee && attachTo === "all_mfgs" ? ALL_MFGS : entityCode
    if (!code) {
      setApiError(
        !isEmployee ? "Select an entity."
        : attachTo === "warehouse" ? "Select a warehouse."
        : "Select a manufacturer."
      )
      return
    }

    const emails = rows
      .filter((r) => r.email.trim())
      .map((r) => ({
        email: r.email.trim(),
        recipient_type: r.recipient_type,
        purpose: r.purpose.trim() || undefined,
      }))
    if (emails.length === 0) { setApiError("Enter at least one email address."); return }

    setSubmitting(true)
    try {
      const res = await fetch("/api/v1/entity-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: entityType,
          entity_code: code,
          // Omitted rather than "" for non-warehouse types, which the schema rejects.
          legal_entity_code: entityType === "warehouse" ? legalEntityCode || undefined : undefined,
          emails,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setApiError(data.error ?? "Failed to save."); return }
      onSaved()
    } catch {
      setApiError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Entity Email</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ee-type">Entity Type</Label>
              <Select
                id="ee-type" value={entityType} className="w-full"
                // Clear the legal entity too: it is warehouse-only, and the API
                // rejects it on the other types.
                onChange={(e) => {
                  setEntityType(e.target.value as EntityType)
                  setEntityCode("")
                  setLegalEntityCode("")
                }}
              >
                <option value="mfg">Manufacturer</option>
                <option value="vendor">Vendor</option>
                <option value="warehouse">Warehouse</option>
                <option value="employee">Employee / other person</option>
              </Select>
            </div>

            {/* Employee picks WHAT it hangs off; the others pick the entity itself. */}
            {isEmployee ? (
              <div className="grid gap-1.5">
                <Label htmlFor="ee-attach">Attach To</Label>
                <Select
                  id="ee-attach" value={attachTo} className="w-full"
                  onChange={(e) => { setAttachTo(e.target.value as AttachTo); setEntityCode("") }}
                >
                  <option value="all_mfgs">All manufacturers</option>
                  <option value="mfg">One manufacturer</option>
                  <option value="warehouse">One warehouse</option>
                </Select>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="ee-code">{TYPE_LABEL[entityType]}</Label>
                <Select id="ee-code" value={entityCode} className="w-full" onChange={(e) => setEntityCode(e.target.value)}>
                  <option value="">— Select —</option>
                  {codeOptions.map((o) => (
                    <option key={o.id} value={o.code}>{o.code} — {o.name}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {isEmployee && (
            <>
              {attachTo !== "all_mfgs" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="ee-attach-code">
                    {attachTo === "warehouse" ? "Warehouse" : "Manufacturer"}
                  </Label>
                  <Select
                    id="ee-attach-code" value={entityCode} className="w-full"
                    onChange={(e) => setEntityCode(e.target.value)}
                  >
                    <option value="">— Select —</option>
                    {(attachTo === "warehouse" ? warehouseOptions : mfgOptions).map((o) => (
                      <option key={o.id} value={o.code}>{o.code} — {o.name}</option>
                    ))}
                  </Select>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {attachTo === "all_mfgs"
                  ? "One row per address, covering every manufacturer — including any added later."
                  : attachTo === "warehouse"
                  ? "Looped in on the inward-invoice mail for this site, for every legal entity."
                  : "Looped in on the PO mail for this manufacturer only."}
                {" "}Anyone can be added here, including people outside the company — the address is typed, not picked from your users.
              </p>
            </>
          )}

          {/* Warehouses only. Every location operates under both Pep and
              Kreative, and the point of contact at the site is not necessarily
              the same person for both. Vendors and manufacturers deal with us as
              one company, so the selector would be meaningless there. */}
          {entityType === "warehouse" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ee-legal-entity">Legal Entity</Label>
              <Select
                id="ee-legal-entity"
                value={legalEntityCode}
                className="w-full"
                onChange={(e) => setLegalEntityCode(e.target.value)}
              >
                <option value="">All entities (shared contact)</option>
                {legalEntityOptions.map((o) => (
                  <option key={o.code} value={o.code}>{o.legal_name} ({o.code})</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {legalEntityCode
                  ? `Added on top of any shared contacts — a ${legalEntityCode} invoice notifies both.`
                  : "Notified for every entity's goods. Pick an entity only for a contact specific to it."}
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label>Emails</Label>
              {rows.map((row, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    type="email" placeholder="name@example.com"
                    value={row.email} onChange={(e) => updateRow(i, { email: e.target.value })}
                  />
                  <Select
                    value={row.recipient_type}
                    onChange={(e) => updateRow(i, { recipient_type: e.target.value as "to" | "cc" })}
                    aria-label="Send as"
                    className="w-20 shrink-0"
                  >
                    <option value="to">To</option>
                    <option value="cc">CC</option>
                  </Select>
                  <Input
                    placeholder="Purpose (e.g. PO, Invoice)"
                    value={row.purpose} onChange={(e) => updateRow(i, { purpose: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={rows.length === 1}
                    className="mt-1.5 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addRow}
                className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5 w-fit"
              >
                <Plus className="h-3.5 w-3.5" />
                Add another email
              </button>
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Adding…" : "Add Email(s)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
