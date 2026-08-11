> **Companion document to:** [`discovery-full.md`](./discovery-full.md) (Technical Architecture Review — stack, module structure, logging, event candidates, migration strategy, outbox pattern, producer/consumer analysis). That document answers **HOW** the system works. This document answers **WHY** it behaves this way — the business domain underneath the code.
>
> **Status:** Domain discovery, grounded in code evidence · **Method:** Every claim is labeled **Fact** (directly supported by code), **Inference** (strongly implied, not stated outright), **Assumption** (needs business confirmation), or **Recommendation** (architectural guidance, not a finding). No business rule, aggregate, event, or workflow below was invented — each traces to a file:line citation. · **Last updated:** 2026-07-04

---

## 1. Executive Business Summary

**What business this ERP supports** (Fact, evidence throughout §5–§9): a **multi-brand D2C consumer-goods company** — the generated PO PDF letterhead reads "Pep Technologies Pvt Ltd, MCaffeine" (`lib/pdf/po-document.tsx`) — that designs and sells branded SKUs (at least two brands are live: **mcaffeine** and **hyphen**, `app/api/v1/purchase-orders/route.ts:163-166`) manufactured by **contract manufacturers**, not made in-house. The presence of `inci_name` (International Nomenclature of Cosmetic Ingredients) on raw materials (Inference, `lib/queries/raw-materials.ts`, `types/masters.ts`) strongly implies the product category is **cosmetics/personal-care/FMCG**, where ingredient declarations are regulated.

**Major business problems it solves today (Fact):**
- **Governs changes to reference data that money and compliance depend on** — vendor bank/GST/PAN details, manufacturer rates, product formulations — via a maker-checker approval workflow, so no single person can unilaterally alter data that feeds costing, payments, or regulatory declarations (§9, Approval workflow).
- **Runs the procurement cycle with a contract manufacturer** — raising, approving (when off-plan), tracking, splitting/receiving, and short-closing purchase orders, with an automatic PO document + email sent to the manufacturer the moment an order is authorized (§9, Procurement workflow).
- **Maintains one authoritative product formulation (BOM) per SKU at a time**, with full history when a formulation is corrected in place, so costing and manufacturing instructions never reference two competing recipes (§9, BOM workflow).
- **Centrally provisions and audits who can see/do what**, tied to a company Google Workspace identity rather than open self-signup (§3, Identity & Access).

**Capabilities that exist today (Fact):** Master Data governance (SKU, Vendor, Manufacturer, Raw Material, Packing Material), Product Formulation (BOM), Procurement (Purchase Orders), Approval/Governance, Identity & Access.

**Capabilities that appear incomplete or only planned (Fact — page shells with no business logic behind them, confirmed in the companion technical review's Phase 0):** Inventory, Manufacturing (beyond BOM formulation itself), Finance, Sales-CRM, HR-Payroll, Reports, and a **Uniware/Unicommerce integration** that exists only as a connectivity test script with no consuming code (`scripts/testing_uniware_connection.ts`) — likely a planned order/inventory sync with a warehouse/order-management system, but its business scope is not yet knowable from code (Assumption — needs business confirmation of what Uniware/Unicommerce is meant to do here).

---

## 2. Business Capability Map

```
ERP
├── Master Data Governance                    [LIVE]
│   ├── SKU Management
│   ├── Vendor Management
│   ├── Manufacturer Management
│   ├── Raw Material Management  (base record + vendor rate + manufacturer rate)
│   └── Packing Material Management (base record + vendor rate + manufacturer rate)
├── Product Formulation (Bill of Materials)   [LIVE]
├── Procurement (Purchase Orders)             [LIVE]
├── Approval & Governance (cross-cutting)     [LIVE]
├── Identity & Access                         [LIVE]
├── Inventory                                 [PLANNED — page shell only]
├── Manufacturing (production execution)      [PLANNED — page shell only]
├── Finance                                   [PLANNED — page shell only]
├── Sales / CRM                               [PLANNED — page shell only]
├── HR & Payroll                              [PLANNED — page shell only]
├── Reporting                                 [PLANNED — page shell only]
└── External Order/Inventory Sync (Uniware)   [SPIKE — no consuming code yet]
```

| Capability | Purpose | Business owner (Inference from role names, §3) | Supporting modules | Depends on |
|---|---|---|---|---|
| **Master Data Governance** | Keep one trustworthy version of "who we buy from, what we buy, what we sell" | Procurement/costing functions — role names `cost_creator`, plus general editor roles | SKU, Vendor, Mfg, RM, PM masters + their rate sub-tables | Approval & Governance (every edit is gated) |
| **Product Formulation (BOM)** | Define exactly what goes into one unit of a SKU, and by how much | `bom_creator` role (Fact, `scripts/seed-permissions.ts`) | BOM master, BOM History | SKU (must exist), RM/PM masters (lines reference them), Approval & Governance |
| **Procurement** | Order raw/packing materials — actually, finished SKUs — from contract manufacturers into warehouses | `production_operations`/`production_head` roles (editor on `/po-tracking`, Fact) | Purchase Orders (create, split, close, email) | SKU (must be active), Manufacturer master, Approval & Governance (impromptu POs only) |
| **Approval & Governance** | Gate risky changes on human sign-off; keep a permanent audit trail | `admin`/`manager` roles (Fact, role-checked but not seeded anywhere found — see §17 risk) | Approvals queue, Approval History | None — it's the seam every other capability plugs into |
| **Identity & Access** | Control who can see/do what, tied to a real company identity | `developer` role (only role permitted to manage permissions, Fact) | Auth (Google OAuth), page permissions, per-user overrides | None — foundational |
| **Inventory / Manufacturing / Finance / Sales-CRM / HR-Payroll / Reporting** | Named page shells exist; no business logic found | Unknown — Assumption | Directory stubs only | N/A |
| **Uniware/Unicommerce sync** | Unknown — a connectivity spike exists, nothing consumes it | Unknown — Assumption | `scripts/testing_uniware_connection.ts` only | N/A |

---

## 3. Domain Map (Bounded Contexts)

Five bounded contexts are actually implemented; six more are named but empty.

### 3.1 Master Data Governance
- **Responsibilities:** own the canonical identity and lifecycle of SKUs, Vendors, Manufacturers, Raw Materials, and Packing Materials, including their commercial rate relationships.
- **Owned entities:** SKU, Vendor, Manufacturer, Raw Material, Packing Material, RM×Vendor Rate, RM×Manufacturer Rate, PM×Vendor Rate, PM×Manufacturer Rate.
- **Shared concepts:** `status` lifecycle (`active`/`in_review`/`draft`/`inactive`), field-level diff, "one pending approval at a time."
- **Upstream context:** none — this is foundational reference data.
- **Downstream contexts:** Product Formulation (BOM lines reference RM/PM), Procurement (POs reference SKU + Manufacturer), Approval & Governance (every mutating action here is a client of the governance context).
- **External integrations:** none directly; S3 for compliance documents (GST cert, cancelled cheque, PAN).

### 3.2 Product Formulation (Bill of Materials)
- **Responsibilities:** define and version the recipe (RM percentages + PM quantities) that makes one unit of a SKU, and guarantee exactly one is authoritative at any time.
- **Owned entities:** BOM (header + lines), BOM History (archived line snapshots).
- **Shared concepts:** reuses Master Data's SKU and RM/PM identities by reference (`sku_id`, `mtrl_id`/`mtrl_type`); reuses Approval & Governance's diff/approval mechanism wholesale.
- **Upstream contexts:** Master Data Governance (a BOM cannot exist without a SKU and its RM/PM lines already existing there).
- **Downstream contexts:** none implemented yet — Manufacturing/Finance/Reporting would be natural downstream consumers of "what's the current formulation and its cost" but those contexts are empty page shells today.
- **External integrations:** none.

### 3.3 Procurement (Purchase Orders)
- **Responsibilities:** raise, authorize, track, split/receive, and close purchase orders against contract manufacturers.
- **Owned entities:** Purchase Order (including split children), PO attachment.
- **Shared concepts:** reuses Master Data's SKU (must be `active`) and Manufacturer identities by reference; reuses Approval & Governance for the impromptu-PO path only.
- **Upstream contexts:** Master Data Governance (SKU + Manufacturer must already exist).
- **Downstream contexts:** none implemented — an actual goods-receipt/Inventory context would naturally sit downstream of "PO received," but Inventory is an empty page shell today.
- **External integrations:** Gmail SMTP (PO email to the manufacturer), AWS S3 (PO PDF storage, PO bulk-CSV source files).

### 3.4 Approval & Governance (cross-cutting)
- **Responsibilities:** provide one generic maker-checker mechanism — submit a diff, lock the entity, let a privileged role approve or reject with a mandatory reason — reused by every other context rather than each reimplementing its own review flow.
- **Owned entities:** Approval (+ Approval Item), plus a registry of per-module "how to apply/revert" handlers (`MODULE_HANDLERS`).
- **Shared concepts:** the field-level diff (`old_value`/`new_value`) is the one shared vocabulary every context speaks when proposing a change.
- **Upstream contexts:** none — it is a service every other live context depends on.
- **Downstream contexts:** Master Data Governance, Product Formulation, and (partially) Procurement all call into it; none of them own it.
- **External integrations:** triggers the Procurement context's PO-email side effect specifically for the `PO` module on approval.

### 3.5 Identity & Access
- **Responsibilities:** authenticate users against a company Google identity, and authorize page/action access via a role-based-with-per-user-override model.
- **Owned entities:** User, Role assignment, Session, Session History, Page Permission, User Page Permission Override.
- **Shared concepts:** none shared *into* other contexts except the `userId`/`roles` every other context reads to make its own local authorization decisions (e.g. "is this an `admin`/`manager`" check inside Approval & Governance).
- **Upstream contexts:** none — foundational.
- **Downstream contexts:** every other context depends on it for "who is this and what can they do," but none of them own or duplicate its logic.
- **External integrations:** Google OAuth (sign-in only, not account creation).

### 3.6 Planned / empty contexts
Inventory, Manufacturing (production execution beyond formulation), Finance, Sales-CRM, HR-Payroll, Reporting, and Uniware/Unicommerce sync are named in the codebase (directories, or a connectivity script) but have no business rules, entities, or workflows to document — Fact, confirmed by the companion technical review's Phase 0/Phase 4 discovery.

### 3.7 Context relationship diagram

```
Identity & Access ──────────────► (every context reads userId/roles)

Master Data Governance ─────┬──► Product Formulation (BOM)
                             └──► Procurement (Purchase Orders)

Approval & Governance ◄─────┬── Master Data Governance   (all masters)
                             ├── Product Formulation      (BOM)
                             └── Procurement               (impromptu POs only)

Procurement ──► [Gmail SMTP, AWS S3]   (external)
Master Data Governance ──► [AWS S3]     (compliance docs, external)

(no implemented edges into Inventory / Manufacturing / Finance / Sales-CRM / HR-Payroll / Reporting / Uniware)
```

---

## 4. Ubiquitous Language

| Term | Definition (business meaning) | Owner | Related concepts | Evidence |
|---|---|---|---|---|
| **SKU** | A sellable finished product identity (code, name, brand, category) — the anchor everything else (formulation, purchase orders) attaches to. | Master Data Governance | Brand, BOM, Purchase Order | `types/masters.ts:24-34` |
| **Brand** | Which product line a SKU belongs to — the company runs at least two: mcaffeine and hyphen. | Master Data Governance | SKU, PO numbering | `app/api/v1/purchase-orders/route.ts:163-166` |
| **Vendor** | A supplier used for procurement pricing and compliance tracking (GST, banking, PAN) — scoped to raw materials, packing materials, or both. | Master Data Governance | Raw Material, Packing Material, Vendor Rate | `types/masters.ts:57-71` |
| **Manufacturer** | A contract manufacturing partner who both makes finished SKUs AND can be a fixed-rate pricing source for raw/packing materials. | Master Data Governance / Procurement | Purchase Order, Manufacturer Rate | `types/masters.ts:37-55`, `lib/pdf/po-document.tsx` |
| **Raw Material (RM)** | An ingredient used in a formulation, identified in part by its INCI name (the regulated cosmetic-ingredient identifier). | Master Data Governance | BOM line, Vendor/Manufacturer Rate | `lib/queries/raw-materials.ts` |
| **Packing Material (PM)** | A packaging component (bottle, cap, carton, label) with its own color/spec (pantone) and rate structure, distinct from ingredients. | Master Data Governance | BOM line, Vendor/Manufacturer Rate | `types/masters.ts:132-181` |
| **Vendor Rate ("dynamic")** | The price a vendor currently charges for an RM/PM — called "dynamic" because vendor pricing is expected to change more often. | Master Data Governance | Vendor, RM, PM | `cost_master_rm_ven`/`cost_master_pm_ven`, `lib/queries/raw-materials.ts` |
| **Manufacturer Rate ("fixed")** | The price a manufacturer has agreed for an RM/PM for a period — called "fixed" because it's a negotiated rate held stable, as opposed to a fluctuating vendor rate. | Master Data Governance | Manufacturer, RM, PM, Approved Vendor | `cost_master_rm_mfg`/`cost_master_pm_mfg`, `lib/queries/raw-materials.ts:336-339` |
| **Approved Vendor** | On a manufacturer's RM rate, an optional reference to which vendor's material that manufacturer's rate is tied to — a three-way manufacturer↔vendor↔material relationship. | Master Data Governance | Manufacturer Rate, Vendor | `lib/queries/raw-materials.ts:336-339` |
| **BOM (Bill of Materials)** | The formulation/recipe for one SKU — a set of Raw Material lines (as percentages of the formula) and Packing Material lines (as fixed quantities per unit). | Product Formulation | SKU, RM line, PM line | `lib/validation/bom.ts:26`, `lib/queries/bom.ts:6-9` |
| **RM Line percentage** | On a BOM, each raw-material line's `amount` IS its percentage share of the formulation — all RM lines on an active BOM must total between 99.9% and 100.1%. | Product Formulation | BOM | `lib/validation/bom.ts:10-18,26,61-68` |
| **New Version (BOM mode)** | Creating a fresh, separate formulation record for a SKU that will supersede whichever formulation is currently active. | Product Formulation | BOM, Superseded BOM | `useBomWizard.ts`, `lib/approvals/module-handlers.ts:553-574` |
| **Update Existing (BOM mode)** | Correcting/amending the CURRENT formulation in place — the prior line values are archived before being overwritten. | Product Formulation | BOM, BOM History | `lib/approvals/module-handlers.ts:527-537` |
| **Superseded BOM** | A formulation that was active for a SKU and has just been automatically deactivated because a different BOM for that same SKU was just approved/activated — enforces exactly one active formulation per SKU. | Product Formulation | BOM | `lib/approvals/module-handlers.ts:553-574` |
| **Purchase Order (PO)** | A request to a manufacturer to produce and dispatch a quantity of a SKU to a destination warehouse by an expected date. | Procurement | Manufacturer, SKU, Destination | `lib/queries/purchase-orders.ts:5-8` |
| **Normal PO** | A routine, planned purchase order raised directly with the manufacturer with no extra sign-off — implies it follows an already-vetted procurement plan. | Procurement | Purchase Order, Impromptu PO | `app/api/v1/purchase-orders/route.ts:185-186` |
| **Impromptu PO** | An ad-hoc, off-plan purchase order that requires a mandatory reason and goes through approval before being authorized to the manufacturer. | Procurement / Approval & Governance | Purchase Order, Reason | `AddPODialog.tsx:108-112`, `app/api/v1/purchase-orders/route.ts:211-243` |
| **Destination (CWH/MWH)** | The warehouse (Company Warehouse / Mother Warehouse) the manufacturer should dispatch a PO's goods to. | Procurement | Purchase Order | `app/po-tracking/po-procurement/po-types.ts:33` |
| **Splitting a PO** | The mechanism by which received quantity is credited against a PO — the original ordered quantity is never changed; received quantity accumulates via one or more splits. There is no separate "receive" action. | Procurement | Purchase Order | `app/api/v1/purchase-orders/[id]/split/route.ts:4-7,100` |
| **Short-closing a PO** | A deliberate decision to stop chasing a remaining, uncollected quantity that's larger than the automatic tolerance — formally closing the order without full receipt. | Procurement | Purchase Order | `app/api/v1/purchase-orders/[id]/close/route.ts:1-5` |
| **Receipt tolerance** | The smaller of 100 units or 10% of the original order — a shortfall within this band is treated as fully received automatically, without anyone deciding to short-close. | Procurement | Purchase Order, Split | `app/api/v1/purchase-orders/[id]/split/route.ts:104-117` |
| **Approval** | A pending change to a master record, formulation, or PO that has been submitted and is awaiting a decision from an authorized reviewer. | Approval & Governance | Approval Item, Diff | `lib/queries/approvals.ts:88-93` |
| **Approval Item** | One changed field on a pending approval, recorded as its old value and its proposed new value. | Approval & Governance | Approval | `lib/queries/approvals.ts:98-101` |
| **In Review** | The status a record is locked to the moment a change is submitted for approval — blocks any further edits until the approval is resolved. | Approval & Governance | Draft, Active | `lib/constants.ts:8-13` |
| **Draft (post-rejection)** | The status a record returns to after a rejection — editable again, but only by the person who originally submitted the change. | Approval & Governance | In Review, Rejection Remarks | `app/api/v1/masters/material-master/route.ts:185-191` |
| **Rejection Remarks** | A mandatory, free-text reason an approver must give when rejecting a change — the only place human judgment is captured as text rather than a field diff. | Approval & Governance | Approval, Draft | `app/api/v1/approvals/[id]/route.ts:55-58` |
| **Company Google Account** | The identity credential for every user — sign-in only works for an email that already exists in the system's own user list; Google verifies the person, it does not create their access. | Identity & Access | User, Role | `app/auth/signin/page.tsx:15`, `lib/auth.ts:13-20` |
| **Role** | A functional job-title-shaped grouping (e.g. `bom_creator`, `cost_creator`, `production_head`) that grants default page-level access; distinct from the separately-checked `admin`/`manager` roles that gate approval actions. | Identity & Access | Page Permission, Approver | `scripts/seed-permissions.ts`, `app/api/v1/approvals/[id]/route.ts:35-39` |
| **Per-user Override** | An individual exception to a user's role-based access for one specific page — completely replaces the role-based answer for that page when present. | Identity & Access | Role, Page Permission | `lib/permissions.ts:19-37`, `docs/authentication-and-permissions.md:77-79` |

---

## 5. Entity Catalogue

For fuller field-level detail, see the Master Data research embedded in §7 (Business Rule Catalogue) — this section states purpose, lifecycle, and relationships only, per the instruction to avoid schema detail.

| Entity | Business purpose | Lifecycle (states) | Key state transitions | Relationships | Ownership |
|---|---|---|---|---|---|
| **SKU** | The sellable product identity | `active → in_review → active` (edits only); created directly `active` | Create=immediate-active; Update=diff→in_review→approve/reject | Referenced by BOM, Purchase Order | Master Data Governance |
| **Vendor** | Supplier for procurement pricing + compliance | `in_review` (always on create) `→ active`; `→ draft` on reject | Every create AND every edit (field or document) goes through approval | Referenced by RM/PM Vendor Rate | Master Data Governance |
| **Manufacturer** | Contract manufacturing partner + fixed-rate pricing source | Same shape as Vendor | Same shape as Vendor | Referenced by RM/PM Manufacturer Rate, Purchase Order | Master Data Governance |
| **Raw Material** | An ingredient (with regulated INCI identity) | `in_review` (on create) `→ active`; `→ draft` on reject | Base record + independent rate sub-entities each have their own approval cycle | Referenced by BOM lines; has Vendor/Manufacturer Rate children | Master Data Governance |
| **RM Vendor Rate / RM Manufacturer Rate** | The commercial price for an RM from a specific vendor or manufacturer | `in_review → active`, archived to a history table on every approved change | Independent approval cycle per rate row, not tied to the RM base record's cycle | Belongs to one RM + one Vendor or Manufacturer | Master Data Governance |
| **Packing Material** | A packaging component with a color/print spec | Same shape as Raw Material (base + rate children) | Same shape as Raw Material | Referenced by BOM lines; has Vendor/Manufacturer Rate children | Master Data Governance |
| **BOM (header)** | The formulation for one SKU | `in_review → active → inactive` (superseded) | Submit→approve→activate; activation auto-deactivates any other active BOM for the same SKU | Belongs to one SKU; has many BOM lines | Product Formulation |
| **BOM Line** | One ingredient (RM, as %) or packaging component (PM, as qty) in a formulation | Written only at approval time, never at submission | Archived to BOM History before being overwritten (update-existing mode only) | Belongs to one BOM; references one RM or PM | Product Formulation |
| **Purchase Order** | A request to a manufacturer to produce/dispatch a SKU quantity | `draft → raised → punched → partially_received/received`, or `→ short_closed`, or `→ cancelled` | Normal=direct to raised; Impromptu=draft, needs approval to reach raised; splitting credits received qty; explicit action needed to short-close | References one SKU + one Manufacturer; can be split into child POs | Procurement |
| **Approval** | A pending/decided change request | `pending → approved` or `pending → rejected` | Approve runs the module's apply-and-archive logic; reject reverts the entity to draft with a mandatory remark | References one entity in exactly one other context (polymorphic by module) | Approval & Governance |
| **User** | A person authorized to use the system | `active`/`inactive` (gates sign-in) | Provisioned centrally (no self-signup found) | Has Role assignments, Sessions, submits/approves Approvals | Identity & Access |
| **Session** | One active login | `active → inactive` on logout | Tracked alongside an append-only Session History ledger | Belongs to one User | Identity & Access |

---

## 6. Aggregate Analysis

Aggregate boundaries below reflect where the code enforces **transactional consistency together** and where independent approval cycles imply the business itself treats things as separately governable, even when they describe "the same" real-world object.

### 6.1 SKU
- **Aggregate Root:** SKU
- **Contained entities:** none (no history sub-entity is written at create time; `sku_history` is a side-effect of the Approval context, not part of the SKU aggregate's own consistency boundary at write time)
- **Business invariants:** `sku_code` is unique and immutable after creation (Fact, `lib/queries/skus.ts:79`); at most one pending approval per SKU
- **Consistency boundary:** a single `master_skus` row
- **Lifecycle:** create → active (no gate) → edit → in_review → active/draft
- **State machine:** `active ⇄ in_review`, with `in_review → draft` only via rejection
- **Business owner:** Master Data Governance
- **Commands:** CreateSku, BulkImportSku, UpdateSku (submit for approval)
- **Possible future events:** `sku.created`, `sku.updateRequested`, `sku.updated`, `sku.updateRejected` (already named in the companion technical review's event catalog — not repeated here)
- **Why this boundary exists (Inference):** a SKU by itself carries no compliance risk (it's just an identity + classification), which is why it alone among masters is allowed to go live without review — the aggregate is intentionally small and low-friction.

### 6.2 Vendor
- **Aggregate Root:** Vendor (spans two tables — `master_vendors` + `details_vendor` — inserted/updated together in one transaction, Fact, `app/api/v1/masters/vendors/route.ts:6-11`)
- **Contained entities:** Vendor Details (location, zone, GST, bank, documents) — always written atomically with the root
- **Business invariants:** `code` unique and auto-generated; every create AND every field/document edit requires approval; at most one pending approval at a time
- **Consistency boundary:** the vendor + its details row together
- **Lifecycle:** create → in_review → active; edit (field or doc) → in_review → active/draft
- **State machine:** `in_review ⇄ active`, `in_review → draft` on reject; field-changes and doc-changes are tracked as independent diff sub-sets within one approval but always resolve the whole aggregate to `active`
- **Business owner:** Master Data Governance
- **Commands:** CreateVendor, UpdateVendorFields, UpdateVendorDocuments, BulkImportVendor
- **Possible future events:** `vendor.created`, `vendor.updateRequested`, `vendor.updated`, `vendor.docsUpdated`, `vendor.updateRejected`
- **Why this boundary exists (Inference):** vendor identity and its compliance documents must always agree with each other (you cannot have a vendor "active" with stale banking details), so they're one aggregate, one transaction, one approval.

### 6.3 Manufacturer
- Identical shape and reasoning to Vendor (§6.2) — Manufacturer + Manufacturer Details is one aggregate for the same reason: identity and compliance/banking data must move together (Fact, `lib/approvals/module-handlers.ts:289-335`).

### 6.4 Raw Material (three separate aggregates, not one)
The code treats "a Raw Material" as **three independently governable aggregates**, even though a business person might describe them as "one RM":
1. **RM base record** (module `RM_MAT`) — Aggregate Root: `master_rm`. Invariant: unique by `name`+`make`+`inci_name` (case-insensitive duplicate check, Fact, `lib/queries/raw-materials.ts:342-348`). No history table — an approved edit overwrites the prior name/make/type/uom/hsn/inci_name with no archive (Fact, `lib/approvals/module-handlers.ts:185-206`; see §17 risk).
2. **RM × Vendor Rate** (module `RM_VRM`) — Aggregate Root: one `cost_master_rm_ven` row. Invariant: at most one pending approval per RM+vendor pair; archived to `history_cost_ven` before every approved overwrite.
3. **RM × Manufacturer Rate** (module `RM_RATE`) — Aggregate Root: one `cost_master_rm_mfg` row, which can additionally carry an "approved vendor" reference. Archived to `history_cost_mfg` before overwrite.
- **Why this boundary exists (Inference):** identity (what the ingredient IS) and price (what it COSTS from a given source) change for different reasons, on different schedules, decided by different people potentially — separating them into independent aggregates means a rate renegotiation doesn't need to touch or re-approve the ingredient's core identity, and vice versa.

### 6.5 Packing Material
- Same three-aggregate split as Raw Material (`PM_MAT`, `PM_VRM`, `PM_RATE`) — Fact, mirrored handler structure in `lib/approvals/module-handlers.ts`. One asymmetry worth naming as its own finding: a brand-new PM's bundled rate can be written `active` immediately in one create path while RM's equivalent path always forces `in_review` (Fact, `pm-handler.ts:61,72` vs `rm-handler.ts:27,39` — see §17 risk).

### 6.6 BOM
- **Aggregate Root:** `master_recipe` (header)
- **Contained entities:** BOM Lines (`details_recipe`) — always written/replaced together with the header, never independently
- **Business invariants:** exactly one `active` BOM per SKU at any time (enforced at approval time by deactivating siblings, Fact, `lib/approvals/module-handlers.ts:553-574`); RM lines must sum to 99.9%–100.1%; at least one RM line required; lines are never written until the governing approval is decided
- **Consistency boundary:** one BOM header + its full current line set
- **Lifecycle:** submit (new-version or update-existing) → in_review → active (siblings deactivated) → eventually superseded → inactive
- **State machine:** `in_review → active`, `in_review → draft` (reject), `active → inactive` (superseded by a sibling's activation, not a direct user action)
- **Business owner:** Product Formulation (`bom_creator` role)
- **Commands:** SubmitNewBomVersion, SubmitBomUpdate, CheckExistingBom (query, not a command)
- **Possible future events:** `bom.submitted`, `bom.activated`, `bom.deactivated` (one per superseded sibling), `bom.updateRejected`
- **Why this boundary exists (Inference):** a formulation's lines only make sense together (a formulation is not "half-approved" — either the whole recipe takes effect or none of it does), and the one-active-per-SKU rule requires the approval step to see and act on the whole SKU's formulation set atomically, which is why lines are staged as a diff and only materialized at approval time rather than written incrementally.

### 6.7 Purchase Order
- **Aggregate Root:** one `purchase_orders` row
- **Contained entities:** none directly, but a PO can produce child POs via splitting — each child is its OWN aggregate instance, linked by `parent_po_id`, not a contained sub-entity
- **Business invariants:** ordered quantity (`qty`) is never mutated after creation — only `received_qty` accumulates (Fact, `app/api/v1/purchase-orders/[id]/split/route.ts:4-7`); SKU must be `active` at creation and at re-edit time; no backdating of `expected_on`; only the original submitter may re-edit a draft
- **Consistency boundary:** one PO row (plus, transactionally, its Approval when impromptu)
- **Lifecycle:** `draft → raised → punched → partially_received/received`, or `→ short_closed`/`cancelled`; splitting can happen from `draft`, `raised`, `punched`, or `partially_received`
- **State machine:** see §10 for the full transition table
- **Business owner:** Procurement (`production_operations`/`production_head` roles)
- **Commands:** CreateNormalPo, CreateImpromptuPo, BulkImportPo, ReEditDraftPo, SplitPo, ShortClosePo, SendPoEmail
- **Possible future events:** `po.raised`, `po.raisedDirect`, `po.approved`, `po.split`, `po.statusChanged`, `po.closed`, `po.emailSent`
- **Why this boundary exists (Inference):** a PO is the unit of commitment to a manufacturer — splitting deliberately creates new, independent PO records rather than sub-line-items, which suggests the business treats each dispatch/receipt event as its own trackable commercial document, not merely a quantity update on the original order.

### 6.8 Approval
- **Aggregate Root:** one `approvals` row
- **Contained entities:** its Approval Items (the field-level diff) — always inserted together with the root, in one transaction
- **Business invariants:** at most one `pending` approval per `(module, entity_id)` pair, system-wide, regardless of which context that entity belongs to; rejection requires a non-empty remark; approvals/rejections are never deleted (Fact, `lib/queries/approvals.ts:180-181`)
- **Consistency boundary:** one approval + its full item set
- **Lifecycle:** `pending → approved` or `pending → rejected`
- **Business owner:** Approval & Governance
- **Commands:** SubmitForApproval (raised by every other context), ApproveChange, RejectChange
- **Possible future events:** `approval.raised`, `approval.approved`, `approval.rejected`
- **Why this boundary exists (Inference):** this aggregate is deliberately generic (module + entity_id + a field-diff shape) precisely so every other bounded context can reuse ONE governance mechanism instead of building its own — it is the shared kernel of the whole system's change-control model.

---

## 7. Business Rule Catalogue

Rules are grouped by context. Every rule cites its enforcement site.

### Master Data Governance

**BR-001 — SKU code is unique and immutable.**
Description: Once a SKU is created, its `sku_code` can never be changed by any update path.
Evidence: `lib/queries/skus.ts:79` (comment: "sku_code is immutable"); `app/api/v1/masters/skus/route.ts:42-45` (409 on duplicate).
Reason: a SKU code is likely referenced externally (packaging, listings, other systems) — changing it after the fact would break traceability.
Enforced where: SKU create/update route.
Impacted entities: SKU.
Business justification: Fact.
Possible violations: none found — enforced at the DB constraint + application layer.
Possible future event: `sku.created` (duplicate-rejected variant not modeled as its own event — it's a synchronous 409).

**BR-002 — Raw Materials are duplicate-checked by name + make + INCI name (case-insensitive).**
Evidence: `lib/queries/raw-materials.ts:342-348`.
Reason (Inference): prevents re-registering the same regulated ingredient under a different code, which would fragment sourcing/rate history for what is chemically the same material.
Enforced where: `check-RM` action and inline in material-master create.
Impacted entities: Raw Material.
Status: Fact.
Possible future event: `rawMaterial.duplicateDetected` (not currently modeled — see §13).

**BR-003 — Packing Materials are duplicate-checked by name + type (case-sensitive).**
Evidence: `lib/queries/packing-materials.ts:296-298`.
Reason (Inference): same protection as BR-002, but the case-sensitivity difference versus RM (Fact) is unexplained in code and worth a business/tech confirmation — is that intentional or an oversight? (Assumption.)
Impacted entities: Packing Material.

**BR-004 — A rejected/draft master record may only be re-edited by its original submitter.**
Evidence: `app/api/v1/masters/material-master/route.ts:185-191,257-263` (RM and PM); mirrored across Vendor/Manufacturer edit dialogs.
Reason: preserves accountability — the person whose name is on a rejected submission is the one responsible for fixing it, not a colleague.
Impacted entities: Vendor, Manufacturer, Raw Material, Packing Material.
Status: Fact.
Possible future event: `*.updateRejected` already carries this context via `remarks`.

**BR-005 — Vendor/Manufacturer document changes are gated by approval exactly like field changes** (not a lower-risk bypass, as one might assume).
Evidence: `app/api/v1/masters/vendors/route.ts:362-425`, manufacturer `update_docs` action; `VENDOR_DOC_FIELDS`/`MFG_DOC_FIELDS` in `lib/approvals/module-handlers.ts:234-236,285-287`.
Reason (Inference): GST certificates, cancelled cheques, and PAN cards directly affect statutory/banking risk, so they get the same scrutiny as a name or bank-account change.
Status: Fact.

**BR-006 — RM_MAT, PM_MAT, VENDOR, and MFG have no history table; an approved edit permanently overwrites the prior value with no full-row archive** (only the field-level approval-item diff survives, forever, in the approvals ledger).
Evidence: `lib/approvals/module-handlers.ts:185-335` (no archive call in any of these four handlers, contrasted with SKU/RM_RATE/PM_RATE/RM_VRM/PM_VRM/BOM which do archive).
Reason: not stated in code — appears to be an inconsistency rather than a deliberate choice.
Status: **Fact** (the absence), but **Assumption** on whether this is intentional — flagged again in §17 as a business risk, since it means a vendor's or manufacturer's prior bank account number, once changed and approved, is not recoverable from a dedicated audit table (only from the generic diff row).

### Product Formulation (BOM)

**BR-007 — Raw Material lines on a BOM must sum to between 99.9% and 100.1%.**
Evidence: `lib/validation/bom.ts:10-18,61-68`.
Reason: a formulation is a percentage-composition declaration and, by definition, its ingredients must total to (approximately) whole — likely also driven by regulatory ingredient-declaration requirements for cosmetics (Inference).
Enforced where: client-side wizard AND server-side Zod schema, same constants (single source of truth, `lib/validation/bom.ts`).
Impacted entities: BOM.
Status: Fact (the rule); Inference (the regulatory motive).
Possible future event: none currently — a violation is a synchronous validation rejection, not a recorded business fact.

**BR-008 — Exactly one BOM may be `active` per SKU at any time.**
Evidence: `lib/approvals/module-handlers.ts:553-574`; `lib/queries/bom.ts:281-283` (comment).
Reason: costing, manufacturing instructions, and regulatory declarations must reference a single unambiguous formulation, never two competing ones.
Enforced where: at approval-apply time, automatically, with no human decision — every other active BOM for that SKU is deactivated as a side effect.
Impacted entities: BOM (fan-out to sibling BOMs).
Status: Fact.
Possible future event: `bom.deactivated` (one per superseded sibling).

**BR-009 — At least one RM line is required on every BOM submission; PM lines may be empty.**
Evidence: `lib/validation/bom.ts:45`.
Reason (Inference): every product needs an ingredient composition to exist at all, but a product could conceivably have zero distinct packaging components tracked in this system (e.g. unpackaged bulk, or packaging tracked elsewhere).
Status: Fact (the rule); Assumption (the reason for the RM/PM asymmetry).

**BR-010 — A BOM line dropped from an "update-existing" submission is recorded as removed, not silently deleted, and the prior BOM state is fully archived before any line is touched.**
Evidence: `app/api/v1/masters/recipe-master/route.ts:106-115` (removed-line sentinel); `lib/approvals/module-handlers.ts:527-537` (full snapshot to `history_recipe` before delete/reinsert).
Reason: preserves a recoverable, queryable audit trail of every formulation revision — a real business need for recipe/regulatory audit (per the BOM domain research).
Status: Fact.

### Procurement

**BR-011 — A Purchase Order cannot be raised (or re-edited) against a SKU that is not `active`.**
Evidence: `app/api/v1/purchase-orders/route.ts:150-160`; `app/api/v1/purchase-orders/[id]/route.ts:44-52`.
Reason: prevents new manufacturing spend against a product that's been sunset, is mid-reformulation, or otherwise unsellable.
Impacted entities: Purchase Order, SKU.
Status: Fact.

**BR-012 — Expected dispatch date on a PO can never be backdated.**
Evidence: `app/api/v1/purchase-orders/[id]/route.ts:36-42`; mirrored client-side (`min={today}` on the date field).
Reason: the expected date is a real commitment communicated to the manufacturer — a date in the past is not a meaningful instruction.
Status: Fact.

**BR-013 — "Normal" POs are raised directly with no approval; "Impromptu" POs must be approved, and must carry a reason.**
Evidence: `app/api/v1/purchase-orders/route.ts:185-186` (comment: "Normal PO: insert directly as raised, no approval needed"); mandatory reason field only on impromptu (`AddPODialog.tsx:58-59,192-196`).
Reason (Inference): normal POs follow an already-vetted procurement plan; impromptu POs are off-plan and therefore need a second pair of eyes plus a documented justification.
Status: Fact (mechanism); Inference (business motive).

**BR-014 — Only the PO's original submitter may re-edit it while it's a draft, and only while it is `draft` with no pending approval.**
Evidence: `app/api/v1/purchase-orders/[id]/route.ts:58-76`.
Reason: preserves accountability for who is amending a not-yet-authorized commercial request.
Status: Fact.

**BR-015 — Receiving is implicit, via splitting: ordered quantity is immutable, received quantity accumulates via one or more split actions, with no dedicated "receive" endpoint.**
Evidence: `app/api/v1/purchase-orders/[id]/split/route.ts:4-7,100`.
Reason: allows a single order to be fulfilled across multiple partial deliveries/allocations, each independently trackable.
Status: Fact.

**BR-016 — A shortfall within the smaller of 100 units or 10% of the original order quantity is automatically treated as fully received; a larger shortfall requires either further splitting or a deliberate short-close.**
Evidence: `app/api/v1/purchase-orders/[id]/split/route.ts:104-117`.
Reason: contract manufacturing rarely delivers the exact ordered quantity (yield loss, batch rounding, minor rejects) — the tolerance absorbs routine imprecision so POs don't sit open forever over negligible shortfalls.
Status: Fact.

**BR-017 — Short-closing is reserved for a deliberate decision not to fulfil a remainder that is LARGER than the automatic tolerance.**
Evidence: `app/api/v1/purchase-orders/[id]/close/route.ts:1-5` (comment gives the "500 units left from 10,000" example); UI gates the action to `remaining > tolerance` (`PoTable.tsx:263`).
Reason: distinct from BR-016's automatic closure — this is a human decision to stop chasing a real, non-trivial shortfall.
Status: Fact.

**BR-018 — Approving an impromptu PO automatically sends the PO document to the manufacturer by email, exactly once.**
Evidence: `app/api/v1/approvals/[id]/route.ts:113-131`; `lib/queries/purchase-orders.ts:150` (`setEmailSentAt` guarded to fire once).
Reason: the approved PO is the commercial/legal instrument authorizing the manufacturer to produce — sending it immediately on approval closes the loop without a manual step.
Status: Fact.

### Approval & Governance

**BR-019 — At most one pending approval may exist for any given entity at a time, across every module.**
Evidence: `lib/queries/approvals.ts:149-157`, checked before every submission across SKU/Vendor/Manufacturer/RM/PM/BOM/PO paths.
Reason: prevents a maker from stacking concurrent edits, and prevents an approver from actioning a stale duplicate.
Status: Fact.

**BR-020 — Rejection requires a non-empty remark.**
Evidence: `app/api/v1/approvals/[id]/route.ts:55-58`.
Reason: a rejection reverts real business data to draft and sends the maker back to rework it — without a stated reason there's no way to know what to fix, and no audit trail for why a change was denied.
Status: Fact.

**BR-021 — Only `admin`/`manager` roles may approve or reject; there is no rule preventing the same person from approving their own submission.**
Evidence: `app/api/v1/approvals/[id]/route.ts:35-39` (role check exists); no comparison anywhere of `approval.raised_by` to the acting approver's id.
Reason: role-based separation exists, but transaction-level maker-checker (the classic "you cannot approve your own request") does not. This is explicitly named as an open risk in the team's own prior architecture notes (`architecture-discussion-framework.md:609,650`).
Status: **Fact** (the gap); flagged again in §17.

**BR-022 — Approval and rejection decisions are never deleted; they form a permanent history.**
Evidence: `lib/queries/approvals.ts:180-181,186-214`.
Reason: the audit trail is the point of the whole mechanism — a governance record that could be erased would defeat its purpose.
Status: Fact.

### Identity & Access

**BR-023 — Sign-in requires an email that already exists in the system's own user list; Google only verifies identity, it never creates access.**
Evidence: `lib/auth.ts:13-20`.
Reason: access is centrally provisioned by the company, not self-service.
Status: Fact.

**BR-024 — A per-user page-permission override, when present, completely replaces the role-based answer for that page — it does not combine with or add to role permissions.**
Evidence: `lib/permissions.ts:19-37`; `docs/authentication-and-permissions.md:77-79`.
Reason: supports individual exceptions (e.g. one person needing elevated access) without needing a new role or a role change.
Status: Fact.

---

## 8. Business Decision Catalogue

| Decision | Why it exists | Who is affected | Business consequence | Analytics value | Audit value | Event value |
|---|---|---|---|---|---|---|
| **Duplicate SKU/RM/PM/Vendor/Manufacturer/PO-number detected** | Prevents fragmenting one real-world thing across multiple records | The submitting user (blocked synchronously); bulk imports instead silently skip the duplicate row | Data integrity preserved automatically, with zero human judgment involved | Track how often duplicates are attempted — signals process gaps upstream (e.g. people not checking before creating) | Low today — skipped bulk rows aren't individually logged as "why" | High — a `*.duplicateDetected` event would let a dashboard show data-entry friction hot-spots |
| **Approval required (impromptu PO, or any masters edit)** | Gates risky changes on human review | The submitter (blocked from immediate effect) and the approver (must act) | Slower turnaround for legitimate off-plan procurement or master edits, in exchange for oversight | Approval queue age/throughput is a natural ops metric | Very high — this IS the audit mechanism | High — already the richest event surface in the system |
| **Rejection (with mandatory remarks)** | Forces a stated reason and returns control to the original submitter | Submitter (must rework); no one else can touch the draft | Creates a documented disagreement/correction cycle | Rejection-rate-by-module/by-approver could reveal training gaps or unclear submission guidance | High — remarks are a rich, searchable text audit field, already never deleted | High |
| **SKU not active → block PO creation** | Prevents wasted procurement spend on sunset/unsellable products | Whoever is trying to raise a PO | Immediate synchronous block, not a queue | Could reveal how often people try to order for inactive SKUs (process friction) | Low today — not recorded as a distinct fact | Medium |
| **Only one active BOM per SKU (auto-deactivate siblings)** | Guarantees an unambiguous costing/production formulation | Anyone consuming "the current formulation" for a SKU (costing, manufacturing, regulatory) | A formulation change silently retires the old one the moment its replacement is approved | High — "how often does this SKU's formula change" is a real cost/quality signal | High — the deactivation is already logged per the companion technical review's BOM instrumentation | High — `bom.deactivated` is exactly this decision made durable |
| **Tolerance-based auto-receive on PO split** | Absorbs routine manufacturing shortfall without manual intervention | Whoever is tracking PO completion | Some POs close as "received" despite a small real shortfall — a deliberate business trade-off, not an error | High — shortfall-within-tolerance rate is a supplier-performance signal worth tracking over time | Medium | Medium |
| **Short-close a PO** | Formalizes a decision not to chase a real, larger-than-tolerance shortfall | Whoever raised/owns the PO; the manufacturer relationship implicitly | Order closes with unmet quantity, permanently | High — short-close rate per manufacturer is a supplier-reliability signal | High — this is an explicit, deliberate human decision worth its own event | High |
| **Vendor/Manufacturer/RM/PM base-record edits overwrite with no history table** | Not a deliberate decision found in code — an inconsistency (see BR-006) | Anyone later needing to know "what did this used to be" | Prior values are unrecoverable outside the generic diff row | N/A | **Negative** — this is a gap, not a feature | N/A until fixed |

---

## 9. Workflow Catalogue

### 9.1 Master Data Edit (generic — applies to SKU, Vendor, Manufacturer, RM, PM base records)
- **Purpose:** change an existing master record without ever letting an unreviewed value go live.
- **Trigger:** an authorized editor submits new field values for an existing record.
- **Steps:** (1) fetch current row; (2) compute field-level diff; (3) if empty, short-circuit with "no changes detected"; (4) if a pending approval already exists, block (409); (5) if the record is `draft` (previously rejected) and the requester isn't the original submitter, block (403); (6) insert one `approvals` row + one `approval_items` row per changed field; (7) flip the entity to `in_review`.
- **Business rules involved:** BR-004, BR-019.
- **State transitions:** `active/draft → in_review`.
- **Decision points:** empty diff (no-op), pending-approval conflict, draft-ownership conflict.
- **Side effects:** entity locked from further edits until resolved.
- **Completion criteria:** an approval decision is made (see §9.3).
- **Exceptions:** SKU create and every bulk-import path skip this workflow entirely — they write directly as `active` (BR-013's sibling rule for masters, not just POs).

### 9.2 Master Data Create
- **Purpose:** register a brand-new record.
- **Trigger:** an authorized editor submits a new record.
- **Steps (SKU only):** insert directly as `active` — no approval. **Steps (Vendor/Manufacturer/RM/PM):** (1) duplicate check (RM/PM by name+make/type; Vendor/Manufacturer by generated code collision retry); (2) insert as `in_review`; (3) raise an approval with every populated field as a "from nothing" diff; (4) resolves to `active` on approval, `draft` on rejection.
- **Business rules involved:** BR-001, BR-002, BR-003.
- **Decision points:** duplicate detected → hard block (not escalated to a human).
- **Completion criteria:** approval decision (SKU: immediate).

### 9.3 Approval Decision
- **Purpose:** the single reusable review step every other workflow above depends on.
- **Trigger:** an `admin`/`manager` opens the approvals queue and acts on a pending item.
- **Steps:** (1) re-verify the approval is still `pending` (guards against a race where it was already actioned); (2) on approve — invoke the module's own "apply and archive" logic (which may itself fan out, e.g. BOM's sibling deactivation), then mark the approval `approved`; (3) on reject — require a non-empty remark, revert the entity to `draft`, mark the approval `rejected`.
- **Business rules involved:** BR-019 (re-checked), BR-020, BR-021, BR-022.
- **State transitions:** `pending → approved/rejected`; entity `in_review → active` or `in_review → draft`.
- **Decision points:** the human approve/reject choice itself — the system supplies only the diff, no automated risk-scoring of the change.
- **Side effects:** module-specific (history archival where applicable; BOM's sibling fan-out; PO's automatic email).
- **Completion criteria:** approval reaches `approved` or `rejected`.
- **Exceptions:** none — every module funnels through this one workflow.

### 9.4 Purchase Order Creation
- **Purpose:** commit to a manufacturer for a quantity of a SKU.
- **Trigger:** a procurement user creates a PO (normal, impromptu, or via bulk CSV).
- **Steps:** (1) validate the target SKU is `active`; (2) generate a brand/type/month-scoped PO number; (3) **Normal** → insert directly as `raised`. **Impromptu** → insert as `draft`, raise an approval with the full order detail as the diff. **Bulk CSV** → parse rows from S3, resolve each manufacturer by code, insert each valid row directly as `raised`, skip invalid rows.
- **Business rules involved:** BR-011, BR-012, BR-013.
- **State transitions:** `(none) → draft` or `(none) → raised`.
- **Decision points:** SKU-not-active block; per-row skip on bulk import (manufacturer not found, invalid quantity).
- **Side effects:** none until approval (impromptu) or immediately (normal/bulk) — PO exists and is visible.
- **Completion criteria:** PO reaches `raised` (directly, or via §9.3 for impromptu).

### 9.5 Purchase Order Fulfilment (Split/Receive)
- **Purpose:** record delivery against an order without ever mutating the original ordered quantity.
- **Trigger:** goods arrive (fully or partially) from the manufacturer.
- **Steps:** (1) create one or more child POs via the split action, each crediting a quantity to the parent's `received_qty`; (2) compute remaining quantity against the parent's original order; (3) if remaining is within tolerance, auto-close the parent to `received`; otherwise the parent stays open (still splittable, or eligible for a manual short-close).
- **Business rules involved:** BR-015, BR-016.
- **State transitions:** `raised/punched/partially_received → received` (auto) or unchanged (partial, awaiting more splits/a decision).
- **Decision points:** tolerance check.
- **Side effects:** child PO records created, each independently trackable.
- **Completion criteria:** parent PO reaches `received` or `short_closed`.
- **Exceptions:** short-closing (§9.6) is the alternative completion path when the shortfall exceeds tolerance and the business chooses not to keep chasing it.

### 9.6 Purchase Order Short-Close
- **Purpose:** formally end an order with a real, accepted shortfall.
- **Trigger:** a user decides not to fulfil the remainder of a `raised`/`punched`/`partially_received` PO.
- **Steps:** (1) verify the PO's current status permits closing; (2) set status to `short_closed`.
- **Business rules involved:** BR-017.
- **State transitions:** `raised/punched/partially_received → short_closed`.
- **Decision points:** none automated — this is entirely a human decision, gated only by remaining-qty-exceeds-tolerance in the UI.
- **Completion criteria:** status is `short_closed` (terminal).

### 9.7 BOM Submission and Activation
- **Purpose:** create or amend a SKU's formulation without ever letting a half-finished recipe take effect.
- **Trigger:** a formulator submits a new formulation version, or an amendment to the current one.
- **Steps:** (1) dry-run check whether the SKU already has an active BOM (steers new-version vs update-existing); (2) new-version → create a new BOM header `in_review`; update-existing → verify no pending approval exists on that BOM, lock it `in_review`; (3) diff proposed RM/PM lines against current lines (empty for new-version); (4) raise one approval encoding the whole line diff, including removed-line sentinels; (5) on approval — for update-existing, snapshot every current line to history first, then delete and reinsert the new set; for new-version, just insert; (6) activate the BOM; (7) deactivate every other currently-active BOM for the same SKU, one at a time.
- **Business rules involved:** BR-007, BR-008, BR-009, BR-010.
- **State transitions:** `(none)/active → in_review → active`; sibling `active → inactive`.
- **Decision points:** RM total out of tolerance → synchronous validation block, not escalated to a human; existing-active-BOM found → steers the workflow branch, not a hard block.
- **Side effects:** sibling BOM deactivation (fan-out); history snapshot (update-existing only).
- **Completion criteria:** approval reaches `approved` and the new BOM is `active`.

---

## 10. State Transition Catalogue

### SKU
| From | To | Trigger | Approval required? | Business meaning |
|---|---|---|---|---|
| (none) | active | Create | No | New product identity registered |
| active | in_review | Update submitted | — | Locked pending review |
| in_review | active | Approved | Yes | Change takes effect |
| in_review | draft | Rejected | Yes | Reverted for correction |
| draft | in_review | Resubmitted by original submitter | — | Back into review |

### Vendor / Manufacturer (identical shape)
| From | To | Trigger | Approval required? | Business meaning |
|---|---|---|---|---|
| (none) | in_review | Create | — | New supplier/partner proposed, not yet live |
| in_review | active | Approved | Yes | Supplier/partner usable for procurement |
| in_review | draft | Rejected | Yes | Proposal or edit denied |
| active | in_review | Field or document update submitted | — | Locked pending review |
| draft | in_review | Resubmitted by original submitter | — | Back into review |

### Raw Material / Packing Material base record (identical shape to Vendor)
Same transition table as Vendor/Manufacturer, applied independently to the base record and — separately — to each rate row (which has its own `in_review ⇄ active`/`draft` cycle against `history_cost_mfg`/`history_cost_ven`).

### BOM
| From | To | Trigger | Approval required? | Business meaning |
|---|---|---|---|---|
| (none) | in_review | Submit new version | — | Candidate formulation proposed |
| active | in_review | Submit update to current formulation | — | Amendment locked pending review |
| in_review | active | Approved | Yes | This formulation is now authoritative for the SKU |
| in_review | draft | Rejected | Yes | Submission denied |
| active | inactive | A different BOM for the same SKU is activated | No (automatic) | Formulation superseded |

Invalid transitions worth naming explicitly: a BOM cannot move directly from `inactive` back to `active` without going through a fresh `in_review → active` cycle (Inference — no code path found that reactivates a deactivated BOM directly); two BOMs for the same SKU cannot both be `active` simultaneously (BR-008).

### Purchase Order
| From | To | Trigger | Approval required? | Business meaning |
|---|---|---|---|---|
| (none) | raised | Normal PO created | No | Order authorized immediately |
| (none) | draft | Impromptu PO created | — | Off-plan order proposed |
| draft | raised | Approved | Yes | Off-plan order now authorized; PO email auto-sent |
| draft | draft | Rejected | Yes | Stays with submitter for correction |
| raised | punched | (not found in reviewed code — Assumption: happens in an inward/GRN process outside this codebase's reviewed scope) | Unknown | Physical receipt process has begun |
| raised/punched/partially_received | partially_received | Split with remaining qty beyond tolerance | No | Some quantity received, order stays open |
| raised/punched/partially_received | received | Split with remaining qty within tolerance | No (automatic) | Order treated as complete |
| raised/punched/partially_received | short_closed | Manual short-close | No | Deliberate early closure with accepted shortfall |
| ? | cancelled | (no route found in reviewed code — Assumption) | Unknown | Order abandoned entirely |

Invalid transitions worth naming: a PO cannot be edited once it leaves `draft` (BR-014); `qty` never changes after creation under any transition (BR-015).

---

## 11. Transaction Boundary Analysis

| Workflow | Must occur atomically | May occur after commit | May become asynchronous | Should eventually use an Outbox | Why |
|---|---|---|---|---|---|
| **Master data create/edit submission** | Diff computation, approval + approval-item insert, entity status flip to `in_review` | Nothing found today | Audit-log/event recording (already logged after commit in the companion technical review) | Yes, once a real event bus exists | The record's visible lock state (`in_review`) and the approval record that will eventually unlock it must never disagree — a crash between them would leave a record permanently stuck locked with no way to review it. |
| **Approval decision (approve)** | Module apply-and-archive (history snapshot + overwrite/insert) + status flip to `active` + approval marked `approved`, all in one DB transaction (Fact, confirmed in the companion review) | The PO auto-email send (already fire-and-forget, deliberately outside the transaction — Fact, `app/api/v1/approvals/[id]/route.ts:113-131`) | The PO email already is; any future notification to the submitter should be too | Yes for the email step specifically — today a crash after commit but before the email send would silently skip notifying the manufacturer, with only a log line as evidence | The business-critical part (does the change actually take effect, consistently) must be atomic; the notification is a nice-to-have that shouldn't be able to roll back a governance decision if it fails. |
| **BOM activation with sibling deactivation** | Header activation + line insert/reinsert + sibling deactivation, all in one transaction (Fact) | Nothing found today | The per-sibling audit event (already the case per the companion review) | Yes, once real events exist — today, if the process crashes mid-fan-out, some siblings could be left active alongside the new BOM until a retry, which would (briefly) violate BR-008 | The one-active-BOM-per-SKU invariant is the whole point of this workflow — it cannot be allowed to be partially true. |
| **PO split** | Child PO insert(s) + parent `received_qty` credit + parent status recompute, in one transaction (Fact, confirmed pattern from `close/route.ts` similarly wrapped) | Nothing found today | None identified | Not obviously needed — no cross-system side effect here today | Received quantity and the resulting status must never disagree, or the PO's completion state becomes untrustworthy. |
| **PO bulk CSV import** | Each valid row's PO insert (Fact — wrapped in one transaction per the companion review's PO_BULK handler) | Nothing found today | None identified | Not obviously needed | A partially-committed bulk file would leave an ambiguous "which rows actually landed" state for the person who uploaded it. |

**Recommendation (not a finding):** every "should eventually use an Outbox" row above already has the raw ingredients for it in the companion technical review (§4.2's transactional-outbox concept, §5's event catalog) — this document's contribution is establishing *why* those specific boundaries matter in business terms, not re-specifying the outbox mechanism itself.

---

## 12. Side Effect Matrix

| Business activity | Immediate effect | Delayed effect | Notifications | Reporting/analytics updates | External integrations | Future consumers |
|---|---|---|---|---|---|---|
| Master data create/edit submitted | Entity locked to `in_review` | Approval appears in the queue | None found — no "new approval waiting" notification to approvers exists in code (Fact — a gap, see §17) | None found | None | A notification service (named as a stub in the companion technical review) |
| Approval approved | Entity's new values take effect; history archived where applicable | None beyond the transaction, except PO's email (below) | For PO only: auto-email to manufacturer | None found — no dashboard/metrics consumer exists yet | For PO only: PDF generation + S3 upload + Gmail SMTP send | A "submitter was notified their change was approved" feature (not found — gap) |
| Approval rejected | Entity reverts to `draft`; remark stored | None found | None found — the submitter is not proactively notified; they'd have to check the record's status themselves (Fact — a gap) | None found | None | Same notification gap as above |
| BOM activated | New formulation becomes authoritative | Sibling BOMs deactivated (same transaction, not truly "delayed" — but logically a downstream consequence) | None found | None found — a costing/reporting context that reacts to "formulation changed" doesn't exist yet | None | Finance/Reporting/Manufacturing contexts, once built |
| PO approved (impromptu) | Status → `raised` | PO PDF + email sent (fire-and-forget, same request but explicitly decoupled) | Manufacturer receives the PO by email | None found | Gmail SMTP, AWS S3 | None currently — a "manufacturer confirmed receipt" loop doesn't exist |
| PO split/received | `received_qty` credited; status recomputed | None found | None found | None found — no inventory/goods-receipt context exists to react to this | None | The (currently empty) Inventory context is the obvious natural consumer |
| PO short-closed | Status → `short_closed` (terminal) | None found | None found | None found | None | A supplier-performance reporting feature (not found — opportunity, §18) |

**Business side effects vs. technical side effects** (as requested):
- **Business side effects** (things a person in the company would recognize as "something happened in the real world" or "something the business now knows"): the manufacturer receiving a PO email; a formulation becoming authoritative; an order being formally short-closed; a record becoming editable again after rejection.
- **Technical side effects** (infrastructure consequences, not business facts in themselves): the S3 upload of the PO PDF; the DB transaction commit; the structured log line. These matter for the *how* (already covered in the companion technical review) but are not, on their own, business events worth modeling in a domain sense.

---

## 13. Event Discovery Matrix

Per the instructions, this section derives potential events FROM business activities already established above — it does not design an event schema (the companion technical review's event catalog already exists for that and is not repeated here).

| Business Activity | Business Fact | Potential Domain Event | Potential Integration Event | Potential Consumers | Why this event exists |
|---|---|---|---|---|---|
| A master record is created | "A new [Vendor/SKU/RM/...] now exists" | `sku.created`, `vendor.created`, etc. | None obviously needed yet | Audit trail; a future "new supplier onboarded" notification | Every downstream context that references this entity needs to know it exists — today they'd only find out by querying the table directly |
| A master record's edit is approved | "This [Vendor/SKU/...]'s data has changed, here specifically" | `*.updated` with the field diff | None | A future notification to the submitter; a future data-quality dashboard | This is the ONLY durable, structured record of the prior value for the four modules with no history table (BR-006) — making this event durable is a partial mitigation for that risk, not just a nice-to-have |
| An approval is rejected | "This proposed change was denied, and why" | `approval.rejected` (with remarks) | None | A future "notify the submitter" feature (currently missing per §12) | Right now the submitter must poll the UI to discover a rejection — an event is the natural trigger for a missing notification |
| A BOM is activated | "This SKU's authoritative formulation just changed" | `bom.activated` | None obviously — unless a future PLM/regulatory system needs to know | A future costing engine; a future regulatory-declaration generator; a future manufacturing-instruction system | None of these consumer contexts exist yet, but the fact itself is exactly the kind of "something the business now knows" moment that justifies an event over a query-only model |
| A BOM is superseded (deactivated) | "This formulation is no longer authoritative, replaced by X" | `bom.deactivated` (per sibling) | None | Same as above, plus a future "formulation history" view (the read-only BOM History page already partially serves this today via direct query) | The fan-out nature (BR-008) means this is genuinely a per-sibling fact, not one fact for the whole batch — modeling it as N events matches the real business granularity |
| A PO is approved | "This order is now authorized" | `po.approved` | Yes — this is the one place an external party (the manufacturer) needs to know, today served by email rather than a machine-readable event | The manufacturer (via email today); a future supplier portal; a future logistics/inventory context | This is the one activity in the whole system that already crosses an organizational boundary (to the manufacturer) — a strong signal it's a genuine integration point, not just an internal fact |
| A PO is split/received | "Some or all of this order has arrived" | `po.split`, implicitly `po.statusChanged` | Possibly — if a future warehouse/inventory system needs to know goods arrived | The (currently empty) Inventory context; a future supplier-performance dashboard | Receiving quantity is exactly the kind of fact an Inventory context would need to react to, once one exists — this is the clearest "future consumer" in the whole matrix |
| A PO is short-closed | "This order is deliberately closed with an accepted shortfall" | `po.closed` (reason: short-close) | Possibly, for supplier-performance tracking | A future supplier-performance reporting feature | This is a human decision worth remembering distinctly from an automatic tolerance-based closure — conflating the two would lose a real business signal |

**What this matrix deliberately does NOT propose (per instructions):** events for every CRUD action regardless of business significance, events for internal validation failures (duplicate checks, RM-total-out-of-range) that are synchronous user-facing rejections rather than business facts worth recording as history, or any event for the six planned-but-empty contexts, since there is no business activity yet to derive an event from.

---

## 14. Responsibility Matrix

| Business Capability | Module (code) | Owner (role, Inference) | Primary Aggregate | External Dependencies |
|---|---|---|---|---|
| SKU Management | `app/api/v1/masters/skus/`, `lib/queries/skus.ts` | General editor role(s); no SKU-specific role name found | SKU | None |
| Vendor Management | `app/api/v1/masters/vendors/` | General editor role(s); no vendor-specific role name found | Vendor | AWS S3 (compliance docs) |
| Manufacturer Management | `app/api/v1/masters/manufacturers/` | General editor role(s); no manufacturer-specific role name found | Manufacturer | AWS S3 (compliance docs) |
| Raw Material Management | `app/api/v1/masters/raw-materials/`, `app/api/v1/masters/material-master/` | `cost_creator` (rates), general editor (base record) — Inference from role naming | Raw Material (×3 sub-aggregates) | None |
| Packing Material Management | `app/api/v1/masters/packing-materials/`, `app/api/v1/masters/material-master/` | Same as Raw Material | Packing Material (×3 sub-aggregates) | None |
| Product Formulation (BOM) | `app/api/v1/masters/recipe-master/` | `bom_creator` (Fact, `scripts/seed-permissions.ts`) | BOM | None |
| Procurement (Purchase Orders) | `app/api/v1/purchase-orders/` | `production_operations`, `production_head` (Fact — editor on `/po-tracking`) | Purchase Order | Gmail SMTP, AWS S3 |
| Approval & Governance | `app/api/v1/approvals/`, `lib/approvals/module-handlers.ts` | `admin`/`manager` (Fact, but not seeded anywhere found — see §17) | Approval | None |
| Identity & Access | `lib/auth.ts`, `lib/permissions.ts`, `app/api/v1/admin/` | `developer` (Fact — only role permitted to manage permissions) | User / Permission | Google OAuth |
| Inventory / Manufacturing / Finance / Sales-CRM / HR-Payroll / Reporting | Page shells only | Unknown | None yet | None yet |
| Uniware/Unicommerce sync | `scripts/testing_uniware_connection.ts` only | Unknown | None yet | Unknown external system (Assumption) |

---

## 15. Context Interaction Map

| Interaction | Data ownership | Read dependency | Write dependency | Shared concepts | Future async opportunity |
|---|---|---|---|---|---|
| Product Formulation → Master Data Governance | Master Data owns SKU + RM + PM | BOM reads SKU identity/status and RM/PM identity to populate lines | BOM never writes to SKU/RM/PM directly | Entity identity (`sku_id`, `mtrl_id`/`mtrl_type`) | If RM/PM status changes (e.g. discontinued), BOM currently only *surfaces* it via a joined `mtrl_master_status` flag (Fact) — an event-driven "warn me if my formulation now references a discontinued material" notification is a natural evolution, not yet built |
| Procurement → Master Data Governance | Master Data owns SKU + Manufacturer | PO reads SKU status (must be active) and Manufacturer details (for the email/PDF) | PO never writes to SKU/Manufacturer | Entity identity + status | None obviously needed beyond what exists — this is a simple read dependency today |
| Master Data / Product Formulation / Procurement → Approval & Governance | Approval & Governance owns the generic diff/decision record | All three write a proposed diff and read back approval status | Approval & Governance never writes into the other contexts' tables directly — each module's own handler does, via the Strategy-pattern registry (Fact, per the companion technical review) | The field-diff shape (`old_value`/`new_value`) is the one truly shared vocabulary | Already effectively decoupled via the handler registry — the natural next step (already scoped in the companion review) is decoupling it further via real domain events instead of a synchronous handler call |
| Every context → Identity & Access | Identity & Access owns User/Role/Permission | Every context reads `userId`/`roles` per request | No other context writes identity data | `userId`, `roles`, access level | None identified — this is appropriately a pure read dependency |
| Procurement → Gmail/S3 (external) | N/A (external system) | N/A | PO writes a PDF to S3 and triggers an email send | The PO document itself | This is already the one place a message-queue/event-driven pattern would pay off first (per the companion technical review's own analysis) — not repeated here |

---

## 16. Architectural Decision Opportunities (not ADRs — candidates for one)

1. **Whether RM_MAT, PM_MAT, VENDOR, and MFG should get real history tables**, matching the pattern already used by SKU, RM_RATE, PM_RATE, RM_VRM, PM_VRM, and BOM (BR-006). This is a genuine architectural fork — add tables (consistent, more migration work) vs. formally adopt the approval-item diff as the permanent record (less work, less consistent).
2. **Whether approval self-approval should be blocked** (BR-021) — a compliance-relevant decision the business, not the engineering team, should make: is role separation alone sufficient, or is a same-person guard required?
3. **Whether `admin`/`manager` should be formally added to the seeded role taxonomy** (§17) rather than existing only as a role check with no documented provisioning path.
4. **Whether the PO status machine needs an explicit `punched → receiving` step and a `cancelled` transition** to be modeled inside this codebase, or whether those genuinely live in a system/process outside what was reviewed (currently unresolved — see §10).
5. **Whether brand-scoped permissions are needed** now that at least two brands (mcaffeine, hyphen) exist in the data but not in the access-control model (§17).
6. **What the Uniware/Unicommerce integration is actually meant to do** — this needs a business conversation before any architecture decision about it is even possible.
7. Everything already named in the companion technical review (Outbox pattern, event backbone choice, gateway rollout) remains valid and is not re-litigated here — this list is additive, focused on decisions the business/domain lens surfaced that the technical review's lens didn't.

---

## 17. Business Risks

| Risk | Evidence | Business impact |
|---|---|---|
| **No history table for Vendor, Manufacturer, RM base record, PM base record** | BR-006 | A vendor's or manufacturer's prior bank account, GST number, or registered name — once changed and approved — is not recoverable from a dedicated audit table. In a banking-fraud or compliance-dispute scenario, the business would have to reconstruct history from the generic approval-item diff rows rather than a purpose-built ledger. |
| **No self-approval guard** | BR-021, corroborated by the team's own prior notes (`architecture-discussion-framework.md:609,650`) | Anyone holding both an editing role and `admin`/`manager` can approve their own submitted change with no system-level objection — a real internal-controls gap in a regulated-adjacent business (cosmetics/GST/banking data all present). |
| **`admin`/`manager` roles are checked in code but not present in the seeded role taxonomy or schema documentation** | §3 finding #2 | Suggests approver assignment happens outside any documented/reviewable process (manual DB inserts?) — an access-governance gap: nobody reviewing the seed scripts or permission docs would know who is actually able to approve anything. |
| **No notification when an approval is submitted or decided** | §12 | Approvers must proactively check the queue; submitters must proactively check their record's status. In a busy queue, legitimate changes (including time-sensitive procurement) could sit unnoticed. |
| **Multi-brand data exists (mcaffeine, hyphen) with no brand-scoped access control** | §3 finding #7 | Anyone with, say, `production_head` access can act across both brands — if the business ever needs a brand-siloed team (a Hyphen-only buyer who shouldn't see mcaffeine POs, for instance), that's unsupported today without a new permission dimension. |
| **PM's bundled-rate-on-create path can write a rate as `active` immediately, while RM's equivalent always forces `in_review`** | §5 (Masters research) finding on `pm-handler.ts:61,72` vs `rm-handler.ts:27,39` | An inconsistency between two conceptually parallel materials — a PM rate could go live without the same review RM rates always get, depending on which action/screen was used to enter it. |
| **PO lifecycle has states (`punched`, `cancelled`) with no corresponding transition code found in the reviewed routes** | §9 finding #6 | Either those transitions genuinely live outside this codebase (fine, but undocumented as such) or they're simply missing — worth a direct business/engineering confirmation rather than leaving it ambiguous. |
| **The Uniware/Unicommerce integration has no business scope documented anywhere** | Companion technical review, Phase 0 | Whatever this integration is meant to do (order sync? inventory sync?) is currently unknowable from the code — a risk if it's quietly expected to matter to a real workflow soon. |
| **Same duplicate-detection concept (RM vs PM) uses different case-sensitivity** (BR-002 vs BR-003) | §7 | Possibly intentional, possibly an oversight — either way, it's an inconsistency in otherwise-parallel business rules that should be confirmed rather than assumed correct. |

---

## 18. Opportunities

1. **Close the history-table gap** (Vendor/Manufacturer/RM_MAT/PM_MAT) — the highest-value domain-modeling improvement identified, since it directly strengthens the audit story for the exact data (bank details, GST, core identity) most likely to matter in a dispute or compliance review.
2. **Add submitter/approver notifications** driven off the approval-decision fact already established in §9.3 — a natural, low-risk first "event consumer" once the companion technical review's event bus exists, and it closes a real, named gap (§17) rather than being speculative.
3. **Model `approval.rejected` and `bom.deactivated` (and the others in §13) as real domain events**, not because events are inherently better, but because each one traces to a genuine "something the business now knows" moment identified in this document — the companion technical review's event catalog can be validated against this domain analysis to confirm nothing essential is missing and nothing speculative was added.
4. **Supplier/manufacturer performance reporting** — short-close rate, tolerance-shortfall rate, and rejection rate per vendor/manufacturer are all decisions already happening in the system today (§8) with no reporting surface yet; this is a "connect existing facts to a new view" opportunity, not new business logic.
5. **A formal decision on brand-scoped access** before the business needs it under time pressure (§17) — this is cheap to decide now and expensive to retrofit once more brand-specific workflows exist.
6. **Clarify and, if needed, close the PM/RM rate-approval asymmetry** (§17) — a small, well-scoped fix once confirmed as unintentional.
7. **Use this document's Event Discovery Matrix (§13) as a check against the companion technical review's event catalog** — where they agree, confidence is high; where this document names a business fact the technical catalog didn't capture (or vice versa), that's exactly the kind of discrepancy worth resolving before building any real event bus.
