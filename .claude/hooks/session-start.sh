#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web (cloud sessions).
#
# Sets up what the integrations/ lanes and CI's tooling job need, so a fresh
# cloud session can run the tooling tests, lint and the node and e2e lanes
# straight away: Node 22, the pinned atomic-server checkout linked in as
# ./browser (with its pnpm install), a source build of the pinned
# atomic-server (e2e profile, as CI's build-server job), and Playwright's
# Chromium. The container is snapshotted after this hook, so later sessions
# start warm and each step below is close to a no-op on a re-run.
#
# Every step is best-effort: a failing step logs a warning and the rest still
# runs. Keep this in step with .atomic-server-ref's requirements and with
# ci.yml's build-server job; see AGENTS.md, "Claude Code cloud sessions".
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
# One checkout per container, outside the repo and outside /tmp, so it is in
# the snapshot. link-atomic-server.mjs moves it to a new pin in place, which
# keeps target/ and so makes the rebuild after a pin bump incremental.
CHECKOUT="${ATOMIC_SERVER_CHECKOUT:-$HOME/.cache/atomic-plugins/atomic-server}"
export ATOMIC_SERVER_CHECKOUT="$CHECKOUT"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"

WARNINGS=0
step() { echo "==> $*"; }
warn() {
  echo "WARN: $*" >&2
  WARNINGS=$((WARNINGS + 1))
}

# --- Session environment ----------------------------------------------------
env_line() { [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "$1" >>"$CLAUDE_ENV_FILE"; }

# Node 22: CI's NODE_VERSION, and Node 26 breaks one TAP-format tooling test.
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  if [ -x /opt/node22/bin/node ]; then
    step "Using /opt/node22 (node on PATH is $(node --version 2>/dev/null || echo missing))"
    export PATH="/opt/node22/bin:$PATH"
    env_line 'export PATH="/opt/node22/bin:$PATH"'
  else
    warn "node on PATH is not 22 and /opt/node22 is missing"
  fi
fi
env_line "export PATH=\"$BIN:\$PATH\""
env_line "export ATOMIC_SERVER_CHECKOUT=\"$CHECKOUT\""

# atomic-server binds to `::` by default, and cloud containers have no IPv6
# ("Address family not supported by protocol"). serve.mjs passes its
# environment on, so ATOMIC_IP makes the lane servers bind IPv4 instead.
if [ ! -e /proc/net/if_inet6 ]; then
  step "No IPv6: exporting ATOMIC_IP=0.0.0.0 for this session"
  export ATOMIC_IP="${ATOMIC_IP:-0.0.0.0}"
  env_line 'export ATOMIC_IP="${ATOMIC_IP:-0.0.0.0}"'
fi

# --- atomic-server checkout, ./browser, pnpm install ------------------------
# The data-browser build that server/build.rs runs regenerates these
# committed files with a small diff. The binary embeds the built output, not
# these sources, so restore them: link-atomic-server.mjs refuses to move a
# checkout with uncommitted changes to a new pin.
restore_generated() {
  [ -d "$CHECKOUT/.git" ] &&
    git -C "$CHECKOUT" checkout -- browser/data-browser/src/chunks/Website/runtime 2>/dev/null
  return 0
}

step "link-atomic-server.mjs (checkout at $CHECKOUT)"
cd "$REPO" || exit 0
mkdir -p "$(dirname "$CHECKOUT")"
restore_generated
node integrations/tooling/link-atomic-server.mjs || warn "link-atomic-server.mjs failed"
SHA=$(cat "$REPO/.atomic-server-ref")

# CI's worker checks typecheck the e2e specs against @tomic/lib's dist/.
step "Build @tomic/lib"
(cd "$CHECKOUT/browser" && pnpm --filter @tomic/lib build >/dev/null) ||
  warn "@tomic/lib build failed"

# Plugins' own npm dependencies: the same loop as ci.yml's "Install plugin
# npm dependencies" step. certify.mjs and the e2e typecheck need them.
step "Plugin npm dependencies"
for lock in "$REPO"/integrations/*/pnpm-lock.yaml "$REPO"/integrations/*/app/pnpm-lock.yaml "$REPO"/integrations/*/e2e/pnpm-lock.yaml; do
  [ -e "$lock" ] || continue
  (cd "$(dirname "$lock")" && pnpm install --frozen-lockfile >/dev/null) ||
    warn "pnpm install failed in ${lock%/pnpm-lock.yaml}"
done

# --- Playwright Chromium ----------------------------------------------------
# The image's preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)
# usually lags the pinned @playwright/test, and the session proxy blocks
# Playwright's CDN (cdn.playwright.dev). Chrome for Testing builds are the
# same zips, mirrored on storage.googleapis.com, so unpack those into the
# directories Playwright expects.
step "Playwright Chromium for browser/e2e"
PW="$CHECKOUT/browser/e2e/node_modules/.bin/playwright"
if [ -x "$PW" ]; then
  if ! PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= "$PW" install chromium chromium-headless-shell >/dev/null 2>&1; then
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= "$PW" install --dry-run chromium chromium-headless-shell 2>/dev/null |
      awk '/Install location:/{loc=$3} /Download url:/{if (loc) print loc, $3; loc=""}' |
      while read -r loc url; do
        case "$url" in */builds/cft/*) ;; *) continue ;; esac
        [ -f "$loc/INSTALLATION_COMPLETE" ] && continue
        mirror="https://storage.googleapis.com/chrome-for-testing-public/${url#*/builds/cft/}"
        echo "Downloading $mirror"
        tmp=$(mktemp -d)
        if curl -fsSL --retry 3 "$mirror" -o "$tmp/browser.zip" && unzip -q "$tmp/browser.zip" -d "$tmp/x"; then
          rm -rf "$loc" && mkdir -p "$loc" && mv "$tmp"/x/* "$loc"/ &&
            touch "$loc/INSTALLATION_COMPLETE" "$loc/DEPENDENCIES_VALIDATED"
        else
          echo "WARN: Playwright browser download failed: $mirror" >&2
        fi
        rm -rf "$tmp"
      done
  fi
else
  warn "$PW missing (pnpm install failed?)"
fi

# --- atomic-server e2e binary -----------------------------------------------
# ghcr's blob host (pkg-containers.githubusercontent.com) is blocked here, so
# ATOMIC_SERVER_IMAGE can't be pulled: build from source, with the same
# commands as ci.yml's build-server job (workflow.test.mjs keeps that job and
# the Dockerfile in step; keep this in step with them by hand).
# A stamp per pinned SHA skips the whole step on a warm re-run.
STAMP="$CHECKOUT/target/e2e/.built-for-atomic-plugins"
if [ -x "$CHECKOUT/target/e2e/atomic-server" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SHA" ]; then
  step "atomic-server e2e binary is already built for ${SHA:0:12}"
else
  cd "$CHECKOUT" || exit 0

  step "Rust toolchain from rust-toolchain.toml + wasm targets"
  RUST_VERSION=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
  rustup toolchain install "$RUST_VERSION" --profile minimal \
    --target wasm32-unknown-unknown --target wasm32-wasip2 ||
    warn "rustup install failed"

  step "wasm-pack"
  if ! command -v wasm-pack >/dev/null; then
    sh .dagger/scripts/install-wasm-pack.sh "$BIN" || warn "wasm-pack install failed"
  fi

  # `--no-opt`: wasm-opt's binaryen download fails behind the proxy, and CI
  # skips it too.
  step "Browser WASM bundle"
  (cd wasm && CARGO_ENCODED_RUSTFLAGS='--cfg'$'\x1f''getrandom_backend="wasm_js"' \
    wasm-pack build --target web --out-dir pkg --no-opt &&
    mkdir -p ../browser/data-browser/public/wasm &&
    cp pkg/atomic_wasm.js pkg/atomic_wasm_bg.wasm ../browser/data-browser/public/wasm/) ||
    warn "WASM bundle build failed"

  step "cargo build --profile e2e (cold: tens of minutes)"
  if SKIP_WASM_BUILD=1 VITE_E2E=true cargo build --profile e2e \
    -p atomic-server --no-default-features --features wasm-plugins; then
    echo "$SHA" >"$STAMP"
  else
    warn "atomic-server build failed"
  fi
  restore_generated
  if [ -n "$(git -C "$CHECKOUT" status --porcelain --untracked-files=no)" ]; then
    warn "$CHECKOUT has uncommitted changes; the next pin bump's link-atomic-server.mjs will refuse to move it"
  fi
fi

step "Done ($WARNINGS warning(s))"
df -h / | tail -1
exit 0
