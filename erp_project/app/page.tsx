import Link from "next/link"
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"

// `built: false` routes have no page.tsx yet — prefetch={false} on their
// Link stops Next from firing a background fetch that just 404s.
// const modules = [
//   { name: "HR & Payroll",         slug: "/hr-payroll",    description: "Employee management, attendance, payroll processing", built: false },
//   { name: "Inventory",            slug: "/inventory",     description: "Stock management, warehousing, procurement", built: false },
//   { name: "Sales & CRM",          slug: "/sales-crm",     description: "Orders, invoicing, customer management", built: false },
//   { name: "Finance & Accounting", slug: "/finance",       description: "GL, AP/AR, financial reporting", built: false },
//   { name: "Masters",              slug: "/masters",       description: "Master data: SKUs, vendors, manufacturers, materials", built: true },
//   { name: "Reports & Analytics",  slug: "/reports",       description: "Dashboards, KPIs, data exports", built: false },
//   { name: "Manufacturing",        slug: "/manufacturing", description: "Production planning, BOMs, work orders", built: true },
// ]

export default async function Home() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const roles = session.user.roles ?? []

  // const accessLevels = await Promise.all(
  //   modules.map(m => resolveAccess(userId, roles, m.slug))
  // )

  return (
    <div className="p-6 max-w-5xl space-y-10">

      <div className="border-t border-border pt-8 space-y-8">
        <div>
          <h2 className="text-lg font-bold tracking-tight">How this system works</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            A guide to what each module contains, the bulk-upload/mapping rules, the PO flow, and the approval process.
          </p>
        </div>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Masters — what each table holds</h3>
          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li><span className="font-medium text-foreground">SKUs</span> — sku_code, name, brand, category/subcategory, sku type, filling &amp; UOM, MRP, GST, and the BOM currently linked to it.</li>
            <li><span className="font-medium text-foreground">Raw Materials (RM)</span> — rm_code, name, make/type, UOM, HSN code, INCI name, plus its rate &amp; MOQ against each manufacturer/vendor.</li>
            <li><span className="font-medium text-foreground">Packing Materials (PM)</span> — pm_code, name, type, HSN code, UOM, plus its rate &amp; MOQ against each manufacturer/vendor.</li>
            <li><span className="font-medium text-foreground">Vendors</span> — code, name, type (RM/PM/both), location, zone, GST number, registered name, bank details.</li>
            <li><span className="font-medium text-foreground">Manufacturers</span> — code, name, location, zone, GST number, registered name, bank details, email.</li>
            <li><span className="font-medium text-foreground">BOM (Recipe)</span> — sku_code, each material&apos;s type (RM/PM) and code, quantity, UOM, effective dates, and the resulting material cost.</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Open <Link href="/masters" className="text-primary hover:underline">Masters</Link> and pick a tab to browse, search, or export any of these as CSV/Excel.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Bulk CSV upload — BOM / Recipe</h3>
          <p className="text-sm text-muted-foreground">
            A recipe is just a list of materials mapped to their exact RM/PM code, so the code has to already exist in
            the material master before you upload — <span className="font-medium text-foreground">export the Raw Material and Packing Material masters first</span> to
            copy the correct codes, then build your CSV against them:
          </p>
          <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li><span className="font-medium text-foreground">Single BOM</span> (creation wizard, step 4 &quot;Upload CSV&quot;) — columns: <code className="font-mono text-xs bg-muted px-1 rounded">mtrl_type, mtrl_code, amount, uom</code>. Download the sample template from that step to get the exact format.</li>
            <li><span className="font-medium text-foreground">Bulk import</span> (multiple SKUs/BOMs at once) — columns: <code className="font-mono text-xs bg-muted px-1 rounded">sku_code, bom_code (optional, auto-generated if blank), effective_from, mtrl_type, mtrl_code, amount, uom</code>.</li>
          </ol>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">mtrl_code must exactly match an existing rm_code or pm_code</span> — a typo or an unmapped code will fail the row instead of silently linking to the wrong ingredient.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Bulk CSV upload — Rate masters</h3>
          <p className="text-sm text-muted-foreground">
            Rate uploads (RM×Manufacturer, RM×Vendor, PM×Manufacturer, PM×Vendor) work the same way — rows are matched
            by <span className="font-medium text-foreground">rm_code / pm_code</span>, not by any internal ID, so accuracy depends entirely on using the right code:
          </p>
          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li><span className="font-medium text-foreground">RM × Manufacturer</span> — <code className="font-mono text-xs bg-muted px-1 rounded">rm_code, mfg_code, approved_vendor_code (optional), curr_rate, uom, effective_from, remarks</code></li>
            <li><span className="font-medium text-foreground">RM × Vendor</span> — <code className="font-mono text-xs bg-muted px-1 rounded">rm_code, vendor_code, curr_rate, moq, uom, effective_from, effective_to, mfg_code (optional), remarks</code></li>
            <li><span className="font-medium text-foreground">PM × Manufacturer</span> — <code className="font-mono text-xs bg-muted px-1 rounded">pm_code, mfg_code, curr_rate, uom, effective_from, remarks</code></li>
            <li><span className="font-medium text-foreground">PM × Vendor</span> — <code className="font-mono text-xs bg-muted px-1 rounded">pm_code, vendor_code, curr_rate, moq, uom, effective_from, effective_to, remarks</code></li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Same rule as BOM: pull the RM/PM master export first so the code you paste into the CSV matches the ingredient you actually mean to re-rate.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Updating a data point</h3>
          <p className="text-sm text-muted-foreground">
            Whenever you edit an <span className="font-medium text-foreground">existing</span> master record or an existing rate row, the Remarks field is mandatory —
            the Save button stays disabled until you explain why the change is being made. This applies to SKUs, RM, PM,
            Vendors, Manufacturers, and rate edits alike.
          </p>
          <p className="text-sm text-muted-foreground">
            The one exception: adding a brand-new rate row for the first time doesn&apos;t require remarks — only <em>editing</em> a rate that already exists does.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Raising a Purchase Order</h3>
          <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li><span className="font-medium text-foreground">Impromptu (single) PO</span> — pick an active SKU, the manufacturer, quantity, and an expected dispatch date (can&apos;t be backdated); destination is optional. <span className="font-medium text-foreground">Remarks are mandatory</span> for impromptu POs. Rate is auto-computed from the SKU&apos;s final costing.</li>
            <li><span className="font-medium text-foreground">Bulk PO upload</span> — CSV columns: <code className="font-mono text-xs bg-muted px-1 rounded">po_no (leave blank to create new), mfg_code, sku_code, qty, expected_on, destination, status</code>. A blank/unrecognized po_no creates a new PO; a matching po_no only updates that PO&apos;s status, expected date, or destination.</li>
            <li>Every PO goes through the same approval flow below — once approved, its status becomes <span className="font-mono text-xs bg-muted px-1 rounded">raised</span> and a notification email goes out automatically.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Inwarding (receiving stock against a PO)</h3>
          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li><span className="font-medium text-foreground">Quick receive</span> — open the PO and enter the quantity received; use this when there&apos;s nothing to reconcile against an invoice.</li>
            <li><span className="font-medium text-foreground">Invoice-based inward</span> — upload the vendor/manufacturer invoice, then fill in the invoice number, manufacturer, destination, and at least one line item with a valid quantity mapped to a SKU. Each line can be linked to an existing open PO (to book received qty against it) or, if left unlinked, it creates a new inward PO on its own.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Manufacturing</h3>
          <p className="text-sm text-muted-foreground">
            Production planning and work orders, organized by manufacturer.
          </p>
          <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li>Open <Link href="/manufacturing" className="text-primary hover:underline">Manufacturing</Link> to see the list of manufacturers.</li>
            <li>Click into a manufacturer to see its overview — production status, BOMs in use, and related work.</li>
            <li>Any master-data edits triggered from here (e.g. rates) follow the same approval flow below.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h3 className="font-semibold text-sm">Approval workflow</h3>
          <p className="text-sm text-muted-foreground">
            Edits to master records (SKUs, vendors, manufacturers, materials, rates, POs) don&apos;t save directly —
            they go through review first:
          </p>
          <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5 ml-1">
            <li>You edit a record and click <span className="font-medium text-foreground">Submit for Approval</span>. The system computes exactly which fields changed.</li>
            <li>The record is locked (status becomes <span className="font-mono text-xs bg-muted px-1 rounded">in_review</span>) so no one else can edit it at the same time.</li>
            <li>An approver opens <Link href="/approvals" className="text-primary hover:underline">Approvals</Link>, reviews the before/after diff, and approves or rejects it.</li>
            <li>
              <span className="font-medium text-foreground">Approved</span> — the change is applied and the record goes back to <span className="font-mono text-xs bg-muted px-1 rounded">active</span>.
              <span className="font-medium text-foreground"> Rejected</span> — the record moves to <span className="font-mono text-xs bg-muted px-1 rounded">draft</span> with a reason, and only the original submitter can re-edit and resubmit it.
            </li>
          </ol>
          <p className="text-sm text-muted-foreground">
            While a record shows <span className="font-mono text-xs bg-muted px-1 rounded">in_review</span>, its edit form is disabled with a banner explaining it&apos;s pending review.
            BOM edits are the one exception — they save immediately and don&apos;t require approval.
          </p>
        </section>
      </div>
    </div>
  )
}
