> **Related docs:** [Architecture](./architecture.md) · [Architecture Evolution](./architecture-evolution.md) · [Event-Driven Options](./event-driven-options.md) · [Event Catalog](./event-catalog.md) · [Event Instrumentation Blueprint](./event-instrumentation-blueprint.md)

# Interaction Logging Map — What Actually Logs Today

> **Status:** Audit / reference (documents current state only, proposes no changes) · **Owner:** Ajay
> **Last updated:** 2026-07-03

---

## 1. Purpose

For every masters page, the PO page, and the approvals page: at each click (page load, export download, open create/CSV dialog, submit, approve/reject), what actually fires today via `lib/logger.ts` (Winston) or `lib/events.ts` (the S3 raw/processed/failed sink)? This doc answers that question as a debugging/audit reference, grounded in the real call sites in the codebase — it is **not** the same thing as [`event-catalog.md`](./event-catalog.md), which designs a *future* typed domain-event bus. This doc describes only what exists right now, including where nothing exists.

The coverage turned out uneven: some domains (SKU, Vendor, Manufacturer, RM, PM) are richly instrumented on the backend; others (BOM, every export route, every frontend create/edit dialog) have none. Gaps are marked explicitly rather than omitted, so this doc can double as a punch list if you later decide to close them.

---

## 2. Legend

| Box | Meaning |
|---|---|
| **Logger** (solid) | A `logger.*` call from `lib/logger.ts` (Winston → pretty console + `logs/app-*.log`/`logs/error-*.log`, JSON with `requestId`/`module`/extras) |
| **Event** (solid) | A call to `lib/events.ts`'s `recordRawEvent` / `recordProcessedEvent` / `recordFailedEvent` (→ S3 `raw-events/`, `processed-events/`, `failed-events/`) |
| **console** (solid, labeled) | A bare `console.log`/`console.error`, not routed through Winston |
| *(dashed)* **No instrumentation** | Confirmed by code search — nothing fires at this touchpoint today |

---

## 3. Page-by-page

### 3.1 SKU (`app/masters/skus`)

Backed by `app/api/v1/masters/skus/route.ts`, on `withGateway` → `createRequestContext()` gives one `requestId`/`userId` for the whole request.

```mermaid
flowchart TD
    P["/api/v1/masters/skus"] --> Create["Create SKU"]
    P --> Bulk["Bulk CSV"]
    P --> S3Bulk["Bulk from S3"]
    P --> Update["Update (approval)"]

    Create --> L1["Logger: create started (L25)"]
    L1 --> E1["Event: raw SKU (L26)"]
    E1 --> DB1[("INSERT master_skus")]
    DB1 --> L2["Logger: created (L38)"]
    L2 --> E2["Event: processed SKU (L37)"]
    DB1 -.dup code.-> LW["Logger.warn: duplicate SKU code (L43)"]

    Bulk --> L3["Logger: bulk started (L57)"]
    L3 --> E3["Event: raw SKU_BULK (L58)"]
    E3 --> DB2[("batch INSERT")]
    DB2 --> L4["Logger: committed (L88)"]
    L4 --> E4["Event: processed SKU_BULK (L87)"]

    S3Bulk --> LW2["Logger.warn: parse failure (L187)"]
    S3Bulk --> L5["Logger: import started (L196)"]
    L5 --> E5["Event: raw SKU (S3 bulk, L197)"]
    E5 --> DB3[("batch INSERT")]
    DB3 --> L6["Logger: committed (L229)"]

    Update --> LBlk["Logger.warn: blocked, pending approval (L111)"]
    Update --> L7["Logger: update started (L119)"]
    L7 --> Diff{"diff vs current"}
    Diff -->|no changes| LN["Logger: no changes (L143)"]
    Diff -->|changed| E6["Event: raw SKU_UPDATE (L120)"]
    E6 --> AR[("INSERT approvals + approval_items")]
    AR --> L8["Logger: submitted for approval (L163)"]
    L8 --> E7["Event: processed SKU_UPDATE (L162)"]
```

All four sub-flows have a matching `recordFailedEvent`/`logger.error` on their catch branch (L46, L93, L169, L234) — omitted above for brevity.

### 3.2 Vendor (`app/masters/vendors`)

Same shape as SKU, plus a doc-only fast path with **no approval gate**.

```mermaid
flowchart TD
    P["/api/v1/masters/vendors"] --> Create["Create"]
    P --> Bulk["Bulk CSV / S3"]
    P --> Update["Update (approval)"]
    P --> Docs["Update docs (no approval)"]

    Create --> L1["Logger: started (L50)"] --> E1["Event: raw VENDOR (L51)"] --> DB1[("INSERT master_vendors + details_vendor")] --> L2["Logger: created (L74)"] --> E2["Event: processed (L107)"]

    Bulk --> L3["Logger: bulk started (L125/L285)"] --> E3["Event: raw VENDOR_BULK (L126/L295)\nsame tag for CSV & S3, disambiguated by source field"] --> DB2[("batch INSERT")] --> L4["Logger: committed (L175/L342)"]

    Update --> LBlk["Logger.warn: blocked, pending approval (L203)"] --> L5["Logger: started (L211)"] --> Diff{diff} --> AR[("INSERT approvals + approval_items")] --> L6["Logger: submitted (L260)"] --> E4["Event: processed VENDOR_UPDATE (L261)"]

    Docs --> LBlk2["Logger.warn: blocked, pending approval (L372)"] --> L7["Logger: started (L381)"] --> DB3[("UPDATE details_vendor doc keys")] --> L8["Logger: submitted for approval (L425)"] --> E5["Event: processed VENDOR_DOCS (L426)"]
```

### 3.3 Manufacturer (`app/masters/manufacturers`)

This is the page your original diagram sketched. Reproduced here against the real call sites — with the frontend touchpoints (dialog open, CSV select, preview) marked as **no instrumentation**, since none exists in `AddMfgDialog.tsx`/the CSV-import dialog today. The blue boxes at those points in your sketch describe an aspiration, not current code.

```mermaid
flowchart TD
    Page["Manufacturers page"] --> DL["Download export"]
    Page --> UP["Upload CSV"]
    Page --> New["Create New Manufacturer"]

    DL -.no instrumentation.-> DLnote["export/route.ts:75 has only\nconsole.error on failure"]

    UP -.no instrumentation.-> Dialog["Dialog opens"]
    Dialog -.no instrumentation.-> Select["CSV selected, preview shown"]
    Select --> Submit["Submit click -> POST /api/v1/masters/manufacturers"]
    Dialog -.no instrumentation.-> Cancel["Dialog closes / cancelled"]

    Submit --> L1["Logger: bulk started (L133)"] --> E1["Event: raw MFG_BULK (L134)"] --> DB1[("batch INSERT master_mfgs + details_mfg")] --> L2["Logger: committed (L192)"] --> E2["Event: processed MFG_S3BULK (L437)\n** tag mismatch: raw=MFG_BULK, processed/failed=MFG_S3BULK **"]

    New --> L3["Logger: create started (L49)"] --> E3["Event: raw MFG (L50)"] --> DB2[("INSERT master_mfgs + details_mfg")] --> L4["Logger: created (L73)"] --> E4["Event: processed MFG (L115)"]

    DB1 --> Status["status: in_review"]
    DB2 --> Status2["status: active (no approval on create)"]
    Status --> Approval["Approval flow (see 3.9)"]
    Approval --> Active["status: active"]
```

The doc-update path (`update_docs`, L218/L258/L265, tags `MFG_DOCS`) mirrors Vendor's docs fast path — no approval gate, submitted-for-approval logger line only for field updates (`update`, L281–L351, tag `MFG_UPDATE`).

### 3.4 Raw Material (`app/masters/raw-materials`)

Two-route split worth calling out: the outer router logs only one generic line per request; all the real instrumentation lives in the delegate handler.

```mermaid
flowchart TD
    P["/api/v1/masters/raw-materials\n(route.ts)"] --> L0["Logger: request received (L18)\nhand-rolled ctx, no completion/duration log"]
    L0 --> Handler["rm-handler.ts (delegate)"]

    Handler --> Create["create"] --> L1["Logger: started (L47)"] --> E1["Event: raw RM_MAT (L48)"] --> DB1[("INSERT master_rm")] --> L2["Logger: success (L86)"] --> E2["Event: processed RM_MAT (L85)"]
    Handler --> Full["create-full"] --> L3["Logger: started (L145)"] --> E3["Event: raw RM_FULL (L146)"] --> DB2[("INSERT master_rm + cost_master_rm_mfg + cost_master_rm_ven")] --> L4["Logger: success (L200)"]
    Handler --> Rates["add-rates"] --> L5["Logger: started (L221)"] --> E4["Event: raw RM_RATES (L222)"] --> DB3[("INSERT rate row")] --> L6["Logger: success (L272)"]
    Handler --> Bulk["bulk / bulk-from-S3"] --> L7["Logger: started (L294/L338)"] --> E5["Event: raw RM_BULK / RM_S3BULK (L295/L339)"] --> DB4[("batch INSERT")] --> L8["Logger: completed (L321/L380)"]
```

**Same conceptual action, different tags**: creating a raw material via the separate `material-master/route.ts` combined view logs `RM_CREATE`/`RM_UPDATE` (L30, L198) instead of `RM_MAT`/`RM_FULL` above — two tag families for one action depending which route the UI went through.

### 3.5 Packing Material (`app/masters/packing-materials`)

Identical structure to Raw Material, via `pm-handler.ts`: `create` (L30/L39, tag `PM`), `create-full` (L166, tag `PM_FULL`), `add-rates` (L258, tag `PM_RATES`), `bulk`/`bulk_from_s3` (L345/L401, tags `PM_BULK`/`PM_S3BULK`). Same two-tag-family issue against `material-master/route.ts`'s `PM_CREATE`/`PM_UPDATE` (L89, L270).

### 3.6 Material Master — combined RM/PM view (`app/masters/material-master`)

```mermaid
flowchart TD
    P["/api/v1/masters/material-master"] --> RMc["RM create"] --> L1["Logger (L29)"] --> E1["Event: raw RM_CREATE (L30)"] --> L2["Logger: created (L68)"]
    P --> PMc["PM create"] --> L3["Logger (L89)"] --> E2["Event: raw PM_CREATE (L90)"] --> L4["Logger: created (L137)"]
    P --> RMu["RM update"] --> LBlk["Logger.warn: blocked / unauthorized draft edit (L189)"] --> L5["Logger: submitted (L212)"] --> E3["Event: processed RM_UPDATE (L225)"]
    P --> PMu["PM update"] --> L6["Logger: submitted (L283)"] --> E4["Event: processed PM_UPDATE (L303)"]
```

No dedicated `export/route.ts` exists for this combined view (each of RM and PM has its own export route instead).

### 3.7 BOM (`app/masters/recipe-master`)

```mermaid
flowchart TD
    Submit["Submit BOM (new-version / update-existing)"] -.no instrumentation.-> Approval["Approval flow (see 3.9)"]
    Approval -.no instrumentation.-> Activate["BOM activated"]
    Activate -.no instrumentation.-> Deactivate["Sibling BOMs deactivated"]
    Deactivate -.no instrumentation.-> Done["status: active"]
```

**Total instrumentation gap.** `app/api/v1/masters/recipe-master/route.ts`, `[id]/route.ts`, and `export/route.ts` contain zero `logger.*` calls and zero `lib/events.ts` calls — not thin coverage, none at all. Every other masters domain has at least the create/update path instrumented; BOM has nothing, including the fan-out deactivation of sibling BOMs (`deactivateOtherActiveBomsForSku`), which is exactly the kind of side-effecting, multi-row write you'd most want a record of.

### 3.8 PO Procurement (`app/po-tracking/po-procurement`)

Largest domain — split into three diagrams by sub-flow.

**Create (impromptu → approval, or normal → direct):**

```mermaid
flowchart TD
    Impromptu["Impromptu PO dialog submit"] --> DB1[("INSERT purchase_orders, status=draft")] --> AR[("INSERT approvals")] --> Approval["Approval flow (see 3.9)"] --> Email["Auto-send email (approvals/[id]/route.ts:116-131)"]
    Email --> L1["Logger: email sent (L123)"] --> DB2[("email_sent_at stamped")]
    Email -.no manufacturer email.-> LW["Logger.warn: skipped (L125)"]
    Email -.send failure.-> LE["Logger.error: send failed (L128)\napproval already committed either way"]

    Normal["Normal PO dialog submit"] --> L2["Logger.error on failure only (L198)\nno success-path logger line"] --> DB3[("INSERT purchase_orders, status=raised")]

    BulkCsv["Bulk CSV upload"] --> L3["Logger.error on failure only (L138)"] --> E1["Event: raw/processed/failed PO_BULK\n(module-handlers.ts, inside applyAndArchive)"] --> DB4[("batch INSERT, status=raised")]
```

**Split:**

```mermaid
flowchart TD
    SplitDialog["SplitPODialog submit"] --> C1["console: '[split dialog] success' (SplitPODialog.tsx:131)\n** only client-side console line found in the whole scope **"]
    SplitDialog --> API["POST /api/v1/purchase-orders/[id]/split"]
    API --> L1["Logger: split started (L52)"] --> E1["Event: raw PO_SPLIT (L53)"] --> DB1[("INSERT child POs, credit parent received_qty")]
    DB1 --> L2["Logger: within tolerance -> received (L113)\nor partial -> unchanged (L116)"]
    L2 --> L3["Logger: split succeeded (L121)"] --> E2["Event: processed PO_SPLIT (L120)"]
```

**Close / short-close:**

```mermaid
flowchart TD
    Close["Close / short-close action"] --> API["POST /api/v1/purchase-orders/[id]/close"]
    API -.PO not found.-> LW["Logger.warn (L36)"]
    API --> L1["Logger: short_closed (L48)"] --> E1["Event: raw+processed purchase_order_short_closed (L29, L49)\n** snake_case tag, unlike every other UPPER_SNAKE tag **\n** no recordFailedEvent in this file at all **"]
```

`preview-pdf/route.ts` and manual `send-email/route.ts` round out the domain: preview-pdf has **no instrumentation at all**; send-email has Logger lines (L20 started, L39 sent, L31 skipped-no-email, L43 failed) but **no event calls**.

### 3.9 Approvals (`app/approvals`)

```mermaid
flowchart TD
    List["Approvals list load"] --> LW["Logger.warn: unauthenticated (route.ts:13)\n** generates its own requestId, different from the one below **"]
    List --> L1["Logger: fetch started (route.ts:31, second/different requestId)"] --> L2["Logger: success, count (L57)"]

    Approve["Approve click"] --> L3["Logger: request received (L33)"]
    L3 --> RBAC{admin/manager?}
    RBAC -->|no| LW2["Logger.warn: forbidden (L37)"]
    RBAC -->|yes| Status{status == pending?}
    Status -->|no| LW3["Logger.warn: already actioned (L68)"]
    Status -->|yes| E1["Event: raw APPROVAL (L84), before txn"]
    E1 --> Txn[("Transaction: module handler applyAndArchive + markApproved")]
    Txn --> L4["Logger: applied and archived (L101)"] --> E2["Event: processed APPROVAL (L109)"]
    L4 --> ModuleEvent["Re-enters the target module's own\nsection above at the DB-commit step\n(e.g. SKU 3.1, Vendor 3.2, PO 3.8)"]

    Reject["Reject click"] --> LW4["Logger.warn: reject without remarks (L56)\nremarks mandatory"]
    Reject --> Txn2[("Transaction: setStatus(draft) + markRejected")] --> L5["Logger: reverted to draft (L105)"]

    Txn -.failure.-> LE["Logger.error: transaction failed (L137)"] --> E3["Event: failed APPROVAL (L138)"]
```

---

## 4. Cross-cutting findings

| Finding | Where |
|---|---|
| Two request-context idioms: `withGateway`+`createRequestContext()` (duration-tracked, one requestId) vs hand-rolled inline `{ requestId: crypto.randomUUID(), userId, route }` (no duration tracking) | Gateway: SKU, Vendor, Manufacturer, Material-Master, PO routes. Hand-rolled: Raw Material, Packing Material, all three `approvals/*` routes |
| `approvals/route.ts` generates two different `requestId`s within one request | `app/api/v1/approvals/route.ts:13` and `:21` |
| `MFG_BULK` (raw) vs `MFG_S3BULK` (processed/failed) tag mismatch for the same S3-bulk-import flow | `app/api/v1/masters/manufacturers/route.ts:377` vs `:437/442` |
| Same conceptual action ("create a raw/packing material") logged under two different tag families depending on which route handled it | `material-master/route.ts` (`RM_CREATE`/`PM_CREATE`) vs `raw-materials/rm-handler.ts` / `packing-materials/pm-handler.ts` (`RM_MAT`/`RM_FULL`/`PM`/`PM_FULL`) |
| `purchase_order_short_closed` uses snake_case, unlike every other UPPER_SNAKE module tag; no `recordFailedEvent` call exists in that route at all | `app/api/v1/purchase-orders/[id]/close/route.ts` |
| Zero backend instrumentation (no `logger.*`, no event calls) | BOM master — all of `app/api/v1/masters/recipe-master/route.ts`, `[id]/route.ts`, `export/route.ts`; every masters `export/route.ts` (one bare `console.error` only); PO `preview-pdf/route.ts` |
| Zero frontend dialog instrumentation except one line | `SplitPODialog.tsx:131` is the only client-side console call in any create/edit/CSV-import dialog across all masters and PO pages — dialog-open, file-select, and preview-generated events shown in the original Manufacturers sketch don't exist in code today |

---

## 5. Non-goals

- Does not propose fixes for the gaps or inconsistencies above — that's a follow-up decision once you decide which ones are worth closing.
- Does not touch the future domain-event bus design — see [`event-catalog.md`](./event-catalog.md) for that.
- Does not cover the RM/PM Procurement page (`app/po-tracking/rm-pm-procurement`) — no dedicated API routes or instrumentation exist there to document. PO Inwarding (`app/po-tracking/po-inwarding`, formerly the Dispatch Calendar stub) reuses the PO routes covered in §3.8.
