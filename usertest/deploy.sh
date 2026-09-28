#!/bin/sh
# Copies the built catalog (catalog.mjs), the Caddyfile and server.sh to the
# droplet, then reloads Caddy. Existing app module versions on the droplet are
# kept, so testers who installed an older version can still update from it.
#
#   sh usertest/deploy.sh root@<droplet-ip> [ssh options…]
#
# It does not restart atomic-server; run server.sh on the droplet for that.
set -eu

TARGET=${1:?usage: deploy.sh <user@host> [ssh options…]}
shift
HERE=$(cd "$(dirname "$0")" && pwd)

[ -f "$HERE/out/catalog.json" ] ||
  { echo "no usertest/out/catalog.json; run node usertest/catalog.mjs first" >&2; exit 1; }

# COPYFILE_DISABLE keeps macOS tar from adding ._ metadata files.
(cd "$HERE/out" && COPYFILE_DISABLE=1 tar czf - catalog.json apps) |
  ssh "$@" "$TARGET" 'mkdir -p /srv/catalog && tar xzf - -C /srv/catalog'
(cd "$HERE" && COPYFILE_DISABLE=1 tar czf - Caddyfile caddy-usertest.conf server.sh collector) |
  ssh "$@" "$TARGET" 'set -e
    test -f /etc/caddy/usertest.env ||
      { echo "create /etc/caddy/usertest.env first (README.md)" >&2; exit 1; }
    mkdir -p /opt/usertest /etc/systemd/system/caddy.service.d
    tar xzf - -C /opt/usertest
    cp /opt/usertest/caddy-usertest.conf /etc/systemd/system/caddy.service.d/usertest.conf
    cp /opt/usertest/Caddyfile /etc/caddy/Caddyfile
    set -a; . /etc/caddy/usertest.env; set +a
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    systemctl daemon-reload
    systemctl restart caddy'
echo "deployed to $TARGET"
