import logger from "../logger"
import { UNIWARE_SANDBOX } from "../env"
import { parseCsvRows, normalizeHeader } from "../csv"
import { getToken } from "./auth"
import { BASE, TIMEOUT_MS, VENDOR_CREATE_PATH } from "./endpoints"
import { authHeaders, uniwareFacility } from "./facility"
import { createExportJob, pollExportJob, downloadExportCsv } from "./export-jobs"
import type { UniwareVendor } from "./vendor-match"
import type { VendorCreatePayload } from "./vendor-registry"

const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; vendors: UniwareVendor[] }>()

/** Every vendor configured at one facility, from Uniware's "Vendors" export. Off prod this is
 *  the sandbox facility — the one createVendor writes to — so dev reads what it creates. */
export async function pullFacilityVendors(facilityCode: string): Promise<UniwareVendor[]> {
  facilityCode = uniwareFacility(facilityCode)
  const hit = cache.get(facilityCode)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.vendors

  const job = await createExportJob(facilityCode, "Vendors", ["vendorCode", "vendorName"])
  const rows = parseCsvRows(await downloadExportCsv(await pollExportJob(job)))
  // The file comes back with display headers ("Vendor Code"), not the column keys.
  const header = (rows[0] ?? []).map(normalizeHeader)
  const codeAt = header.findIndex((h) => h === "vendor_code" || h === "vendorcode")
  const nameAt = header.findIndex((h) => h === "vendor_name" || h === "vendorname")
  if (codeAt < 0) throw new Error(`Vendors export for ${facilityCode} has no Vendor Code column`)

  const vendors = rows.slice(1)
    .map((r) => ({ code: (r[codeAt] ?? "").trim(), name: nameAt >= 0 ? (r[nameAt] ?? "").trim() : "" }))
    .filter((v) => v.code)
  cache.set(facilityCode, { at: Date.now(), vendors })
  return vendors
}

export function forgetFacilityVendors(facilityCode: string): void {
  cache.delete(uniwareFacility(facilityCode))
}

/** POST vendor/create at one facility. Off prod it goes to the sandbox facility, like every other write. */
export async function createVendor(payload: VendorCreatePayload, facilityCode: string): Promise<{ sandbox: boolean }> {
  const token = await getToken()
  const res = await fetch(`${BASE}${VENDOR_CREATE_PATH}`, {
    method: "POST",
    headers: { ...authHeaders(token, facilityCode), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!raw.trim()) throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)

  let data: {
    successful?: boolean
    message?: string
    errors?: { description?: string; message?: string; fieldName?: string }[]
    warnings?: { description?: string; message?: string }[]
  }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }

  if (!data.successful) {
    const msgs = (data.errors ?? [])
      .map((e) => [e.fieldName, e.description || e.message].filter(Boolean).join(": "))
      .filter(Boolean)
    const message = msgs.join("; ") || data.message || `Uniware rejected the vendor (HTTP ${res.status})`
    // Proven on TEST_FACILITY 2026-10-09: a second create answers "Vendor Code already exists".
    // The vendor is there either way, so a retry after a timeout is not a failure.
    if (/vendor code already exists/i.test(message)) {
      logger.info({ module: "UNIWARE", facility: uniwareFacility(facilityCode), vendorCode: payload.vendor.code, message: "Vendor already existed in Uniware" })
      return { sandbox: UNIWARE_SANDBOX }
    }
    throw new Error(message)
  }
  for (const w of data.warnings ?? []) {
    logger.warn({ module: "UNIWARE", facilityCode, vendorCode: payload.vendor.code, message: w.description || w.message })
  }
  logger.info({ module: "UNIWARE", facility: uniwareFacility(facilityCode), vendorCode: payload.vendor.code, message: "Vendor created in Uniware" })
  return { sandbox: UNIWARE_SANDBOX }
}
