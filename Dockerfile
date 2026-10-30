# syntax=docker/dockerfile:1
# ---- Stage 1: build the grants CLI from upstream source ----
# The CLI used to be cross-compiled on a workstation by vendor-cli.sh and
# committed as bin/grants-pp-cli-linux. Nothing in the image said which
# upstream source that binary came from.
#
# Now the image builds it from one pinned upstream commit, stamped on the
# image as the label org.pubvera.cli.commit. Same pattern as pubvera-recallis
# and pubvera-retractis.
#
# PP_LIBRARY_COMMIT is declared before the first FROM so it is global. An ARG
# declared after a FROM exists only in that stage; each stage that needs the
# value re-declares it with a bare ARG and inherits this default. Declaring
# the default inside the builder stage only left the label empty on
# pubvera-recallis (measured 2026-09-24), and CI now fails on that.
ARG PP_LIBRARY_COMMIT=58edea349ce3df8a301d4d8950119487c32604b8

FROM golang:1.26-alpine AS cli-builder
ARG PP_LIBRARY_COMMIT
RUN CGO_ENABLED=0 go install -trimpath \
    github.com/mvanhorn/printing-press-library/library/health/grants/cmd/grants-pp-cli@${PP_LIBRARY_COMMIT}

# ---- Stage 2: build the Go web server ----
FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go semaphore.go version.go index.html app.js app-module.js style.css ./
# The CalVer version from the release workflow; "dev" for any other build.
# -X names the variable main.appVersion: for package main the linker uses
# "main", not the module path.
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.appVersion=${APP_VERSION}" -o /out/server .
# Copy index.html, its scripts and style.css to /out so they're available in runtime
COPY index.html app.js app-module.js style.css /out/

# ---- Stage 3: minimal runtime ----
# Pinned to a specific minor so two builds on different days share the same
# base image. Still receives Alpine security patches within 3.24; moving to a
# newer minor must be a deliberate change, not a silent one.
FROM alpine:3.24
# The unprivileged user the server runs as (see USER below). UID 10001 is the
# same as pubvera-bibliovera, so host-side checks use one number everywhere.
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=web-builder /out/index.html ./index.html
COPY --from=web-builder /out/app.js ./app.js
COPY --from=web-builder /out/app-module.js ./app-module.js
COPY --from=web-builder /out/style.css ./style.css
COPY --from=cli-builder /go/bin/grants-pp-cli ./grants-pp-cli
RUN chmod +x ./server ./grants-pp-cli

# The upstream commit the CLI was built from, readable with docker inspect.
ARG PP_LIBRARY_COMMIT
LABEL org.pubvera.cli.commit=${PP_LIBRARY_COMMIT}

# The CalVer version the server reports on /version.
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=${APP_VERSION}

ENV CLI_BIN=/app/grants-pp-cli
# Matches defaultPort in main.go. Declared here so the image itself carries the
# value and the healthcheck below can follow it.
ENV PORT=8095
EXPOSE 8095
# $PORT is resolved by the container shell at runtime, not at build time, so an
# overridden PORT keeps the healthcheck pointing at the right port instead of
# reporting unhealthy against a working app.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- "http://localhost:${PORT:-8095}/healthz" || exit 1
# The server ran as root (UID 0, measured with docker top on 2026-10-10). The
# container has no mounts and writes nothing (docker diff = 0 lines), so the
# root-owned, world-readable files under /app are enough for this user. CI
# checks the UID of PID 1 in the running image.
USER app
CMD ["./server"]
