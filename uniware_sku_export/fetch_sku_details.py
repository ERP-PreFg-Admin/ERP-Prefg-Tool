# ── Item Master exporter (Unicommerce) — single, facility-agnostic job ────────
import os, json, time, signal, threading, http.client, requests
import pandas as pd
from io import StringIO
from datetime import datetime, timedelta
from urllib.parse import urlencode
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
HOST                 = "pep.unicommerce.com"
CLIENT_ID            = "my-trusted-client"
USERNAME             = "erp.prefg@mcaffeine.com"
PASSWORD             = "Admin@erpprefg"
# The REST API requires a Facility header on every request, even for
# facility-agnostic job types like Item Master. Set this in your .env —
# any valid facility code works, it does not scope/filter the results.
FACILITY             = "mCaff_Gurgaon2"
BASE                 = f"https://{HOST}"
TOKEN_EXPIRY_BUFFER  = 300
MAX_RETRIES          = 3
RATE_LIMIT_WAIT      = 60
POLL_INTERVAL        = 5  # 5 seconds -> to check for file ready after export job create.
POLL_MAX_ATTEMPTS    = 30  # 30 * 10s = 5 minutes total
DOWNLOAD_MAX_RETRIES = 3
DOWNLOAD_RETRY_WAIT  = 10

EXPORT_JOB_TYPE_NAME = "Item Master"
CUSTOM_FILE_NAME     = f"item_master({datetime.now().strftime("%m-%d_%H-%M-%S")})_mcaf407"
DOWNLOAD_DESTINATION = r"C:\Users\AJAY SINGH\Desktop\Unicommerce playing\Downloads"


EXPORT_COLUMNS = [
    "categoryCode", "skuCode", "itemName", "description", "scanIdentifier",
    "requireCustomization", "length", "width", "height", "weight",
    "ean", "upc", "isbn", "color", "size", "brand", "itemDetailFields", "tags",
    "imageUrl", "productPageUrl", "taxTypeCode", "gstTaxTypeCode", "basePrice",
    "costPrice", "tat", "MRP", "updated", "category", "enabled", "type",
    "componentProductCode", "componentQuantity", "componentPrice", "hsn",
    "taxCalculationType", "batchGroupCode", "grnExpiryTolerance",
    "dispatchExpiryTolerance", "returnExpiryTolerance", "expirable",
    "determineExpiryFrom", "shelfLife", "ExpiryDate", "skuType", "fragile",
    "dangerousGood", "itemType_SKU_Category",
]

exit_flag = threading.Event()
signal.signal(signal.SIGINT, lambda s, f: (print("\n⚠️  Exiting..."), exit_flag.set()))

# ── Auth ──────────────────────────────────────────────────────────────────────
def _token_from_response(data):
    if "access_token" not in data:
        raise Exception(f"❌ Auth failed: {data}")
    expiry = datetime.now() + timedelta(seconds=data.get("expires_in", 43199) - TOKEN_EXPIRY_BUFFER)
    return data["access_token"], data.get("refresh_token"), expiry

def get_access_token():
    conn = http.client.HTTPSConnection(HOST, timeout=30)
    qs = urlencode({"grant_type": "password", "client_id": CLIENT_ID, "username": USERNAME, "password": PASSWORD})
    conn.request("POST", f"/oauth/token?{qs}", "", {"Content-Type": "application/x-www-form-urlencoded"})
    data = json.loads(conn.getresponse().read().decode())
    print("✅ Token obtained.")
    return _token_from_response(data)

def refresh_access_token(refresh_token):
    conn = http.client.HTTPSConnection(HOST, timeout=30)
    conn.request("GET", f"/oauth/token?grant_type=refresh_token&client_id={CLIENT_ID}&refresh_token={refresh_token}",
                 "", {"Content-Type": "application/json"})
    data = json.loads(conn.getresponse().read().decode())
    if "access_token" not in data:
        print("⚠️  Refresh failed, doing full login...")
        return get_access_token()
    print("✅ Token refreshed.")
    return _token_from_response(data)

def maybe_refresh(access_token, refresh_token, expiry):
    return refresh_access_token(refresh_token) if datetime.now() >= expiry else (access_token, refresh_token, expiry)

# ── Export job lifecycle ──────────────────────────────────────────────────────
def create_export_job(access_token):
    headers = {"Authorization": f"Bearer {access_token}" , "Facility":FACILITY}
    payload = {"exportJobTypeName": EXPORT_JOB_TYPE_NAME, "exportColums": EXPORT_COLUMNS,
               "exportFilters": [], "frequency": "ONETIME"}
    r = requests.post(f"{BASE}/services/rest/v1/export/job/create", headers=headers, json=payload, timeout=30)
    raw = r.text.strip()
    if not raw:
        raise ValueError(f"Empty response body (HTTP {r.status_code}). Check exportJobTypeName/columns/auth.")
    try:
        resp = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(f"Non-JSON response (HTTP {r.status_code}): {raw[:500]!r}")
    if not resp.get("successful"):
        raise ValueError(f"Export job creation failed: {[e.get('description', e) for e in resp.get('errors', [])]}")
    return resp["jobCode"]

def poll_job_until_done(access_token, refresh_token, expiry, job_code):
    for attempt in range(1, POLL_MAX_ATTEMPTS + 1):
        if exit_flag.is_set():
            raise InterruptedError("Exit requested during poll.")
        access_token, refresh_token, expiry = maybe_refresh(access_token, refresh_token, expiry)
        headers = {"Authorization": f"Bearer {access_token}"}
        try:
            r = requests.post(f"{BASE}/services/rest/v1/export/job/status", headers=headers, json={"jobCode": job_code}, timeout=30)
            if r.status_code == 401:
                access_token, refresh_token, expiry = refresh_access_token(refresh_token)
                continue
            resp = json.loads(r.text) if r.text.strip().startswith("{") else {}
        except Exception as e:
            print(f"   ⚠️  poll error: {e}")
            resp = {}

        successful = resp.get("successful", False)
        status     = str(resp.get("status", "UNKNOWN")).upper()
        file_path  = resp.get("filePath", "")
        errors     = resp.get("errors") or []
        warnings   = resp.get("warnings") or []

        print(f"   [{attempt}/{POLL_MAX_ATTEMPTS}] job {job_code} → {status}")
        for w in warnings:
            print(f"      ⚠️  warning: {w.get('description') or w.get('message')}")

        if not successful and errors:
            msgs = [e.get("description") or e.get("message") for e in errors]
            raise ValueError(f"Job '{job_code}' returned errors: {msgs}")

        # Docs describe the terminal state as "SUCCESSFUL"; observed responses
        # also use "COMPLETE" — accept either once filePath is set.
        if status in ("SUCCESSFUL", "COMPLETE", "SUCCESS") and file_path:
            return file_path
        if status in ("FAILED", "ERROR"):
            raise ValueError(f"Job '{job_code}' failed with status '{status}'.")
        print(f"   ⏳ Not complete yet. Waiting {POLL_INTERVAL} seconds before checking again...")
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Job '{job_code}' timed out.")

def download_csv(file_path_url):
    for attempt in range(1, DOWNLOAD_MAX_RETRIES + 1):
        try:
            r = requests.get(file_path_url, timeout=120)
            r.raise_for_status()
            df = pd.read_csv(StringIO(r.content.decode("utf-8")), low_memory=False)
            df.columns = df.columns.str.strip()
            return df
        except Exception as e:
            print(f"   ⚠️  download attempt {attempt}/{DOWNLOAD_MAX_RETRIES} failed: {e}")
            time.sleep(DOWNLOAD_RETRY_WAIT)
    raise RuntimeError(f"Download failed after {DOWNLOAD_MAX_RETRIES} attempts.")

# Unicommerce's export CSV header for the item/SKU code doesn't always match
# the "skuCode" export-column key it was requested with — try known aliases
# (case-insensitive) before giving up. Update this list once you see the
# actual header names printed below (if none match).
ITEM_CODE_COL_CANDIDATES = [
    "skuCode", "SKU Code", "Sku Code", "SKUCode", "Product Code",
    "Item SkuCode", "Item Sku Code", "SKU", "itemtypeSku",
]

def find_item_code_col(df):
    lower_map = {c.lower(): c for c in df.columns}
    for cand in ITEM_CODE_COL_CANDIDATES:
        if cand.lower() in lower_map:
            return lower_map[cand.lower()]
    return None

# ── Main ──────────────────────────────────────────────────────────────────────
def run():
    access_token, refresh_token, expiry = get_access_token()

    # Phase 1 — create the single export job
    job_code = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            access_token, refresh_token, expiry = maybe_refresh(access_token, refresh_token, expiry)
            job_code = create_export_job(access_token)
            print(f"✅ Job created: {job_code}")
            break
        except Exception as e:
            print(f"⚠️  attempt {attempt}/{MAX_RETRIES}: {e}")
            print(f"   ⏳ Waiting {RATE_LIMIT_WAIT//60} minutes before trying again...")
            time.sleep(RATE_LIMIT_WAIT)
    if job_code is None:
        print("❌ Could not create export job. Aborting.")
        return pd.DataFrame()

    # Phase 2 — poll, download
    file_url= poll_job_until_done( access_token, refresh_token, expiry, job_code)
    if not file_url:
        print("❌ No file URL found. Aborting.")
        return pd.DataFrame()
    df = download_csv(file_url)

    # Phase 3 — keep unique item/SKU codes only (dedupe as a safety net) & save
    item_code_col = find_item_code_col(df)
    if item_code_col is None:
        print(f"⚠️  No item/SKU code column found. Actual headers: {list(df.columns)}")
    else:
        before = len(df)
        df = df.drop_duplicates(subset=item_code_col, keep="first").reset_index(drop=True)
        print(f"📊 {len(df):,} unique items ({before - len(df):,} duplicate rows dropped)")

    if not df.empty:
        csv_path = os.path.join(DOWNLOAD_DESTINATION, f"{CUSTOM_FILE_NAME}.csv")
        df.to_csv(csv_path, index=False)
        df.to_excel("output.xlsx", index=False)
        print(f"🚀 Saved: {csv_path}")

    return df


if __name__ == "__main__":
    run()