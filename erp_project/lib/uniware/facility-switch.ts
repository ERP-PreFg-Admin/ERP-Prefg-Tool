import { BASE , TIMEOUT_MS ,  SWITCH_FACILITY_PATH} from "./endpoints"
import { requireUniwareWebCookie, UniwareSessionStale } from "./web-session"

export async function switchFacilityWithCookie(cookie: string , facilityCode: string ) : Promise<void> {
    const res = await fetch(`${BASE}${SWITCH_FACILITY_PATH}` , {
        method:"POST", 
        headers: {
            "Content-Type" : "application/json",
            "X-Requested-With" : "XMLHttpRequest" ,
            Cookie:cookie,
        },
        body:JSON.stringify({currentUrl : "/dashboard/overview" , facilityCode}),
        signal:AbortSignal.timeout(TIMEOUT_MS)
    })

    const text = await res.text()
    let data : {
        successful?:boolean;
        errors?:{
            message?:string;
            description?:string
        } []
    }
    try {
        data = JSON.parse(text)
    } catch {
        if(res.status === 401 ||  /USER_NOT_LOGGED_IN|login/i.test(text)) throw new UniwareSessionStale()
        throw new Error(`uniware switch to ${facilityCode}: HTTP ${res.status} , non-JSON`)
    }

    if(!data.successful) {
        const msg= (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean).join("; ")
        if(res.status === 401 || /USER_NOT_LOGGED_IN/i.test(msg)) throw new UniwareSessionStale()
        throw new Error(`Uniware would not switch to ${facilityCode}: ${msg || res.status}`)
    }
}

export async function switchFacility(facilityCode: string): Promise<void> {
  return switchFacilityWithCookie(await requireUniwareWebCookie(), facilityCode)
}
