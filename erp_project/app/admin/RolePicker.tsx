"use client"

/**
 * Role picker — choose the function, then the designation within it.
 *
 * ── Why it looks like this ──────────────────────────────────────────────────
 * The two choices are not siblings, so they aren't numbered as steps:
 * designation lives *inside* a chosen function. That containment is drawn with
 * the same solid left rail app/admin/authority.ts uses on the permissions table
 * for "decided at this level", and the chosen function's name carries the
 * heading face. Numbered "Step 1 / Step 2" labels would restate what the
 * indent already says.
 *
 * Designations render top-to-bottom as a ladder because DESIGNATION_ORDER in
 * lib/roles.ts is already ordered most-senior-first — a flat row of pills would
 * throw that away. Only the Head rung is marked, in the amber the rest of admin
 * uses for approvers: Head being the approval gate is the one consequence of
 * this choice an admin must see *before* making it, and the taxonomy's
 * `approver` flag exists to drive exactly this hint.
 *
 * The composed key is echoed in mono underneath, matching how role keys and page
 * slugs are shown everywhere else in admin — it names what is actually granted.
 *
 * Serves both callers through one `value` / `onChange` contract: the user dialog
 * as an adder (`value=""`, nothing stays selected) and the permissions page as a
 * selector (`value` holds the current role).
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { DOMAINS, DESIGNATIONS, SYSTEM_ROLES, roleDomain, isKnownRole } from "@/lib/roles"

/** Function key for the two roles that hold no org position. */
const SYSTEM = "__system"

const FUNCTIONS = [
  ...DOMAINS.map((d) => ({ key: d.key as string, label: d.label })),
  { key: SYSTEM, label: "System" },
]

/** Which function a role key sits under. "" for none, or an unmigrated value. */
function functionOf(roleKey: string): string {
  if (!roleKey || !isKnownRole(roleKey)) return ""
  return roleDomain(roleKey) ?? SYSTEM
}

const EYEBROW = "font-heading text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"

type Rung = { key: string; label: string; approver: boolean }

export function RolePicker({
  value,
  onChange,
  taken = [],
  suffixFor,
}: {
  /** Selected role key. "" in adder mode, where nothing stays selected. */
  value: string
  onChange: (roleKey: string) => void
  /** Role keys already held — shown as added, not removed from the ladder. */
  taken?: readonly string[]
  /** Optional trailing note per role, e.g. a page-grant count. */
  suffixFor?: (roleKey: string) => string
}) {
  // Seeded from `value` so a pre-selected role opens under its own function,
  // then held locally so an adder stays put for the next pick.
  const [fn, setFn] = useState(() => functionOf(value))

  const chosen = FUNCTIONS.find((f) => f.key === fn) ?? null

  const rungs: Rung[] =
    fn === SYSTEM
      ? SYSTEM_ROLES.map((r) => ({ key: r.key as string, label: r.label, approver: false }))
      : fn
        ? DESIGNATIONS.map((d) => ({ key: `${fn}_${d.key}`, label: d.label, approver: d.approver }))
        : []

  return (
    <div className="space-y-3">
      {/* ── Function ─────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className={EYEBROW}>Function</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {FUNCTIONS.map((f) => {
            const active = fn === f.key
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFn(f.key)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors",
                  FOCUS,
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Designation, inside the chosen function ──────────────────────── */}
      {!chosen ? (
        <p className="text-xs text-muted-foreground">Choose a function to see its roles.</p>
      ) : (
        <div
          // Solid rail = "you are inside this", the same language the
          // permissions table uses for a grant decided at its own level.
          className="border-l-2 border-solid border-l-primary/40 pl-3.5 space-y-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-heading text-sm font-bold text-foreground">{chosen.label}</span>
            <span className={EYEBROW}>{fn === SYSTEM ? "Role" : "Designation"}</span>
          </div>

          <div className="space-y-1">
            {rungs.map((r) => {
              const active = value === r.key
              const added = taken.includes(r.key)
              const suffix = suffixFor?.(r.key)
              return (
                <button
                  key={r.key}
                  type="button"
                  disabled={added}
                  aria-pressed={active}
                  onClick={() => onChange(r.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
                    FOCUS,
                    added
                      ? "cursor-not-allowed border-transparent bg-muted/40 text-muted-foreground/60"
                      : active
                        ? "border-primary bg-primary/10 font-medium text-foreground"
                        : "border-transparent hover:border-input hover:bg-muted/50"
                  )}
                >
                  <span className="flex-1">{r.label}</span>

                  {suffix && (
                    <span className="font-mono text-[11px] text-muted-foreground">{suffix}</span>
                  )}

                  {added ? (
                    <span className="text-[11px] text-muted-foreground">Added</span>
                  ) : (
                    r.approver && (
                      /* The single loud note on this control. Head is the
                         approval gate; everything else here stays quiet. */
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                        Approves
                        <span aria-hidden className="text-[9px]">◆</span>
                      </span>
                    )
                  )}
                </button>
              )
            })}
          </div>

          {/* What is actually being granted, in the mono voice admin already
              uses for role keys and page slugs. */}
          {value && functionOf(value) === fn && (
            <p className="font-mono text-[11px] text-muted-foreground pt-0.5">{value}</p>
          )}
        </div>
      )}
    </div>
  )
}
