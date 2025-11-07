#!/bin/sh
set -eu

BASE_URL="${DEMO_LOAD_BASE_URL:-http://nginx}"

while true; do
  curl -sf "${BASE_URL}/" >/dev/null || true
  curl -sf "${BASE_URL}/cache" >/dev/null || true
  curl -s -o /dev/null -w "" -X POST \
    -H 'content-type: application/json' \
    -d '{"task":"report","actor":"loadgen"}' \
    "${BASE_URL}/jobs" || true
  curl -s "${BASE_URL}/external" >/dev/null || true
  curl -s "${BASE_URL}/error" >/dev/null 2>&1 || true
  sleep 1
done
