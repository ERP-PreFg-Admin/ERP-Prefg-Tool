-- WHAT: attachments_invoice + uniware_web_session — documents moving BOTH ways
-- between an invoice and the Uniware PO it was mirrored to.
--
-- WHY: there is no warehouse-side application, so Uniware is the only surface
-- the warehouse and we both see. Two gaps follow from that:
--   · the warehouse receives goods without our supplier invoice in front of it
--   · the invoice copy it signs at the dock never reaches the ERP
-- Both are the same pipe, so they are one table.
--
-- ── WHY THIS ISN'T A COLUMN ──────────────────────────────────────────────────
-- invoice_mfg.attachment_key is taken — it holds the supplier invoice PDF we
-- stored at commit — and one invoice grows several documents over its life
-- (our push, the signed copy, a debit note, a photo of damaged cartons).
--
-- ── WHY invoice_id AND NOT po_id ─────────────────────────────────────────────
-- lib/invoice/invoice-inward.ts mirrors ONE Uniware PO per invoice carrying
-- every SKU. Documents hang off that Uniware PO, so the invoice is the grain.
-- Our inward POs are per-SKU children of it and share its document list; keying
-- on po_id would store the same file once per SKU.
--
-- ── MANY DOCUMENTS PER INVOICE IS THE NORMAL CASE ────────────────────────────
-- A PO in Uniware accumulates whatever the warehouse attaches: the signed
-- invoice copy, a weighment slip, photos of damaged cartons, a debit note. One
-- row per file, and the pull inserts every entry /documents/list returns.
--
-- The UNIQUE key is (invoice_id, filename) rather than the document id because
-- FILENAME IS THE ADDRESS: /document/V2/download takes &filename=, not an id, so
-- a name is necessarily unique within one identifier or the second file of that
-- name could never be fetched. uniware_doc_id (their `documentLocation`) is kept
-- beside it for tracing a row back to their record, not for identity.
--
-- ── attachments_invoice.source IS LOAD-BEARING ───────────────────────────────
-- 'erp'     we pushed it to Uniware
-- 'uniware' someone there uploaded it and we pulled it down
-- Without it the next pull re-downloads the invoice PDF WE pushed and stores a
-- second copy of a file already in S3 under invoice_mfg.attachment_key. The pull
-- skips filenames it already holds as 'erp'.
--
-- ── uniware_web_session: ONE ROW, AND WHY IT HAS TO EXIST ────────────────────
-- The Uniware document API mints its capability at
--   POST pep.unicommerce.com/data/document/auth/details/get
-- which takes the TENANT WEB COOKIE. Measured 2026-09-01: our OAuth bearer gets
-- HTTP 500, anonymous gets 401 USER_NOT_LOGGED_IN, the cookie gets 200. Tenant
-- 'pep' authenticates through Keycloak realm google_only — Google SSO with 2FA,
-- no username/password form — so the cookie cannot be obtained by any service
-- credential we hold. A human runs `python uniware_documents/harvest.py login`
-- and that writes the row here; it lasts about 10 hours.
--
-- Everything downstream of the mint is plain HTTP: the token+checksum pair is
-- self-authorising on docs.unicommerce.com, needs no cookie and no bearer, and
-- never expires. So this row is the ONLY perishable credential in the feature.
--
-- SECURITY: this row is a live session for erp.prefg@mcaffeine.com. Treat it as
-- a password — never log it, never return it from an API route, never send it to
-- a browser. Same for the minted token/checksum pairs.
--
-- RE-RUNNABLE: no. MySQL 8 has no ADD COLUMN IF NOT EXISTS; CREATE TABLE uses
-- IF NOT EXISTS so a partial run can be resumed.
-- RUN ON: both schemas.

CREATE TABLE IF NOT EXISTS attachments_invoice (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id          INT          NOT NULL,
  filename            VARCHAR(255) NOT NULL,
  -- Our own S3 object. The Uniware URL is presigned and expires, so only the
  -- bytes survive — never store their link and call it an attachment.
  s3_key              VARCHAR(512) NOT NULL,
  content_type        VARCHAR(120) DEFAULT NULL,
  bytes               INT          DEFAULT NULL,
  source              ENUM('erp','uniware') NOT NULL,
  -- As Uniware reports them, for a pulled document. Strings, because they are
  -- what that system said rather than anything we derive — `created` comes back
  -- as "Sep 1, 2026 5:34:30 PM", not a parseable timestamp.
  uniware_doc_id      VARCHAR(64)  DEFAULT NULL,
  uniware_uploaded_by VARCHAR(190) DEFAULT NULL,
  uniware_created     VARCHAR(60)  DEFAULT NULL,
  synced_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One row per file per invoice. This is what makes the pull idempotent: the
  -- sweep inserts blindly and lets the index reject what it already holds.
  UNIQUE KEY uq_invoice_filename (invoice_id, filename),
  KEY idx_invoice (invoice_id),
  KEY idx_s3_key (s3_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS uniware_web_session (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  -- "IS_LOGIN=…; JSESSIONID=…" — the pep.unicommerce.com cookies, as a header.
  cookie      TEXT      NOT NULL,
  obtained_at DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Advisory only. Staleness is detected by CONTENT, never by this or by an
  -- HTTP status: these routes answer 200 with an HTML shell rather than 401.
  expires_at  DATETIME  DEFAULT NULL,
  obtained_by VARCHAR(190) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
