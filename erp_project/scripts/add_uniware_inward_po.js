// Uniware (Unicommerce) auth — ported from uniware_sku_export/fetch_sku_details.py.
//
// Credentials come from the environment, not the source: the Python original
// has them inline, which is how they ended up sitting in a file on disk.
// UNIWARE_* is already in .env and in SSM under /erp-app/<env>/
// (see deploy/push-secrets.mjs).
//
//   node scripts/add_uniware_inward_po.js     # authenticates and reports
//
// Tokens last ~12h. Long-running callers should put maybe_refresh() in front of
// each request rather than tracking expiry themselves.

require("dotenv/config");

const uni_name = process.env.UNIWARE_USER_NAME;
const uni_pass = process.env.UNIWARE_PASSWORD;
const uni_base = (process.env.UNIWARE_BASE_URL || "").replace(/\/+$/, "");

// Unicommerce's stock public OAuth client — there's no per-tenant value to
// configure, which is why the Python hardcodes it too.
const client_id = process.env.UNIWARE_CLIENT_ID || "my-trusted-client";
// Every REST call needs a Facility header. purchaseOrder/create is a
// facility-level call, so unlike the Item Master export this one genuinely
// scopes where the PO lands. Pointed at the sandbox facility until the flow is
// signed off — override with UNIWARE_FACILITY to go live.
const facility = process.env.UNIWARE_FACILITY || "TEST_FACILITY";

// Renew this far ahead of the real expiry, so a request can't go out holding a
// token that dies mid-flight.
const TOKEN_EXPIRY_BUFFER_S = 300;
const DEFAULT_EXPIRES_IN_S = 43199;
const TIMEOUT_MS = 30_000;

/** @typedef {{ access_token: string, refresh_token: string|undefined, expires_at: number }} Token */

/**
 * Shared shape of both auth responses.
 *
 * Checks the payload rather than the HTTP status: this endpoint answers 200
 * with an error body, so `res.ok` alone would let a failed login through.
 */
function token_from_response(data) {
  if (!data || !data.access_token) {
    throw new Error(`Uniware auth failed: ${JSON.stringify(data)}`);
  }
  const ttl = (data.expires_in ?? DEFAULT_EXPIRES_IN_S) - TOKEN_EXPIRY_BUFFER_S;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ttl * 1000,
  };
}

/** Password-grant login. @returns {Promise<Token>} */
async function get_access_token() {
  if (!uni_base) throw new Error("UNIWARE_BASE_URL is not set (check .env)");
  if (!uni_name) throw new Error("UNIWARE_USER_NAME is not set (check .env)");
  if (!uni_pass) throw new Error("UNIWARE_PASSWORD is not set (check .env)");

  // Credentials travel in the query string because that's what this endpoint
  // reads — it ignores a form-encoded body. Not our choice.
  const qs = new URLSearchParams({
    grant_type: "password",
    client_id,
    username: uni_name,
    password: uni_pass,
  });

  const res = await fetch(`${uni_base}/oauth/token?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  const token = token_from_response(data);
  console.log("Token obtained.");
  return token;
}

/** Exchange a refresh token, falling back to a full login. @returns {Promise<Token>} */
async function refresh_access_token(refresh_token) {
  if (!refresh_token) return get_access_token();

  const qs = new URLSearchParams({
    grant_type: "refresh_token",
    client_id,
    refresh_token,
  });

  // GET here, unlike the POST used for the password grant. That asymmetry is
  // the API's, not a mistake.
  const res = await fetch(`${uni_base}/oauth/token?${qs}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));

  if (!data || !data.access_token) {
    console.warn("Refresh failed, doing full login...");
    return get_access_token();
  }
  console.log("Token refreshed.");
  return token_from_response(data);
}

/** Renew only once the buffered expiry has passed. @returns {Promise<Token>} */
async function maybe_refresh(token) {
  if (!token) return get_access_token();
  return Date.now() >= token.expires_at
    ? refresh_access_token(token.refresh_token)
    : token;
}

/** Headers every Uniware REST call needs. */
function auth_headers(token) {
  return { Authorization: `Bearer ${token.access_token}`, Facility: facility };
}

// ── Purchase order create ────────────────────────────────────────────────────
// POST /services/rest/v1/purchase/purchaseOrder/create
// Mandatory: vendorCode, and per item itemSKU + quantity + unitPrice.

/**
 * Shape a create payload. Only the documented fields are sent — Uniware rejects
 * unknown keys rather than ignoring them.
 *
 * @param {{
 *   purchaseOrderCode?: string, vendorCode: string, vendorAgreementName?: string,
 *   currencyCode?: string, expiryDate?: string|Date, deliveryDate?: string|Date,
 *   logisticCharges?: number, logisticChargesDivisionMethod?: string,
 *   items: Array<{ itemSKU: string, quantity: number, unitPrice: number,
 *                  maxRetailPrice?: number, discount?: number,
 *                  discountPercentage?: number, taxTypeCode?: string }>,
 *   customFields?: Record<string, string>,
 * }} po
 */
function build_purchase_order(po) {
  if (!po.vendorCode) throw new Error("vendorCode is required");
  if (!po.items?.length) throw new Error("At least one purchase order item is required");

  po.items.forEach((it, i) => {
    if (!it.itemSKU) throw new Error(`items[${i}].itemSKU is required`);
    if (!(Number(it.quantity) > 0)) throw new Error(`items[${i}].quantity must be > 0`);
    if (it.unitPrice == null) throw new Error(`items[${i}].unitPrice is required`);
  });

  // Uniware wants UTC ISO-8601; accepts a Date or an already-formatted string.
  const iso = (d) => (d == null ? undefined : d instanceof Date ? d.toISOString() : String(d));

  const payload = {
    purchaseOrderCode: po.purchaseOrderCode,
    type: "MANUAL", // the only value this endpoint documents
    vendorCode: po.vendorCode,
    vendorAgreementName: po.vendorAgreementName,
    currencyCode: po.currencyCode || "INR",
    expiryDate: iso(po.expiryDate),
    deliveryDate: iso(po.deliveryDate),
    logisticChargesDivisionMethod: po.logisticChargesDivisionMethod,
    logisticCharges: po.logisticCharges,
    purchaseOrderItems: po.items.map((it) => ({
      itemSKU: it.itemSKU,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      maxRetailPrice: it.maxRetailPrice == null ? undefined : Number(it.maxRetailPrice),
      discount: it.discount == null ? undefined : Number(it.discount),
      discountPercentage: it.discountPercentage == null ? undefined : Number(it.discountPercentage),
      taxTypeCode: it.taxTypeCode,
    })),
    customFieldValues: po.customFields
      ? Object.entries(po.customFields).map(([name, value]) => ({ name, value: String(value) }))
      : undefined,
  };

  // Strip undefined so optional fields are absent rather than null — Uniware
  // treats an explicit null as a value and complains about some of them.
  return JSON.parse(JSON.stringify(payload));
}

/**
 * Create the PO. Resolves to the API's response object.
 *
 * Uniware answers HTTP 200 with `{successful: false, errors: [...]}` on a
 * business failure, so the body decides success, not the status code.
 */
async function create_purchase_order(token, payload) {
  const res = await fetch(`${uni_base}/services/rest/v1/purchase/purchaseOrder/create`, {
    method: "POST",
    headers: { ...auth_headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const raw = await res.text();
  if (!raw.trim()) {
    throw new Error(`Empty response (HTTP ${res.status}) — check the Facility header and auth.`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${raw.slice(0, 500)}`);
  }

  if (!data.successful) {
    const msgs = (data.errors || []).map((e) => e.description || e.message || JSON.stringify(e));
    throw new Error(
      `Purchase order create failed (HTTP ${res.status}): ${msgs.join("; ") || JSON.stringify(data).slice(0, 500)}`
    );
  }
  for (const w of data.warnings || []) {
    console.warn(`  warning: ${w.description || w.message}`);
  }
  return data;
}

module.exports = {
  uni_base,
  client_id,
  facility,
  token_from_response,
  get_access_token,
  refresh_access_token,
  maybe_refresh,
  auth_headers,
  build_purchase_order,
  create_purchase_order,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
//
//   node scripts/add_uniware_inward_po.js --auth-only
//   node scripts/add_uniware_inward_po.js --vendor V001 --sku MCaf407 --qty 10 --price 69.21
//   node scripts/add_uniware_inward_po.js --file po.json
//   ... add --dry-run to print the payload without sending it.

function parse_args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    // Flags have no value; everything else consumes the next token.
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const args = parse_args(process.argv.slice(2));

    const token = await get_access_token();
    console.log(`  base:     ${uni_base}`);
    console.log(`  facility: ${facility}`);
    console.log(`  token:    ${token.access_token.slice(0, 8)}… (${token.access_token.length} chars)`);
    console.log(`  usable for a further ~${Math.round((token.expires_at - Date.now()) / 60000)} min`);
    // maybe_refresh has to be a no-op on a fresh token, or every call would
    // silently re-authenticate.
    console.log(`  maybe_refresh reused the token: ${(await maybe_refresh(token)) === token}`);

    if (args["auth-only"]) return;

    const po = args.file
      ? JSON.parse(require("node:fs").readFileSync(args.file, "utf8"))
      : {
          purchaseOrderCode: args.code,
          vendorCode: args.vendor,
          items: [{
            itemSKU: args.sku,
            quantity: Number(args.qty),
            unitPrice: Number(args.price),
          }],
        };

    if (!po.vendorCode || !po.items?.[0]?.itemSKU) {
      console.log("\nNothing to create. Pass --vendor/--sku/--qty/--price, or --file po.json,");
      console.log("or --auth-only to just check the credentials.");
      return;
    }

    const payload = build_purchase_order(po);
    console.log("\nPayload:");
    console.log(JSON.stringify(payload, null, 2));

    if (args["dry-run"]) { console.log("\n--dry-run: not sent."); return; }

    console.log(`\nCreating in ${facility}…`);
    const result = await create_purchase_order(token, payload);
    console.log("Created:", JSON.stringify(result, null, 2));
  })().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
