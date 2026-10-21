# `lib/` Restructure Plan

**Status:** proposed — waiting for go-ahead
**Date:** 2026-10-14
**Scope:** folder layout of `lib/` and the imports that point into it. No behaviour change, no SQL change, no route change.

---

## 1. Why

`lib/` has 33 loose files at its root sitting beside 21 folders, and the folders mix three different kinds of code:

| Kind | Today | Problem |
|---|---|---|
| Platform (db, env, logger, auth, scope) | loose at the root | Nothing says "this is infrastructure every module may use" |
| Integrations (Uniware, Nanonets, SES, S3, AWS) | `uniware/`, `nanonets/`, `mail/`, `aws/`, plus loose `s3.ts`, `import-s3.ts` | S3 is split across a folder and two root files |
| Business domains (PO, invoice, masters, costing) | `po/`, `invoice/`, `masters/`, `costing/`, `manufacturing/`, `master-routes/` … | A domain's SQL, Zod and approval handler live in three *other* folders (`queries/`, `validation/`, `approvals/handlers/`) |

The goal is a layout where the folder tells you the layer, and the layer tells you what it may import.

## 2. Target shape

```
lib/
  core/           db, db-sku, env, logger, request-context, query-timing, events, build-info, constants
  access/         auth, permissions, pages, roles, scope, brand-guard, brand-view, admin-guards, s3-guard
  gateway/        (unchanged) with-gateway, errors, rate-limit, scope-rules
  shared/         date, numeric, csv, pagination, fuzzy-search, api-error-message
  export/         export → index-free: export.ts, configs.ts
  hooks/          useAsync, useUrlFilters
  utils.ts        STAYS — shadcn's cn(); components.json points the CLI at @/lib/utils

  integrations/
    uniware/      (moved as-is) + mfg-facility-push, mfg-facility-sync
    nanonets/     (moved as-is)
    mail/         (moved as-is)
    aws/          s3, import-s3, cloudwatch, ec2
    pdf/          (moved as-is)

  procurement/    po/, invoice/, gatepass/            ← Phase 2 pulls their queries/validation/handlers in
  masters/        masters/ + master-routes/ + users/
  costing/        costing/ + manufacturing/
  approvals/      engine only (module-handlers, types, bulk-envelope, apply-columns)
  reports/        reports/ + cron/
  services/       (unchanged) page reads

  queries/        shrinks domain by domain in Phase 2, then holds only platform SQL (auth, activity, permissions…)
  validation/     shrinks the same way; shared.ts stays
```

Allowed imports, top to bottom (enforced in Phase 3):

```
core  ←  access / shared  ←  integrations  ←  domains  ←  services / app
```

`core` imports nothing from `lib`. An integration never imports a domain. A domain never imports another domain's `queries` — it calls that domain's function.

## 3. Sequencing and gates

| Phase | What | Size | Gate to start | Gate to finish |
|---|---|---|---|---|
| **0** | Commit or shelve the in-flight invoice-revert / PO_EDIT work | — | — | `git status` clean under `lib/`, `app/`, `tests/` |
| **1a** | Platform: `core/`, `access/`, `shared/`, `export/`, `hooks/` | 24 files, ~800 import lines | Phase 0 | G1 below |
| **1b** | Integrations: move under `integrations/`, fold in S3 + mfg-facility | 5 folders + 4 files | 1a merged | G1 + Uniware-boundary lint check |
| **2** | Domains, one per PR: procurement → masters → costing → reports. Each pulls in its `queries/*`, `validation/*`, `approvals/handlers/*` | 1 domain at a time | 1b merged | G1 + `npm run test:db` |
| **3** | ESLint boundary rules per §2 | config only | Phase 2 procurement merged | `npm run lint` shows no *new* errors |

**G1 — every move commit must pass, in this order:**
1. `npx tsc --noEmit --incremental false` (not the incremental one — a stale `tsconfig.tsbuildinfo` hides broken imports)
2. `npm test`
3. `npm run lint:changed`
4. `npm run build` with the dev server stopped
5. `git grep` for the old path returns nothing in `app lib components tests scripts types eslint.config.mjs CLAUDE.md AGENTS.md docs`

Phase 1 is one commit per target folder (`refactor(lib): move platform files to lib/core`), each made with `git mv` so `git log --follow` keeps history. Any single folder can be reverted on its own.

## 4. Risks

| Risk | Why it bites here | Mitigation |
|---|---|---|
| **ESLint boundary goes silent** | `erp/ui-data-boundary` bans `"@/lib/db"`, `"@/lib/db-sku"`, `"@/lib/query-timing"`, `"@/lib/queries/*"` and ten `"@/lib/uniware/*"` paths **by exact string**. After a move nothing matches, the rule passes everything, and no check fails. | Update `eslint.config.mjs` in the same commit as the move. Prove it: add a throwaway page importing `@/lib/core/db`, confirm lint fails, delete it. |
| **Prefix collisions in find-replace** | `@/lib/db` ⊂ `@/lib/db-sku`, `@/lib/s3` ⊂ `@/lib/s3-guard`, `@/lib/export` ⊂ `@/lib/export-configs`. The repo already has a find-replace scar (`/api/` → `/api/v1/v2/` in the Nanonets URL). | Replace the full quoted specifier only (`"@/lib/db"` with both quotes), longest names first. Never replace bare path text. |
| **Relative imports missed** | 152 test/script files import `../../lib/...`, by design (CLAUDE.md, Testing §1). A replace on `@/lib/` alone misses all of them. | Codemod handles both `@/lib/x` and `(../)+lib/x`. G1 step 5 greps both. |
| **Unit tests turn impure** | `tests/unit` may only import modules that don't reach `lib/db`, `lib/s3`, `lib/mail/mailer`. An `index.ts` barrel that re-exports a whole folder would drag those in and break `npm test` without credentials. | **No new barrel files.** `uniware/index.ts` and `nanonets/index.ts` already exist and move as-is. |
| **Merge conflicts with in-flight work** | 45+ modified files right now, most of them under `lib/`. | Phase 0. Don't start while a feature branch is open. |
| **shadcn CLI breaks** | `components.json` aliases `@/lib/utils`. | `lib/utils.ts` doesn't move. |
| **Docs point at dead paths** | CLAUDE.md alone names ~60 `lib/` paths. It already cites a file that's gone (`lib/po-split.ts`). | Update CLAUDE.md / AGENTS.md path tables in the same commit. Fix the `po-split` references while there. |
| **Stale build cache** | `.next/` and `tsconfig.tsbuildinfo` can hold old module paths. | Delete both before G1 step 1. |

No shim files re-exporting from the old paths. There are no outside consumers, and shims would leave two valid import paths for every file.

## 5. Phase 1 move table

Fan-in = files that import it today. Higher numbers mean more of the diff.

| From | To | Fan-in |
|---|---|---|
| `lib/db.ts` | `lib/core/db.ts` | 145 |
| `lib/date.ts` | `lib/shared/date.ts` | 87 |
| `lib/logger.ts` | `lib/core/logger.ts` | 86 |
| `lib/scope.ts` | `lib/access/scope.ts` | 77 |
| `lib/permissions.ts` | `lib/access/permissions.ts` | 39 |
| `lib/auth.ts` | `lib/access/auth.ts` | 38 |
| `lib/constants.ts` | `lib/core/constants.ts` | 35 |
| `lib/env.ts` | `lib/core/env.ts` | 33 |
| `lib/events.ts` | `lib/core/events.ts` | 32 |
| `lib/query-timing.ts` | `lib/core/query-timing.ts` | 25 |
| `lib/export.ts` | `lib/export/export.ts` | 20 |
| `lib/export-configs.ts` | `lib/export/configs.ts` | 17 |
| `lib/brand-view.ts` | `lib/access/brand-view.ts` | 17 |
| `lib/pagination.ts` | `lib/shared/pagination.ts` | 16 |
| `lib/cached-reference-data.ts` | `lib/core/cached-reference-data.ts` | 15 |
| `lib/roles.ts` | `lib/access/roles.ts` | 11 |
| `lib/useUrlFilters.ts` | `lib/hooks/useUrlFilters.ts` | 10 |
| `lib/csv.ts` | `lib/shared/csv.ts` | 10 |
| `lib/fuzzy-search.ts` | `lib/shared/fuzzy-search.ts` | 9 |
| `lib/brand-guard.ts` | `lib/access/brand-guard.ts` | 9 |
| `lib/s3-guard.ts` | `lib/access/s3-guard.ts` | 6 |
| `lib/api-error-message.ts` | `lib/shared/api-error-message.ts` | 6 |
| `lib/numeric.ts` | `lib/shared/numeric.ts` | 4 |
| `lib/build-info.ts` | `lib/core/build-info.ts` | 4 |
| `lib/pages.ts` | `lib/access/pages.ts` | 3 |
| `lib/admin-guards.ts` | `lib/access/admin-guards.ts` | 3 |
| `lib/request-context.ts` | `lib/core/request-context.ts` | 1 |
| `lib/db-sku.ts` | `lib/core/db-sku.ts` | 1 |
| `lib/utils.ts` | **stays** | 97 |

**Phase 1b** (integrations): `lib/s3.ts` (12) and `lib/import-s3.ts` (11) → `lib/integrations/aws/`; `lib/mfg-facility-push.ts` (1) and `lib/mfg-facility-sync.ts` (2) → `lib/integrations/uniware/`; then the `uniware/`, `nanonets/`, `mail/`, `aws/`, `pdf/` folders move as-is.

## 6. Phase 2 — what one domain move looks like (procurement)

```
lib/procurement/
  po/            ← lib/po/*
  invoice/       ← lib/invoice/*   (local/ parsers included)
  gatepass/      ← lib/gatepass/*
  queries/       ← lib/queries/{purchase-orders, supplier-invoices, invoice-revert, uniware-documents, uniware-grn, s3-files}.ts
  validation/    ← lib/validation/{purchase-orders, purchase-order-detail, invoice-verify, gatepass}.ts
  approval-handlers/ ← lib/approvals/handlers/{purchase-orders, invoice-revert}.ts
```

`lib/approvals/module-handlers.ts` then imports handlers from each domain, and `lib/approvals/` keeps only the engine. Renames worth doing while files are already moving: `supplier-invoices.ts` → `invoices.ts` (the table is `invoice_mfg`), `sku-details.ts` → `dwh-products.ts` (it reads the DWH, not `details_sku`).

Splitting the 1,337-line `purchase-orders.ts` query file is **not** part of this plan — a move and a split in one diff can't be reviewed. It's a follow-up once the file sits in its domain.

## 7. Who and how

- The moves are mechanical: `git mv` plus an import-rewrite script (§4 rules: quoted specifiers, longest first, both alias and relative forms). Either Claude runs it per folder and you review each commit, or you run it from the script.
- ~30 minutes per Phase 1 commit, including G1. Phase 2 is about half a day per domain.
- Nothing touches the database, the deploy or any API path, so there is no prod gate. Each step can be reverted with one `git revert`.

## 8. Not in scope

- Splitting large files (`queries/purchase-orders.ts`, `mail/mailer.ts`)
- Moving routes out of `app/api/`
- Changing any function signature, SQL or behaviour
- Removing `any` / `eslint-disable`
