/**
 * What the running container is, for the header badge.
 *
 * The problem this exists to solve: the box pulls a MOVING image tag (:test or
 * :prod), so a deploy that fails to land leaves the previous container running
 * and nothing on screen looks wrong. A commit SHA alone does not help — nobody
 * remembers which SHA they expected. A build age does: "built 3 days ago" when
 * you deployed ten minutes ago is unmissable.
 *
 * Pure on purpose (no lib/db, no lib/env) so it is unit-testable — see
 * tests/unit/build-info.test.ts and the note in AGENTS.md about what a unit test
 * may import.
 */

export type BuildEnv = "local" | "test" | "prod"

export type BuildInfo = {
  /** "v1.2.0" on prod, a short commit SHA on test, "dev" locally. */
  version: string
  env: BuildEnv
  /** ISO string baked in at image build time, or null when it was not passed. */
  builtAt: string | null
  /** `buildAge(builtAt)`, computed SERVER-SIDE in app/layout.tsx and passed down
   *  as a string. Deliberately not recomputed by the component that renders it:
   *  TopBar sits inside ClientLayout and so ships in the client bundle, and a
   *  `new Date()` there would run on both server and client — which disagree
   *  either side of a minute boundary. That is a hydration mismatch for a
   *  decorative string, so the value is frozen at render time instead. */
  age: string | null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Coarse relative age of the build — "just now" / "12m ago" / "5h ago" / "3d ago".
 *
 * Deliberately coarse: this answers "did my deploy land?", not "exactly when".
 * Returns null for a missing or unparseable stamp, and for a stamp in the future
 * (clock skew between the CI runner and the viewer is not worth rendering as
 * "-2h ago").
 */
export function buildAge(builtAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!builtAt) return null
  const then = Date.parse(builtAt)
  if (Number.isNaN(then)) return null

  const ms = now.getTime() - then
  if (ms < 0) return null
  if (ms < MINUTE) return "just now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}
