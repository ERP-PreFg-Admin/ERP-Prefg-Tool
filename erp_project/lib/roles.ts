/**
 * The canonical role taxonomy — counterpart to lib/pages.ts.
 *
 * Roles used to be free text: `user_roles.role` and `page_permissions.role` are
 * plain VARCHAR(100), and the list shown in the admin UI was *derived* by
 * unioning those two tables. A typo in the Users dialog silently created a
 * permanent new role. This file replaces that with a declared list.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 * Twelve org roles: four domains (RM · PM · Production · Cost) x three
 * designations (Head · Lead · Executive), keyed as `${domain}_${designation}`.
 * Plus two system roles, `developer` and `admin`, which have no designation
 * because they aren't org positions.
 *
 * The key is a single lowercase string on purpose. `user_roles` has a composite
 * PK of (user_id, role), the JWT carries `roles: string[]`, and resolveAccess
 * matches on the string — so encoding designation *into* the key means no schema
 * change, no new column, and each of the twelve is independently grantable.
 *
 * ── What a role does NOT do ───────────────────────────────────────────────
 * Nothing in the app branches on a role name; there is no `if (role === ...)`
 * anywhere. A role's only power is the `page_permissions` rows attached to it
 * (see lib/permissions.ts resolveAccess). `approver: true` on Head is
 * descriptive — it documents why Heads are seeded `editor` on /approvals, and
 * drives a UI hint. The actual gate is still the page permission.
 */

export const DOMAINS = [
  { key: "rm", label: "Raw Material" },
  { key: "pm", label: "Packing Material" },
  { key: "production", label: "Production" },
  { key: "cost", label: "Cost" },
] as const

export const DESIGNATIONS = [
  { key: "head", label: "Head", approver: true },
  { key: "lead", label: "Lead", approver: false },
  { key: "executive", label: "Executive", approver: false },
] as const

/** No designation — these gate the tool itself, not a position in the org. */
export const SYSTEM_ROLES = [
  { key: "developer", label: "Developer" },
  { key: "admin", label: "Admin" },
] as const

export type Role = {
  /** Stored value, e.g. "rm_head" or "developer". Lowercase, [a-z_] only. */
  key: string
  /** Display label, e.g. "Raw Material - Head". */
  label: string
  /** Grouping label for pickers: the domain name, or "System". */
  group: string
  domain?: string
  designation?: string
  /** Heads approve; see the file header for what this does and doesn't mean. */
  approver: boolean
}

export const ROLES: Role[] = [
  ...SYSTEM_ROLES.map((r) => ({
    key: r.key,
    label: r.label,
    group: "System",
    approver: false,
  })),
  ...DOMAINS.flatMap((d) =>
    DESIGNATIONS.map((g) => ({
      key: `${d.key}_${g.key}`,
      label: `${d.label} - ${g.label}`,
      group: d.label,
      domain: d.key,
      designation: g.key,
      approver: g.approver,
    }))
  ),
]

/** For z.enum validation on the users and permissions routes. */
export const ROLE_KEYS = ROLES.map((r) => r.key) as [string, ...string[]]

export const ROLE_BY_KEY: Record<string, Role> = Object.fromEntries(
  ROLES.map((r) => [r.key, r])
)

export const DESIGNATION_LABELS: Record<string, string> = Object.fromEntries(
  DESIGNATIONS.map((d) => [d.key, d.label])
)

/** Most senior first — the order designations are listed and sorted in. */
export const DESIGNATION_ORDER = DESIGNATIONS.map((d) => d.key)

/** undefined for the two system roles, which hold no org position. */
export function roleDesignation(key: string): string | undefined {
  return ROLE_BY_KEY[key]?.designation
}

export function roleDomain(key: string): string | undefined {
  return ROLE_BY_KEY[key]?.domain
}

/**
 * The distinct designations a set of roles carries, most senior first.
 *
 * A user can hold roles across domains — "RM Head" plus "Cost Executive" — so
 * this is a list, not a single value. Deriving it from the roles rather than
 * storing a `users.designation` column keeps one source of truth: a column
 * could disagree with the roles actually granted, and the roles are what
 * resolveAccess reads.
 */
export function designationsOf(roleKeys: string[]): string[] {
  const found = new Set(roleKeys.map(roleDesignation).filter(Boolean) as string[])
  return DESIGNATION_ORDER.filter((d) => found.has(d))
}

/** The distinct domains a set of roles covers, in DOMAINS order. */
export function domainsOf(roleKeys: string[]): string[] {
  const found = new Set(roleKeys.map(roleDomain).filter(Boolean) as string[])
  return DOMAINS.map((d) => d.key).filter((d) => found.has(d))
}

export const DOMAIN_LABELS: Record<string, string> = Object.fromEntries(
  DOMAINS.map((d) => [d.key, d.label])
)

export const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r.key, r.label])
)

/** The four *_head keys — seeded `editor` on /approvals. */
export const APPROVER_ROLES = ROLES.filter((r) => r.approver).map((r) => r.key)

/**
 * False for any legacy string still sitting in the DB (a schema that hasn't had
 * prisma/migrate_role_taxonomy.sql applied). The Users table flags these rather
 * than rendering them as if they were real.
 */
export function isKnownRole(key: string): boolean {
  return ROLE_LABELS[key] !== undefined
}

/** Label for display, falling back to the raw value for unmigrated strings. */
export function roleLabel(key: string): string {
  return ROLE_LABELS[key] ?? key
}
