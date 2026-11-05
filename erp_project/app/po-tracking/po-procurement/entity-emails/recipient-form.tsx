"use client"

// The one address form on the Emails page: add a recipient, edit one, or the first address of a new list.

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { apiErrorMessage } from "@/lib/api-error-message"

/** Which list an address belongs to: the stored (entity_type, entity_code, legal_entity_code). */
export type ListKey = { entity_type: string; entity_code: string; legal_entity_code: string | null }
export type Recipient = { email: string; recipient_type: "to" | "cc"; purpose: string }

/** The stored row an edit acts on. */
export type StoredRecipient = ListKey & { id: number; email: string; recipient_type: string; purpose: string | null; status: string }

async function send(method: "POST" | "PATCH", body: unknown): Promise<string | null> {
  try {
    const res = await fetch("/api/v1/entity-emails", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    return res.ok ? null : apiErrorMessage(await res.json().catch(() => ({})), "Failed to save.")
  } catch {
    return "Network error. Please try again."
  }
}

/** Adds one address to a list; null on success, else the message to show. */
export function addRecipient(list: ListKey, r: Recipient): Promise<string | null> {
  return send("POST", {
    entity_type: list.entity_type, entity_code: list.entity_code,
    legal_entity_code: list.legal_entity_code ?? undefined, status: "active",
    emails: [{ email: r.email.trim(), recipient_type: r.recipient_type, purpose: r.purpose.trim() || undefined }],
  })
}

/** Changes one stored address in place; the list it belongs to never moves. */
export function updateRecipient(row: StoredRecipient, change: Partial<Recipient & { status: string }>): Promise<string | null> {
  return send("PATCH", {
    id: row.id, entity_type: row.entity_type, entity_code: row.entity_code,
    legal_entity_code: row.legal_entity_code ?? undefined, email: row.email,
    recipient_type: row.recipient_type === "cc" ? "cc" : "to", purpose: row.purpose ?? undefined, status: row.status,
    ...change,
    ...(change.email !== undefined ? { email: change.email.trim() } : {}),
    ...(change.purpose !== undefined ? { purpose: change.purpose.trim() || undefined } : {}),
  })
}

/** Email, To/CC and purpose on one line, with Save and Cancel. `submit` returns an error message or null. */
export function RecipientFields({ initial, submitLabel = "Save", onSubmit, onCancel }: {
  initial?: Partial<Recipient>
  submitLabel?: string
  onSubmit: (r: Recipient) => Promise<string | null>
  onCancel?: () => void
}) {
  const [email, setEmail] = useState(initial?.email ?? "")
  const [as, setAs] = useState<"to" | "cc">(initial?.recipient_type ?? "to")
  const [purpose, setPurpose] = useState(initial?.purpose ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    setSaving(true)
    setError("")
    const err = await onSubmit({ email, recipient_type: as, purpose })
    setSaving(false)
    if (err) setError(err)
  }

  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Input
        autoFocus type="email" required placeholder="name@company.com" value={email}
        onChange={(e) => setEmail(e.target.value)} disabled={saving} className="h-8 w-72" aria-label="Email"
      />
      <Select value={as} onChange={(e) => setAs(e.target.value as "to" | "cc")} disabled={saving} className="h-8 w-20 text-sm" aria-label="Send as">
        <option value="to">To</option>
        <option value="cc">CC</option>
      </Select>
      <Input
        placeholder="Purpose (optional)" value={purpose} onChange={(e) => setPurpose(e.target.value)}
        disabled={saving} className="h-8 w-56" aria-label="Purpose"
      />
      <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={saving || !email.trim()}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {submitLabel}
      </Button>
      {onCancel && <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onCancel} disabled={saving}>Cancel</Button>}
      {error && <span className="w-full text-xs text-destructive">{error}</span>}
    </form>
  )
}
