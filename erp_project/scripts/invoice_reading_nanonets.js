require("dotenv/config");
const fs = require("fs");
const path = require("path");

const nanonet_key = process.env.NANONET_API_KEY;
if (!nanonet_key) throw new Error("NANONET_API_KEY is not set (check .env)");

const nanonets_host = "https://extraction-api.nanonets.com/";
const auth = { Authorization: `Bearer ${nanonet_key}` };

const EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "date": {"type": "string", "description": "Invoice date in dd-mmm-yy format, e.g. 05-Jul-25"},
        "invoice_number": {"type": "string"},
        "eway_bill_number": {"type": "string"},
        "from": {"type": "string", "description": "Consignor / origin party or location"},
        "destination": {"type": "string", "description": "Consignee / ship-to location"},
        "vehicle_number": {"type": "string"},
        "line_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sku_code": {"type": "string"},
                    "sku_name": {"type": "string"},
                    "batch": {"type": "string"},
                    "mfg_date": {"type": "string", "description": "dd-mmm-yy"},
                    "expiry": {"type": "string", "description": "dd-mmm-yy"},
                    "qty": {"type": "number"},
                    "hsn": {"type": "string"},
                    "rate": {"type": "number"},
                    "amount": {"type": "number", "description": "rate x qty, before tax"},
                    "gst_percent": {"type": "number", "description": "GST rate as a number, e.g. 18"},
                    "total_amount": {"type": "number", "description": "line total including GST"},
                },
            },
        },
    },
}
// One string, not a tuple — a JS comma-expression would silently keep only the
// last fragment, so every instruction but the final one would be dropped.
const CUSTOM_INSTRUCTIONS = [
    "Extract each product row as a separate object in line_items.",
    "Return ALL dates (date, mfg_date, expiry) in dd-mmm-yy format, e.g. 05-Jul-25.",
    "Strip currency symbols and thousands separators from all numeric fields;",
    "return qty, rate, amount, gst_percent and total_amount as plain numbers.",
    "gst_percent is the tax rate (e.g. 18), not the tax amount.",
    "If a field is not present on the document, return null. Do not guess or fabricate values.",
].join(" ");

async function main() {
    const invoiceDir = path.join(__dirname, "..", "..", "Invoices");
    const invoiceFile = path.join(invoiceDir, "Sales_RP_L_26-27_482 (1).pdf");

    const fileBuffer = fs.readFileSync(invoiceFile);

    const formData = new FormData();
    formData.append(
        "file",
        new Blob([fileBuffer]),
        path.basename(invoiceFile)
    );
    // 1. Upload — returns a file://<uuid> handle to feed the extractor.
    const response = await fetch(`${nanonets_host}api/v2/files`, {
        method: "POST",
        headers: auth,
        body: formData,
    });
    if (!response.ok) {
        throw new Error(`upload ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    console.log("Uploaded:", data.filename, data.file_id);

    // 2. Extract — /extract/sync, NOT /parse/sync. parse only emits
    // markdown/html and has no schema support, so EXTRACTION_SCHEMA would be
    // ignored there. json_options takes the schema dict directly.
    const extract_doc = await fetch(`${nanonets_host}api/v2/parse/sync`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
            input: data.file_id,
            extraction_config: {
                output_format: "html",
                prompt_mode: "append",
            },
        }),
    });

    if (!extract_doc.ok) {
        throw new Error(`extract ${extract_doc.status}: ${await extract_doc.text()}`);
    }

    const res = await extract_doc.json();
    // result is sometimes the format-result directly, sometimes keyed by format.
    const formatResult = res.result?.json ?? res.result;
    const content = formatResult?.content ?? formatResult;
    console.log("Data:", JSON.stringify(content, null, 2));
    return content;
}

main().catch(console.error);