# Permissions: make every check read the slug that was granted

Status: **D1–D4 approved as recommended (2026-10-05); D5 not taken. Phase 0 done — see results
at the end.** No code changed yet.

## The problem in one paragraph

The admin grid grants access per page (`/po-tracking/po-procurement`, `/po-tracking/invoices`, …).
`resolveAccess` (lib/permissions.ts) walks a slug **up** to its parents, never down. Most PO pages
and 23 PO API routes check the parent `/po-tracking`, so a grant on a child page is never read: the
sidebar shows the page unlocked, then the page or its API calls fall back to the user's role and
answer "Access denied". Prod users hit today: sudipta.biswas (editor on three PO pages, nothing on
`/po-tracking`), rakesh.das (editor on Invoices, viewer on `/po-tracking`), abhiraj.singh (recipe
history checks `/masters`). yogesh.gaikwad works only because he also holds `/po-tracking`.

## Governing rule

**A check names the page the action belongs to — the same slug the admin grid shows for that page.**
A route serving more than one page passes if the user holds the required level on **any** of them.
The parent slug keeps working as "all PO pages", because children already inherit it.

## Decisions (owner: Ajay) — needed before Phase 1

| # | Decision | Recommendation |
|---|---|---|
| D1 | Shared routes: "editor on any owning page" passes | Yes. The alternative (split routes per page) is far larger and changes URLs. |
| D2 | Approve the route → page map below | Review every row; this is the real content of the change. |
| D3 | `/manufacturing/facility-map` (+ `/sync`) is called by MFG Overview but checks `/manufacturing` — same bug class, outside `/po-tracking` | Include it (add `/po-tracking/mfg-overview` as a second owner). Opt-in. |
| D4 | `purchase-orders/uniware-grn` has no UI caller | Leave on `/po-tracking` (parent-only) until a page uses it. |
| D5 | Unblock sudipta / rakesh by data before the fix ships? | Your call. A `/po-tracking` editor grant unblocks them but opens every PO page; remove it after Phase 4. |

## Route → page map (D2)

| Route(s) | Checks today | Should check (any of) |
|---|---|---|
| `purchase-orders` (list/create), `[id]`, `[id]/cancel`, `close`, `receive`, `split`, `inwarding`, `preview-pdf`, `export`, `history`, `send-mail`, `quote-rate` | `/po-tracking` | `/po-tracking/po-procurement` |
| `entity-emails` (+ the entity-emails page) | `/po-tracking` | `/po-tracking/po-procurement` |
| `purchase-orders/mfg-skus` | `/po-tracking` | po-procurement, po-inwarding |
| `open-for-receive`, `invoice/sku-history`, v2 `invoice/parse` | `/po-tracking` | `/po-tracking/po-inwarding` |
| `invoice` (list/create), `invoice/[id]`, `invoice/summary` | `/po-tracking` | invoices, po-inwarding |
| `invoice/export`, `invoice/[id]/documents`, `payment`, `verify` | `/po-tracking/invoices` | unchanged |
| `uniware-status`, `uniware-documents` (sync buttons) | `/po-tracking` | po-procurement, invoices |
| `uniware-grn` | `/po-tracking` | unchanged (D4) |
| `manufacturing/facility-map`, `/sync` | `/manufacturing` | `/manufacturing`, `/po-tracking/mfg-overview` (D3) |

Pages: po-procurement, po-inwarding, rm-pm-procurement (placeholder) and entity-emails check their
own slug instead of `/po-tracking`; recipe-master history checks `/masters/recipe-master`.

## Phases and gates

**Phase 0 — Baseline (read-only).** Snapshot every user's *effective* access per page and per route
under today's rules, from prod `user_page_permissions` + `page_permissions` (roles included — role
rows on child slugs have not been checked yet).
*Exit gate:* the snapshot exists and the affected-user list is confirmed.

**Phase 1 — Gateway accepts a list of slugs.** `access.pageSlug` takes one slug or several;
resolution unchanged per slug, best result wins. Single-slug routes behave exactly as today.
*Exit gate:* unit tests for one slug, any-of, parent inheritance, and an explicit `none` override.

**Phase 2 — Re-point pages and routes per the approved map.** Dev schema first.
*Exit gate:* the Phase 0 snapshot is re-run under the new rules and **every** difference is in
the expected direction (see Risk 1) and signed off.

**Phase 3 — Drift guard.** A test that fails when a route or page checks a slug not in
`lib/pages.ts`, so a new route cannot quietly check the wrong one.

**Phase 4 — Test → prod.** Deploy to test, have sudipta and rakesh (or you, impersonating their grants
on test) walk their pages: open, create/edit, sync. Prod only after a separate go-ahead. Then remove
any stop-gap D5 grants.

## Risks

1. **Narrowing — someone loses access.** A user with editor on `/po-tracking` but an explicit lower
   grant on a child (e.g. viewer on Invoices) passes today via the parent and would be held to the
   child after the fix. Today's data shows none, but Phase 0 must check roles too. Any hit is
   resolved per user before Phase 4, not discovered in prod.
2. **Widening — someone gains write.** Editor on Invoices now really allows invoice edits; editor on
   PO Inwarding now allows creating invoices. That is what the grants already say, but it is a change
   in behaviour — confirm it is intended for each affected user.
3. **Shared routes stay coarse.** Any-of means editor on Inwarding also passes invoice edits that
   only the Invoices page makes. Accepted for now; the fix for that is per-action rules, out of scope.

## Rollback

No schema or data change is required, so rollback is a revert of the deploy. A D5 stop-gap grant is
the only data change and is removed by deleting that one row.

## Out of scope

Entity scope (mfg / warehouse, `lib/scope.ts`, `assertKeyReadable`), the admin grid UI, sidebar logic,
and the meaning of an explicit `none` override — all unchanged.

## Phase 0 results (2026-10-05, prod, read-only)

22 users × 11 checks (5 pages, 6 API groups), resolved with the same walk as `resolveAccess`,
today's slugs vs planned slugs. Roles taken from `user_roles` in the DB.

**21 differences: 12 gains, 9 losses.**

Gains — all match grants already given in the admin grid:

| User | Gains | Comes from |
|---|---|---|
| sudipta.biswas | none → editor on PO procurement, inwarding, RM/PM, entity-emails pages; PO, mfg-skus, inwarding, invoice-core, uniware-sync APIs | user grants on the three PO child pages |
| rakesh.das | viewer → editor on invoice-core and uniware-sync APIs | user grant editor on Invoices (role finance_lead also has it) |
| dhwaneet.rathor | none → editor on facility-map APIs (D3) | user grant editor on `/po-tracking`, inherited by MFG Overview |

Note for Risk 3: sudipta gains invoice edits through PO Inwarding without any Invoices grant.

Losses — **all 9 are Kanchan@mcaffeine.com** (every PO page and PO API group, editor → viewer).
Cause: a second precedence rule in `resolveAccess`. Kanchan holds a *user* grant of editor on
`/po-tracking`, but role `cost_head` has *role* rows of viewer on all five PO child slugs. The walk
stops at the first slug with any grant, so a role grant on a child beats a user grant on the parent.
Today Kanchan escapes it only because most checks use `/po-tracking`; the Invoices and MFG Overview
pages (already on their own slug) hold Kanchan to viewer right now.

**New gate G0 (owner: Ajay) — resolve Kanchan before Phase 2 ships.** Recommended: delete
`cost_head`'s five child rows. They are redundant — the role already has viewer on `/po-tracking`,
which the children inherit. Simulated: Kanchan's 9 losses disappear, no other user's access changes,
and Kanchan's Invoices / MFG Overview pages go viewer → editor (what the `/po-tracking` grant says).
Alternative: give Kanchan user-level editor on the five child slugs. Changing the precedence rule
itself stays out of scope.

**Side finding, out of scope:** roles are read once at sign-in and cached in the session JWT
(`lib/auth.ts` jwt callback). Page grants are read live, but a *role* change only takes effect after
the user signs out and in again.

**G0 done 2026-10-05.** Deleted `cost_head`'s five `/po-tracking/*` viewer rows on prod (dev had none).
Baseline re-run: 12 differences, all gains, **0 losses**; no user's current access changed except
Kanchan's Invoices / MFG Overview pages (viewer → editor), as simulated. Rollback if ever needed:
re-insert `('cost_head', '/po-tracking/<invoices|mfg-overview|po-inwarding|po-procurement|rm-pm-procurement>', 'viewer')`.

**Phase 1 + 2 applied 2026-10-05** (uncommitted): `resolveAccessAny` + list-capable `access.pageSlug`,
28 route slugs, 5 page guards. `tsc` clean; only `uniware-grn` still checks `/po-tracking`.
Dev check as erp.prefg (none on `/po-tracking`, editor on FG POs + PO Inwarding): both pages open
after a dev-server restart — the long-running `next dev` had kept serving the old guards.
Still to confirm on dev: create/edit a PO and save an inward invoice; Invoices stays locked.
