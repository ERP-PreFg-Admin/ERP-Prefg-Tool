// Is this manufacturer already a vendor at a facility? Matched against Uniware's own
// Vendors export, whose codes are hand-typed per facility (NG_ELECTRO, _Reve_, …).

export type UniwareVendor = { code: string; name: string }
/** `exact` = normalised equality; only an exact sole match may be used without asking. */
export type VendorMatch = UniwareVendor & { exact: boolean }

const STOP_WORDS = new Set(["pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "the"])

/** "N.G. Electro Products Pvt. Ltd." and "N_G_Electro_Products_Pvt_Ltd" → "ngelectroproducts". */
export function normalizeVendorName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP_WORDS.has(t))
    .join("")
}

/** Keys this short only match exactly — "reve" must not catch "revenue…". */
const PREFIX_MIN = 5

/** Codes carry suffixes (All_Mask_Hyphen) or drop words (Yasharth_Wellness), so a prefix either way is a loose hit. */
function prefixOf(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= PREFIX_MIN && long.startsWith(short)
}

/** Distinct vendors whose code or name matches the manufacturer's code, name or registered name. */
export function matchVendor(
  vendors: UniwareVendor[],
  mfg: { code: string | null; name: string | null; registered_name: string | null },
): VendorMatch[] {
  const keys = [mfg.code, mfg.name, mfg.registered_name].map(normalizeVendorName).filter((k) => k.length >= 3)
  const out = new Map<string, VendorMatch>()
  for (const v of vendors) {
    const code = v.code?.trim()
    if (!code) continue
    const vk = [normalizeVendorName(code), normalizeVendorName(v.name)].filter(Boolean)
    const exact = keys.some((k) => vk.includes(k))
    if (exact || keys.some((k) => vk.some((x) => prefixOf(k, x)))) {
      out.set(code, { code, name: v.name?.trim() ?? "", exact: exact || (out.get(code)?.exact ?? false) })
    }
  }
  return [...out.values()]
}

/** The vendor to use without asking: the one exact match when it is also the only candidate. */
export function soleExactMatch(matches: VendorMatch[]): VendorMatch | null {
  return matches.length === 1 && matches[0].exact ? matches[0] : null
}
