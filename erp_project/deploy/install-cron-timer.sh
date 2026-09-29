#!/bin/bash
# Installs erp-cron.{service,timer} on a box that is already running.
#
# bootstrap-instance.sh also installs these, but it reinstalls Docker and re-runs
# certbot on the way — too blunt for adding a timer to a live box. Same units,
# nothing else touched. Safe to re-run.
#
#   sudo bash install-cron-timer.sh <test|prod>
set -euo pipefail

ENV_NAME="${1:?Usage: install-cron-timer.sh <test|prod>}"
case "$ENV_NAME" in
  # UTC :29 = IST :59. Test is staggered to :25 so the two boxes don't hit the
  # Uniware tenant together; both stay inside IST hour 23.
  test) CRON_MINUTE=25 ;;
  prod) CRON_MINUTE=29 ;;
  *) echo "Unknown env '$ENV_NAME' (expected test or prod)" >&2; exit 1 ;;
esac

if ! grep -q '^CRON_KEY=' /etc/erp/env 2>/dev/null; then
  echo "CRON_KEY is not in /etc/erp/env." >&2
  echo "Push it to SSM and redeploy first, or every run will 401." >&2
  exit 1
fi

cat > /etc/systemd/system/erp-cron.service <<'EOF'
[Unit]
Description=ERP scheduled jobs (the app decides which are due)
After=docker.service

[Service]
Type=oneshot
EnvironmentFile=/etc/erp/env
ExecStart=/usr/bin/curl -sS --fail-with-body --max-time 1800 -X POST \
  -H "x-cron-key: ${CRON_KEY}" http://127.0.0.1:3000/api/v1/cron/run
EOF

# No RandomizedDelaySec: jitter past midnight moves the IST hour to 0 and the
# hour-23 job silently never runs. Not Persistent: a missed window is skipped.
cat > /etc/systemd/system/erp-cron.timer <<EOF
[Unit]
Description=Trigger ERP scheduled jobs hourly

[Timer]
OnCalendar=*-*-* *:${CRON_MINUTE}:00

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now erp-cron.timer
echo "== Timer installed =="
systemctl list-timers erp-cron.timer --no-pager

# Defence in depth only — the timer curls 127.0.0.1 and never passes through
# nginx, and the route checks the key itself. Reverted if nginx rejects it.
CONF=/etc/nginx/conf.d/erp.conf
if [ -f "$CONF" ] && ! grep -q 'location /api/v1/cron' "$CONF"; then
  BACKUP="$CONF.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CONF" "$BACKUP"
  # Before the FIRST `location / {`, matching its indentation. certbot may have
  # split this into two server blocks; the :80 one it redirects from is first.
  awk '!ins && /^[[:space:]]*location \/ \{/ {
         match($0, /^[[:space:]]*/); ind = substr($0, 1, RLENGTH)
         print ind "location /api/v1/cron { allow 127.0.0.1; deny all; }"
         print ""
         ins = 1
       } { print }' "$BACKUP" > "$CONF"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "== nginx: /api/v1/cron denied externally =="
  else
    cp "$BACKUP" "$CONF"
    echo "nginx rejected the edit — reverted. Add the deny by hand; not fatal." >&2
  fi
else
  echo "== nginx: already denied, or erp.conf not found — skipped =="
fi
