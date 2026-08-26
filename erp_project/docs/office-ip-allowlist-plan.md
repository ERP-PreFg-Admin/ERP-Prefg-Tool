# Office-IP allowlist for the ERP web app

## Context

`erp.mcaffeine.com` / `dev.erp.mcaffeine.com` were reachable from the whole
internet, with Google OAuth + `page_permissions` as the only gate. The goal is
office-only access as defense-in-depth.

**The infra team has already applied part of this by hand in the AWS console.**
This document records what is live, the one dated failure it introduces, and the
smallest set of changes to finish it. No application code changes are involved.

The live deployment is **not** the ALB described in `deploy/setup-commands.md` —
it is EC2 + nginx + Certbot on each instance's own Elastic IP
(`deploy/bootstrap-instance.sh:100-130`).

## Current state (verified 2026-08-26, `AWS_PROFILE=erp`, ap-south-1)

| | dev | prod |
|---|---|---|
| Instance | `i-0d269978588f3c2da` `erp-app-test` | `i-0a249d3d470e693d3` `erp-app-prod` |
| Elastic IP | `13.201.247.36` | `65.0.197.42` |
| Security group | `sg-0ed005f62f2449112` `launch-wizard-9` | `sg-0b47822934473fe9f` `launch-wizard-10` |
| **443 ingress** | **office + VPN only** | `0.0.0.0/0` |
| **80 ingress** | **office + VPN only** | `0.0.0.0/0` |
| 22 ingress | `0.0.0.0/0` | `0.0.0.0/0` |
| Cert expiry | Oct 11 10:31 2026 GMT | Oct 11 10:40 2026 GMT |

The two allowlisted CIDRs on dev:

- `103.71.113.198/32` — the office public IP (confirmed against `checkip.amazonaws.com`
  from an office machine)
- `13.207.143.186/32` — the Elastic IP of `i-0fad3b0ab65100369`, tagged **AWS-VPN**

`deploy/open-ports.sh` still opens 80/443 to `0.0.0.0/0` on both SGs and will
**undo the dev allowlist if anyone re-runs it.**

## Problem 1 — dev's TLS cert breaks on Oct 11 2026

Certbot renews over **HTTP-01 on port 80** (`bootstrap-instance.sh:130` uses
`--nginx`), and Let's Encrypt validates from its own servers — not the office,
not the VPN. Port 80 is now closed to them, so the renewal attempts that begin
around **Sep 11** fail silently on `certbot-renew.timer`
(`bootstrap-instance.sh:141`), and dev serves an expired cert from Oct 11.

Both certs expire the same day, so applying the identical rule to prod without
this fix takes both environments down together.

## Problem 2 — port 22 open to the world on both boxes

Pre-existing, untouched by this work, and now the widest exposure on the dev
instance. Access to these boxes is via **SSM Session Manager** (outbound; see
`redeploy-app.sh`), so inbound 22 is not needed at all.

## Problem 3 — the SES webhook path is blocked on 443

`/api/v1/webhooks/ses` is posted to by **SNS from AWS IPs**, so a 443 allowlist
blocks it. Its own header comment (`app/api/v1/webhooks/ses/route.ts:8-19`)
notes the failure is silent: SNS retries, disables the subscription, and
`email_suppressions` stays empty while every send still looks fine.

**Not currently breaking anything** — `aws sns list-subscriptions-by-topic
--topic-arn arn:aws:sns:ap-south-1:157320387454:erp-app-ses-events` returns an
empty list, so bounce/complaint suppression is not wired up at all today. That
is a separate gap. But the SG rule means the `SubscriptionConfirmation` POST
will fail whenever someone does wire it, and it will look like an SNS problem.

## Recommended change

Keep the team's security-group approach — it is already 90% done and far simpler
than moving the allowlist into nginx. Only the port-80 rule is wrong.

### 1. Reopen port 80 on dev (fixes the cert)

nginx serves nothing on 80 but a 301 to HTTPS and the ACME challenge path
(Certbot `--redirect`), so this leaks nothing:

```bash
export AWS_PROFILE=erp MSYS_NO_PATHCONV=1
aws ec2 authorize-security-group-ingress --region ap-south-1 \
  --group-id sg-0ed005f62f2449112 --protocol tcp --port 80 --cidr 0.0.0.0/0

# then drop the two narrow 80 rules that are now redundant
aws ec2 revoke-security-group-ingress --region ap-south-1 \
  --group-id sg-0ed005f62f2449112 --protocol tcp --port 80 --cidr 103.71.113.198/32
aws ec2 revoke-security-group-ingress --region ap-south-1 \
  --group-id sg-0ed005f62f2449112 --protocol tcp --port 80 --cidr 13.207.143.186/32
```

An outsider hitting `http://` now gets a 301 to an HTTPS port they cannot reach.

### 2. Mirror 443 to prod

```bash
for cidr in 103.71.113.198/32 13.207.143.186/32; do
  aws ec2 authorize-security-group-ingress --region ap-south-1 \
    --group-id sg-0b47822934473fe9f --protocol tcp --port 443 --cidr "$cidr"
done
aws ec2 revoke-security-group-ingress --region ap-south-1 \
  --group-id sg-0b47822934473fe9f --protocol tcp --port 443 --cidr 0.0.0.0/0
```

Leave prod's port 80 at `0.0.0.0/0` for the same ACME reason.

### 3. Close port 22 on both

```bash
for sg in sg-0ed005f62f2449112 sg-0b47822934473fe9f; do
  aws ec2 revoke-security-group-ingress --region ap-south-1 \
    --group-id "$sg" --protocol tcp --port 22 --cidr 0.0.0.0/0
done
```

Confirm SSM works on both boxes *before* revoking, so there is a known-good path
back in.

### 4. Stop `open-ports.sh` from undoing it

`deploy/open-ports.sh` opens 80/443 to `0.0.0.0/0` on both SGs. Either narrow
port 443 in it to the two allowlisted CIDRs, or delete the 443 case and leave a
comment saying 443 is allowlisted by hand. As written it is a loaded gun.

## Verification

1. **From the office:** `https://erp.mcaffeine.com` and `https://dev.erp.mcaffeine.com`
   load, Google login completes, a few pages render.
2. **From the VPN**, same.
3. **From a non-office, non-VPN network** (phone on mobile data): the HTTPS
   connection times out; `http://` returns a 301.
4. **Cert renewal — the point of change 1.** On the dev box via SSM:
   `certbot renew --dry-run`. Must pass. Re-run on prod after change 2.
5. **SSM still reaches both boxes** after change 3.
6. Re-read both SGs to confirm the final shape:
   ```bash
   aws ec2 describe-security-groups --region ap-south-1 \
     --group-ids sg-0ed005f62f2449112 sg-0b47822934473fe9f \
     --query 'SecurityGroups[].{Id:GroupId,Ingress:IpPermissions}'
   ```

## If the SES webhook gets wired up later

A security group cannot make a path-level exception, so at that point the
allowlist has to move into nginx, where `/api/v1/webhooks/ses` can stay open
(its SNS signature check is the real access control) while `location /` is
office-only. Two notes for whoever does it:

- Put `allow` / `deny` **inside the `location` blocks, never at server level** —
  a server-level `deny all` is inherited by the ACME challenge location Certbot
  injects at renewal, reintroducing Problem 1.
- The change belongs in the `erp.conf` heredoc at `bootstrap-instance.sh:106-124`,
  not only on the running boxes, or the next re-bootstrap reverts it.

The cheaper alternative is to have SNS deliver to **SQS** and poll it, which
needs no inbound path at all.

## Notes

- Both instances have Elastic IPs, so DNS will not drift on a stop/start.
- **`/api/health` is now office-only.** Nothing polls it today (there is no ALB),
  but an external uptime monitor added later would time out.
- **If an ALB or CloudFront is ever put in front of these boxes**, the SG
  allowlist stops meaning anything — the proxy becomes the only client IP.
- No lockout risk: SSM is outbound, so a bad rule is always recoverable.
