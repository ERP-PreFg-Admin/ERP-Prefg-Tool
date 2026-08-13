export type RateLimitRule = {
  /** Requests allowed per window, per user. */
  limit: number
  windowMs: number
  /** Max simultaneous in-flight requests for this route, per user. */
  concurrency?: number
  /** Max simultaneous in-flight requests for this route, across all users. */
  instanceConcurrency?: number
}

// `ok` MUST be the literal `false` / `true`, not `false | true` (which collapses
// to `boolean`). The literals are what make this a discriminated union, so
// `if (!verdict.ok)` narrows to RateLimitDenial in with-gateway.ts. With
// `boolean` nothing narrows and every field access there is a TS2339.
export type RateLimitDenial = {
    ok: false
    reason:"rate" | "concurrency"
    retryAfterSec: number
    limit: number
    observed:number
}

export type RateLimitGrant = {
    ok: true
    remaining:number
    /** MUST be called in a `finally`. A leaked slot shrinks the limit forever. */
    release: () => void
    /** Set only in shadow mode: what would have been refused under enforcement. */
    wouldBlock?:RateLimitDenial
}

export type RateLimitVerdict = RateLimitDenial | RateLimitGrant
/** Hit timestamps per `path:userId`, pruned to the window on every read. */
const hits = new Map<string , number[]>()
/** In-flight counts, keyed `path:userId` and (for the instance gate) `path`. */
const inFlight = new Map<string , number>()

export const isShadowMode = () : boolean => process.env.RATE_LIMIT_MODE != "enforce"

function bump(key:string , by:number) : void {
    const next = (inFlight.get(key) ?? 0) + by
    if(next <= 0) inFlight.delete(key)
    else inFlight.set(key , next)
}

/** Test Seam: the map are module state, so a test my be able to reset them.*/
export function __resetRateLimitState() : void {
    hits.clear()
    inFlight.clear()
}


/**
 * Evaluate both gates for one request. On a grant the caller MUST invoke
 * `release()` in a `finally` — see lib/gateway/with-gateway.ts, the only
 * production call site.
 */
export function acquire(path:string , userId:number , rule:RateLimitRule) : RateLimitVerdict {
    const userKey = `${path}:${userId}`
    const now = Date.now()

    const recent = (hits.get(userKey) ?? []).filter((t) => now - t < rule.windowMs)

    let denied: RateLimitDenial | null = null

    if(recent.length >= rule.limit) {
        // The window frees up when its oldest hit ages out, not windowMs for now.
        denied = {
            ok:false,
            reason: "rate",
            retryAfterSec: Math.max(1 , Math.ceil((rule.windowMs - (now - recent[0])) / 1000)),
            limit: rule.limit,
            observed: recent.length
        }
    }
    // Per-user gate: keyed on userKey, so it counts only this user's tabs.
    else if(rule.concurrency != null && ((inFlight.get(userKey) ?? 0) >= rule.concurrency)) {
        denied = {
            ok : false,
            reason : "concurrency",
            retryAfterSec : 30,
            limit : rule.concurrency,
            observed : inFlight.get(userKey) ?? 0
        }
    }
    // Instance-wide gate: keyed on `path` alone, so it counts EVERY user's
    // in-flight parses. This branch read `rule.concurrency`/`userKey` — the same
    // condition as the one above — so it could never fire and instanceConcurrency
    // was never enforced.
    else if(rule.instanceConcurrency != null && ((inFlight.get(path) ?? 0) >= rule.instanceConcurrency)) {
        denied =  {
            ok:false,
            reason: "concurrency",
            limit: rule.instanceConcurrency,
            retryAfterSec:30,
            observed:inFlight.get(path) ?? 0,
        }
    }

    if(denied && !isShadowMode()) {
        // Store the pruned window but do NOT record a hit: a refused request never
        // reached the handler, so counting it would extend its own lockout.
        hits.set(userKey , recent)
        return denied
    }
    recent.push(now)
    hits.set(userKey , recent)
    bump(userKey , 1)
    bump(path,1)

    let released = false

    return {
        ok:true,
        remaining : Math.max(0 , rule.limit - recent.length),
        release: () => {
            if(released) return
            released = true
            bump(userKey ,-1)
            bump(path , -1)
        },
        ... (denied ? {wouldBlock: denied} : {}),
    }
}

