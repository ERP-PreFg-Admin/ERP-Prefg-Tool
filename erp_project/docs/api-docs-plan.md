# API Documentation — Depth Pass, Information Flow, and Diagram Artifact

## Context

You asked for three things: more detail on every API route (why it exists, its request
and response, an example payload), an overall picture of how information flows between
the APIs, and a diagram or artifact for that flow.

Investigating first changed what this job is.

**The per-route work largely exists already.** `ERP Project/api-docs/` holds 10 markdown
files, 179 KB, generated 2026-09-22 against `main` at `9158671` — still HEAD. It mentions
**all 89 routes, none missing**, and 58 of them have a dedicated section with rationale,
payload, response and an error table. I spot-checked its sharper claims against source and
they hold: rate limiting really does ship in shadow mode (`lib/gateway/rate-limit.ts:44`),
and `app/api/v2/files/view/route.ts:40` really does write the header name
`Content-Diposition` with a colon separator.

**It is invisible.** `.gitignore` lines 14–15 exclude it — added in your current
uncommitted working tree — so it is outside version control, outside `docs/`, and unknown
to `docs/README.md`. It will rot where it sits.

**The in-repo doc is the thin one.** `docs/api-reference.md` is 1790 lines and is item 5
of 7 in the README's mandatory reading order, but only ~49 routes have a body, 40 are
index rows, no route states its access slug or scope rule, and there is no TOC.

**The flow picture genuinely does not exist.** `api-docs/` has zero mermaid and zero
cross-module content. No doc in the repo traces masters → costing → PO → invoice → GRN →
three-way match → payment. That is the real new work, and it is the part you cannot get by
moving files around.

Outcome: one in-repo API reference at full depth for all 89 routes, one flow document that
explains how the APIs feed each other, and a shareable artifact of that flow.

---

## Decisions taken

| # | Decision | Consequence |
|---|---|---|
| 1 | `api-docs/` **moves into the repo** as `erp_project/docs/api/` | Un-ignore it; the per-domain split survives; nothing is rewritten from scratch |
| 2 | **Full depth for all 89 routes** | 58 sections get verified, **31 get promoted** from a grouped mention to their own entry |
| 3 | `docs/api-reference.md` **becomes an index** that links into `docs/api/` | One canonical home; the 1790-line file stops competing with it |
| 4 | New `docs/api-information-flow.md`, **mermaid** | Matches house style — 9 docs already use it, 41 blocks |
| 5 | **Plus a published HTML artifact** of the flow map | Shareable link for people who will not open the repo |
| 6 | **Drift gets fixed** and listed | Known: the vendors payload contradiction, pre-rename table names, `architecture.md`'s MariaDB/`auth()` diagram |
| 7 | **Code bugs get documented and listed, never fixed** in this pass | Including the four in `app/api/v2/files/view/route.ts` |

**Governing constraint:** everything written must be checked against source. The existing
`api-docs/` is good but unverified by me at scale, and a confidently wrong API doc is worse
than a thin one — it gets trusted. Verification is the bulk of the effort, not writing.

---

## Phases and gates

### Phase 0 — Land the move cleanly · GATE: your go-ahead before anything else

Untangle the working tree first, because `.gitignore` and `docs/api-reference.md` both
already carry uncommitted edits and this phase touches both.

1. `git mv`-equivalent: copy `api-docs/*` → `erp_project/docs/api/`, drop the two
   `api-docs` lines from the root `.gitignore`.
2. Leave the original `api-docs/` in place until Phase 3 exits, so there is an untouched
   reference copy if a verification pass corrupts something.

**Exit:** `docs/api/` exists with 10 files, `git status` shows them as new tracked files,
nothing else in the tree changed.

**Owner of the business call:** you — whether `api-docs/` was ignored as scratch or on
purpose. If it was deliberate, say so now and Phase 0 inverts into "enrich
`api-reference.md` in place instead".

---

### Phase 1 — Mechanical extraction · no judgement, no context burn

Before reading a single route by hand, pull the facts that are greppable into one table:
`access` slug and level, `scope` rule, `rateLimit`, which `schema` is bound, exported HTTP
methods, `runtime`/`maxDuration`, and whether the route is `withGateway`-wrapped at all.

This is one pass over `app/api/**/route.ts` producing a generated table that every later
phase checks against, and it catches the cheap errors (a doc claiming `viewer` where the
code says `editor`) without a model reading 89 files.

**Exit:** a machine-extracted table of all 89 routes; diffed against what `docs/api/`
currently claims; disagreements listed.

---

### Phase 2 — Verify the 58 existing sections · domain by domain

Order chosen by blast radius, hardest first while attention is freshest:

1. `approvals.md` (5) — the app's most important mutation, and the one with no Zod schema
2. `invoice.md` (7) — the NDJSON pipeline, the rollback ordering, three-way match
3. `uniware.md` (11) — external calls, the shadow-mode limits, the two ungated routes
4. `purchase-orders.md` (14) — the status machine and tolerance rules
5. `masters.md` (27) — repetitive; the action-discriminator pattern repeats
6. `manufacturing.md` (9), `admin-and-files.md` (12), `v2.md` (4)
7. `00-conventions.md` last — it is the contract the others defer to, so it settles once
   the departures are known

**Exit per file:** every claim traced to a line of source, every example payload checked
against its Zod schema in `lib/validation/*`, every error code checked against what the
handler actually throws.

---

### Phase 3 — Promote the 31 thin routes to full depth

These are mentioned but have no section of their own:

- **Export family (14)** — the seven `manufacturing/[mfgId]/*/export`, plus
  `masters/{skus,vendors,manufacturers,material-master,raw-materials,packing-materials,recipe-master}/export`.
  They share one pattern (`format` param, `ROW_LIMIT` pre-count → 413, scope pushed into
  SQL via `filterParams`, columns from `lib/export-configs.ts`). Document the pattern once,
  then one short entry each recording only what differs.
- **Rate bulk + history (8)** — `{raw,packing}-materials/{mrm,vrm}-{bulk,history}`.
- **The rest (9)** — `gatepass/create`, `masters/warehouses`, `masters/vendors/history`,
  `masters/manufacturers/history`, `masters/recipe-master/history/[id]`,
  `purchase-orders/[id]/close`, `/mfg-skus`, `/open-for-receive`, `/quote-rate`.

`quote-rate` deserves more than its size suggests — it is where the costing chain becomes a
PO price, and it is the seam Phase 4's costing diagram has to land on.

**Exit:** 89 dedicated entries; `api-docs/` original deleted.

---

### Phase 4 — `docs/api-information-flow.md` · the genuinely new work

Nine sections, each earning a different diagram rather than nine that look alike:

| Section | Diagram | What only this one shows |
|---|---|---|
| The `withGateway` pipeline | `flowchart` | The 9 ordered stages and which HTTP status each can emit — the funnel every other flow passes through |
| Masters create + approval gate | `sequenceDiagram` | The two-transaction shape: submit writes `in_review` + `approvals` + `approval_items`; approve applies via `MODULE_HANDLERS` |
| Approval state machine | `stateDiagram` | `pending → approved/rejected`, and the entity's parallel `active/in_review/rejected` track |
| Costing chain | `flowchart` | Data dependency, not time: vendor rate → mfg rate → recipe → misc → final costing → `quote-rate` → PO `unit_price` |
| PO lifecycle | `stateDiagram` | `draft → raised → split/partially_received → received/cancelled/short_close`, plus the `isDraftPo()` display quirk |
| Invoice inwarding | *link out* | `docs/po-inwarding.md` already has a good sequenceDiagram — link it, do not duplicate |
| Three-way match + payment | `flowchart` | The three legs (`po`/`pod`/`inv`), which are stored vs derived, and where the human sign-off enters |
| Uniware sync sweeps | `sequenceDiagram` | Which of the 18 endpoints each sweep calls, and the 200-with-`successful:false` trap |
| Email + SES bounce loop | `sequenceDiagram` | The one unauthenticated write path and why its signature check is the whole access control |

Plus a **cross-module spine**: one flowchart tracing a single SKU from master creation
through to a paid supplier invoice, with each hop labelled by the route that performs it.
That spine is the thing no existing doc has.

**Exit:** every diagram's claims traceable to Phases 1–3; `docs/README.md` updated.

---

### Phase 5 — The published artifact · GATE: you see the mermaid first

A single self-contained HTML page of the flow map, published to a private claude.ai link.
It renders the same flows interactively — pick a flow, see its steps, click through to the
route that performs each hop.

Deliberately built **after** Phase 4, from the verified markdown, so the artifact cannot
say something the repo does not.

---

### Phase 6 — Drift fixes and the bug list

Fix, and list what changed:

- `docs/api-reference.md` — vendors `create` says `code` is server-generated in its action
  table then `Required: Yes` in the field table; names `vendors`/`vendor_details` for what
  are really `master_vendors`/`details_vendor`.
- `docs/architecture.md` — its mutation-lifecycle mermaid says MariaDB (it is MySQL 8.0)
  and shows per-route `auth()`, which `withGateway` replaced.
- `docs/masters-module.md` — pre-rename table names (`bom`, `bom_details`, `skus`).
- `docs/po-inwarding.md` — refers to `lib/uniware.ts` and `lib/nanonets.ts` as single
  files; both are directories now.

Deliver separately, **changing no code**, a ranked defect list:

1. `app/api/v2/files/view/route.ts:40` — header name `Content-Diposition` (missing `s`) and
   a `:` where the spec wants `;`. **`download=1` silently does nothing** and no filename
   is ever suggested.
2. Same file — error code `"Validation_error"` against a lower-snake codebase; message
   *"Could now read file."*
3. `POST /api/v1/approvals/[id]` — no Zod schema; the app's most important mutation is its
   least validated, and its failures return the legacy `{ error }` shape.
4. Rate limiting is in shadow mode unless `RATE_LIMIT_MODE=enforce` — nothing is limited.
5. Nine routes have no in-repo caller (`/approvals` GET, `/approvals/history`, the two
   masters `history` routes, `/files/preview` v1, `/debug-env-check`, `/uniware-grn`,
   `/[id]/preview-pdf`, `/v2/facilities/po-code`). Reported, never removed — per your
   standing rule that a URL can have callers grep cannot see.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **Dirty working tree.** `.gitignore` and `docs/api-reference.md` already have uncommitted edits; Phase 0 touches both | Phase 0 is its own gate. Commit or stash the existing edits first — your call which |
| **`api-docs/` was ignored deliberately** | Phase 0's owner-gate asks before the move. Inverting costs nothing if caught there |
| **Confidently wrong docs.** The source is unverified at scale | Phases 1–3 exist only for this. Phase 1 catches the cheap errors mechanically before any hand-reading |
| **Docs start rotting immediately.** No generator, no linter, nothing detects drift | Add one `tests/unit/` check in the house style (`node:test` via `tsx`, no new dependency): assert every `route.ts` under `app/api` has a matching entry in `docs/api/`. It catches a *new* route with no docs — the most common rot — and nothing more. It is a near-clone of `tests/unit/route-scope.test.ts`, which already walks `app/api` recursively, matches on a regex, and carries an `EXEMPT` map where each exception must state its reason. Same shape, same file layout, ~40 lines |
| **Artifact and repo diverge** | Phase 5 is built from the Phase 4 markdown, never in parallel with it |
| **Scope creep into fixing code** | Decision 7 is absolute. The defect list is a deliverable, not a work item |

---

## Critical files

**Read to verify:** `lib/gateway/with-gateway.ts` · `lib/gateway/errors.ts` ·
`lib/gateway/scope-rules.ts` · `lib/gateway/rate-limit.ts` · `lib/validation/*.ts` (16) ·
`lib/scope.ts` · `lib/approvals/module-handlers.ts` · `lib/costing/final-costing.ts` ·
`lib/invoice/invoice-inward.ts` · `lib/po/po-rules.ts` · `lib/uniware/endpoints.ts` ·
`app/api/**/route.ts` (89).

**Reuse, do not re-derive:** `docs/api/00-conventions.md` (the shared contract, already
written) · `docs/po-inwarding.md`'s sequenceDiagram · `docs/business-architecture.md` §9
Workflow Catalogue and §10 State Transitions · `lib/export-configs.ts` for the export
family's column sets.

**Write:** `docs/api/*` (10 files) · `docs/api-information-flow.md` ·
`docs/api-reference.md` (reduced to an index) · `docs/README.md` (index entry) ·
`.gitignore` (drop 2 lines) · one `tests/unit/` drift check ·
`docs/api-docs-plan.md` (this plan, saved into the repo per standing preference).

---

## Verification

- `npx tsc --noEmit --incremental false` and `npm run lint:changed` — should be untouched;
  this pass writes no application code.
- `npm test` — must stay green, and must now include the new docs-coverage check.
- Mermaid renders: every fenced block parses on GitHub's renderer.
- Spot-check contract: pick 10 routes at random across domains and confirm the documented
  access slug, scope rule and error codes match source.
- Every internal doc link resolves — no `./api/x.md` pointing at a file that moved.
