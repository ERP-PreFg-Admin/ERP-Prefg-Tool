# ERP Uniware Session extension

A tiny Chrome extension whose only job is to hand your **already signed-in**
Uniware session to the ERP, so the ERP can push and pull purchase-order
documents on Uniware. It does not log you in and does not store anything — it
reads the `pep.unicommerce.com` session cookies and POSTs them to the ERP once,
when you click the icon.

Why it exists: Uniware's tenant signs in through Google SSO with 2FA
(`google_only`), which no server can automate. But whoever refreshes the session
is already logged into Uniware in their browser — the extension just lifts the
cookies out of that session. `JSESSIONID` is `HttpOnly`, so only an extension
(via `chrome.cookies`) can read it; a page script or bookmarklet cannot.

## Using it

1. Open **pep.unicommerce.com** and make sure you are signed in.
2. Click the extension icon.
3. First time only: type the ERP address (e.g. `http://localhost:3000` in dev,
   or the real ERP URL) and it is remembered.
4. Click **Send session to ERP** → you should see "✓ Session updated".

Do this again whenever the ERP's "Sync Documents" says the session has expired —
roughly once every ten hours. Anyone with Uniware access can do it.

## Installing it

### You, now — load unpacked
1. `chrome://extensions`
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this folder.

### The team, later — Chrome Enterprise force-install
IT publishes this folder (an internal URL, or the Chrome Web Store as
*unlisted*) and force-installs it by extension ID via `ExtensionInstallForcelist`
in Google Admin or the Windows registry. It then appears on every managed Chrome
automatically and updates centrally — nobody clicks "Load unpacked" but you.

## What it sends

Exactly two cookies — `JSESSIONID` and `IS_LOGIN` — to `POST
/api/v1/uniware/session` on the ERP, over HTTPS. Nothing else, nowhere else. The
ERP validates the cookie by using it before storing, so only a working Uniware
session is accepted.

## Security

The cookie is a live login. Treat this extension like a password tool:
- Point it only at the real ERP address.
- The ERP endpoint is HTTPS-only and rate-limited.
- The cookie is never logged, echoed, or stored by the extension itself.
