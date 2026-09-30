# ERP Process Documentation

## Context

The ERP has 92 API routes, 25 approval modules and roughly 40 documents in
`erp_project/docs/`, and **not one of them describes a business process from end
to end.** The closest is `docs/business-architecture.md` §9, which is dated
2026-07-04 — it predates invoice inwarding, gift kits, Uniware, gatepass and the
whole MFG costing module, and its seven "workflows" are self-contained units of
work that nothing joins together. The stage from three-way match to payment
exists in the documentation as two table rows.

So the chain **master data → recipe → costing → raise a PO → mail it → receive
goods → book the invoice → match it → pay it → mirror it to Unicommerce** is
spread across four documents of different vintages, two of which are plans.

The audience is everyone: a new developer, the ops team who run the process, an
auditor asking which controls exist, and non-technical readers who need to
understand what actually happens. That mixed audience is the governing
constraint — every section leads in plain language and puts the technical detail
in a clearly-marked strip underneath, so a non-technical reader can follow the
whole document without reading a single file path.

**The API reference is already done** and is not to be repeated: `api-docs/`
(10 files, 4,272 lines, generated 2026-09-22 against `9158671`) covers all 92
routes with request shapes, error codes and per-route warnings. These process
docs name the route a step calls and link to `api-docs/` for its contract.

---

## Deliverable

A new folder **`C:\Users\AJAY SINGH\Desktop\ERP Project\process-docs\`** —
a sibling of `api-docs/`, outside the repo, exactly as the API docs are filed.

One overall file plus one detailed file per module, eleven in total:

| File | Covers |
|---|---|
| `index.md` | The whole business in one read: the end-to-end chain, a Mermaid overview, who does what, where each module starts and stops, and the links out |
| `01-access-and-roles.md` | Signing in, page permissions, the role taxonomy, entity scope, brand view, the activity trail |
| `02-master-data.md` | SKU · Vendor · Manufacturer · Warehouse · RM/PM material master and both cost masters |
| `03-approvals.md` | The maker–checker engine every master edit routes through, and the 25 registered modules |
| `04-recipe.md` | Recipe Master, versioning, variant families, gift kits |
| `05-costing.md` | MFG Cost Manager: production lines, misc costs, Agreed Final Costing, the exports |
| `06-purchase-orders.md` | Raise → approve → mail → split → receive → close/cancel, and the draft rule |
| `07-goods-receipt-and-invoicing.md` | The inwarding desk: invoice PDF → parse → review → inward POs → receipts → Uniware → warehouse mail |
| `08-three-way-match-and-payment.md` | PO · INV · GRN legs, verification sign-off, the payment lifecycle |
| `09-unicommerce.md` | The facility map, the three sweeps, document sync, the explorer, the browser session |
| `10-gatepass.md` | Per-facility despatch summary and gatepass creation |

Stub modules (Finance, Sales CRM, HR & Payroll, Inventory, Reports, the two
empty MFG tabs) are **omitted entirely**, as decided.

---

## The shape of every module file

Same skeleton in all ten, so a reader learns it once:

```
# <Module>

## What this module is for          ← plain language, no jargon, 3-5 sentences
## Who does what                    ← role table: who initiates, who approves, who sees
## The process                      ← Mermaid flow, then numbered steps
   Each step:
     What happens        (plain language)
     On screen           (page slug + the control, e.g. "/po-tracking/po-procurement → Raise PO")
     Behind the scenes   (route + tables + helper, boxed; links to ../api-docs/<file>.md)
## The rules that govern it         ← business controls + data-sanity rules, one per row
## What it writes                   ← tables touched, and what is audited where
## Known gaps                       ← honest, per-module
## Where to look in the code        ← 5-10 paths, no more
```

**"On screen" is written at screen + action level** — names the page and the
control ("the Actions menu → Split"), never a click-by-click field walkthrough
that dies with the next UI change.

---

## Actors

Role-based, using the declared taxonomy in `lib/roles.ts`: five domains
(Raw Material · Packing Material · Production · Cost · Warehouse) × three
designations (Head · Lead · Executive), plus the two system roles `developer`
and `admin`. **Heads are the approvers** — `DESIGNATION_ORDER`'s `approver: true`
is descriptive, and the real gate is the `page_permissions` row seeding Heads as
`editor` on `/approvals`.

**Finance is a planned sixth domain.** It does not exist in `lib/roles.ts`
today. The docs will name `finance_head` / `finance_lead` / `finance_executive`
as the actors on the verification and payment steps in `08-`, each marked
**(planned role — not yet in `lib/roles.ts`)**, so the document is correct now
and becomes correct without an edit once the domain is added. `01-` will carry a
short note on what adding it takes: one entry in `DOMAINS`, then re-run
`scripts/seed-permissions.ts`.

State plainly, once, in `01-`: **nothing in the app branches on a role name.**
A role's only power is its `page_permissions` rows. An auditor will ask.

---

## The checks sections

Three of the four kinds, as decided — business controls, data-sanity rules and
known gaps. **No test-file listing**; tests are named only where one *is* the
control (`tests/db/mfg-facility-map.test.ts` is the only thing left guarding the
dropped `uq_wh_code` index, and that fact belongs in `09-`).

Each rule gets one row: **what it prevents · where it is enforced · what breaks
without it**. Written so the middle column can be verified against the code and
the other two read without it.

The material is already gathered. The load-bearing ones:

- **Business controls** — the approval gate and the `in_review` lock; mandatory
  `remarks` on every master edit; `409 pending_approval` on a double submit;
  `assertNotSelfLockout` / `assertNotSelfScope` (no UI recovery path exists for
  either); the `activity_log` row on every non-GET; `confirm: true` required
  before an irreversible Unicommerce write.
- **Data sanity** — the 99.5–100.5% RM band; one `rm_version` per variant
  family, enforced at all four doors; the gift-kit shape rules; `poTolerance`
  and the auto-close; one inward PO per SKU; the lines-vs-header reconciliation
  (four independent layers, and the gate whose absence cost ~42,600 units /
  ₹29 lakh); the 2% three-way tolerance; the vendor-code conflict check;
  `STRICT_TRANS_TABLES` and the two silent production data losses it now stops.

### Known gaps — the seed list

Carried per module, and collected in `index.md`. These are confirmed, not
guesses:

1. **Approval is not entity-scoped.** Anyone with `/approvals` editor can
   approve any pending item, including another manufacturer's rate change.
   Documented as *deliberately deferred — scoping planned*, per your answer.
2. **Rate limiting is in shadow mode** unless `RATE_LIMIT_MODE=enforce`.
   Nothing is actually limited today.
3. **`bom_misc` has no history.** Misc costs are edited in place, so no past
   date can be priced with them — the invoice drilldown reads current JW,
   shrink, shipper, utility and margin even when pricing an older invoice.
4. **Recipe lines and `filling` are not versioned for costing.** A recipe
   reformulated since an invoice prices that invoice with today's materials.
5. **`uq_wh_code` was dropped.** Two manufacturers claiming one Uniware vendor
   code at one facility is now blocked only by app code plus one DB test.
6. **`lib/po-split.ts` has drifted** from the production split route (it still
   shrinks the parent's qty, which the route deliberately stopped doing).
7. **Gatepass writes to Unicommerce are irreversible** and leave no local
   record — the ERP stores nothing about a gatepass it created.
8. **`/gatepass/summary` has no entity scope** — page permission is the only
   gate, because the route deliberately never touches the DB.
9. **The PO leg of the three-way match is presence-only.** No per-invoice share
   of a PO is stored, so a header-level billed-vs-ordered comparison is
   meaningless when one PO is settled by twenty invoices.
10. **A PM quoted by several vendors costs at an arbitrary one** —
    `cost_master_pm_mfg` has no `approved_vendor_id` column, unlike its RM twin.
11. **Some routes still return the legacy `{ error }` shape** with no `code` or
    `requestId` — including `POST /api/v1/approvals/[id]`, the app's most
    important mutation.
12. **`/api/v2/files/view` has a misspelled `Content-Disposition`**, so
    `download=1` does nothing.
13. **The repo's own `README.md` and several `docs/` files are stale** — they
    say MariaDB (it is MySQL 8.0), describe a `middleware.ts` that does not
    exist, and contradict `package.json` about the `db:*` scripts. `index.md`
    will say which documents to trust and which not to.

---

## Diagrams

Mermaid, as decided — the repo's own docs already use it, GitHub and VS Code
render it, and it degrades to readable text elsewhere.

One per module file (the module's own flow), plus two in `index.md`: the
end-to-end chain, and the approval gate as a state diagram (`draft → in_review →
active`, with `rejected` looping back to the submitter). Keep each under ~15
nodes; a diagram nobody can read on a laptop is worse than the numbered list
beside it.

---

## Order of work

1. `index.md` skeleton and the shared section template — get the shape agreed
   before ten files are written to it.
2. `01-access-and-roles.md` and `03-approvals.md` — every other file leans on
   these two, so they set the vocabulary.
3. `02-` and `04-` and `05-` — the master-data spine.
4. `06-` → `07-` → `08-` — the transactional chain, written in order because
   each picks up where the last stops.
5. `09-` and `10-` — the integrations.
6. Back-fill `index.md`: the gap register, the cross-links, the trust list.

---

## Verification

It is documentation, so "does it run" is the wrong test. What it must survive:

1. **Every page slug named exists** in `lib/pages.ts` — grep each one.
2. **Every route named exists** in the census in `api-docs/index.md`, spelled
   identically (`/api/v1/...`), and its linked `api-docs/` file really covers it.
3. **Every table named exists** in `lib/queries/*.ts` — never in
   `prisma/schema.prisma`, which still carries pre-rename model names. The four
   deliberately-`bom_*` columns (`master_recipe.bom_code`,
   `master_skus.active_bom_id`, `details_sku.curr_bom_id`,
   `details_cost_ext_fixed.bom_detail_id`) and the never-renamed `bom_misc` must
   be spelled as they are, not "corrected".
4. **Every rule in a checks table is traced to a file** that currently enforces
   it, by reading that file — not by trusting this plan.
5. **Every Mermaid block renders.** Paste each into a viewer; one syntax error
   silently blanks the diagram.
6. **Walk one flow live per transactional module** — raise a draft PO, open the
   inwarding desk, open an invoice drilldown — and confirm the screens and
   controls are named as they actually appear.
7. **`npm test` and `npx tsc --noEmit --incremental false` still pass** — this
   task changes no code, so a failure means something else moved.

Re-run 1–3 as a batch before calling it done; they are the checks that catch
the errors a reader would actually trip over.

---

## Explicitly not in scope

- No code changes. If the work turns up a real defect (it will — see the gap
  list), it gets written into Known Gaps, not fixed here.
- No edits to `erp_project/docs/`. The stale files are named in `index.md` and
  left alone.
- No API contracts, request/response shapes or error-code tables — that is
  `api-docs/`, and duplicating it creates a second answer that will drift.
