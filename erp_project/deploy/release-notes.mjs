// The "What's new" popup's notes. Plain node, no deps, so the deploy job can run it.
//   node deploy/release-notes.mjs draft          drafts release-notes/next.json from commits since the last tag, for rewriting + review
//   node deploy/release-notes.mjs stamp <prevTag> <newTag> <outFile>   (deploy) ships the reviewed notes if they cover prevTag..newTag
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const NEXT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "release-notes", "next.json")

/** Commit type → popup group; anything else is internal. */
const KIND = { feat: "new", fix: "fixed", perf: "fixed" }

/** Scope → the screen users know it by. Unknown scopes show no screen name. */
export const AREA = {
  po: "PO Tracking", "po-tracking": "PO Tracking", "po-mail": "PO Tracking", "po-inwarding": "PO Inwarding",
  inward: "PO Inwarding", invoice: "Invoices", invoices: "Invoices", gatepass: "Gatepass",
  masters: "Masters", "material-master": "Material Master", "cost-master": "Cost Master",
  skus: "SKU Master", sku: "SKU Master", rm: "RM Master", pm: "PM Master", vendors: "Vendor Master",
  manufacturers: "Manufacturer Master", warehouses: "Warehouse Master",
  recipe: "Recipe Master", bom: "Recipe Master",
  costing: "Costing", manufacturing: "Manufacturing", "mfg-overview": "Manufacturer Overview",
  "facility-map": "Manufacturer Overview", approvals: "Approvals", admin: "Admin", roles: "Admin",
  permissions: "Admin", reports: "Reports", uniware: "Uniware", mail: "Email", csv: "CSV upload",
  filters: "Filters", ui: "", layout: "",
}

/** Scopes that are plumbing even under feat/fix. */
const INTERNAL = new Set(["lint", "deploy", "ci", "release", "cron", "observability", "gateway", "db", "s3",
  "prisma", "deps", "date", "lib", "test", "tests"])

const SUBJECT = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/

/** One commit → a note, or null when users shouldn't see it. */
export function parseCommit(subject, body = "") {
  const trailer = /^Release-note:\s*(.+)$/im.exec(body)?.[1]?.trim()
  if (trailer && /^skip$/i.test(trailer)) return null
  const m = SUBJECT.exec(subject.trim())
  if (!m) return null
  const kind = KIND[m[1].toLowerCase()]
  if (!kind) return null
  const scopes = (m[2] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (scopes.some((s) => INTERNAL.has(s))) return null
  const area = scopes.map((s) => AREA[s]).find((a) => a) ?? ""
  const raw = (trailer ?? m[3]).trim().replace(/\.$/, "")
  return { kind, area, text: raw.charAt(0).toUpperCase() + raw.slice(1) }
}

/** The popup's payload for one release; repeated notes (re-applied commits) appear once. */
export function buildNotes(version, date, commits) {
  const seen = new Set()
  const items = []
  for (const c of commits) {
    const n = parseCommit(c.subject, c.body)
    if (!n) continue
    const key = `${n.kind}|${n.area}|${n.text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(n)
  }
  return { version, date, items }
}

function readCommits(from, to) {
  const out = execFileSync("git", ["log", "--no-merges", "--format=%s%x1f%b%x1e", `${from}..${to}`], { encoding: "utf8" })
  return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [subject, body = ""] = r.split("\x1f")
    return { subject, body }
  })
}

/** Reviewed notes ship only when they were written for exactly this release; anything else ships none. */
export function stampNotes(next, prevTag, newTag, date) {
  const empty = { version: newTag, date, items: [] }
  if (!next || next.from !== prevTag) {
    return { notes: empty, warning: `release-notes/next.json covers ${next?.from ?? "nothing"}.., not ${prevTag}.. — shipping no notes` }
  }
  const items = (next.items ?? []).filter((i) => i && (i.kind === "new" || i.kind === "fixed") && String(i.text ?? "").trim())
  return { notes: { version: newTag, date, items }, warning: null }
}

function latestTag() {
  return execFileSync("git", ["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"], { encoding: "utf8" }).split("\n")[0].trim()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2)
  const today = new Date().toISOString().slice(0, 10)
  if (cmd === "draft") {
    const from = args[0] ?? latestTag()
    const { items } = buildNotes(null, today, readCommits(from, "HEAD"))
    writeFileSync(NEXT_FILE, JSON.stringify({ from, items }, null, 2) + "\n")
    console.log(`Drafted ${items.length} note(s) for ${from}..HEAD into release-notes/next.json — rewrite them in plain words, then commit.`)
  } else if (cmd === "stamp" && args.length === 3) {
    const [prevTag, newTag, outFile] = args
    const next = existsSync(NEXT_FILE) ? JSON.parse(readFileSync(NEXT_FILE, "utf8")) : null
    const { notes, warning } = stampNotes(next, prevTag, newTag, today)
    if (warning) console.log(`::warning::${warning}`)
    writeFileSync(outFile, JSON.stringify(notes, null, 2) + "\n")
    console.log(`${newTag}: ${notes.items.length} note(s) shipped`)
  } else {
    console.error("usage: release-notes.mjs draft [fromTag] | stamp <prevTag> <newTag> <outFile>")
    process.exit(2)
  }
}
