"use client"

// Starts a list that has no card yet: what it is for, which one, then its first address.
// Wildcards follow the stored rules: '*' on an employee row is every manufacturer, on a warehouse row every warehouse.

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { RecipientFields, addRecipient, type ListKey } from "./recipient-form"

type Option = { code: string; name: string }
type Target = "mfg" | "mfg_or_all" | "warehouse" | "warehouse_or_all" | "report" | "vendor"

const KINDS: { key: string; label: string; type: string; target: Target; help: string }[] = [
  { key: "mfg", label: "A manufacturer's PO mail", type: "mfg", target: "mfg", help: "Gets this manufacturer's PO and split-PO mails." },
  { key: "mfg_cc", label: "Colleagues on PO mail", type: "employee", target: "mfg_or_all", help: "CC'd on the manufacturer's PO mail. Anyone can be added, inside or outside the company." },
  { key: "warehouse", label: "A warehouse's inward notices", type: "warehouse", target: "warehouse_or_all", help: "Gets the notice for each invoice inwarded to this warehouse." },
  { key: "warehouse_cc", label: "Colleagues on a warehouse's notices", type: "employee", target: "warehouse", help: "CC'd on this warehouse's inward notices, for every legal entity." },
  { key: "report", label: "A scheduled report", type: "report", target: "report", help: "Gets the report and nothing else." },
  { key: "npd", label: "NPD POs", type: "npd", target: "mfg_or_all", help: "Gets NPD POs instead of the manufacturer." },
  { key: "tech_transfer", label: "Tech Transfer POs", type: "tech_transfer", target: "mfg_or_all", help: "Gets Tech Transfer POs instead of the manufacturer." },
  { key: "cpr", label: "CPR POs", type: "cpr", target: "mfg_or_all", help: "Gets CPR POs instead of the manufacturer." },
  { key: "vendor", label: "Vendor contacts", type: "vendor", target: "vendor", help: "Kept on file; the ERP sends no vendor mail yet." },
]

// Codes must match REPORT_CODES in lib/constants.ts — the API validates against it.
const REPORTS: Option[] = [
  { code: "daily_ops", name: "Daily ops report (23:59 IST)" },
  { code: "po_low_open_qty", name: "Low open PO quantity (08:00 IST)" },
]

export default function NewListDialog({ open, onClose, onCreated, mfgOptions, warehouseOptions, vendorOptions, legalEntityOptions }: {
  open: boolean
  onClose: () => void
  /** The new list's key, so the page can open its card. */
  onCreated: (list: ListKey) => void
  mfgOptions: Option[]
  warehouseOptions: Option[]
  vendorOptions: Option[]
  legalEntityOptions: { code: string; legal_name: string }[]
}) {
  const [kindKey, setKindKey] = useState(KINDS[0].key)
  const [code, setCode] = useState("")
  const [legal, setLegal] = useState("")
  const kind = KINDS.find((k) => k.key === kindKey)!

  const targets: Option[] =
    kind.target === "mfg" ? mfgOptions
    : kind.target === "mfg_or_all" ? [{ code: "*", name: "Every manufacturer, including ones added later" }, ...mfgOptions]
    : kind.target === "warehouse" ? warehouseOptions
    : kind.target === "warehouse_or_all" ? [{ code: "*", name: "All warehouses, including ones added later" }, ...warehouseOptions]
    : kind.target === "report" ? REPORTS
    : vendorOptions
  const targetLabel = kind.target.startsWith("mfg") ? "Manufacturer" : kind.target.startsWith("warehouse") ? "Warehouse" : kind.target === "report" ? "Report" : "Vendor"

  function close() {
    onClose()
    setCode("")
    setLegal("")
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New email list</DialogTitle>
          <DialogDescription>For a list that has no card yet. To add someone to an existing list, use its card&apos;s Add recipient.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nl-kind">For</Label>
              <Select id="nl-kind" value={kindKey} className="w-full" onChange={(e) => { setKindKey(e.target.value); setCode(""); setLegal("") }}>
                {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nl-code">{targetLabel}</Label>
              <Select id="nl-code" value={code} className="w-full" onChange={(e) => setCode(e.target.value)}>
                <option value="">Select…</option>
                {targets.map((t) => <option key={t.code} value={t.code}>{t.code === "*" ? t.name : `${t.name} (${t.code})`}</option>)}
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{kind.help}</p>

          {kind.type === "warehouse" && (
            <div className="grid gap-1.5">
              <Label htmlFor="nl-legal">Legal entity</Label>
              <Select id="nl-legal" value={legal} className="w-full" onChange={(e) => setLegal(e.target.value)}>
                <option value="">Every legal entity</option>
                {legalEntityOptions.map((o) => <option key={o.code} value={o.code}>{o.legal_name} ({o.code})</option>)}
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>First recipient</Label>
            {/* Keyed by the list, so switching it starts a clean address. */}
            <RecipientFields
              key={`${kindKey}|${code}|${legal}`}
              submitLabel="Create list"
              onCancel={close}
              onSubmit={async (r) => {
                if (!code) return `Pick a ${targetLabel.toLowerCase()} first.`
                const list = { entity_type: kind.type, entity_code: code, legal_entity_code: kind.type === "warehouse" ? legal || null : null }
                const err = await addRecipient(list, r)
                if (!err) { onCreated(list); close() }
                return err
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
