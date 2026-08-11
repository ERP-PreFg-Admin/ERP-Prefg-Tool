#!/bin/bash
# EC2 Launch Template user-data. Runs once at instance boot (Amazon Linux 2023).
# Replace the placeholders below (AWS_REGION, ECR_REPO_URI, SSM_PARAM_PATH) before
# pasting this into the Launch Template's "User data" field.
set -euo pipefail
exec > >(tee /var/log/erp-bootstrap.log) 2>&1

AWS_REGION="ap-south-1"
ECR_REPO_URI="230235764844.dkr.ecr.ap-south-1.amazonaws.com/erp-app"
SSM_PARAM_PATH="/erp/prod"
IMAGE_TAG="latest"
DOMAIN="erp.mcaffeine.com"
CERTBOT_EMAIL="ajay.singh@mcaffeine.com"

echo "== Installing Docker =="
dnf update -y
dnf install -y docker
systemctl enable --now docker

echo "== Installing CloudWatch Agent =="
dnf install -y amazon-cloudwatch-agent
mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<'CWCONFIG'
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/erp/app-*.log",   "log_group_name": "/erp/app",       "log_stream_name": "{instance_id}/app",   "timezone": "UTC" },
          { "file_path": "/var/log/erp/error-*.log", "log_group_name": "/erp/app",       "log_stream_name": "{instance_id}/error", "timezone": "UTC" },
          { "file_path": "/var/log/erp-bootstrap.log","log_group_name": "/erp/bootstrap", "log_stream_name": "{instance_id}",      "timezone": "UTC" }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "ERP/EC2",
    "append_dimensions": { "InstanceId": "${aws:InstanceId}", "AutoScalingGroupName": "${aws:AutoScalingGroupName}" },
    "metrics_collected": {
      "cpu":  { "measurement": ["cpu_usage_active"], "totalcpu": true },
      "mem":  { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"] }
    }
  }
}
CWCONFIG
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json

echo "== Fetching app secrets from SSM Parameter Store =="
mkdir -p /etc/erp
aws ssm get-parameters-by-path \
  --path "$SSM_PARAM_PATH" --with-decryption --region "$AWS_REGION" \
  --query 'Parameters[].[Name,Value]' --output text \
| while IFS=$'\t' read -r name value; do
    key=$(basename "$name")
    printf '%s=%s\n' "$key" "$value" >> /etc/erp/env
  done
chmod 600 /etc/erp/env

echo "== Logging in to ECR =="
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_REPO_URI%%/*}"

echo "== Pulling and starting the app container =="
mkdir -p /var/log/erp
chown 999:999 /var/log/erp  # matches the container's non-root "nextjs" user (uid/gid 999)
docker pull "${ECR_REPO_URI}:${IMAGE_TAG}"
docker rm -f erp 2>/dev/null || true
docker run -d \
  --name erp \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /etc/erp/env \
  -v /var/log/erp:/app/logs \
  "${ECR_REPO_URI}:${IMAGE_TAG}"

echo "== Installing nginx + Certbot (reverse proxy + HTTPS) =="
dnf install -y nginx python3-pip
systemctl enable nginx
pip3 install certbot certbot-nginx
ln -sf /usr/local/bin/certbot /usr/bin/certbot

cat > /etc/nginx/conf.d/erp.conf <<NGINXCONF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXCONF

# Upload limits live in their OWN file, not in erp.conf above, because
# `certbot --nginx` rewrites erp.conf when it installs and renews the
# certificate. Keeping these here means one source of truth that certbot never
# touches, and rolling back is deleting one file. Bare directives (no server
# block) are valid because nginx.conf includes conf.d/*.conf inside `http`.
cat > /etc/nginx/conf.d/00-erp-limits.conf <<'LIMITSCONF'
# Supplier invoices are uploaded through this proxy. nginx defaults to 1m, which
# silently 413s the SCANNED invoices (Anuspa, Yasharth) — those are page images
# several MB each, while every text-layer invoice is well under 1m and sailed
# through. It read as a parser bug because the only suppliers it hit were the
# ones that need OCR anyway.
client_max_body_size 10m;

# Match the parse route's own budget (maxDuration = 300 in
# app/api/v2/purchase-orders/invoice/parse/route.ts). Nanonets OCR runs 50-70s
# on a scanned PDF and nginx defaults to 60s — without this, raising the size
# limit alone would just turn the 413 into a 504 on exactly the same files.
proxy_read_timeout 300s;
proxy_send_timeout 300s;
LIMITSCONF

rm -f /etc/nginx/conf.d/default.conf
nginx -t
systemctl restart nginx

# Requires the domain's DNS to already point at this instance's IP (Elastic
# IP re-association happens before this script runs, so it should).
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect

cat > /etc/systemd/system/certbot-renew.service <<'EOF'
[Unit]
Description=Certbot renewal

[Service]
Type=oneshot
ExecStart=/usr/local/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF

cat > /etc/systemd/system/certbot-renew.timer <<'EOF'
[Unit]
Description=Run certbot renew twice daily

[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now certbot-renew.timer

echo "== Done =="
