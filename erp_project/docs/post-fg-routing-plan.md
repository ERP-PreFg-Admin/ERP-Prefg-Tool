# One domain, two ERPs: routing erp.mcaffeine.com by path

**Status:** plan, awaiting go-ahead. Nothing has been changed.

## Goal

`erp.mcaffeine.com` stays the only address users know. CloudFront sits in front, and the path decides which system answers:

| Path | Goes to |
|---|---|
| `/postfg/api/*` | post-FG API EC2 |
| `/postfg/*` | post-FG frontend S3 bucket |
| `/` and everything else | pre-FG EC2 (this app, unchanged) |

## What is actually deployed (read 2026-10-23)

**Everything is in one account, `157320387454`, region ap-south-1.** That includes pre-FG, post-FG, ECR and SSM. Account `230235764844` hosts neither app.

| | Pre-FG | Post-FG (dev only so far) |
|---|---|---|
| Compute | `erp-app-prod` `i-0a249d3d470e693d3` (t3.small, EIP `65.0.197.42`) · `erp-app-test` `i-0d269978588f3c2da` (t3.micro, `13.201.247.36`) | `mcaffeine-erp-post-fg-api-ec2-dev` `i-0861f2e66c3ce83f7` (t3.micro, `15.252.52.54`) |
| Front door | GoDaddy A records: `erp.` → prod box, `dev.erp.` → test box. nginx + Let's Encrypt on each box. Prod cert valid to 2027-01-10 | **already behind CloudFront.** Its security group allows port 80 only from `pl-9aa247f3`, described as "HTTP from CloudFront (API origin of the frontend site)" |
| Static | — | S3 `mcaffeine-erp-post-fg-frontend-s3-dev` |
| Who can reach it | **Office and VPN only.** Security group `sg-0b47822934473fe9f` allows 443 just from `13.207.143.186/32` (the AWS-VPN box) and `103.71.113.198/32` (the office) | through its CloudFront, which can't be listed with our keys |
| Managed by | `deploy/*.sh` + GitHub Actions | Terraform (state in `mcaffeine-erp-post-fg-tfstate`) |

There is also a port-8005 rule on post-FG for the "PO process Lambda" (`sg-08af29b3cd39dd1f2`). It's internal and untouched here.

## Recommended now: nginx on the pre-FG box (added 2026-10-23)

The pre-FG box already runs nginx in front of the app on `erp.mcaffeine.com`. One more `location` sends `/postfg/` to post-FG's existing CloudFront distribution, which already routes post-FG's frontend and API.
- **Nothing changes in DNS.**
- **No WAF:** the box's office/VPN security group already covers `/postfg` too.
- **Pre-FG timeouts unchanged:** pre-FG never goes through CloudFront.
- **No new AWS cost.**
- **Rollback:** delete the block and reload nginx.
- **Survives pre-FG deploys:** nginx runs on the host, not in the container, so redeploying pre-FG doesn't take post-FG down. Only an outage of the box itself does.

```nginx
# Goes in the 443 server block certbot wrote into /etc/nginx/conf.d/erp.conf.
location /postfg/ {
    resolver 169.254.169.253 valid=30s;           # VPC DNS; CloudFront IPs rotate
    set $postfg <post-fg-distribution>.cloudfront.net;
    rewrite ^/postfg/(.*)$ /$1 break;             # post-FG's distribution serves from /
    proxy_pass https://$postfg;
    proxy_ssl_server_name on;
    proxy_ssl_name $postfg;
    proxy_set_header Host $postfg;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
}
```

**Post-FG dev distribution:** `d2e7vqoxx4587h.cloudfront.net`. Probed 2026-10-23:
- the page, deep-link fallback and `/api/v1/health` all return 200;
- the health check reports `database: disabled`;
- assets are referenced from `/assets/`, at the root.

**Decided 2026-10-23:** the path is `/postfg`.

**Done on `erp-app-test` 2026-10-23.** The block was added to `/etc/nginx/conf.d/erp.conf` over SSM, with `resolver … ipv6=off`, because the box resolves CloudFront to IPv6 first. `nginx -t` passed and nginx reloaded.
- **Backup:** `/root/erp.conf.bak-20261023-094348`. To undo, copy it back and reload.
- **Verified from the office:**
  - pre-FG `/` still answers 307 → `/auth/signin`, and `/api/health` 200;
  - `/postfg` returns 301 → `/postfg/`;
  - `/postfg/` and `/postfg/po-review` return 200 from CloudFront;
  - `/postfg/api/v1/health` returns 200.
- **Not yet in `deploy/bootstrap-instance.sh`:** a rebuilt box would lose the block.

**Post-FG dev live at `dev.erp.mcaffeine.com/postfg/`, 2026-10-23.** Login works. On their side, the post-FG team:
- built the frontend under the `/postfg/` base path and router `basename`;
- set `VITE_API_BASE_URL=/postfg/api/v1`;
- added the login URLs, Google keys and `AUTH_SECRET` to the dev SSM `.env`.

Handover doc: https://claude.ai/artifact/J2U8tV3VozFpQfE4BdfmSB. **Next: prod**, which needs the post-FG prod infra first. Then the same nginx block on `erp-app-prod`, pointing at the prod distribution. That step needs its own go-ahead.

- Post-FG lives under a path on the existing domains: `dev.erp.mcaffeine.com` first, then `erp.mcaffeine.com` once dev is checked. `/` stays pre-FG.
- Logins don't collide: post-FG's cookies are `postfg_session` and `postfg_oauth_state`, while pre-FG's are `authjs.*`.

**Post-FG must also change, because nginx alone is not enough:**
- **Frontend:** Vite `base: '/postfg/'`, `<BrowserRouter basename="/postfg">`, and the GitHub variable `VITE_API_BASE_URL=/postfg/api/v1`. Without these, the browser asks pre-FG for `/assets/*` and `/api/v1/*`.
- **Backend `.env` (SSM `/mcaffeine-erp-post-fg/<env>/api/env`):** `AUTH_CALLBACK_URL`, `AUTH_REDIRECT_URL` and `FRONTEND_ORIGIN` move onto `https://dev.erp.mcaffeine.com/postfg…`.
- **Google OAuth client:** add the new callback URL.

**Needed from the post-FG team:**
- the distribution domain, for dev and for prod;
- the path its API sits on behind that distribution (assumed `/api/*`, which becomes `/postfg/api/*` for users);
- the frontend built with base path `/postfg`, so its asset URLs and API calls carry the prefix.

**Gates:**
1. Add the block to `erp-app-test` (`dev.erp.mcaffeine.com`), pointing at the post-FG dev distribution. Run `nginx -t`, then reload. Check that a `/postfg` page, a post-FG API call and a deep-link refresh all work, and that pre-FG is unaffected.
2. Prod `erp-app-prod`, with its own go-ahead. Same steps, applied over SSM.
3. Copy the block into `deploy/bootstrap-instance.sh` and `user-data.sh`, so that a rebuilt box keeps it.

**Side finding:** the pre-FG `location /` sets no `proxy_read_timeout`, so nginx's default of 60 s already applies today. The 300 s routes only survive because they keep sending data. Invoice parse, which sits silent for 50–70 s, is at the edge.

The CloudFront design below remains the option if post-FG later needs to stand on its own, independent of the pre-FG box.

## Approach (CloudFront alternative)

Post-FG already has a CloudFront distribution in front of its S3 frontend and API, in the same account and in Terraform. **So we extend that setup rather than build a second, parallel one.**
- A prod distribution with alias `erp.mcaffeine.com` gets pre-FG as its **default** origin, next to post-FG's two origins.
- The dev distribution gets `dev.erp.mcaffeine.com` the same way.
- Post-FG's Terraform owns the distribution, which keeps one owner and no drift.
- Pre-FG only needs an origin hostname and a security-group rule.

## Sequencing and gates

### 0. Decide (Ajay + post-FG team)
1. **Who owns the distribution.** Recommended: post-FG's Terraform, which adds pre-FG as an origin. The alternative is a separate distribution we own that duplicates post-FG's origins.
2. **Does the office/VPN restriction stay?** Recommended: yes. See step 2.
3. **Shared or separate login** (see Login below).

### 1. Gate: long requests (blocking risk)
CloudFront waits **60 s by default** for an origin response, and at most **180 s** after a quota increase. Pre-FG has routes with `maxDuration = 300`:
- the invoice commit, parse and documents routes;
- the facility-map sync;
- gatepass;
- `uniware-status`, `uniware-grn` and `uniware-documents`;
- the Uniware explorer.

The CloudFront timeout counts *silence*. A route that streams NDJSON steps survives as long as each step arrives within the limit.

Before anything else:
- List which of these routes stay silent for more than 60 s. Invoice parse, for one, is a single 50–70 s Nanonets wait.
- Request the 180 s quota on the account.
- Confirm the hourly cron calls its jobs in-process or via localhost, not through the public domain.

**If any route can be silent for more than 180 s, stop.** Either that route streams a heartbeat, or this design changes.

### 2. Keep the office/VPN lock (blocking risk)
Behind CloudFront, the box only ever sees CloudFront's IPs. The current security-group allow-list therefore can't stay as the only lock:
- If we simply open 443 to CloudFront, **the ERP becomes reachable from the whole internet.**
- The lock moves to an **AWS WAF web ACL** on the distribution: an IP set holding `13.207.143.186/32` and `103.71.113.198/32`, with everything else blocked.
- If post-FG must stay public, scope that rule to the pre-FG paths only, i.e. anything not under `/postfg`.
- WAF costs roughly $5–6 a month for one ACL and one rule, plus $0.60 per million requests.
- The SES webhook (`/api/v1/webhooks/ses`) is called by SNS from AWS IPs, not the office. It needs its own allow rule, or SES bounces stop being recorded.

### 3. Prepare pre-FG as an origin, with no user impact
- Create the GoDaddy A records `origin-prefg.erp.mcaffeine.com` → `65.0.197.42` and `origin-prefg-dev.erp.mcaffeine.com` → `13.201.247.36`.
- Add each name to nginx's `server_name` and issue a certbot cert for it. CloudFront needs a DNS name per origin, not an IP.
- Add a security-group rule allowing 443 from the CloudFront origin-facing prefix list, alongside the office and VPN rules. Remove nothing yet.
- `deploy/bootstrap-instance.sh` and `user-data.sh` learn the origin name, so a rebuilt box comes back the same way.

### 4. Distribution changes (post-FG Terraform)
- **Cert:** issue an ACM cert in **us-east-1** for `erp.mcaffeine.com` and `dev.erp.mcaffeine.com`, validated with a GoDaddy CNAME.
- **Origins:** add pre-FG with HTTPS-only to the origin and the response timeout from step 1.
- **Behaviours, in this order:**
  1. `/postfg/api/*` → post-FG API
  2. `/postfg/*` → S3, with a CloudFront Function that rewrites deep links to `/postfg/index.html`
  3. default → pre-FG

  The API behaviour must come first, or API calls land on S3.
- **Pre-FG behaviour settings:** `CachingDisabled` plus `AllViewerExceptHostHeader`, all HTTP methods.
- **Post-FG frontend build:** it must be built under the base path `/postfg`.
- **WAF:** attach the web ACL from step 2.

### 5. Prove on dev first (gate)
- Point `dev.erp.mcaffeine.com` at the dev distribution. Rollback is the A record back to `13.201.247.36`.
- Run through these on dev:
  - Google sign-in;
  - an invoice parse and commit;
  - one facility sync;
  - a PO PDF and mail;
  - a CSV upload;
  - a post-FG page and a post-FG API call;
  - the SES webhook;
  - **access from outside the office and VPN is refused.**
- **Gate to continue:** every check passes, and no 504 appears in the CloudFront logs.

### 6. Cut over prod (needs its own go-ahead)
- A day ahead, drop the TTL on the `erp` record to 300 s.
- Swap the `erp` record from the A record to a CNAME pointing at the prod distribution.
- **Rollback:** switch the A record back to `65.0.197.42`. The office/VPN security-group rules are still in place, so direct access keeps working throughout.

### 7. After a stable week
- Remove the direct office/VPN 443 rules, so that only CloudFront reaches the box.
- Keep SSH and SSM as they are.

## Login

Both systems sit on one hostname, so the browser already sends pre-FG's NextAuth cookie to `/postfg/api/*`.

- **Shared login:** the post-FG backend decodes that cookie with the same `AUTH_SECRET`. Sessions are Auth.js JWTs (`auth.config.ts`, `strategy: "jwt"`). Post-FG then needs no sign-in of its own.
- **Separate login:** post-FG's cookie names must differ from `authjs.*`, or the two apps overwrite each other's session.

## Risk

| Risk | Mitigation |
|---|---|
| ERP becomes public once CloudFront fronts it | Step 2: the WAF IP allow-list goes on before any DNS move, and dev checks that outsiders are refused |
| Long routes 504 behind CloudFront | Step 1 gate; raise the quota to 180 s; stream a heartbeat on any route that stays silent |
| SES bounce webhook blocked by the IP lock | Its own WAF allow rule, checked on dev |
| Two owners, one distribution | Post-FG's Terraform owns it; pre-FG contributes an origin name only |
| Origin cert or Host mismatch | `AllViewerExceptHostHeader` plus the origin hostname's own cert. `AUTH_URL` is fixed, and no route builds URLs from the Host header (checked: `req.url` is only used for query strings) |
| Cutover breaks sign-in or mail | Proven on dev first; rollback is one DNS record |

**Not touched:** the pre-FG app code, the deploy workflow, the database and Uniware.
