import logger from "../logger";
import { uniwareStatusFallback } from "./errors";
import { getToken } from "./auth";
import { authHeaders, uniwareFacility } from "./facility";
import { buildPurchaseOrder } from "./po-builder";
import type { UniwarePoInput } from "./po-builder";
import { BASE, TIMEOUT_MS, PO_CREATE_PATH, PO_DETAILS_PATH, PO_DOCUMENT_PATH } from "./endpoints";
import { switchFacilityWithCookie } from "./facility-switch";
import { requireUniwareWebCookie, withCookieSession } from "./web-session";

export async function createPurchaseOrder(po: UniwarePoInput): Promise<{ purchaseOrderCode: string }> {
    const token = await getToken()
    const payload = buildPurchaseOrder(po)

    const res = await fetch(`${BASE}${PO_CREATE_PATH}` , {
        method : "POST" , 
        headers : {
            ...authHeaders(token , po.facility) , 
            "Content-Type" : "application/json"
        },
        body : JSON.stringify(payload) , 
        signal : AbortSignal.timeout(TIMEOUT_MS)
    })

    const raw = await res.text()
    if(!raw.trim()) {
        throw new Error(`Uniware returned an empty response (HTTP ${res.status}) - check Facility and auth`)
    }
    let data : {
        successful?:boolean
        errors?: { description?: string , message?: string }[]
        warnings?: { description?: string , message?: string }[]
        purchaseOrderCode?: string
    }

    try {
        data = JSON.parse(raw)
    } catch {
        throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0 , 300)}`)
    }

    if(!data.successful) {
        const msg =  (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
        throw new Error(msg.join("; ") || `Uniware rejected the purchase order (HTTP ${res.status})`)
    }

    for(const w of data.warnings ?? []) {
        logger.warn({ module:"UNIWARE" , poCode : po.purchaseOrderCode , message:w.description || w.message})
    }

    const assigned = data.purchaseOrderCode ?? po.purchaseOrderCode
    if(!assigned) {
        throw new Error("Uniware accepted the purchase order but returned no purchaseOrderCode")

    }
    return { purchaseOrderCode : assigned}
}


/** Cookie, not bearer: /po/show serves whichever facility the SESSION is on, and
 *  only the web session can be switched. */
export async function fetchPurchaseOrderPdf(code: string , facility ? : string) : Promise<Buffer> {
    // Switch + fetch must not interleave with another caller's switch.
    return withCookieSession(async () => {
        const cookie = await requireUniwareWebCookie()
        return fetchPurchaseOrderPdfWithCookie(cookie, code, facility)
    })
}

/** Split out so a unit test can drive it without the DB. Does NOT lock — callers
 *  outside fetchPurchaseOrderPdf must hold withCookieSession themselves. */
export async function fetchPurchaseOrderPdfWithCookie(
    cookie: string, code: string, facility?: string
): Promise<Buffer> {
    await switchFacilityWithCookie(cookie, uniwareFacility(facility))

    const query = new URLSearchParams({ code, legacy: "1" })
    const res = await fetch(`${BASE}${PO_DOCUMENT_PATH}?${query}`, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const buf = Buffer.from(await res.arrayBuffer())
    if (!res.ok) throw new Error(`Uniware PO document ${code}: HTTP ${res.status}`)

    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
        const ct = res.headers.get("content-type") ?? "unknown"
        throw new Error(`Uniware PO document ${code}: expected a PDF, got ${ct} (${buf.length} bytes)`)
    }
    return buf
}
/** One PO line's quantities as Unicommerce reports them, keyed by SKU. */
export type UniwarePoLineQty = {
    sku: string
    pendingQty: number
    qcPassQty: number
}

export async function fetchPurchaseOrderStatus(
    code : string , facility?: string
) : Promise<{ status: string; grnCount: number; lines: UniwarePoLineQty[] }> {
    const token = await getToken()

    const res = await fetch(`${BASE}${PO_DETAILS_PATH}` , {
        method : "POST" ,
        headers : {
            ...authHeaders(token , facility) ,
            "Content-Type" : "application/json"
        },
        body: JSON.stringify({purchaseOrderCode : code}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    const data = (await res.json().catch(() => ({}))) as {
        successful?: boolean
        statusCode?: string
        inflowReceiptsCount?: number
        purchaseOrderItems?: {
            itemSKU?: string
            pendingQuantity?: number
            qcPassQuantity?: number
        }[]
        errors?:{
            description?: string;
            message?: string
        }[]
    }
    if(!data.successful) {
        const msg = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
        throw new Error(
            msg.join(", ") || uniwareStatusFallback(`purchase order ${code}` , res.status)
        )
    }
    if(!data.statusCode) throw new Error(`Uniware returned no statusCode for ${code}`)

    const grnCount = Number(data.inflowReceiptsCount ?? 0)

    const num = (v: unknown) => {
        const n = Number(v ?? 0)
        return Number.isFinite(n) ? n : 0
    }
    const lines: UniwarePoLineQty[] = (data.purchaseOrderItems ?? [])
        .filter((i) => typeof i.itemSKU === "string" && i.itemSKU.trim() !== "")
        .map((i) => ({
            sku: (i.itemSKU as string).trim(),
            pendingQty: num(i.pendingQuantity),
            qcPassQty: num(i.qcPassQuantity),
        }))

    return { status: data.statusCode, grnCount: Number.isFinite(grnCount) ? grnCount : 0, lines }
}

export type UniwarePushResult = {
    po_no : string  
    ok : boolean
    error? : string
    duplicate?: boolean
}

export async function pushPurchaseOrders(pos : UniwarePoInput[]) : Promise<UniwarePushResult[]>{
    const out: UniwarePushResult[] = []
    for (const po of pos){
        const label = po.purchaseOrderCode ?? "(assigned)"

        try {
            const res = await createPurchaseOrder(po)
            out.push({po_no : res.purchaseOrderCode , ok:true})
        } catch(err) {
            const message = err instanceof Error ? err.message : String(err)
            const duplicate = /duplicate purchase order code/i.test(message)
            out.push({
                po_no: label , 
                ok:duplicate , 
                error:message , 
                duplicate
            })
            logger[duplicate ? "warn" : "error"]({
                module: "UNIWARE",
                poCode: label,
                err: message,
                message: duplicate ? "PO already existed in Uniware" : "Uniware PO create failed",
            })
        }
    }
    return out
}