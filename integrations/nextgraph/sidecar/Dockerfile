# The operator-run NextGraph sidecar for the Atomic Server `nextgraph` plugin,
# built reproducibly: pinned toolchain image, pinned nextgraph-rs commit
# (Cargo.toml) and a committed Cargo.lock, built with --locked.
#
#   docker build -t ng-atomic-sidecar integrations/nextgraph/sidecar
#
# nextgraph-rs's bundled RocksDB build script compiles with -march=haswell on
# every Linux target, which an arm64 compiler rejects. The c++/cc wrappers
# below drop that one flag on non-x86_64 hosts, so the image builds natively
# on linux/amd64 and linux/arm64. (On macOS the same script overrides
# LIBCLANG_PATH with /usr/local/opt/llvm@17/lib, which is why this is built in
# Docker rather than with a local cargo.)
FROM rust:1.90-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev cmake \
 && rm -rf /var/lib/apt/lists/*
RUN for tool in c++ cc; do \
      printf '#!/bin/sh\nif [ "$(uname -m)" != x86_64 ]; then\n  for a; do shift; [ "$a" = -march=haswell ] || set -- "$@" "$a"; done\nfi\nexec /usr/bin/%s "$@"\n' "$tool" > /usr/local/bin/ng-$tool \
      && chmod +x /usr/local/bin/ng-$tool; \
    done
ENV CXX=/usr/local/bin/ng-c++ CC=/usr/local/bin/ng-cc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo test --release --locked \
 && cargo build --release --locked \
 && cp target/release/ng-atomic-sidecar /usr/local/bin/

FROM debian:bookworm-slim
COPY --from=build /usr/local/bin/ng-atomic-sidecar /usr/local/bin/ng-atomic-sidecar
RUN useradd --system --create-home sidecar
USER sidecar
ENTRYPOINT ["ng-atomic-sidecar"]
