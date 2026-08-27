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
import { apiErrorMessage } from "@/lib/api-error-message"

type EntityType = "vendor" | "mfg" | "warehouse" | "employee"
type EntityOption = { id: number; code: string; name: string }
/**
 * What an employee row hangs off. "all_mfgs" is stored as entity_code '*'.
 *
 * "all_warehouses" is the odd one out: it stores entity_type 'warehouse', not
 * 'employee'. It has to — '*' on an employee row already means every
 * MANUFACTURER (selectForMfg), so the same value cannot also mean every
 * warehouse. The every-warehouse wildcard lives on the warehouse type
 * (selectByWarehouseForEntity), and this option is a shortcut to it, so the
 * person is found from the flow they were looking in rather than duplicating
 * the wildcard on a second type.
 */
type AttachTo = "warehouse" | "mfg" | "all_mfgs" | "all_warehouses"

const TYPE_LABEL: Record<EntityType, string> = {
  mfg: "Manufacturer",
  vendor: "Vendor",
  // Warehouses are keyed by name, not a code — that's what
  // purchase_orders.destination stores, and what the inward mail looks up.
  warehouse: "Warehouse",
  employee: "Employee",
}

/** The wildcard entity_code meaning "every manufacturer, including future ones". */
// Same stored value for both, read differently by entity_type: on an employee row
// it means every manufacturer, on a warehouse row every warehouse. See
// selectForMfg and selectByWarehouseForEntity.
const ALL_MFGS = "*"
const ALL_WAREHOUSES = "*"

type EmailRow = { email: string; recipient_type: "to" | "cc"; purpose: string }

const emptyRow = (): EmailRow => ({ email: "", recipient_type: "to", purpose: "" })

/** The stored row an edit is acting on. Absent = this is a create. */
export type EditingEntityEmail = {
  id: number
  entity_type: string
  entity_code: string
  legal_entity_code: string | null
  email: string
  recipient_type: string
  purpose: string | null
  status: string
}

export default function AddEntityEmailDialog({
  open, onClose, onSaved, vendorOptions, mfgOptions, warehouseOptions, legalEntityOptions,
  editing = null,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  /**
   * Present = edit that row instead of creating. One dialog serves both because
   * the entity pickers and address fields are identical; a second component
   * would duplicate the type/code/legal-entity logic and then drift from it.
   *
   * An edit acts on ONE address — the list shows one per line, so that is the
   * unit the user clicked. The multi-row adder is hidden accordingly.
   */
  editing?: EditingEntityEmail | null
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
  /** Inactive keeps the row but stops it being mailed — every send path filters
   *  status = 'active'. */
  const [status, setStatus] = useState<"active" | "inactive">("active")
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState("")

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
    setEntityType((editing?.entity_type as EntityType) ?? "mfg")
    setEntityCode(editing?.entity_code ?? "")
    setLegalEntityCode(editing?.legal_entity_code ?? "")
    setRows(editing
      ? [{
          email: editing.email,
          recipient_type: editing.recipient_type === "cc" ? "cc" : "to",
          purpose: editing.purpose ?? "",
        }]
      : [emptyRow()])
    // Which picker an employee row was attached to isn't stored — infer it from
    // whether the code matches a warehouse name. '*' is always all-manufacturers
    // on an employee row.
    setAttachTo(
      editing?.entity_type !== "employee" ? "all_mfgs"
      : editing.entity_code === "*"       ? "all_mfgs"
      : warehouseOptions.some((w) => w.code === editing.entity_code) ? "warehouse"
      : "mfg"
    )
    setStatus(editing?.status === "inactive" ? "inactive" : "active")
    setApiError("")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeded per open; `editing` is stable because the caller keys the dialog by row id
  }, [open])

  const isEmployee = entityType === "employee"

  // "All warehouses" is a real stored row (entity_code = '*'), not a UI shortcut
  // that fans out into one row per site — so a warehouse added next month is
  // covered without anyone revisiting this list. Matched by the wildcard arm of
  // selectByWarehouseForEntity.
  //
  // Offered on the warehouse type only. An employee row's '*' already means every
  // MANUFACTURER, so the same value cannot also mean every warehouse without one
  // meaning silently bleeding into the other.
  const ALL_WAREHOUSES_OPTION: EntityOption = {
    id: -1, code: ALL_WAREHOUSES, name: "every warehouse, including ones added later",
  }

  const codeOptions =
    entityType === "vendor" ? vendorOptions
    : entityType === "warehouse" ? [ALL_WAREHOUSES_OPTION, ...warehouseOptions]
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

    // The two "all" options are the codes the user doesn't pick from a list.
    // all_warehouses also changes the TYPE — see the AttachTo comment: the
    // every-warehouse wildcard is a warehouse row, because '*' on an employee
    // row is already spoken for by every-manufacturer.
    const type = isEmployee && attachTo === "all_warehouses" ? "warehouse" : entityType
    const code =
      isEmployee && attachTo === "all_mfgs"       ? ALL_MFGS
      : isEmployee && attachTo === "all_warehouses" ? ALL_WAREHOUSES
      : entityCode
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
      // Omitted rather than "" for non-warehouse types, which the schema rejects.
      const legal = entityType === "warehouse" ? legalEntityCode || undefined : undefined

      const res = await fetch("/api/v1/entity-emails", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing
            // One address, by id. `emails[0]` is the only row in edit mode.
            ? {
                id: editing.id,
                entity_type: type,
                entity_code: code,
                legal_entity_code: legal,
                email: emails[0].email,
                recipient_type: emails[0].recipient_type,
                purpose: emails[0].purpose,
                status,
              }
            : {
                entity_type: type,
                entity_code: code,
                legal_entity_code: legal,
                emails,
                status,
              }
        ),
      })
      const data = await res.json()
      // apiErrorMessage, not data.error: the gateway puts the field-level Zod
      // message in `details`, so reading only `error` reported "Invalid request"
      // for a mistyped address.
      if (!res.ok) { setApiError(apiErrorMessage(data, "Failed to save.")); return }
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
          <DialogTitle>{editing ? "Edit Entity Email" : "Add Entity Email"}</DialogTitle>
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
                  <option value="all_warehouses">All warehouses</option>
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
              {(attachTo === "mfg" || attachTo === "warehouse") && (
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
                  : attachTo === "all_warehouses"
                  ? "Looped in on the inward-invoice mail for every site and every legal entity — including sites added later. Saved as a warehouse contact, so it appears under Warehouse in the list."
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
            <Label>{editing ? "Email" : "Emails"}</Label>
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
                  {!editing && <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={rows.length === 1}
                    className="mt-1.5 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>}
                </div>
              ))}
              {/* An edit acts on the one address the user clicked. Adding more
                  here would have to become an insert, which is what the Add
                  button on the list is for. */}
              {!editing && <button
                type="button"
                onClick={addRow}
                className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5 w-fit"
              >
                <Plus className="h-3.5 w-3.5" />
                Add another email
              </button>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ee-status">Status</Label>
            <Select
              id="ee-status" value={status} className="w-full"
              onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
            >
              <option value="active">Active — receives mail</option>
              <option value="inactive">Inactive — kept on file, not mailed</option>
            </Select>
            {status === "inactive" && (
              <p className="text-xs text-muted-foreground">
                Stays on the list and keeps its history, but is left out of every send.
              </p>
            )}
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {/* The verb matches the action, and stays the same word through the
                pending state — a button that says "Add" then reports "Saved" is
                two names for one thing. */}
            {editing
              ? (submitting ? "Saving…" : "Save Changes")
              : (submitting ? "Adding…" : "Add Email(s)")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
