// Addresses for creating a manufacturer as a Uniware vendor, transcribed from its supplier
// invoices (docs/uniware-vendor-create-plan.md). Keyed by GSTIN: mfg codes differ dev vs prod.

export type VendorAddress = {
  addressLine1: string
  city: string
  pincode: string
  /** Two-letter, as Uniware's own sample ("HR"). */
  stateCode: string
}

/** Placeholders Ajay set for every vendor this app creates (2026-10-09). */
export const VENDOR_PHONE = "11111111"
export const VENDOR_EMAIL = "ABC@gmail.com"

export const VENDOR_ADDRESSES: Record<string, VendorAddress> = {
  // Cheryl — factory address, not the Andheri office
  "27AAACC4638H1ZQ": { addressLine1: "Plot No. A-328, 329, 330, TTC Industrial Area, MIDC, Mahape", city: "Navi Mumbai", pincode: "400710", stateCode: "MH" },
  // Archeesh
  "36AANCA8536H1ZB": { addressLine1: "Plot No. 12 to 29, Gundla Pochampally, Medchal-Malkajgiri Dist", city: "Hyderabad", pincode: "501401", stateCode: "TG" },
  // Aroma De France
  "24AALFA6998C1Z8": { addressLine1: "Block No. 324, Nr. IPCA Laboratories, Vill. Ranu, Tal. Padra", city: "Vadodara", pincode: "391445", stateCode: "GJ" },
  // N.G. Electro — unit MBA, the one on details_mfg's GSTIN
  "02AACCN5184H1ZM": { addressLine1: "Plot No. 51 & 52, Himuda Industrial Area, Phase IV, Bhatolikalan, Teh. Baddi, Dist. Solan", city: "Baddi", pincode: "173205", stateCode: "HP" },
  // Anuspa — read via Nanonets (scanned invoice)
  "02AACCA9104C1ZH": { addressLine1: "Plot No. 3, Industrial Area Estate Khadeen, Dist. Solan", city: "Parwanoo", pincode: "173220", stateCode: "HP" },
  // Aelius
  "06AAQCA9144G1ZF": { addressLine1: "Plot No. GP-55, Udhyog Vihar, Sector-18, HSIIDC", city: "Gurgaon", pincode: "122015", stateCode: "HR" },
  // Vedic
  "09AADCV5085A1ZD": { addressLine1: "C-21, Sector-88, Industrial Area", city: "Noida", pincode: "201305", stateCode: "UP" },
  // Yasharth — read via Nanonets (scanned invoice)
  "27AABCY3614L1Z4": { addressLine1: "G 41, Additional MIDC, Via Dewoolwada, Nerur, Kudal", city: "Sindhudurg", pincode: "416520", stateCode: "MH" },
  // Kain — factory address, not the Vashi registered office
  "27AAHCK8806G1ZB": { addressLine1: "Survey No. 63, Horale, Khopoli Pen Road, Khalapur", city: "Raigad", pincode: "410203", stateCode: "MH" },
  // All Mask (Jainam Invamed)
  "27AACCJ6015B1Z2": { addressLine1: "Gala No. 18, Dream Industrial Park, Poman", city: "Palghar", pincode: "401208", stateCode: "MH" },
  // Ananya
  "06AAQCA4662B1ZS": { addressLine1: "Khasra No. 6/6, 7/8/2, 9min, 10, Pana Paposhian Village, Safiabad", city: "Sonipat", pincode: "131029", stateCode: "HR" },
  // Arovea
  "24AAVCA3458L1Z4": { addressLine1: "New Block No. 622, Khavad-Vekra Road, Village Khavad, Ta. Kadi, Dist. Mehsana", city: "Mehsana", pincode: "382165", stateCode: "GJ" },
  // Reve — PIN from the e-way block of its S3 invoices
  "27AAKFR0481L1ZT": { addressLine1: "Plot No. 78, STICE, Musalgaon, Tal. Sinnar", city: "Nashik", pincode: "422112", stateCode: "MH" },
  // Cimera
  "05AAJCC1207D1ZC": { addressLine1: "Plot No. 52, Sector-6A, I.I.E., SIDCUL", city: "Haridwar", pincode: "249403", stateCode: "UK" },
  // Not here: Kapco, Zymo, Samrvir — no PIN on any invoice.
}

export function vendorAddressFor(gstin: string | null | undefined): VendorAddress | null {
  return VENDOR_ADDRESSES[(gstin ?? "").trim().toUpperCase()] ?? null
}

export type VendorCreatePayload = {
  vendor: {
    code: string
    name: string
    billingAddress: VendorAddress & { countryCode: "IN"; phone: string }
    shippingAddress: VendorAddress & { countryCode: "IN"; phone: string }
    partyContacts: { contactType: "PRIMARY"; name: string; email: string; phone: string }[]
  }
}

/** Only what V2 asked for: code, name, billing = shipping, one placeholder contact. */
export function buildVendorCreatePayload(mfg: { code: string; name: string }, address: VendorAddress): VendorCreatePayload {
  const code = mfg.code.trim()
  const name = mfg.name.trim()
  if (!code || code.length > 45) throw new Error(`Vendor code must be 1-45 characters (got "${code}")`)
  if (!name || name.length > 100) throw new Error(`Vendor name must be 1-100 characters (got "${name}")`)
  const addr = { ...address, countryCode: "IN" as const, phone: VENDOR_PHONE }
  return {
    vendor: {
      code,
      name,
      billingAddress: addr,
      shippingAddress: { ...addr },
      partyContacts: [{ contactType: "PRIMARY", name, email: VENDOR_EMAIL, phone: VENDOR_PHONE }],
    },
  }
}
