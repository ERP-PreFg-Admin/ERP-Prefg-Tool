// Every check in erp-api.postman_collection.json, as one command:
//
//   npm run test:smoke                 # against http://localhost:3000
//   npm run test:smoke -- --base http://localhost:3001
//   npm run test:smoke -- --as qa@mcaffeine.com   # a scoped user, to test the 403 paths
//
// Needs the dev server running. Mints its own session through mint-session.mjs,
// so there is nothing to paste and one definition of "a valid session".
//
// This exists because the routes it covers cannot be reached from tests/db/:
// withGateway needs a real session and opens its own transaction, so the rollback
// harness can only test the helpers underneath (tests/helpers/db.ts explains why).
// Everything here is the layer above that — and unlike the Postman collection it
// needs no extension, no account, and no file picker.
//
// The two upload checks write real objects to S3 under qa-probe/. That is the
// point of them; they are listed at the end so you know what to delete.
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { resolveSession } from "./mint-session.mjs"

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = flag("base", "http://localhost:3000").replace(/\/$/, "")
const here = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
const results = []

/** One check: run `fn`, compare against `want`, record the line. */
async function check(name, want, fn) {
  let got, note
  try {
    ;({ got, note } = await fn())
  } catch (err) {
    got = `threw: ${err.message}`
  }
  const ok = String(got) === String(want)
  if (!ok) failures++
  results.push({ ok, name, want, got, note })
  console.log(
    `${ok ? "  PASS" : "  FAIL"}  ${name.padEnd(46)} ${String(got).padEnd(22)}${ok ? "" : `want ${want}`}${note ? `  ${note}` : ""}`
  )
}

const session = await resolveSession({ base: BASE, cookie: flag("cookie", null), as: flag("as", undefined) })
const H = { Cookie: session.cookie }
const status = async (url, init) => (await fetch(url, init)).status

// The two upload checks POST: they put real objects in S3 and, because
// withGateway logs every non-GET, real rows in activity_log. Fine on your own
// machine, rude on a shared deployment — so they are opt-in there.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)
const WRITES = LOCAL || args.includes("--allow-writes")

console.log(`\nbase        ${BASE}`)
console.log(`acting as   user ${session.userId} <${session.email}>  roles: ${session.roles.join(", ") || "(none)"}`)
console.log(`scope       ${session.scope}`)
if (!LOCAL) console.log(`writes      ${WRITES ? "ALLOWED (--allow-writes)" : "skipped — shared environment"}`)
if (session.scope.startsWith("UNRESTRICTED")) {
  console.log(
    "            ^ an unrestricted user is allowed everywhere by design, so the\n" +
    "              out-of-scope 403 path is NOT covered by this run. Re-run with\n" +
    "              --as <a user scoped to one manufacturer> to cover it."
  )
}

console.log("\n0. setup")
await check("app is up", 200, async () => ({ got: await status(`${BASE}/api/health`) }))

let poKey = null
await check("session cookie is accepted", 200, async () => {
  const res = await fetch(`${BASE}/api/v1/purchase-orders`, { headers: H })
  if (res.ok) {
    const rows = await res.json()
    poKey = rows.find((r) => r.attachment_key)?.attachment_key ?? null
    return { got: res.status, note: `${rows.length} POs, ${rows.filter((r) => r.attachment_key).length} with attachments` }
  }
  return { got: res.status }
})

console.log("\n1. upload — keys are stamped and never reused")
const probe = new Blob([await readFile(path.join(here, "probe.csv"))], { type: "text/csv" })
async function upload() {
  const form = new FormData()
  form.append("file", probe, "probe.csv")
  form.append("folder", "qa-probe")
  form.append("field", "probe")
  const res = await fetch(`${BASE}/api/v1/upload`, { method: "POST", headers: H, body: form })
  return res.ok ? (await res.json()).key : null
}
let key1 = null
let key2 = null
if (WRITES) {
  key1 = await upload()
  key2 = await upload()
  await check("upload key carries the -u<id>- marker", true, async () => ({
    got: /-u\d+-[0-9a-f]{12}\.[A-Za-z0-9]+$/.test(key1 ?? ""),
    note: key1 ?? "upload failed",
  }))
  await check("a repeat upload cannot overwrite the first", true, async () => ({
    got: !!key1 && !!key2 && key1 !== key2,
    note: key2 ?? "",
  }))
} else {
  console.log("  SKIP  both upload checks — they write to S3 and activity_log on a")
  console.log("        shared environment. Pass --allow-writes if that's fine.")
}

console.log("\n2. presign — the object guard")
if (key1) {
  await check("my own just-uploaded key", 200, async () => ({
    got: await status(`${BASE}/api/v1/files/presign?key=${encodeURIComponent(key1)}`, { headers: H }),
  }))
  await check("my own key, inline view", 200, async () => ({
    got: await status(`${BASE}/api/v1/files/presign?key=${encodeURIComponent(key1)}&view=1`, { headers: H }),
  }))
  await check("my key with someone else's marker", 403, async () => ({
    got: await status(
      `${BASE}/api/v1/files/presign?key=${encodeURIComponent(key1.replace(/-u\d+-([0-9a-f]{12})(\.[A-Za-z0-9]+)$/, "-u999999-$1$2"))}`,
      { headers: H }
    ),
  }))
} else {
  console.log("  SKIP  the three own-upload checks (no key — uploads were skipped)")
}
await check("a key owned by nothing", 403, async () => ({
  got: await status(`${BASE}/api/v1/files/presign?key=qa-probe/no-such-object-9f3a1c.pdf`, { headers: H }),
  note: "the enumeration fix",
}))
await check("missing key is still a 400", 400, async () => ({
  got: await status(`${BASE}/api/v1/files/presign`, { headers: H }),
}))
await check("no session at all", 401, async () => ({
  // Any key does: withGateway rejects before the guard is reached.
  got: await status(`${BASE}/api/v1/files/presign?key=qa-probe/anything.pdf`),
}))

if (poKey) {
  await check("a real document on a PO I can see", 200, async () => ({
    got: await status(`${BASE}/api/v1/files/presign?key=${encodeURIComponent(poKey)}`, { headers: H }),
    note: poKey,
  }))
} else {
  console.log("  SKIP  no PO in scope has an attachment")
}

console.log("\n3. still open — expected to fail until fixed")
await check("preview refuses an unowned key (audit #5)", 403, async () => {
  // Deliberately the same key presign refuses above. presign stops at the guard;
  // preview has no guard, so it carries the key to S3 and fails there instead —
  // a 500 here is the finding, not a broken test.
  const got = await status(`${BASE}/api/v1/files/preview?key=qa-probe/no-such-object-9f3a1c.csv`, { headers: H })
  return { got, note: got === 500 ? "reached S3 without authorizing — the hole" : "" }
})

const expectedFailures = 1 // the preview check above
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} pass` +
    (failures ? `  —  ${failures} fail (${expectedFailures} expected: /api/v1/files/preview)` : "")
)
if (key1) console.log(`\nleft in S3: qa-probe/${[key1, key2].filter(Boolean).map((k) => k.split("/").pop()).join(", ")}`)

process.exit(failures > expectedFailures ? 1 : 0)
