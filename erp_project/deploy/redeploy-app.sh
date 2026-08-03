#!/bin/bash
# Repeatable app-only redeploy, run by CI on every push (after bootstrap-instance.sh
# has provisioned the box once). Does NOT touch nginx/Certbot/CloudWatch Agent setup.
# Usage on the box: sudo bash redeploy-app.sh <test|prod>
set -euo pipefail

ENV_NAME="${1:?Usage: redeploy-app.sh <test|prod>}"
AWS_REGION="ap-south-1"
ECR_REPO_URI="157320387454.dkr.ecr.ap-south-1.amazonaws.com/erp-app"

case "$ENV_NAME" in
  test) IMAGE_TAG="test"; SSM_PARAM_PATH="/erp-app/test" ;;
  prod) IMAGE_TAG="prod"; SSM_PARAM_PATH="/erp-app/prod" ;;
  *) echo "Unknown env '$ENV_NAME' (expected test or prod)" >&2; exit 1 ;;
esac

# Refresh /etc/erp/env from SSM before restarting.
#
# Without this a newly-added parameter never reaches the box: bootstrap writes
# this file once at provisioning time, and every later deploy just re-mounts it.
# A new secret would then be silently empty in the container until someone
# re-ran the full bootstrap (this is how NANONET_API_KEY went missing on test).
#
# join('=',[Name,Value]) rather than the tab-separated two-column output, so
# there's no tab handling to get wrong; sed then strips the /erp-app/<env>/
# prefix, leaving KEY=value.
echo "== Refreshing /etc/erp/env from SSM ($SSM_PARAM_PATH) =="
mkdir -p /etc/erp
aws ssm get-parameters-by-path \
  --path "$SSM_PARAM_PATH" --with-decryption --region "$AWS_REGION" \
  --query "Parameters[].join('=',[Name,Value])" --output text \
  | sed "s|^${SSM_PARAM_PATH}/||" > /etc/erp/env.new
# Only replace the live file once the fetch has actually produced something —
# an empty result would otherwise wipe every secret on the box.
if [ -s /etc/erp/env.new ]; then
  chmod 600 /etc/erp/env.new
  mv /etc/erp/env.new /etc/erp/env
else
  rm -f /etc/erp/env.new
  echo "SSM returned no parameters for $SSM_PARAM_PATH — keeping existing /etc/erp/env" >&2
  exit 1
fi

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_REPO_URI%%/*}"

docker pull "${ECR_REPO_URI}:${IMAGE_TAG}"
docker rm -f erp 2>/dev/null || true
docker run -d \
  --name erp \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /etc/erp/env \
  -v /var/log/erp:/app/logs \
  "${ECR_REPO_URI}:${IMAGE_TAG}"

docker image prune -f
