#!/bin/sh
# (Re)starts the log collector (server.mjs) on the user-testing server, as
# root: `sh run.sh`. Logs go to /var/lib/usertest-logs/<UTC date>.jsonl; follow a
# session with `tail -f /var/lib/usertest-logs/$(date -u +%F).jsonl`.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# Shared with the moderator, which hashes its tester's address the same way.
if [ ! -f /etc/usertest-salt.env ]; then
  (umask 077 && printf 'USERTEST_SALT=%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/usertest-salt.env)
fi
docker rm -f usertest-collector >/dev/null 2>&1 || true
docker run -d --name usertest-collector --restart unless-stopped --init \
  -p 127.0.0.1:8081:8081 \
  --env-file /etc/usertest-salt.env \
  -v "$HERE/server.mjs:/app/server.mjs:ro" \
  -v /var/lib/usertest-logs:/logs \
  node:22-alpine node /app/server.mjs
