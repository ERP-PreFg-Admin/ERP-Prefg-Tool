/**
 * Display-side mirror of resolveAccess in lib/permissions.ts.
 *
 * The admin UI used to show only the *stored* value of a row — Inherit / None /
 * Viewer / Editor — which is not the question anyone opens this page to answer.
 * "Inherit" tells you a row is absent; it doesn't tell you what the user ends up
 * with, or which grant decided it. This resolves both, so every row can state
 * its effect and its provenance.
 *
 * It must track lib/permissions.ts exactly, including the part that surprises
 * people: the walk checks override *then* role at each slug level before moving
 * up. So a role grant on /masters/vendors beats an override on /masters — depth
 * wins before layer does. Any change to resolveAccess belongs here too.
 */

import type { AccessLevel } from "@/lib/permissions"

/** "" is the absence of a row, which is what the Inherit option writes. */
export type CellValue = "" | AccessLevel

/** user_roles arrives as one comma-joined string. Lives here rather than in a
 *  client component so the server layout can use it without pulling one in. */
export function splitRoles(roles: string | null): string[] {
  return roles ? roles.split(",").filter(Boolean) : []
}

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, editor: 2 }

/** "/masters/vendors" → "/masters". Top-level slugs have no parent: "/masters"
 *  does not fall back to "/", which is why /admin is deny-by-default. */
export function parentSlug(slug: string): string | null {
  const i = slug.lastIndexOf("/")
  return i <= 0 ? null : slug.slice(0, i)
}

export function bestAccess(levels: AccessLevel[]): AccessLevel {
  return levels.reduce<AccessLevel>(
    (best, cur) => (ACCESS_RANK[cur] > ACCESS_RANK[best] ? cur : best),
    "none"
  )
}

/** What the user actually gets. "blocked" is an explicit none — a deliberate
 *  stop — as opposed to "absent", which is simply no grant anywhere. */
export type Effect = "editor" | "viewer" | "blocked" | "absent"

export type Resolution = {
  effect: Effect
  /** Which layer won, null when nothing matched at any level. */
  layer: "override" | "role" | null
  /** The slug carrying the winning row. Equal to the row's own slug when set
   *  directly, an ancestor when inherited, null when nothing matched. */
  from: string | null
}

const effectOf = (level: AccessLevel): Effect => (level === "none" ? "blocked" : level)

/**
 * Walk the slug up its parents, checking override then role at each level.
 *
 * `overrideAt` / `roleAt` return "" when no row exists at that slug.
 */
export function resolveForDisplay(
  slug: string,
  overrideAt: (s: string) => CellValue,
  roleAt: (s: string) => CellValue
): Resolution {
  let cursor: string | null = slug
  while (cursor) {
    const override = overrideAt(cursor)
    if (override !== "") return { effect: effectOf(override), layer: "override", from: cursor }

    const role = roleAt(cursor)
    if (role !== "") return { effect: effectOf(role), layer: "role", from: cursor }

    cursor = parentSlug(cursor)
  }
  return { effect: "absent", layer: null, from: null }
}

/** Build a `roleAt` for one role from the flat page_permissions list. */
export function roleLookup(
  rows: { role: string; page_slug: string; access_level: string }[],
  roleKey: string
): (s: string) => CellValue {
  const map = new Map(
    rows.filter((r) => r.role === roleKey).map((r) => [r.page_slug, r.access_level as AccessLevel])
  )
  return (s) => map.get(s) ?? ""
}

/**
 * Build a `roleAt` across every role a user holds — the union, best level wins,
 * matching resolveAccess's bestAccess over `role IN (...)`.
 */
export function rolesLookup(
  rows: { role: string; page_slug: string; access_level: string }[],
  roleKeys: string[]
): (s: string) => CellValue {
  const held = new Set(roleKeys)
  const bySlug = new Map<string, AccessLevel[]>()
  for (const r of rows) {
    if (!held.has(r.role)) continue
    const list = bySlug.get(r.page_slug) ?? []
    list.push(r.access_level as AccessLevel)
    bySlug.set(r.page_slug, list)
  }
  return (s) => {
    const levels = bySlug.get(s)
    return levels?.length ? bestAccess(levels) : ""
  }
}

/**
 * Resolve every page for one subject and tally the outcomes.
 *
 * `reachable` counts only pages the user can actually open (viewer or editor) —
 * the headline number, since "no access" is the default state of most slugs and
 * counting it says nothing.
 */
export type AccessSummary = {
  editor: number
  viewer: number
  blocked: number
  absent: number
  reachable: number
}

export function summariseAccess(
  slugs: readonly string[],
  overrideAt: (s: string) => CellValue,
  roleAt: (s: string) => CellValue
): AccessSummary {
  const out: AccessSummary = { editor: 0, viewer: 0, blocked: 0, absent: 0, reachable: 0 }
  for (const slug of slugs) {
    out[resolveForDisplay(slug, overrideAt, roleAt).effect] += 1
  }
  out.reachable = out.editor + out.viewer
  return out
}

// ── Visual language ──────────────────────────────────────────────────────────
// Two independent encodings, deliberately not conflated:
//   colour       = the effect      (what the user gets)
//   border style = the provenance  (where it was decided)
// So a glance down a column reads access levels, and a glance down the rail
// reads which rows are actually configured versus coasting on a parent.

export const EFFECT_LABEL: Record<Effect, string> = {
  editor: "Editor",
  viewer: "Viewer",
  blocked: "Blocked",
  absent: "No access",
}

/** Text colour for the effect, reusing the palette the access select already
 *  established (emerald for editor, destructive for a block). */
export const EFFECT_TEXT: Record<Effect, string> = {
  editor: "text-emerald-700 dark:text-emerald-400",
  viewer: "text-primary",
  blocked: "text-destructive",
  absent: "text-muted-foreground",
}

export const EFFECT_DOT: Record<Effect, string> = {
  editor: "bg-emerald-600 dark:bg-emerald-400",
  viewer: "bg-primary",
  blocked: "bg-destructive",
  absent: "bg-muted-foreground/40",
}

/** The left rail: solid where the row is configured here, dashed where it is
 *  inheriting, absent where nothing governs it at all. */
export function railClass(r: Resolution, ownSlug: string): string {
  if (r.layer === null) return "border-l-2 border-l-transparent"
  const inherited = r.from !== ownSlug
  const colour =
    r.effect === "editor" ? "border-l-emerald-500"
    : r.effect === "viewer" ? "border-l-primary"
    : r.effect === "blocked" ? "border-l-destructive"
    : "border-l-border"
  return `border-l-2 ${inherited ? "border-dashed" : "border-solid"} ${colour}`
}

/** One short clause naming where the effect was decided. */
export function provenanceLabel(r: Resolution, ownSlug: string): string {
  if (r.layer === null) return "no grant anywhere"
  if (r.from === ownSlug) return r.layer === "override" ? "override, set here" : "set here"
  return r.layer === "override" ? `override on ${r.from}` : `from ${r.from}`
}
