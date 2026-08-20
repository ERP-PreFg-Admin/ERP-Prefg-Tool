// Rewrite lib/ import specifiers after a `git mv`, for the lib module refactor
// (~/.claude/plans/lib-module-refactor.md). Temporary — delete when the last
// group lands.
//
//   node tests/move-imports.mjs mailer=mail/mailer recipients=mail/recipients
//
// Matches @/lib/<old>, ../lib/<old>, ../../lib/<old> and any /sub path under
// them, in .ts/.tsx/.mjs and in .md docs. Lives in tests/ because .gitignore
// has /scripts/*, so a new file there would be silently untracked.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"

const map = process.argv.slice(2)
  .map((a) => a.split("="))
  .sort((a, b) => b[0].length - a[0].length) // longest first: invoice-local before invoice-*

if (!map.length || map.some((p) => p.length !== 2)) {
  console.error("usage: node tests/move-imports.mjs old=new [old=new ...]")
  process.exit(1)
}

// `scripts` is here even though most of it is gitignored: those files are still
// on disk and `tsc --noEmit` checks them, so a missed rewrite there fails the
// type check for the whole refactor.
const ROOTS = ["app", "lib", "components", "tests", "types", "docs", "scripts"]
const EXT = /\.(ts|tsx|mjs|md)$/
const SKIP = new Set(["node_modules", ".next", ".git", "generated"])

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.test(e.name)) yield p
  }
}

function* targets() {
  for (const root of ROOTS) {
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue
    yield* walk(root)
  }
  // repo-root markdown (CLAUDE.md, AGENTS.md, README.md)
  for (const n of readdirSync(".")) if (EXT.test(n)) yield n
}

let files = 0
let edits = 0

for (const f of targets()) {
  const before = readFileSync(f, "utf8")
  let after = before
  for (const [old, next] of map) {
    // The lookahead is load-bearing: without it `po-guard` would also match
    // inside `po-guards`, and `invoice` inside `invoice-detect`.
    after = after.replace(
      new RegExp(`((?:@/|(?:\\.\\./)+)lib/)${old}(?=["'\`/])`, "g"),
      `$1${next}`
    )
  }
  if (after === before) continue
  writeFileSync(f, after)
  files++
  const a = after.split("\n")
  edits += before.split("\n").filter((l, i) => l !== a[i]).length
}

console.log(`rewrote ${edits} lines in ${files} files`)
