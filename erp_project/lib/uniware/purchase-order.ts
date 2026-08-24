import logger from "../logger";
import { uniwareStatusFallback } from "./errors";
import { getToken } from "./auth";
import { authHeaders } from "./facility";
import { buildPurchaseOrder } from "./po-builder";
import type { UniwarePoInput } from "./po-builder";
import { BASE, TIMEOUT_MS, PO_CREATE_PATH, PO_DETAILS_PATH } from "./endpoints";

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



export async function fetchPurchaseOrderPdf(code: string , facility ? : string) : Promise<Buffer> {
    const token =await getToken()
    const url = `${BASE}/po/show?code=${encodeURIComponent(code)}$legacy=1`

    const res = await fetch(url , {
        headers :authHeaders(token , facility),
        signal :AbortSignal.timeout(TIMEOUT_MS)
    })

    const buf = Buffer.from(await res.arrayBuffer())

    if(!res.ok)  {
        throw new Error(`Uniware PO document ${code}: HTTP ${res.status}`)
    }

    if(buf.subarray(0 , 5).toString("latin1") !== "%PDF-") {
        const ct = res.headers.get("content-type") ?? "unknown"
        throw new Error(`Uniware PO document ${code}: expected a PDF, got ${ct} (${buf.length} bytes)`)
    }
    return buf
}


export async function fetchPurchaseOrderStatus(code : string , facility?: string) : Promise<string> {
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

    return data.statusCode
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