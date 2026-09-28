#!/bin/sh
# (Re)starts the log collector (server.mjs) on the droplet, as root:
# `sh run.sh`. Logs go to /var/lib/usertest-logs/<UTC date>.jsonl; follow a
# session with `tail -f /var/lib/usertest-logs/$(date -u +%F).jsonl`.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
docker rm -f usertest-collector >/dev/null 2>&1 || true
docker run -d --name usertest-collector --restart unless-stopped --init \
  -p 127.0.0.1:8081:8081 \
  -v "$HERE/server.mjs:/app/server.mjs:ro" \
  -v /var/lib/usertest-logs:/logs \
  node:22-alpine node /app/server.mjs
