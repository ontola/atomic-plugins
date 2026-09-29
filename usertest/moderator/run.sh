#!/bin/sh
# (Re)starts the voice moderator (server.mjs) on the droplet, as root:
# `sh run.sh`. It reads the API key from /etc/anthropic.env and the invite
# code from /etc/usertest-moderator.env (USERTEST_CODE=..., created on first
# run). Sessions are kept in /var/lib/usertest-sessions/<id>/.
# /etc/usertest-salt.env comes from ../collector/run.sh (run that first). With
# /etc/github-findings.env (GITHUB_FINDINGS_TOKEN=..., a fine-grained token
# with Issues read/write on ontola/usertest-findings only), each finished
# session's findings are filed there; without it they stay in findings.md.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
test -s /etc/anthropic.env || { echo "put ANTHROPIC_API_KEY=... in /etc/anthropic.env" >&2; exit 1; }
test -s /etc/usertest-salt.env || { echo "run ../collector/run.sh first (it creates /etc/usertest-salt.env)" >&2; exit 1; }
FINDINGS_ENV=
[ -s /etc/github-findings.env ] && FINDINGS_ENV="--env-file /etc/github-findings.env"
if [ ! -f /etc/usertest-moderator.env ]; then
  (umask 077 && printf 'USERTEST_CODE=%s\n' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/usertest-moderator.env)
fi
mkdir -p /var/lib/usertest-sessions /var/lib/usertest-logs
docker run --rm -v "$HERE:/app" -w /app node:22-alpine npm ci --omit=dev --no-audit --no-fund --silent
docker rm -f usertest-moderator >/dev/null 2>&1 || true
docker run -d --name usertest-moderator --restart unless-stopped --init \
  -p 127.0.0.1:8082:8082 \
  --env-file /etc/anthropic.env --env-file /etc/usertest-moderator.env \
  --env-file /etc/usertest-salt.env $FINDINGS_ENV \
  -v "$HERE:/app:ro" -w /app \
  -v /var/lib/usertest-sessions:/sessions \
  -v /var/lib/usertest-logs:/logs:ro \
  node:22-alpine node server.mjs
