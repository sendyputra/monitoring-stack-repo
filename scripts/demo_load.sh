#!/bin/sh
set -eu

while true; do
  curl -sf http://demo-app:8000/ >/dev/null || true
  curl -sf http://demo-app:8000/cache >/dev/null || true
  curl -s -o /dev/null -w "" -X POST \
    -H 'content-type: application/json' \
    -d '{"task":"report","actor":"loadgen"}' \
    http://demo-app:8000/jobs || true
  curl -s http://demo-app:8000/external >/dev/null || true
  curl -s http://demo-app:8000/error >/dev/null 2>&1 || true
  sleep 1
done
