#!/bin/sh
# (Re)starts the test instance's atomic-server on the droplet. Run as root on
# the droplet:
#
#   sh server.sh <base-domain> [<atomic-server sha>]
#   USERTEST_PLUGIN_ROUTES=read-write sh server.sh <base-domain> [<sha>]
#
# It runs the published e2e image of the pinned commit, which is built with
# VITE_E2E: that keeps /app/dev-drive (a drive without signup) and also
# exposes test-only routes such as /app/prunetests. The image has no built-in
# HTTPS, so Caddy terminates TLS in front of it (Caddyfile).
#
# Server plugins (plugin routes, e.g. integrations/remotestorage/) stay off
# unless USERTEST_PLUGIN_ROUTES is `read-only` or `read-write`. Then it runs
# the image's `-plugin-routes` variant (built with the `plugin-routes` cargo
# feature by .github/workflows/atomic-server-e2e-image.yml) with
# ATOMIC_PLUGIN_ROUTES at that level and ATOMIC_ROUTES_ORIGIN
# https://routes.<base-domain>: each Installation answers on
# https://<slug>.routes.<base-domain>, which Caddy serves (README.md,
# "Trying server plugins"). Without the variable the run is the same as
# before.
#
# Errors (and the sidebar Feedback form) are reported to the collector
# (collector/), in Sentry's format: project 1 is the server, 2 the
# data-browser.
#
# The store lives in the named volume atomic-plugins-store and survives
# restarts, also a switch between the two image variants of one SHA.
# `docker volume rm atomic-plugins-store` (with the container stopped) resets
# every tester's drive.
set -eu

BASE_DOMAIN=${1:?usage: [USERTEST_PLUGIN_ROUTES=read-only|read-write] server.sh <base-domain> [<sha>]}
# candidate15, main's .atomic-server-ref.
SHA=${2:-59ddfe788a2e4b1123daa191358662598aa59dc4}
ROUTES=${USERTEST_PLUGIN_ROUTES:-off}

IMAGE=ghcr.io/ontola/atomic-server-e2e:$SHA
set --
case "$ROUTES" in
  off) ;;
  read-only | read-write)
    IMAGE=$IMAGE-plugin-routes
    # From candidate16 on (ontola/atomic-server#1903), plugin routes only
    # honour X-Forwarded-Host/-Proto from a trusted proxy. Caddy reaches the
    # container from the Docker bridge gateway, so add then:
    #   -e ATOMIC_TRUSTED_PROXIES=172.17.0.1
    # candidate15 has no such setting and honours them from anyone.
    set -- -e ATOMIC_PLUGIN_ROUTES="$ROUTES" \
      -e ATOMIC_ROUTES_ORIGIN="https://routes.$BASE_DOMAIN"
    ;;
  *)
    echo "USERTEST_PLUGIN_ROUTES must be off, read-only or read-write, not '$ROUTES'" >&2
    exit 1
    ;;
esac

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
  "$@" \
  "$IMAGE" >/dev/null
echo "started $IMAGE (plugin routes: $ROUTES)"
