"use client"

/**
 * CLIENT component for /po-tracking/po-procurement/entity-emails — one card per list the ERP mails
 * (a manufacturer, a warehouse, a report…), with its recipients. Grouping lives in email-lists.ts.
 */

import { useMemo, useState } from "react"
import { useUrlFilters } from "@/lib/useUrlFilters"
import { ArrowLeft, ChevronDown, ChevronRight, Mail, Pause, Pencil, Play, Plus, UserPlus } from "lucide-react"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import NewListDialog from "./NewListDialog"
import { RecipientFields, addRecipient, updateRecipient } from "./recipient-form"
import { EMAIL_TABS, groupEmailLists, tabOf } from "./email-lists"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

type EntityOption = { id: number; code: string; name: string }

type EntityEmailRow = {
  id: number
  entity_type: string
  entity_code: string
  /** master_entity.code, warehouse rows only. NULL = serves every entity. */
  legal_entity_code: string | null
  email: string
  /** Which header this address goes in. Older rows read back as 'to'. */
  recipient_type: string
  purpose: string | null
  /** 'inactive' (shown as Paused) stays listed, but every send path filters status = 'active'. */
  status: string
  created_at: string | null
  created_by: number | null
  /** Resolved from users; null for the rows that predate the column. */
  created_by_name: string | null
}

/** "2026-10-30 12:12" in IST, the shape the rest of the ERP prints. */
function addedOn(iso: string | null): string {
  if (!iso) return ""
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

export default function EntityEmailsClient({
  rows,
  currentSearch,
  currentType,
  vendorOptions,
  mfgOptions,
  warehouseOptions,
  legalEntityOptions,
  facilities,
  canEdit,
}: {
  rows: EntityEmailRow[]
  currentSearch: string
  currentType: string
  vendorOptions: EntityOption[]
  mfgOptions: EntityOption[]
  warehouseOptions: EntityOption[]
  legalEntityOptions: { code: string; legal_name: string }[]
  facilities: { facility_code: string; wh_name: string; entity_code: string }[]
  canEdit: boolean
}) {
  const { navigate, router } = useUrlFilters()
  const { toast } = useToast()
  // The dialog, only for starting a list that has no card yet.
  const [showNew, setShowNew] = useState(false)
  // The row being edited in place.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  // Cards open on click; a search opens every match, since that is what was asked for.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const filtered = !!currentSearch
  // ?type= holds a tab key; an old link with a bare entity_type lands on that type's tab.
  const tab = EMAIL_TABS.some((t) => t.key === currentType) ? currentType : currentType ? tabOf(currentType) : "mfg"
  // The card showing an inline add row.
  const [adding, setAdding] = useState<string | null>(null)
  const toggle = (key: string) =>
    setOpenKeys((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })

  const lists = useMemo(() => groupEmailLists(rows, {
    mfg: new Map(mfgOptions.map((o) => [o.code, o.name])),
    vendor: new Map(vendorOptions.map((o) => [o.code, o.name])),
    facilities: facilities.reduce((m, f) => m.set(f.wh_name, [...(m.get(f.wh_name) ?? []), f]), new Map<string, { entity_code: string; facility_code: string }[]>()),
  }), [rows, mfgOptions, vendorOptions, facilities])
  const listCount = (key: string) => lists.filter((l) => tabOf(l.rows[0].entity_type) === key).length
  const shown = lists.filter((l) => tabOf(l.rows[0].entity_type) === tab)

  /** A one-click change (To/CC, Pause/Resume); a failure is a toast, since there is no form to show it in. */
  async function quickChange(r: EntityEmailRow, change: { recipient_type?: "to" | "cc"; status?: string }) {
    setBusyId(r.id)
    const err = await updateRecipient(r, change)
    setBusyId(null)
    if (err) toast({ title: `Couldn't update ${r.email}`, description: err, variant: "error" })
    else router.refresh()
  }

  return (
    <>
      <MasterToolbar>
        <UrlSearchInput initialValue={currentSearch} placeholder="Search by code, facility, email or purpose…" />
        <MasterToolbarActions>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push("/po-tracking/po-procurement")}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to FG POs Tracking
          </Button>
          {canEdit && (
            <Button size="sm" className="gap-1.5" onClick={() => setShowNew(true)} title="Start a list for a manufacturer, warehouse or report that has none yet">
              <Plus className="h-3.5 w-3.5" />
              New list
            </Button>
          )}
        </MasterToolbarActions>
      </MasterToolbar>

      <TabsList className="mb-3">
        {EMAIL_TABS.map((t) => (
          <TabsTrigger key={t.key} active={t.key === tab} onClick={() => navigate({ type: t.key })}>
            {t.label}
            <span className="rounded bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{listCount(t.key)}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      {shown.length === 0 ? (
        <Card className="py-10 text-center text-sm text-muted-foreground">
          {currentSearch ? "Nothing on this tab matches the search." : "No lists of this kind yet. Use New list to start one."}
        </Card>
      ) : (
        <div className="space-y-2">
          {shown.map((list) => {
            const first = list.rows[0]
            const open = filtered || openKeys.has(list.key) || adding === list.key
            return (
              <Card key={list.key} className="overflow-hidden p-0">
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(list.key)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <Mail className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate text-sm font-semibold">{list.title}</span>
                    {list.codes.map((c) => (
                      <span key={c} className="shrink-0 rounded border px-1.5 font-mono text-[10px] text-muted-foreground" title="Uniware facility">{c}</span>
                    ))}
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px]">{list.badge}</Badge>
                    <Badge variant={list.active ? "success" : "outline"} className="shrink-0 px-1.5 py-0 text-[11px]">{list.active} active</Badge>
                    <span className="hidden truncate text-xs text-muted-foreground md:inline">{list.description}</span>
                  </button>
                  {canEdit && (
                    <Button size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={() => { setEditingId(null); setAdding(list.key) }}>
                      <UserPlus className="h-3.5 w-3.5" />
                      Add recipient
                    </Button>
                  )}
                </div>

                {open && (
                  <Table className="border-t">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-5">Email</TableHead>
                        <TableHead className="w-28">As</TableHead>
                        <TableHead className="w-28">Status</TableHead>
                        <TableHead className="w-56">Added</TableHead>
                        {canEdit && <TableHead className="w-40" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.rows.map((r) => {
                        const paused = r.status === "inactive"
                        const busy = busyId === r.id
                        if (editingId === r.id) {
                          return (
                            <TableRow key={r.id} className="bg-muted/40 hover:bg-muted/40">
                              <TableCell colSpan={canEdit ? 5 : 4} className="px-5 py-2.5">
                                <RecipientFields
                                  initial={{ email: r.email, recipient_type: r.recipient_type === "cc" ? "cc" : "to", purpose: r.purpose ?? "" }}
                                  onCancel={() => setEditingId(null)}
                                  onSubmit={async (v) => {
                                    const err = await updateRecipient(r, v)
                                    if (!err) { setEditingId(null); router.refresh() }
                                    return err
                                  }}
                                />
                              </TableCell>
                            </TableRow>
                          )
                        }
                        return (
                          // Dimmed rather than hidden: a paused contact is still a record someone may resume.
                          <TableRow key={r.id} className={paused ? "opacity-55 hover:opacity-100 transition-opacity" : undefined}>
                            <TableCell className="pl-5 text-sm" title={r.purpose ?? undefined}>{r.email}</TableCell>
                            <TableCell>
                              <Select
                                value={r.recipient_type === "cc" ? "cc" : "to"}
                                disabled={!canEdit || busy}
                                onChange={(e) => void quickChange(r, { recipient_type: e.target.value as "to" | "cc" })}
                                aria-label={`Send ${r.email} as`}
                                className="h-8 w-20 text-sm"
                              >
                                <option value="to">To</option>
                                <option value="cc">CC</option>
                              </Select>
                            </TableCell>
                            <TableCell>
                              {paused
                                ? <Badge variant="outline" title="Kept on file, but left out of every send">Paused</Badge>
                                : <Badge variant="success">Active</Badge>}
                            </TableCell>
                            <TableCell className="text-sm tabular-nums text-muted-foreground whitespace-nowrap">
                              {/* Null on the rows that predate the column; inventing an author would not be honest. */}
                              {[r.created_by_name, addedOn(r.created_at)].filter(Boolean).join(", ") || "—"}
                            </TableCell>
                            {canEdit && (
                              <TableCell className="pr-5 text-right whitespace-nowrap">
                                <Button
                                  variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-primary"
                                  disabled={busy}
                                  onClick={() => void quickChange(r, { status: paused ? "active" : "inactive" })}
                                  title={paused ? `Send to ${r.email} again` : `Skip ${r.email} without removing them`}
                                >
                                  {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                                  {paused ? "Resume" : "Pause"}
                                </Button>
                                <Button
                                  variant="ghost" size="sm" className="h-7 gap-1.5 text-xs"
                                  disabled={busy}
                                  onClick={() => { setAdding(null); setEditingId(r.id) }}
                                  title={`Edit ${r.email}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        )
                      })}
                      {adding === list.key && (
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={canEdit ? 5 : 4} className="px-5 py-2.5">
                            <RecipientFields
                              onCancel={() => setAdding(null)}
                              onSubmit={async (v) => {
                                const err = await addRecipient(first, v)
                                if (!err) { setAdding(null); router.refresh() }
                                return err
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <NewListDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        // Opens the new list's card, so the address just added is in view.
        onCreated={(l) => {
          setOpenKeys((s) => new Set(s).add(`${l.entity_type}|${l.entity_code}|${l.legal_entity_code ?? ""}`))
          router.refresh()
        }}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        vendorOptions={vendorOptions}
        legalEntityOptions={legalEntityOptions}
      />
    </>
  )
}
