#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="${TARGET_USER:-youruser}"
TARGET_HOST="${TARGET_HOST:-192.162.200.30}"
TARGET_PATH="${TARGET_PATH:-/home/${TARGET_USER}/monitoring-stack}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"

RSYNC="rsync -az --delete -e 'ssh -i ${SSH_KEY}'"

${RSYNC} . ${TARGET_USER}@${TARGET_HOST}:${TARGET_PATH}

ssh -i "${SSH_KEY}" ${TARGET_USER}@${TARGET_HOST} <<'EOF'
set -e
cd "${TARGET_PATH}"
which docker-compose >/dev/null 2>&1 && DC="docker-compose" || DC="docker compose"
$DC pull
$DC up -d
$DC ps
EOF

echo "Deployed to ${TARGET_HOST}:${TARGET_PATH}"
