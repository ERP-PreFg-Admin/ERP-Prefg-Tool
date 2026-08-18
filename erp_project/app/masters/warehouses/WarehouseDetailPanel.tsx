"use client"

/**
 * Everything known about one warehouse AS ONE LEGAL ENTITY, in a right-edge
 * slide-over.
 *
 * Scoped to a single entity on purpose: Pep and Kreative are separate companies
 * with separate registrations, and this panel used to render a section per
 * master_entity row — so opening a Pep row showed Kreative's facility code,
 * GSTINs and addresses next to it. The `entity` prop is the row that was clicked
 * and there is deliberately no way to reach the other one from here.
 *
 * The location block above it (city, zone, site contact) is shared by both
 * entities — it describes the place, not the company.
 *
 * Read-only: editing goes through EditWarehouseDialog and the approval flow, so
 * this panel has no way to write and can't bypass it.
 */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { Pencil } from "lucide-react"
import {
  SidePanel, SidePanelContent, SidePanelHeader, SidePanelTitle, SidePanelDescription,
  DetailRow,
} from "@/components/ui/side-panel"
import type { Warehouse, WarehouseEntity, Entity } from "@/types/masters"

/** Join the structured ship-to parts into one readable block, skipping blanks. */
function shipToLines(row: WarehouseEntity): string[] {
  const cityState = [row.ship_to_city, row.ship_to_state].filter(Boolean).join(", ")
  const tail = [cityState, row.ship_to_pincode?.trim()].filter(Boolean).join(" — ")
  return [row.ship_to_line1, row.ship_to_line2, tail].filter((v): v is string => Boolean(v))
}

export function WarehouseDetailPanel({
  warehouse,
  entity,
  entityRow,
  onClose,
  onEdit,
}: {
  warehouse: Warehouse | null
  /** The legal entity whose row was clicked. The other entity's data is not
   *  passed in at all, so it cannot be rendered by accident. */
  entity: Entity | null
  entityRow: WarehouseEntity | null
  onClose: () => void
  onEdit: () => void
}) {
  if (!warehouse || !entity) return null

  const row = entityRow
  const lines = row ? shipToLines(row) : []
  // The per-entity type overrides the location's.
  const type = row?.type ?? warehouse.type

  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()}>
      <SidePanelContent aria-describedby={undefined}>
        <SidePanelHeader>
          <SidePanelTitle>
            {warehouse.name}
            <span className="ml-2 font-mono text-sm font-normal text-muted-foreground">
              {entity.code}
            </span>
          </SidePanelTitle>
          <SidePanelDescription>
            {entity.legal_name} ·{" "}
            {[warehouse.location, warehouse.state].filter(Boolean).join(", ") || "No address on file"}
          </SidePanelDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={type === "MWH" ? "info" : "secondary"}>
              {type === "MWH" ? "Mother Warehouse" : "Child Warehouse"}
            </Badge>
            {/* The pair's own status when it exists — the location's would read as
                active for an entity that isn't live here. */}
            <StatusBadge status={row?.status ?? warehouse.status} />
            {/* But the location's approval state still has to show, or an
                in_review warehouse reads as active and the disabled Edit dialog
                comes as a surprise. Only when it differs from the badge above —
                a child row is only ever active/inactive. */}
            {(warehouse.status === "in_review" || warehouse.status === "rejected") && (
              <span className="text-xs text-muted-foreground">
                Location <StatusBadge status={warehouse.status} />
              </span>
            )}
            {warehouse.code && (
              <span className="font-mono text-xs text-muted-foreground">{warehouse.code}</span>
            )}
          </div>
        </SidePanelHeader>

        <section className="space-y-1">
          <h3 className="mb-1 text-sm font-semibold">Location</h3>
          <div className="grid grid-cols-2 gap-x-4">
            <DetailRow label="City" value={warehouse.location} />
            <DetailRow label="State" value={warehouse.state} />
            <DetailRow label="Zone" value={warehouse.zone} />
            <DetailRow label="Short code" value={warehouse.code} mono />
          </div>
        </section>

        <section className="mt-4 space-y-1 border-t pt-4">
          <h3 className="mb-1 text-sm font-semibold">Site contact</h3>
          <div className="grid grid-cols-2 gap-x-4">
            <DetailRow label="Contact person" value={warehouse.contact_person} />
            <DetailRow label="Phone" value={warehouse.contact_phone} />
          </div>
          {/* Named explicitly as the operator's, because the per-entity GSTINs
              below are ours and confusing the two would misfile a tax record. */}
          <DetailRow label="Site GSTIN (3PL operator)" value={warehouse.site_gstin} mono />
          <p className="text-xs text-muted-foreground">
            Inward notifications go to the addresses filed under this warehouse in
            PO Tracking → Entity Emails, not to the contact above.
          </p>
        </section>

        <section className="mt-4 space-y-1 border-t pt-4">
          <h3 className="mb-1 text-sm font-semibold">
            {entity.legal_name}
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {entity.code}
            </span>
            {row && row.status !== "active" && (
              <Badge variant="secondary" className="ml-2">Inactive here</Badge>
            )}
          </h3>

          {!row ? (
            <p className="text-sm text-muted-foreground">
              Not configured for this warehouse — inwarding under {entity.code} is blocked.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4">
                <DetailRow label="Uniware facility" value={row.facility_code} mono />
                <DetailRow label="Type" value={row.type ?? `${warehouse.type} (location)`} />
                <DetailRow label="Bill-to GSTIN" value={row.bill_to_gstin} mono />
                <DetailRow label="Ship-to GSTIN" value={row.ship_to_gstin} mono />
              </div>
              <DetailRow label="Bill to" value={row.bill_to_name} />
              <DetailRow
                label="Bill to address"
                value={row.bill_to_address && <span className="whitespace-pre-line">{row.bill_to_address}</span>}
              />
              <DetailRow label="Ship to" value={row.ship_to_name} />
              <DetailRow
                label="Ship to address"
                value={
                  lines.length ? (
                    <span className="whitespace-pre-line">{lines.join("\n")}</span>
                  ) : row.ship_to_address ? (
                    // Falls back to the verbatim block when the structured
                    // columns haven't been filled in yet.
                    <span className="whitespace-pre-line">{row.ship_to_address}</span>
                  ) : null
                }
              />
              <DetailRow label="Remarks" value={row.remarks} />
            </>
          )}
        </section>

        <div className="mt-6 flex justify-end border-t pt-4">
          <Button
            size="sm"
            onClick={() => {
              onClose()
              onEdit()
            }}
          >
            <Pencil className="mr-1.5 h-4 w-4" />
            Edit
          </Button>
        </div>
      </SidePanelContent>
    </SidePanel>
  )
}
