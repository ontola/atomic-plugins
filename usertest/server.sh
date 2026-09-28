#!/bin/sh
# (Re)starts the test instance's atomic-server on the droplet. Run as root on
# the droplet: `sh server.sh <base-domain> [<atomic-server sha>]`.
#
# It runs the published e2e image of the pinned commit, which is built with
# VITE_E2E: that keeps /app/dev-drive (a drive without signup) and also
# exposes test-only routes such as /app/prunetests. The image has no built-in
# HTTPS, so Caddy terminates TLS in front of it (Caddyfile).
#
# Errors (and the sidebar Feedback form) are reported to the collector
# (collector/), in Sentry's format: project 1 is the server, 2 the
# data-browser.
#
# The store lives in the named volume atomic-plugins-store and survives
# restarts. `docker volume rm atomic-plugins-store` (with the container
# stopped) resets every tester's drive.
set -eu

BASE_DOMAIN=${1:?usage: server.sh <base-domain> [<sha>]}
SHA=${2:-2567fc30ba2da19124bbfb600e6a82c642b45819}
IMAGE=ghcr.io/ontola/atomic-server-e2e:$SHA

docker pull -q "$IMAGE" >/dev/null
docker rm -f atomic-plugins >/dev/null 2>&1 || true
# ATOMIC_HOST_MODE=open: anyone who reaches the URL can create a drive, which
# is what testers need. Stop the container between session days.
docker run -d --name atomic-plugins --restart unless-stopped --init \
  -p 127.0.0.1:8080:80 -v atomic-plugins-store:/data \
  -e ATOMIC_DOMAIN="plugins.$BASE_DOMAIN" -e ATOMIC_PORT=80 \
  -e ATOMIC_HOST_MODE=open \
  -e ATOMIC_INTEGRATION_PROXY_URL=https://localthought.io \
  -e SENTRY_DSN="https://usertest@logs.$BASE_DOMAIN/1" \
  -e SENTRY_DSN_BROWSER="https://usertest@logs.$BASE_DOMAIN/2" \
  -e SENTRY_ENVIRONMENT=usertest \
  "$IMAGE"
