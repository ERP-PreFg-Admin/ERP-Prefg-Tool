// Throwaway check: does app/admin/authority.ts still resolve access the same way
// lib/permissions.ts does?
//
//   npx tsx scripts/_check-admin-authority.ts
//
// The admin UI states each page's resolved effect and where it came from. That
// is only worth showing if it matches the real gate — a display that disagrees
// with resolveAccess is worse than no display, because it will be believed.
// If resolveAccess changes, this fails.
import assert from "node:assert"
import {
  resolveForDisplay, roleLookup, rolesLookup, parentSlug, provenanceLabel, summariseAccess,
} from "../app/admin/authority"
import { roleDesignation, designationsOf, domainsOf } from "../lib/roles"

const rows = [
  { role: "rm_head", page_slug: "/masters",         access_level: "viewer" },
  { role: "rm_head", page_slug: "/masters/vendors", access_level: "editor" },
  { role: "rm_head", page_slug: "/admin",           access_level: "none"   },
]
const noOverride = () => "" as const
const roleAt = roleLookup(rows, "rm_head")

// The walk stops at top level: "/masters" has no parent, which is why /admin is
// deny-by-default rather than inheriting from "/".
assert.strictEqual(parentSlug("/masters/vendors"), "/masters")
assert.strictEqual(parentSlug("/masters"), null)
assert.strictEqual(parentSlug("/"), null)

let r = resolveForDisplay("/masters/vendors", noOverride, roleAt)
assert.deepStrictEqual([r.effect, r.layer, r.from], ["editor", "role", "/masters/vendors"])
assert.strictEqual(provenanceLabel(r, "/masters/vendors"), "set here")

r = resolveForDisplay("/masters/skus", noOverride, roleAt)
assert.deepStrictEqual([r.effect, r.layer, r.from], ["viewer", "role", "/masters"])
assert.strictEqual(provenanceLabel(r, "/masters/skus"), "from /masters")

// An explicit 'none' is a row: it wins its level and stops the climb.
assert.strictEqual(resolveForDisplay("/admin", noOverride, roleAt).effect, "blocked")

// No row at any level.
r = resolveForDisplay("/finance", noOverride, roleAt)
assert.deepStrictEqual([r.effect, r.layer, r.from], ["absent", null, null])

// The one everyone gets wrong: depth beats layer. resolveAccess checks override
// then role at EACH slug before moving up, so a role grant on the child outranks
// an override on the parent.
const overrideAt = (s: string) => (s === "/masters" ? ("none" as const) : ("" as const))
r = resolveForDisplay("/masters/vendors", overrideAt, roleAt)
assert.strictEqual(r.effect, "editor", "child role grant must beat parent override")
assert.strictEqual(r.layer, "role")

// Same override does win where the child has no grant of its own.
r = resolveForDisplay("/masters/skus", overrideAt, roleAt)
assert.strictEqual(r.effect, "blocked")
assert.strictEqual(provenanceLabel(r, "/masters/skus"), "override on /masters")

// Several roles on one slug take the best level, matching bestAccess().
const multi = rolesLookup(
  [
    { role: "rm_lead", page_slug: "/masters", access_level: "viewer" },
    { role: "pm_lead", page_slug: "/masters", access_level: "editor" },
  ],
  ["rm_lead", "pm_lead"]
)
assert.strictEqual(resolveForDisplay("/masters", noOverride, multi).effect, "editor")

// ── Designation, derived from the role key ───────────────────────────────────
// rm_head is Raw Material + Head. Nothing stores designation separately, so a
// user holding roles across domains carries several, most senior first.
assert.strictEqual(roleDesignation("rm_head"), "head")
assert.strictEqual(roleDesignation("developer"), undefined, "system roles hold no org position")
assert.deepStrictEqual(designationsOf(["cost_executive", "rm_head"]), ["head", "executive"])
assert.deepStrictEqual(designationsOf(["rm_head", "pm_head"]), ["head"], "deduped across domains")
assert.deepStrictEqual(designationsOf(["admin"]), [])
assert.deepStrictEqual(domainsOf(["cost_executive", "rm_head"]), ["rm", "cost"])

// ── Roster summary ───────────────────────────────────────────────────────────
// "reachable" is viewer + editor: the pages that actually open. Blocked and
// absent are both no-entry, but only one of them was somebody's decision.
const summarySlugs = ["/masters", "/masters/vendors", "/masters/skus", "/admin", "/finance"]
const summary = summariseAccess(summarySlugs, noOverride, rolesLookup(rows, ["rm_head"]))
assert.deepStrictEqual(
  [summary.editor, summary.viewer, summary.blocked, summary.absent, summary.reachable],
  [1, 2, 1, 1, 3],
  JSON.stringify(summary)
)

// No roles and no overrides is the stranded account the roster flags in amber.
assert.strictEqual(summariseAccess(summarySlugs, noOverride, rolesLookup(rows, [])).reachable, 0)

console.log("OK — designation and summary")
