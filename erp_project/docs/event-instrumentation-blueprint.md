> **Related docs:** [Architecture](./architecture.md) · [Architecture Evolution](./architecture-evolution.md) · [Event-Driven Options](./event-driven-options.md) · [Event Catalog](./event-catalog.md) · [Interaction Logging Map](./interaction-logging-map.md)

# Event Instrumentation Blueprint — Target State, Per Page

> **Status:** Design / target-state · **Purpose:** exact diagram, per page, of what should log/console/record at every touchpoint to fully support the event catalog · **Owner:** Ajay
> **Last updated:** 2026-07-05 — §8 (BOM) backend mutation-path logging/eventing has since been implemented; see the update note at the top of that section.

---

## 1. Purpose — how this differs from the other two instrumentation docs

- [`interaction-logging-map.md`](./interaction-logging-map.md) = **what fires today** (audit of current code, gaps marked dashed).
- [`event-catalog.md`](./event-catalog.md) = **what domain events should exist** (names, payloads, when they fire) once a real event bus is built.
- **This doc** = the missing middle layer: for every page, the exact sequence of `console`/`logger`/event calls that should fire at every UI touchpoint *today*, using infrastructure that already exists (`lib/logger.ts`, `lib/events.ts`) plus the new frontend calls needed to close the gaps found in the audit — laid out so it can be implemented mechanically, page by page, ahead of the real event bus.

Every diagram below is color-coded by call type (§2) and by whether the call already exists in code (solid border) or is a new addition needed to close a gap (dashed border, labeled "NEW"). Where a node corresponds to a formal domain event from `event-catalog.md`, its label includes that event name in `code font` so the two docs stay traceable to each other.

---

## 2. Color legend

| Color | Type | Meaning |
|---|---|---|
| 🔵 Blue | **Logger** | `logger.*` from `lib/logger.ts` (Winston → console + `logs/app-*.log`) |
| ⚪ Grey | **Console** | Bare `console.log`/`console.error`, typically client-side (browser devtools only, not persisted) |
| 🟠 Amber | **Raw Event** | `recordRawEvent(...)` — written to S3 `raw-events/` before the action completes |
| 🟢 Green | **Processed Event** | `recordProcessedEvent(...)` — written to S3 `processed-events/` after successful commit |
| 🔴 Red | **Failed Event** | `recordFailedEvent(...)` — written to S3 `failed-events/` on error/rollback |
| 🟣 Purple | **DB Write** | An actual `INSERT`/`UPDATE` against MariaDB |
| 🟦 Teal | **Status Transition** | A `status` column change (`draft → in_review → active`, etc.) |
| 🟡 Gold | **Approval Step** | A step inside the shared `approvals`/`approval_items` flow |
| ▢ Dashed border | **NEW** | Proposed addition — does not exist in code today; solid border = already exists |

```mermaid
flowchart LR
    A["Logger"]:::logger
    B["Console"]:::console
    C["Raw Event"]:::rawEvt
    D["Processed Event"]:::procEvt
    E["Failed Event"]:::failEvt
    F["DB Write"]:::dbWrite
    G["Status"]:::status
    H["Approval"]:::approval
    I["NEW (proposed)"]:::consoleNew

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef console fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef failEvt fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
```

---

## 3. Manufacturer (`app/masters/manufacturers`) — full detail, both branches

Structure confirmed against `AddMfgDialog.tsx` (2-step wizard: Details → optional Documents, single submit) and `CsvImportDialog.tsx` (CSV parsed client-side with preview; Excel uploaded to S3 immediately on file-select). Existing backend instrumentation confirmed against `app/api/v1/masters/manufacturers/route.ts`.

```mermaid
flowchart TD
    Page["Manufacturers page loads"] --> L0["Logger: page load, user/userId/query/time\n(page.tsx:36, [AUDIT])"]:::logger
    L0 --> L0b["Logger: page load complete, rows/ms\n(page.tsx:43)"]:::logger

    Page --> DL["Download CSV/Excel click"]
    DL --> C1["Console: export requested, format, filters\n[NEW]"]:::consoleNew
    C1 --> GET["GET .../export?format=csv|xlsx"]
    GET -.only console error on failure today.-> L1["Logger: export served, rowCount, ms [NEW]"]:::loggerNew

    Page --> Upload["Upload CSV click"]
    Upload --> C2["Console: dialog opened [NEW]"]:::consoleNew
    C2 --> FileType{File type?}
    FileType -->|.xlsx| C3x["Console: excel selected, uploading to S3 [NEW]"]:::consoleNew
    C3x --> S3up["POST /api/v1/upload (stage file)"] --> C4x["Console: staged, s3Key [NEW]"]:::consoleNew
    FileType -->|.csv| C3c["Console: csv selected, parsing client-side [NEW]"]:::consoleNew
    C3c --> Preview["Client parses rows, shows preview table"] --> C4c["Console: parsed N rows, M invalid [NEW]"]:::consoleNew

    C4x --> SubmitBulk["Submit click"]
    C4c --> SubmitBulk
    Upload -.cancel.-> C5["Console: dialog closed without submit [NEW]"]:::consoleNew

    SubmitBulk --> LB1["Logger: bulk insert started, rowCount\n(route.ts:133/376)"]:::logger
    LB1 --> RB1["Raw Event: mfg.bulkImported (route.ts:134/377)\n** fix: unify tag to MFG_BULK for both csv & s3 **"]:::rawEvt
    RB1 --> DBb["DB Write: INSERT master_mfgs + details_mfg per row\nstatus=in_review (route.ts:168-179)"]:::dbWrite
    DBb --> ARb["Approval: INSERT approvals + approval_items per row\n(insertApprovalWithItems, route.ts:180-191)"]:::approval
    ARb --> LB2["Logger: committed, inserted/skipped\n(route.ts:196/436)"]:::logger
    LB2 --> PB1["Processed Event: mfg.bulkImported\n(route.ts:197/437) ** fix: unify to MFG_BULK **"]:::procEvt
    DBb -.error.-> FB1["Failed Event: mfg.bulkImported failed\n(route.ts:202/442)"]:::failEvt

    Page --> New["Create New Manufacturer click"]
    New --> C6["Console: dialog opened, step=details [NEW]"]:::consoleNew
    C6 --> Step1["Step 1: user fills details form\n(AddMfgDialog.tsx:151-171)"]
    Step1 -->|Next| C7["Console: step=documents [NEW]"]:::consoleNew
    Step1 -.Cancel.-> C8["Console: dialog closed, step=details [NEW]"]:::consoleNew
    C7 --> Step2["Step 2 (optional): upload docs\n(AddMfgDialog.tsx:174-219)"]
    Step2 -.Back.-> Step1
    Step2 -.Cancel.-> C9["Console: dialog closed, step=documents [NEW]"]:::consoleNew
    Step2 --> Submit["Submit for Approval click\n(handleSubmit, AddMfgDialog.tsx:84)"]
    Submit --> C10["Console: uploading N pending docs to S3 [NEW]"]:::consoleNew
    C10 --> L2["Logger: create started, name\n(route.ts:49)"]:::logger
    L2 --> R2["Raw Event: mfg.created (route.ts:50)"]:::rawEvt
    R2 --> DB2["DB Write: INSERT master_mfgs + details_mfg\nstatus=in_review (route.ts:65,75)"]:::dbWrite
    DB2 --> AR2["Approval: INSERT approvals + approval_items\n(route.ts:88-111)"]:::approval
    AR2 --> L3["Logger: created + committed\n(route.ts:73,114)"]:::logger
    L3 --> P2["Processed Event: mfg.created (route.ts:115)"]:::procEvt
    DB2 -.error.-> F2["Failed Event: mfg.created failed (route.ts:120)"]:::failEvt

    P2 --> Status1["Status: in_review"]:::status
    PB1 --> Status1
    Status1 --> Appr["Approval decision (see §10)"]
    Appr --> Status2["Status: active"]:::status

    Page --> RowEdit["Edit icon on a row\n(ManufacturersClient.tsx:159-167,\ndisabled while status=in_review)"]
    RowEdit --> C11["Console: edit dialog opened, mfg_id [NEW]"]:::consoleNew
    C11 --> RejCheck["GET /api/v1/approvals/entity?module=MFG&entity_id=...\n(EditMfgDialog.tsx:67 — shows rejection banner\nif row status=draft; edit-locked to original submitter)"]
    RejCheck --> ChangeFields["User edits fields"] --> SubmitEdit["Save click\n(handleSave, EditMfgDialog.tsx:94)"]
    SubmitEdit --> LBlkE["Logger.warn: blocked, pending approval (route.ts:280)"]:::logger
    SubmitEdit --> LE1["Logger: update started (route.ts:290)"]:::logger --> DiffE{diff vs current}
    DiffE -->|no changes| LNE["Logger: no changes detected (route.ts:143-ish)"]:::logger
    DiffE -->|changed| RE1["Raw Event: mfg.updateRequested (route.ts:291)"]:::rawEvt --> ARE["Approval: INSERT approvals + approval_items\n(route.ts:327-340)"]:::approval --> StatusE1["Status: in_review (route.ts:341)"]:::status --> LE2["Logger: submitted for approval (route.ts:343)"]:::logger --> PE1["Processed Event: mfg.updated (route.ts:345)"]:::procEvt
    DiffE -.error.-> FE1["Failed Event: mfg.updateRequested failed (route.ts:349)"]:::failEvt
    StatusE1 --> ApprE["Approval decision (see §10)"] --> ApplyEvtE["mfg.updated — NO history table today;\nchanges[] payload is the only durable record\n(module-handlers.ts, MFG handler)"]:::dbWrite --> StatusE2["Status: active"]:::status

    Page --> RowDocs["Documents icon on a row\n(ManufacturersClient.tsx:168-175, always enabled)"]
    RowDocs --> C12["Console: docs dialog opened, mfg_id [NEW]"]:::consoleNew --> DocsFill["User selects doc files per tab"] --> SubmitDocs["Save click\n(handleSave, ManufacturerDocumentsDialog.tsx:91)"]
    SubmitDocs --> C13["Console: uploading N pending docs to S3 [NEW]"]:::consoleNew --> DocsUp["POST /api/v1/upload per file"]
    DocsUp --> LBlkD["Logger.warn: blocked, pending approval (route.ts:218)"]:::logger
    DocsUp --> LD1["Logger: doc update started [NEW — none exists\nbetween route.ts:211-224 today]"]:::loggerNew --> DiffD{diff vs current doc keys}
    DiffD -->|changed| ARD["Approval: INSERT approvals + approval_items\n(route.ts:248-254)"]:::approval --> StatusD1["Status: in_review (route.ts:255)"]:::status --> LD2["Logger: submitted for approval (route.ts:258)"]:::logger --> PD1["Processed Event: mfg.docsUpdated (route.ts:259)"]:::procEvt
    DiffD -.error.-> FD1["Failed Event: mfg.docsUpdated failed (route.ts:263)"]:::failEvt
    StatusD1 --> ApprD["Approval decision (see §10)"] --> StatusD2["Status: active"]:::status

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef loggerNew fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px,stroke-dasharray:5 5;
    classDef console fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef failEvt fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

**Implementation checklist — Manufacturer:**
1. Add 8 new `console.debug`/`console.log` calls to `AddMfgDialog.tsx` and `CsvImportDialog.tsx` (dialog open, step change, file type branch, parse result, cancel) — pure frontend, no API changes.
2. Fix `MFG_BULK`/`MFG_S3BULK` tag mismatch: use one tag (`MFG_BULK`, distinguished by `source: "csv"|"s3"` in the payload) at raw, processed, *and* failed sites (`route.ts:134,197,202` and `:377,437,442`).
3. Add a `console.error`/`logger.warn` to `DownloadButton.tsx` / `export/route.ts` — export currently has no success-path or duration logging at all.
4. Add "edit dialog opened"/"docs dialog opened" consoles to `EditMfgDialog.tsx` and `ManufacturerDocumentsDialog.tsx` — two more always-available row actions beyond create/bulk, gated only by `status !== in_review`.
5. Add a `logger.info` "doc update started" line to the `update_docs` branch (`route.ts:211-224`) — it currently jumps straight from the pending-approval check to the diff, with no started-log in between, unlike every other action.

---

## 4. SKU (`app/masters/skus`)

```mermaid
flowchart TD
    Page["SKU page loads"] --> L0["Logger: [AUDIT] page load (page.tsx:44)"]:::logger --> L0b["Logger: [AUDIT] complete (page.tsx:52)"]:::logger

    Page --> Create["Create SKU dialog"]
    Create --> C1["Console: dialog opened [NEW]"]:::consoleNew
    C1 --> Fill["User fills SKU form"]
    Fill -.cancel.-> C2["Console: dialog closed [NEW]"]:::consoleNew
    Fill --> Submit["Submit click"]
    Submit --> L1["Logger: create started (route.ts:25)"]:::logger
    L1 --> R1["Raw Event: sku.created (route.ts:26)"]:::rawEvt
    R1 --> DB1["DB Write: INSERT master_skus\n(route.ts:31-ish)"]:::dbWrite
    DB1 --> L2["Logger: created (route.ts:38)"]:::logger
    L2 --> P1["Processed Event: sku.created (route.ts:37)"]:::procEvt
    DB1 -.duplicate sku_code.-> LW["Logger.warn: duplicate (route.ts:43)"]:::logger
    DB1 -.other error.-> F1["Failed Event: sku.created failed (route.ts:46)"]:::failEvt

    Page --> Bulk["Bulk CSV / Excel import"]
    Bulk --> C3["Console: dialog opened, file selected, N rows parsed [NEW]"]:::consoleNew
    C3 --> SubmitB["Submit click"]
    SubmitB --> L3["Logger: bulk started (route.ts:57/196)"]:::logger --> R2["Raw Event: sku.bulkImported (route.ts:58/197)"]:::rawEvt --> DB2["DB Write: batch INSERT master_skus"]:::dbWrite --> L4["Logger: committed (route.ts:88/229)"]:::logger --> P2["Processed Event: sku.bulkImported (route.ts:87)"]:::procEvt
    DB2 -.error.-> F2["Failed Event (route.ts:93/234)"]:::failEvt

    Page --> Edit["Edit SKU dialog"]
    Edit --> C4["Console: dialog opened with current values [NEW]"]:::consoleNew
    C4 --> Change["User edits fields"]
    Change --> SubmitU["Submit click"]
    SubmitU --> LBlk["Logger.warn: blocked, pending approval (route.ts:111)"]:::logger
    SubmitU --> L5["Logger: update started (route.ts:119)"]:::logger
    L5 --> Diff{diff vs current}
    Diff -->|no changes| LN["Logger: no changes detected (route.ts:143)"]:::logger
    Diff -->|changed| R3["Raw Event: sku.updateRequested (route.ts:120)"]:::rawEvt
    R3 --> AR["Approval: INSERT approvals + approval_items"]:::approval
    AR --> L6["Logger: submitted for approval (route.ts:163)"]:::logger --> P3["Processed Event: sku.updateRequested (route.ts:162)"]:::procEvt
    AR --> Status1["Status: in_review"]:::status --> Appr["Approval decision (see §10)"]
    Appr --> ApplyEvt["sku.updated — pre-edit row archived to sku_history,\nthen UPDATE master_skus (module-handlers.ts)"]:::dbWrite
    ApplyEvt --> Status2["Status: active"]:::status

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef console fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef failEvt fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

**Implementation checklist — SKU:** add dialog-open/close console calls to the create/edit dialogs and CSV import dialog (backend is already fully instrumented — no backend changes needed).

---

## 5. Vendor (`app/masters/vendors`)

Same shape as SKU plus the doc-only fast path (no approval gate).

```mermaid
flowchart TD
    Page["Vendors page"] --> Create["Create Vendor"] --> C1["Console: dialog opened [NEW]"]:::consoleNew --> Submit["Submit"]
    Submit --> L1["Logger: started (route.ts:50)"]:::logger --> R1["Raw Event: vendor.created (route.ts:51)"]:::rawEvt --> DB1["DB Write: INSERT master_vendors + details_vendor (route.ts:65-ish)"]:::dbWrite --> L2["Logger: created (route.ts:74)"]:::logger --> P1["Processed Event: vendor.created (route.ts:107)"]:::procEvt

    Page --> Bulk["Bulk CSV/S3"] --> C2["Console: file parsed, N rows [NEW]"]:::consoleNew --> L3["Logger: bulk started (route.ts:125/285)"]:::logger --> R2["Raw Event: vendor.bulkImported (route.ts:126/295)"]:::rawEvt --> DB2["DB Write: batch INSERT"]:::dbWrite --> L4["Logger: committed (route.ts:175/342)"]:::logger

    Page --> Edit["Edit Vendor"] --> C3["Console: dialog opened [NEW]"]:::consoleNew --> SubmitU["Submit"]
    SubmitU --> LBlk["Logger.warn: blocked, pending approval (route.ts:203)"]:::logger
    SubmitU --> L5["Logger: started (route.ts:211)"]:::logger --> Diff{diff} --> AR["Approval: INSERT approvals+items"]:::approval --> Status1["Status: in_review"]:::status --> L6["Logger: submitted (route.ts:260)"]:::logger --> P2["Processed Event: vendor.updateRequested (route.ts:261)"]:::procEvt

    Page --> Docs["Update Documents (no approval gate)"] --> C4["Console: doc upload started [NEW]"]:::consoleNew --> LBlk2["Logger.warn: blocked if pending (route.ts:372)"]:::logger --> L7["Logger: started (route.ts:381)"]:::logger --> DB3["DB Write: UPDATE details_vendor doc keys"]:::dbWrite --> L8["Logger: submitted for approval (route.ts:425)"]:::logger --> P3["Processed Event: vendor.docsUpdated (route.ts:426)"]:::procEvt

    Status1 --> Appr["Approval decision (see §10)"] --> ApplyEvt["vendor.updated — NO history table today;\nchanges[] payload is the only durable record\n(module-handlers.ts, VENDOR handler)"]:::dbWrite --> Status2["Status: active"]:::status

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

**Implementation checklist — Vendor:** add dialog-open consoles (3 dialogs); flag the missing history table as a backend follow-up, not a logging fix — `vendor.updated`'s `changes[]` payload is the interim durable record until one exists.

---

## 6. Raw Material & Packing Material (`app/masters/raw-materials`, `app/masters/packing-materials`)

Identical structure for both domains — one diagram, RM shown, PM is a mechanical substitution (`rawMaterial.*` → `packingMaterial.*`, `rm-handler.ts` → `pm-handler.ts`).

```mermaid
flowchart TD
    Page["Raw Materials page"] --> L0["Logger: request received, action\n(route.ts:18) — hand-rolled ctx, no completion log [fix: adopt withGateway]"]:::logger
    L0 --> Handler["rm-handler.ts"]

    Handler --> Wizard["Add Raw Material wizard opens\n(AddRawMaterialWizard.tsx, 3 steps:\nDetails -> Vendor Pricing -> Approved At)"]
    Wizard --> C1["Console: wizard opened [NEW]"]:::consoleNew --> Step1["Step 1: material details filled"] --> Next1["Next click"]
    Next1 --> Chk1["Duplicate check: action=check-RM\n(name+make+inci_name, wizard.tsx:153-162)"]
    Chk1 --> CDup{duplicate found?}
    CDup -->|yes| C1b["Console: duplicate found, offer edit\nor add-rates-to-existing [NEW]"]:::consoleNew --> WizardMode["wizardMode switches to add-rates\n(wizard.tsx:472-497)"]
    CDup -->|no| Step2["Step 2: vendor/mfg pricing entered"]
    WizardMode --> Step2
    Step2 --> SelectVendor["Vendor selected"] --> Chk2["Duplicate-rate check: action=check-vendor\n(wizard.tsx:298-309)"] --> Step3["Step 3: Approved At"] --> SubmitW["Submit"]

    SubmitW --> Branch{New material\nor existing?}
    Branch -->|new| L1["Logger: create-full started (L145)"]:::logger --> R1["Raw Event: rawMaterial.created (L146)"]:::rawEvt --> DB1["DB Write: INSERT master_rm + cost_master_rm_mfg + cost_master_rm_ven\n(create-full, wizard.tsx:236-262)"]:::dbWrite --> L2["Logger: success (L200)"]:::logger
    Branch -->|existing, add-rates| L3["Logger: add-rates started (L221)"]:::logger --> R2["Raw Event: rawMaterial.rateAdded / vendorRateAdded (L222)"]:::rawEvt --> DB2["DB Write: INSERT cost_master_rm_mfg / cost_master_rm_ven"]:::dbWrite --> L4["Logger: success (L272)"]:::logger

    Handler --> Bulk["Bulk CSV / S3"] --> C4["Console: N rows parsed [NEW]"]:::consoleNew --> L7["Logger: started (L294/338)"]:::logger --> R4["Raw Event: rawMaterial.bulkImported (L295/339)"]:::rawEvt --> DB4["DB Write: batch INSERT"]:::dbWrite --> L8["Logger: completed (L321/380)"]:::logger

    Handler --> RowEditRate["Edit-rate icon on a row\n(EditRmVendorRateDialog.tsx / EditRmMfgRateDialog.tsx,\ndisabled while locked/in-review)"]
    RowEditRate --> C5["Console: rate edit dialog opened [NEW]"]:::consoleNew --> RejCheck["GET /api/v1/approvals/entity?module=RM_VRM|RM_RATE\n(dialog.tsx:58 / :53 — rejection banner if draft)"]
    RejCheck --> SubmitRate["Save click — POSTs the SAME action=add-rates\nas the wizard's rate step, single-entry array\n(EditRmVendorRateDialog.tsx:95-113)"]
    SubmitRate --> AR["Approval: INSERT approvals+items"]:::approval --> Status1["Status: in_review"]:::status --> Appr["Approval decision (see §10)"] --> ApplyEvt["rawMaterial.rateUpdated —\npre-edit row archived to history_cost_mfg/history_cost_ven,\nthen UPDATE rate row"]:::dbWrite --> Status2["Status: active"]:::status

    Handler --> Compare["Compare icon on a row\n(VendorDetailDialog.tsx / MfgDetailDialog.tsx,\nread-only, no mutating action)"]
    Compare --> C6["Console: compare dialog opened [NEW]"]:::consoleNew

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

Note: editing the **base** `master_rm`/`master_pm` record (the `RM_MAT`/`PM_MAT` approval module) is **not** a dialog under these two pages at all — it lives on the separate Material Master page (§7), shared between RM and PM via a `material` prop. Don't look for it here.

**Implementation checklist — RM/PM:** migrate `route.ts` onto `withGateway` for consistent request-context + completion logging (currently hand-rolled, §0 of the interaction-logging-map audit); add dialog-open/duplicate-found consoles to the wizard and both edit-rate dialogs; **resolve the two-tag-family issue** by retiring `material-master/route.ts`'s separate `RM_CREATE`/`PM_CREATE` tags in favor of the richer `RM_MAT`/`PM` family used by the dedicated pages, since both routes represent the same domain action; add a `logger.info`/event pair around the `check-RM`/`check-PM`/`check-vendor` duplicate-check calls, which currently have none (they're read-only lookups but still worth a debug-level trace since they gate what the user is allowed to submit next).

---

## 7. Material Master — combined RM/PM view (`app/masters/material-master`)

This is the **only** place the base `master_rm`/`master_pm` record (`RM_MAT`/`PM_MAT` approval module) can be edited — not under `app/masters/raw-materials` or `app/masters/packing-materials` (§6), which only edit rates. Easy to miss since it's a separate top-level page, shared between RM and PM via `EditMaterialDialog.tsx`'s `material: "rm" | "pm"` prop.

```mermaid
flowchart TD
    Page["Material Master page"] --> Toggle["RM/PM toggle"] --> C1["Console: view switched [NEW]"]:::consoleNew

    Page --> Create["Create dialog"] --> C2["Console: dialog opened, material type [NEW]"]:::consoleNew --> Submit["Submit"]
    Submit --> L1["Logger: started (route.ts:29/89)"]:::logger --> R1["Raw Event: RM_CREATE / PM_CREATE (route.ts:30/90)\n** should be retired in favor of RM_MAT/PM, see §6 **"]:::rawEvt --> DB1["DB Write: INSERT master_rm / master_pm"]:::dbWrite --> L2["Logger: created (route.ts:68/137)"]:::logger

    Page --> RowEdit["Pencil/EditButton on a row\n(MaterialMasterClient.tsx:301,318)"]
    RowEdit --> C3["Console: dialog opened, material type [NEW]"]:::consoleNew --> RejCheck["GET /api/v1/approvals/entity?module=RM_MAT|PM_MAT\n(EditMaterialDialog.tsx:77-88 — rejection\nbanner + submitter-only edit lock if draft)"]
    RejCheck --> LBlk["Logger.warn: unauthorized draft edit / blocked (route.ts:189)"]:::logger --> L3["Logger: submitted (route.ts:212/283)"]:::logger --> AR["Approval: INSERT approvals+items"]:::approval --> Status1["Status: in_review"]:::status --> P1["Processed Event: RM_UPDATE / PM_UPDATE (route.ts:225/303)"]:::procEvt
    Status1 --> Appr["Approval decision (see §10)"] --> ApplyEvt["rawMaterial.updated / packingMaterial.updated —\nNO history table today for RM_MAT/PM_MAT;\nchanges[] payload is the only durable record"]:::dbWrite --> Status2["Status: active"]:::status

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

---

## 8. BOM (`app/masters/recipe-master`) — backend mutation path now instrumented; frontend + a few gaps remain

> **Update (2026-07-05):** the backend logging/eventing described as "[NEW]" below has been **implemented** — `app/api/v1/masters/recipe-master/route.ts` now logs/emits `BOM` raw/processed/failed events around submit, and `bomHandler.applyAndArchive` in `lib/approvals/module-handlers.ts` now logs + emits a processed event on activation and **one per sibling BOM** inside the deactivation loop (a new `selectOtherActiveBomsForSku` query reads sibling ids before the bulk `UPDATE` runs, since MariaDB's `UPDATE` has no `RETURNING`). Diagram nodes below are updated to solid/existing styling where this is now true; genuinely remaining gaps keep the dashed "[NEW]" styling.
>
> Two corrections to this section's original framing, found while implementing:
> - The route was **already** on `withGateway` with a real Zod schema (`bomActionSchema`) before this instrumentation work — it was never on a "hand-rolled" request context the way RM/PM/Approvals are. Auth/RBAC/validation/request-tracing were already present at the same tier as SKU; only the business-fact logging/eventing was missing.
> - The approval-item diff is richer than "flat `line:<rm|pm>:<id>:<field>`" alone: it also includes a `__mode__` sentinel item recording `new-version`/`update-existing`, and `line:<type>:<id>:__removed__` sentinel items for any line dropped from an existing BOM.
>
> Also not previously documented here: a read-only **BOM History page** (`app/masters/recipe-master/history/`) exists, listing BOM headers with archived `history_recipe` revisions. It already has the same `[AUDIT]` page-load `console.log` pattern as the main listing (`lib/query-timing.ts`'s `timedQuery`) — no mutation path, so no action needed on it below.

```mermaid
flowchart TD
    Page["BOM Master page"] --> Wizard["BOM creation wizard opens\n(BomCreationWizard.tsx — always mode:new-version,\nuseBomWizard.ts:182-187)"] --> C1["Console: wizard opened, sku selected [NEW]"]:::consoleNew
    C1 --> WizMode{"Wizard step:\nNew version, or\n'Update Existing BOM'?"}
    WizMode -->|Update Existing BOM| SharedEdit
    WizMode -->|New version| Lines["User enters RM%/PM lines"] --> C2["Console: line added/edited, running total [NEW]"]:::consoleNew --> Review["Review step, RM-total banner"] --> Submit["Submit click"]

    Page --> DetailPanel["BOM listing row -> detail panel"] --> EditBtn["Edit BOM button\n(BomDetailPanel.tsx:169-174,\nshown only if canEdit && status not locked)"]
    EditBtn --> SharedEdit["BomEditDialog.tsx (BomLineEditorTable)\n— ONE dialog, TWO entry points\n(openEditMode, useBomDetailPanel.ts:163-171)"]
    SharedEdit --> C1b["Console: edit dialog opened, recipe_id, entry=wizard|panel [NEW]"]:::consoleNew --> EditLines["User edits RM%/PM lines"] --> SaveEdit["Save for Approval click\n(BomEditDialog.tsx:72-74 -> saveEdit,\nuseBomDetailPanel.ts:179-232)"]

    Submit --> L1a["Logger: bom submit started, mode=new-version\n(route.ts, DONE)"]:::logger
    SaveEdit --> L1b["Logger: bom submit started, mode=update-existing\n(route.ts, DONE)"]:::logger
    L1a --> R1["Raw Event: bom.submitted (tag BOM, DONE)"]:::rawEvt
    L1b --> R1
    R1 --> Post["POST /api/v1/masters/recipe-master\naction=create-full, mode=new-version|update-existing\n(useBomWizard.ts:182 / useBomDetailPanel.ts:207-219)"]
    Post --> AR["Approval: INSERT approvals + approval_items\n(__mode__ sentinel + per-field line:&lt;rm|pm&gt;:&lt;id&gt;:&lt;field&gt; diff\n+ __removed__ sentinels for dropped lines)"]:::approval
    AR --> L2["Logger: submitted for approval (DONE)"]:::logger --> P1["Processed Event: bom.submitted (DONE)"]:::procEvt
    AR --> Status1["Status: in review\n** literal DB value has a space, unlike every other module's in_review —\ndeliberate, per lib/queries/bom.ts comment, not an oversight **"]:::status
    Post -.error.-> F0["Failed Event: bom.submitted failed (DONE, route.ts catch)"]:::failEvt

    Status1 --> Appr["Approval decision (see §10)"]
    Appr --> Mode2{update-existing?}
    Mode2 -->|yes| Snap["DB Write: snapshot every current line\nto history_recipe [still NEW: no dedicated\nlogger.info before/after the snapshot loop itself]"]:::dbWrite
    Mode2 -->|no| Skip["(nothing to snapshot)"]
    Snap --> DB2["DB Write: delete + reinsert details_recipe"]:::dbWrite
    Skip --> DB2
    DB2 --> L4["Logger: BOM activated, bomId, skuId, approverId\n(module-handlers.ts, DONE)"]:::logger --> R2["Processed Event: BOM (activation)\n(module-handlers.ts, DONE)"]:::procEvt
    R2 --> Status2["Status: active"]:::status

    Status2 --> Fanout["selectOtherActiveBomsForSku\n(reads sibling ids BEFORE the bulk UPDATE —\nMariaDB UPDATE has no RETURNING, DONE)"] --> Loop{"for each sibling BOM"}
    Loop --> DB3["DB Write: UPDATE master_recipe.status = inactive\n(single bulk statement, all siblings at once)"]:::dbWrite
    DB3 --> L5["Logger: BOM deactivated (superseded),\nbomId, supersededBy — once per sibling\n(module-handlers.ts, DONE)"]:::logger --> R3["Processed Event: BOM (deactivation)\n— one per sibling, not one for the whole batch\n(module-handlers.ts, DONE — this is the fan-out\ncase event-catalog.md §4.3 describes)"]:::procEvt
    R3 --> Loop

    Page --> DL["Download export"] --> C3["Console: export served, row count\n(export/route.ts, DONE — baseline console.log\nalready existed here before this pass)"]:::console

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef console fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef failEvt fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

**Implementation checklist — BOM:**
1. ~~Add `logger.info`/`recordRawEvent`/`recordProcessedEvent`/`recordFailedEvent` to `app/api/v1/masters/recipe-master/route.ts` at submit~~ — **Done.** Layered inside the existing `withGateway` handler; no route-wiring change was needed.
2. ~~Add the same to `lib/approvals/module-handlers.ts`'s `BOM` handler at activation and inside the sibling-deactivation loop, one event per sibling~~ — **Done.**
3. Add a `logger.warn` when the DB's literal `"in review"` (with a space) status is set/read, so it's never silently confused with every other module's `in_review` — **still open.** Low priority: this is a deliberate, commented value (`lib/queries/bom.ts`), not an accidental one, so the runtime guard is a safety net, not a bug fix.
4. Add a bare `console.error`/success log to `recipe-master/export/route.ts` — **already satisfied**, both before and after this pass (matches every other export route's baseline; a success-path `console.log` was added to all masters export routes in the same session that did items 1–2).
5. Tag the started-log's payload with `entry: "wizard" | "panel"` so the two entry points into the shared edit surface stay distinguishable in logs — **still open, deliberately deferred.** This needs a new field on the wizard's/detail-panel's POST body, which is an API-contract change, not a backend-only logging fix.
6. **New item, not in the original checklist:** add a `logger.info` immediately before/after the `history_recipe` snapshot loop in `bomHandler.applyAndArchive`, reporting how many lines were archived — the activation-level log (item 2) exists, but the snapshot step itself still has no dedicated line-count log, so "how many prior lines were archived on this update" isn't currently visible in a log line, only inferable from the DB.
7. **New item, not in the original checklist:** the BOM History page is read-only with page-load audit logging already in place — explicitly excluded from any future "BOM has no instrumentation" claim; no action needed.

---

## 9. Purchase Orders (`app/po-tracking/po-procurement`)

```mermaid
flowchart TD
    Page["PO page"] --> Impromptu["Impromptu PO dialog"] --> C1["Console: dialog opened [NEW]"]:::consoleNew --> SubmitI["Submit"]
    SubmitI --> DB1["DB Write: INSERT purchase_orders, status=draft"]:::dbWrite --> AR["Approval: INSERT approvals"]:::approval --> Status1["Status: draft -> in_review"]:::status
    Status1 --> Appr["Approval decision (see §10)"] --> DB1b["DB Write: status -> raised (po.approved)"]:::dbWrite --> Email["Auto-send email\n(approvals/[id]/route.ts:116-131)"]
    Email --> L1["Logger: po.emailSent (L123)"]:::logger --> DB1c["DB Write: email_sent_at stamped"]:::dbWrite
    Email -.no mfg email.-> LW["Logger.warn: skipped (L125)"]:::logger
    Email -.send failure.-> LE["Logger.error: po.emailSent failed (L128)\napproval already committed either way"]:::logger

    Page --> Normal["Normal PO dialog"] --> C2["Console: dialog opened [NEW]"]:::consoleNew --> SubmitN["Submit"]
    SubmitN --> L2["Logger: only on failure today (route.ts:198)\n[NEW: add success-path logger.info]"]:::loggerNew --> DB2["DB Write: INSERT purchase_orders, status=raised"]:::dbWrite

    Page --> Bulk["Bulk CSV upload\n(PoBulkUploadDialog.tsx)"] --> C3["Console: N rows parsed [NEW]"]:::consoleNew --> L3["Logger: only on failure today (route.ts:138)\n[NEW: add started/success logs]"]:::loggerNew --> R1["Raw+Processed+Failed Event: po.bulkImported\n(module-handlers.ts, inside applyAndArchive)"]:::rawEvt --> DB3["DB Write: batch INSERT, status=raised"]:::dbWrite

    Page --> RowEdit["Edit button on a row\n(PoTable.tsx:364-371,\ncanEdit = status=draft && raised_by=me, PoTable.tsx:255)"]
    RowEdit --> C4["Console: re-edit dialog opened, po_id [NEW]"]:::consoleNew --> Reopen["ImpromptuPODialog reopened with editData\n(isEdit=true, ImpromptuPODialog.tsx:25,\ntitle changes to 'Re-edit Draft PO')"]
    Reopen --> SubmitEdit["Submit click"]
    SubmitEdit --> LE1["Logger: PO re-edit started (route.ts:81)"]:::logger --> PUT["PUT /api/v1/purchase-orders/[id]\n(ImpromptuPODialog.tsx:94-99 — NOT AddPODialog,\nwhich is never reused for edit)"]
    PUT --> AR2["Approval: INSERT approvals + approval_items\n(route.ts, re-edit flow)"]:::approval --> LE2["Logger: PO re-edit submitted for approval (route.ts:120)"]:::logger
    PUT -.error.-> FE1["Logger.error: PO re-edit failed (route.ts:125)\n[NEW: pair with a recordFailedEvent — none exists today]"]:::loggerNew

    Page --> RowEmail["Row action menu: Send/Resend Email\n(PoTable.tsx:269-303) -> POST .../send-email"]
    RowEmail --> C5["Console: resend requested, po_id [NEW]"]:::consoleNew --> LEm1["Logger: manual email send requested (L20)"]:::logger
    LEm1 -.no mfg email.-> LEmW["Logger.warn: skipped, no email on file (L31)"]:::logger
    LEm1 --> LEm2["Logger: manual email sent (L39)"]:::logger
    LEm1 -.send failure.-> LEmE["Logger.error: manual send failed (L43)"]:::logger

    Page --> RowPdf["Row action menu: Review PDF\n(PoTable.tsx:269-303) -> GET .../preview-pdf"]
    RowPdf --> C6["Console: pdf preview requested [NEW]"]:::consoleNew --> LPdf["Logger + event instrumentation\n[NEW — preview-pdf/route.ts has ZERO\ninstrumentation today, not even a console.error]"]:::loggerNew

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef loggerNew fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px,stroke-dasharray:5 5;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
    classDef approval fill:#eab308,color:#111,stroke:#a16207,stroke-width:2px;
```

There is **no dedicated "Receive PO" action.** Receiving happens implicitly via the two flows below, whichever the user chooses when a PO still has an outstanding quantity:

```mermaid
flowchart TD
    SplitDialog["SplitPODialog submit\n(PoTable.tsx:372-380, enabled for\ndraft/raised/punched/partially_received)\n— this IS the receiving mechanism, not a separate action"] --> C1["console: split success\n(SplitPODialog.tsx:131, already exists)"]:::console
    SplitDialog --> API["POST .../split"]
    API --> L1["Logger: split started (L52)"]:::logger --> R1["Raw Event: po.split (L53)"]:::rawEvt --> DB1["DB Write: INSERT child POs,\ncredit parent received_qty (incrementReceivedQtyBySplit)"]:::dbWrite
    DB1 --> Tolerance{"remaining qty\nwithin tolerance?"}
    Tolerance -->|yes| Status1["Status: received"]:::status
    Tolerance -->|no| Status2["Status: partially_received"]:::status
    Status1 --> L2["Logger: split succeeded (L121)"]:::logger --> P1["Processed Event: po.split (L120)"]:::procEvt
    Status2 --> L2

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef console fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef status fill:#14b8a6,color:#111,stroke:#0f766e,stroke-width:2px;
```

```mermaid
flowchart TD
    Close["Short Close click\n(ShortCloseDialog, PoTable.tsx:42-93 —\nfor resolving a PO without full receipt)"] --> C1["Console: confirm dialog [NEW]"]:::consoleNew --> API["POST .../close"]
    API -.not found.-> LW["Logger.warn (L36)"]:::logger
    API --> L1["Logger: po.closed / statusChanged (L48)"]:::logger --> R1["Raw+Processed Event:\n[fix] rename purchase_order_short_closed\nto PO_CLOSE (UPPER_SNAKE, matches every other tag)\n(L29,L49)"]:::rawEvt --> DB1["DB Write: status -> short_closed"]:::dbWrite
    DB1 -.error.-> F1["Failed Event [NEW — none exists today]"]:::failEvtNew

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
    classDef failEvtNew fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px,stroke-dasharray:5 5;
```

**PATCH `[id]/route.ts:132-172` (attachment replace) has no UI caller anywhere in the app** — the only invoker of the underlying `updatePoAttachment` query is `lib/mail/mailer.ts:95`, a server-side side effect inside `sendPoEmail()` (auto-stamps `attachment_key` when a PO email is sent). Treat this route as either dead code to remove, or an intentionally server-only mechanism — don't design a "replace attachment" UI flow for it without confirming which.

**Implementation checklist — PO:**
1. Add success-path `logger.info` to the Normal PO create path and the Bulk CSV path (both currently log only on failure).
2. Rename `purchase_order_short_closed` → `PO_CLOSE`, matching the UPPER_SNAKE convention everywhere else; add the missing `recordFailedEvent` call.
3. Add `logger`/event instrumentation to `preview-pdf/route.ts` (currently zero, not even a bare `console.error`) and dialog-open consoles to `AddPODialog.tsx`/`ImpromptuPODialog.tsx`/`PoBulkUploadDialog.tsx`.
4. Pair the existing `logger.error` on re-edit failure (`route.ts:125`) with a `recordFailedEvent` call — every other approval-gated update in the app writes a failed-event, re-edit currently doesn't.
5. Add a `console.log` to the row-action menu's Send/Resend Email and Review PDF triggers — both are real, distinct user actions with backend routes but zero frontend trace today.
6. Resolve whether the attachment-replace PATCH route is dead code or intentionally server-only before instrumenting it either way.

---

## 10. Approvals (`app/approvals`) — the shared decision point every module above re-enters

```mermaid
flowchart TD
    List["Approvals list loads"] --> LW["Logger.warn: unauthenticated (route.ts:13)"]:::logger
    List --> L1["Logger: fetch started (route.ts:31)\n[fix: reuse the SAME requestId as the 401 branch\nrather than generating a second one]"]:::logger --> L2["Logger: success, count (route.ts:57)"]:::logger

    Card["Approval card rendered"] --> C1["Console: card viewed, module/entityId [NEW]"]:::consoleNew

    Approve["Approve click"] --> L3["Logger: request received (route.ts:33)"]:::logger --> RBAC{admin/manager?}
    RBAC -->|no| LW2["Logger.warn: forbidden (route.ts:37)"]:::logger
    RBAC -->|yes| PendCheck{status == pending?}
    PendCheck -->|no| LW3["Logger.warn: already actioned (route.ts:68)"]:::logger
    PendCheck -->|yes| R1["Raw Event: approval.approved (route.ts:84)"]:::rawEvt
    R1 --> Txn["Transaction: MODULE_HANDLERS[module].applyAndArchive\n+ markApproved"]:::dbWrite
    Txn --> L4["Logger: applied and archived (route.ts:101)"]:::logger --> P1["Processed Event: approval.approved (route.ts:109)"]:::procEvt
    P1 --> ModuleEvt["Re-enters target module's own diagram\nat the DB-commit step (§3-§9)"]
    Txn -.failure.-> F1["Failed Event: approval.approved failed (route.ts:138)"]:::failEvt

    Reject["Reject click"] --> RemarksCheck{remarks provided?}
    RemarksCheck -->|no| LW4["Logger.warn: reject without remarks (route.ts:56)\nrejection blocked, remarks mandatory"]:::logger
    RemarksCheck -->|yes| C2["Console: reject confirmed, remarks length [NEW]"]:::consoleNew --> Txn2["Transaction: setStatus(draft) + markRejected"]:::dbWrite --> L5["Logger: reverted to draft (route.ts:105)"]:::logger --> P2["Processed Event: approval.rejected [NEW — currently\nonly the generic APPROVAL processed event fires,\nnot one specifically distinguishing reject]"]:::procEvtNew

    ModuleEvt --> POEmail{module == PO?}
    POEmail -->|yes| Email["Auto-send email — see §9"]

    classDef logger fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
    classDef consoleNew fill:#9ca3af,color:#111,stroke:#4b5563,stroke-width:2px,stroke-dasharray:5 5;
    classDef rawEvt fill:#f59e0b,color:#111,stroke:#b45309,stroke-width:2px;
    classDef procEvt fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px;
    classDef procEvtNew fill:#22c55e,color:#111,stroke:#15803d,stroke-width:2px,stroke-dasharray:5 5;
    classDef failEvt fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px;
    classDef dbWrite fill:#a855f7,color:#fff,stroke:#7e22ce,stroke-width:2px;
```

**Implementation checklist — Approvals:**
1. Fix the double-`requestId` bug: generate one id at the top of the request and reuse it in every branch (`route.ts:13` and `:21` currently diverge).
2. Add a distinct `recordProcessedEvent("APPROVAL_REJECTED", ...)` (or equivalent) so reject has its own processed-event trail instead of only the generic `APPROVAL` tag shared with approve.
3. Add a `console.debug` when an approval card is viewed, for basic "who looked at this" visibility ahead of a real audit-log UI.

**Cross-cutting pattern — not part of this page's own flow, but consumed by every module's edit dialog:** `GET /api/v1/approvals/entity?module=...&entity_id=...` is called from seven different masters Edit dialogs (`EditMfgDialog.tsx:67`, `EditMaterialDialog.tsx:80`, `EditRmVendorRateDialog.tsx:58`, `EditRmMfgRateDialog.tsx:53`, `EditPmVendorRateDialog.tsx:57`, `EditPmMfgRateDialog.tsx:53`, `EditVendorDialog.tsx:59`) — never from `RejectDialog.tsx` or `ApprovalCard.tsx` themselves. Each fires only when the row's own status is `draft` (previously rejected), populating a "Rejected by X: '...'" banner and a submitter-only edit lock. Document this once, here, rather than repeating it in every page's own diagram — but don't attach it to the Approvals page's instrumentation, since nothing on this page consumes it.

---

## 11. Cross-page conventions to standardize before writing any of this

These apply to every checklist above — fix once, not per page:

1. **One request-context helper for every route**, not two idioms. Migrate `raw-materials`, `packing-materials`, and all three `approvals/*` routes onto `withGateway`/`createRequestContext()` so every route gets consistent `requestId`, `userId`, and duration tracking for free.
2. **One module-tag family per domain**, not two. Retire the `material-master/route.ts` tags (`RM_CREATE`, `PM_CREATE`, `RM_UPDATE`, `PM_UPDATE`) in favor of the richer tags already used by the dedicated RM/PM pages, since they describe the same actions.
3. **Every event tag is UPPER_SNAKE**, no exceptions — fix `purchase_order_short_closed` → `PO_CLOSE`.
4. **Every bulk/S3-bulk flow uses the same tag for raw, processed, and failed** — fix the Manufacturer `MFG_BULK`/`MFG_S3BULK` mismatch as the template for checking the rest.
5. **Every dialog gets exactly four frontend console calls**: opened, primary-action-completed (e.g. file parsed / step advanced), submitted, closed-without-submitting. This is the minimum set needed to reconstruct a user's path through any dialog from browser devtools alone, and it's what's systematically missing today (only `SplitPODialog.tsx` has any).
6. **Every route gets a success-path logger line**, not just a failure one — PO's Normal-create and Bulk-CSV paths currently log only on error.

---

## 12. Non-goals

- Does not implement any of the above — this is the blueprint each page's implementation PR should follow.
- Does not pick the future event backbone (`event-driven-options.md` still owns that).
- Does not cover inventory/manufacturing/finance/sales-crm/hr-payroll — no pages/routes exist yet to design instrumentation for.
