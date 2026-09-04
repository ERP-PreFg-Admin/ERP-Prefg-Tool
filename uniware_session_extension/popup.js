// Reads the pep.unicommerce.com session cookies and POSTs them to the ERP.
//
// WHY THIS WORKS WHERE A PAGE SCRIPT CANNOT: JSESSIONID is HttpOnly, so
// document.cookie cannot see it. The chrome.cookies API can — it is the one
// context allowed to read HttpOnly cookies — which is the whole reason this is an
// extension and not a bookmarklet.
//
// The cookie is a live login. It goes straight to the ERP over HTTPS and is
// never stored here, never logged, never shown.

const PEP_URL = "https://pep.unicommerce.com/"
// Only these two are the tenant session; nothing else is sent.
const WANTED = ["JSESSIONID", "IS_LOGIN"]

const erpInput = document.getElementById("erp")
const sendBtn = document.getElementById("send")
const statusEl = document.getElementById("status")

function setStatus(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ""
}

// Remember the ERP address between uses.
chrome.storage.local.get("erpUrl").then(({ erpUrl }) => {
  erpInput.value = erpUrl || "http://localhost:3000"
})

sendBtn.addEventListener("click", async () => {
  const base = erpInput.value.trim().replace(/\/+$/, "")
  if (!base) return setStatus("Enter the ERP address first.", "err")
  await chrome.storage.local.set({ erpUrl: base })

  sendBtn.disabled = true
  setStatus("Reading your Uniware session…")
  try {
    const all = await chrome.cookies.getAll({ url: PEP_URL })
    const picked = all.filter((c) => WANTED.includes(c.name))
    const cookie = picked.map((c) => `${c.name}=${c.value}`).join("; ")

    if (!picked.some((c) => c.name === "JSESSIONID")) {
      setStatus("Not signed in to Uniware in this browser.\nOpen pep.unicommerce.com, sign in, then try again.", "err")
      return
    }

    setStatus("Sending to ERP…")
    const res = await fetch(`${base}/api/v1/uniware/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    })
    const data = await res.json().catch(() => ({}))

    if (res.ok && data.ok) {
      setStatus("✓ Session updated. The ERP can now sync documents.", "ok")
    } else if (res.status === 400) {
      setStatus("The ERP rejected the session — it may have expired.\nSign in to Uniware again, then retry.", "err")
    } else {
      setStatus(`ERP error (${res.status}): ${data.error || "unknown"}`, "err")
    }
  } catch (e) {
    setStatus(`Could not reach the ERP: ${e.message}\nCheck the ERP address.`, "err")
  } finally {
    sendBtn.disabled = false
  }
})
