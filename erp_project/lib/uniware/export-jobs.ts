import { getToken } from "./auth";
import { envelopeError, type ExportEnvelope } from "./envelope";
import { BASE, TIMEOUT_MS, EXPORT_JOB_CREATE_PATH, EXPORT_JOB_STATUS_PATH } from "./endpoints";

export const EXPORT_COLUMNS_KEY = "exportColums"

/** The report this module exists to pull. Named exactly as Uniware lists it. */
export const VENDOR_ITEM_EXPORT = "Vendor Item Master"

/** Columns we ask for. Uniware returns display names, not these keys. */
export const VENDOR_ITEM_COLUMNS = [
  "inventory", "vendorCode", "vendorSkuCode", "facility", "itemTypeSku", "itemTypeName",
]

export function isFatalExportError(status : number , text :string ) : boolean {
    if(status === 400 || status === 403 || status === 404) return true;
    const t = text.toLowerCase()
    if(t.includes("invalid column")) return false
    return ["facility", "not found", "does not exist", "no access", "not authorized", "permission"]
    .some((hint) => t.includes(hint))
}

export class UniwareFatalError extends Error {}



/** The report the GatePass summary pulls. Named exactly as Uniware lists it. */
export const SALE_ORDER_EXPORT = "Sale Orders"

/**
 * One `exportFilters` entry. Uniware's filter ids are per report — `invoicedOn`
 * on Sale Orders — and the value shape varies by id, so this stays open rather
 * than pretending to model a union we only know one member of.
 */
export type ExportFilter = { id: string; dateRange?: { start: number; end: number } }

export async function createExportJob(
    facility : string ,
    jobTypeName = VENDOR_ITEM_EXPORT ,
    columns: string[] = VENDOR_ITEM_COLUMNS,
    // Empty means "the whole report", which is what the Vendor Item Master sync
    // wants. Sale Orders is unbounded without a date filter, so its caller passes one.
    filters: ExportFilter[] = [],
) : Promise<string> {
    if(!facility) throw new Error("An export job needs a facility — it is what scopes the report.")
    const  token = await getToken()
    const res = await fetch(`${BASE}${EXPORT_JOB_CREATE_PATH}` , {
        method : "POST" ,
        // NOT authHeaders(): that routes the facility through uniwareFacility(),
        // which off prod pins every call to the sandbox facility. An export is a
        // READ and must ask about the facility the caller named — pinning it is
        // the "0 mapped everywhere" bug tests/unit/uniware-export.test.ts guards.
        headers : {
            Authorization: `Bearer ${token.accessToken}`,
            Facility : facility,
            "Content-Type" :"application/json",
        },
        body: JSON.stringify({
            exportJobTypeName : jobTypeName,
            [EXPORT_COLUMNS_KEY]: columns,
            exportFilters : filters,
            frequency: "ONETIME"
        }),
        signal : AbortSignal.timeout(TIMEOUT_MS)
    })

    const raw = await res.text()
    if (!raw.trim()) {
        if (isFatalExportError(res.status, "")) {
            throw new UniwareFatalError(`Uniware returned an empty response (HTTP ${res.status}) for ${facility}`)
        }
            throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)
    }
    let data: ExportEnvelope & { jobCode?: string; exportJobId?: string }
    
    try {
        data = JSON.parse(raw)
    } catch {
        if (isFatalExportError(res.status, raw)) throw new UniwareFatalError(`${facility}: ${raw.slice(0, 200)}`)
        throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
    }
    
    if (!data.successful) {
        const message = envelopeError(data, res.status, "Uniware rejected the export job")
        if (isFatalExportError(res.status, message)) throw new UniwareFatalError(`${facility}: ${message}`)
        throw new Error(message)
    }
    
    if (!data.jobCode) throw new Error("Uniware accepted the export job but returned no jobCode")
    return data.jobCode
}

export type ExportJobStatus = { status:string , filePath : string | null }

export async function getExportJobStatus(jobCode:string) : Promise<ExportJobStatus> {
    const token = await getToken()
    const res = await fetch(`${BASE}${EXPORT_JOB_STATUS_PATH}` , {
        method : "POST" , 
        // No Facility header at all — the job code already identifies the job.
        // authHeaders() would add one (and uniwareFacility(undefined) can throw
        // on prod when UNIWARE_FACILITY is unset).
        headers : {
            Authorization: `Bearer ${token.accessToken}`,
            "Content-Type"  :"application/json" ,
        },
        body : JSON.stringify({jobCode}),
        signal : AbortSignal.timeout(TIMEOUT_MS),
    })

    const raw = await res.text()
    if (!raw.trim()) throw new Error(`Empty status response for job ${jobCode} (HTTP ${res.status})`)
    let data: ExportEnvelope & { status?: string; filePath?: string }
    try {
        data = JSON.parse(raw)
    } catch {
        throw new Error(`Non-JSON status response for job ${jobCode}: ${raw.slice(0, 200)}`)
    }
    if (!data.successful) {
        throw new Error(envelopeError(data, res.status, `Status check failed for job ${jobCode}`))
    }
    return { status: (data.status ?? "").toUpperCase(), filePath: data.filePath ?? null }
}

export function classifyJobStatus(status: string): "done" | "failed" | "pending" {
  const s = status.toUpperCase()
  if (s === "SUCCESSFUL" || s === "SUCCESS" || s === "COMPLETE" || s === "COMPLETED") return "done"
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "failed"
  return "pending"
}


export async function pollExportJob(
  jobCode: string,
  opts: { attempts?: number; delayMs?: number; onTick?: (attempt: number, status: string) => void } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 40
  const delayMs = opts.delayMs ?? 3000

  for (let i = 1; i <= attempts; i++) {
    const { status, filePath } = await getExportJobStatus(jobCode)
    opts.onTick?.(i, status)
    const verdict = classifyJobStatus(status)
    if (verdict === "failed") throw new Error(`Export job ${jobCode} ended as ${status}`)
    if (verdict === "done") {
      if (!filePath) throw new Error(`Export job ${jobCode} succeeded but returned no filePath`)
      return filePath
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`Export job ${jobCode} was still running after ${attempts} checks`)
}

export async function downloadExportCsv(filePath: string): Promise<string> {
  const token = await getToken()
  const url = /^https?:\/\//i.test(filePath) ? filePath : `${BASE}${filePath.startsWith("/") ? "" : "/"}${filePath}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Downloading the export failed (HTTP ${res.status})`)

  const text = await res.text()
  const head = text.slice(0, 200).toLowerCase()
  if (head.includes("<html") || head.includes("<!doctype")) {
    throw new Error("The export download returned an HTML page, not a CSV — the session was not accepted.")
  }
  if (!text.trim()) throw new Error("The export download was empty.")
  return text
}
