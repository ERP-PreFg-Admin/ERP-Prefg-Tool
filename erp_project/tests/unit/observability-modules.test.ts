// Every API folder must land in a named module, or its lines vanish into "Other" on the Logs tab.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import path from "node:path"
import { MODULES, MODULE_LABEL, moduleForPath, moduleForCode, cloudWatchModulePattern, type ModuleKey } from "../../lib/observability/modules"

// Shared plumbing called from every module's screens, so no one module owns it.
const OTHER_BY_DESIGN: Record<string, string> = {
  "/api/v1/files": "S3 presign/preview for every module's attachments",
  "/api/v1/upload": "S3 upload used by vendors, recipes, invoices alike",
  "/api/v1/debug-env-check": "env diagnostic, not a business module",
  "/api/v2/files": "v2 of the shared S3 file routes",
}

const topFolders = (version: string) =>
  readdirSync(path.join(__dirname, "../../app/api", version), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `/api/${version}/${d.name}`)

test("every top-level API folder maps to a module", () => {
  for (const folder of [...topFolders("v1"), ...topFolders("v2")]) {
    const got = moduleForPath(folder + "/x")
    if (folder in OTHER_BY_DESIGN) assert.equal(got, "other", folder)
    else assert.notEqual(got, "other", `${folder} is unmapped — add it to lib/observability/modules.ts`)
  }
})

test("invoices win over purchase-orders, v1 and v2", () => {
  assert.equal(moduleForPath("/api/v1/purchase-orders/invoice"), "invoices")
  assert.equal(moduleForPath("/api/v1/purchase-orders/invoice/42/verify"), "invoices")
  assert.equal(moduleForPath("/api/v2/purchase-orders/invoice/parse"), "invoices")
  assert.equal(moduleForPath("/api/v1/purchase-orders/42/split"), "purchase-orders")
  assert.equal(moduleForPath("/api/v2/facilities/po-code"), "purchase-orders")
  assert.equal(moduleForPath("/observability/logs"), "other")
  assert.equal(moduleForPath(null), "other")
})

test("legacy codes fold into modules", () => {
  const cases: [string, ModuleKey][] = [
    ["PO_SPLIT", "purchase-orders"], ["PO_INVOICE", "invoices"], ["INVOICE_DETECT", "invoices"],
    ["NANONETS", "invoices"], ["SKU_BULK", "masters"], ["MFG", "masters"], ["MFG_DOCS", "masters"],
    ["MFG_LINE_CREATE", "manufacturing"], ["MFG_MISC_COST_BULK", "manufacturing"],
    ["MFG_FACILITY_SYNC", "manufacturing"], ["BOM", "masters"], ["PM_RATE_BULK", "masters"],
    ["GET_APPROVALS", "approvals"], ["GET_ENTITY_HISTORY", "approvals"], ["UNIWARE_DOC", "uniware"],
    ["GATEPASS", "uniware"], ["CRON", "jobs"], ["SES_WEBHOOK", "jobs"], ["MAILER", "jobs"],
    ["ADMIN_USERS", "admin"], ["OBSERVABILITY", "admin"], ["SOMETHING_NEW", "other"],
  ]
  for (const [code, key] of cases) assert.equal(moduleForCode(code), key, code)
})

test("CloudWatch patterns: carve-outs, null for other, within the 1024-char limit", () => {
  const po = cloudWatchModulePattern("purchase-orders")!
  assert.match(po, /\$\.path = "\/api\/v1\/purchase-orders\*"\) && \(\$\.path != "\/api\/v1\/purchase-orders\/invoice\*"/)
  assert.match(po, /\(\$\.module = "PO_\*"\) && \(\$\.module != "PO_INVOICE"\)/)
  assert.match(po, /\$\.module = "purchase-orders"/)
  assert.equal(cloudWatchModulePattern("other"), null)
  for (const m of MODULES) {
    const p = cloudWatchModulePattern(m.key)
    if (p) assert.ok(p.length < 1024, `${m.key}: ${p.length}`)
    assert.ok(MODULE_LABEL[m.key])
  }
})
