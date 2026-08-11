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
#
# The [ ... ] wrapping join() is LOAD-BEARING and must not be "simplified" away.
# get-parameters-by-path paginates at 10, and with --output text a FLAT list
# (Parameters[].join(...)) prints one line PER PAGE with the entries joined by
# tabs — so 24 parameters came out as 3 lines, and sed (anchored with ^) only
# stripped the prefix off the first entry of each. Wrapping each element in its
# own list makes it a ROW, so text output is newline-separated regardless of how
# many pages come back. Verified on erp-app-prod: flat = 3 lines, wrapped = 24.
echo "== Refreshing /etc/erp/env from SSM ($SSM_PARAM_PATH) =="
mkdir -p /etc/erp
aws ssm get-parameters-by-path \
  --path "$SSM_PARAM_PATH" --with-decryption --region "$AWS_REGION" \
  --query "Parameters[].[join('=',[Name,Value])]" --output text \
  | sed "s|^${SSM_PARAM_PATH}/||" > /etc/erp/env.new

# Guard on the COUNT, not on -s. A non-empty check is worthless against the
# pagination bug above: the broken output was 3 non-empty lines that even looked
# like KEY=value, so `[ -s ]` passed and would have cut the container's
# environment from 23 secrets to 3 — losing the DB password, AUTH_SECRET and the
# S3 credentials on a routine deploy. Compare against what is actually in SSM.
EXPECTED=$(aws ssm get-parameters-by-path \
  --path "$SSM_PARAM_PATH" --region "$AWS_REGION" \
  --query "length(Parameters[])" --output text | awk '{ n += $1 } END { print n }')
GOT=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' /etc/erp/env.new || true)

if [ "${EXPECTED:-0}" -gt 0 ] && [ "$GOT" -eq "$EXPECTED" ]; then
  chmod 600 /etc/erp/env.new
  # Keep the outgoing file: if a deploy ever does land a bad env, the previous
  # one is right there rather than only in SSM.
  [ -f /etc/erp/env ] && cp -a /etc/erp/env "/etc/erp/env.bak-$(date +%Y%m%d-%H%M%S)"
  mv /etc/erp/env.new /etc/erp/env
  echo "   $GOT parameters written to /etc/erp/env"
else
  rm -f /etc/erp/env.new
  echo "Refusing to write /etc/erp/env: parsed $GOT of $EXPECTED parameters from $SSM_PARAM_PATH." >&2
  echo "Existing /etc/erp/env left untouched." >&2
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
