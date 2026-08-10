// Lints ONLY the files you changed.
//
//   npm run lint:changed              vs the merge-base with origin/main
//   npm run lint:changed -- HEAD~3    vs any other ref
//
// Why this exists: `npm run lint` currently reports ~238 pre-existing errors
// (overwhelmingly no-explicit-any). Fixing them is a separate decision, but the
// count must not be allowed to grow — so this is the ratchet. It is what CI runs
// on a pull request.
//
// Plain node (no tsx) so CI can run it before any TypeScript tooling is needed.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const base = process.argv[2] ?? process.env.LINT_BASE ?? "origin/main"

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

/** Prefer the merge base so a stale local branch doesn't lint the whole world. */
function diffTarget() {
  try {
    return git(["merge-base", base, "HEAD"])
  } catch {
    // origin/main may not exist in a shallow clone or a fresh repo.
    console.error(`[lint:changed] cannot resolve "${base}", falling back to HEAD`)
    return "HEAD"
  }
}

const target = diffTarget()

// --diff-filter=ACMR: added / copied / modified / renamed. Deleted files can't be
// linted, and including them makes eslint exit non-zero for the wrong reason.
const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", target, "--", "*.ts", "*.tsx", "*.mjs"])
// Untracked files aren't in any diff but are exactly what a new PR adds.
const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "*.ts", "*.tsx", "*.mjs"])

const files = [...new Set([...tracked.split("\n"), ...untracked.split("\n")])]
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => existsSync(f))

if (files.length === 0) {
  console.log(`[lint:changed] no changed .ts/.tsx/.mjs files vs ${base} — nothing to lint`)
  process.exit(0)
}

console.log(`[lint:changed] ${files.length} file(s) vs ${base}:`)
for (const f of files) console.log(`  ${f}`)

const res = spawnSync("npx", ["eslint", ...files], { stdio: "inherit", shell: true })
process.exit(res.status ?? 1)
