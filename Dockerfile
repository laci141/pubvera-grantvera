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
COPY main.go semaphore.go index.html ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .
# Copy index.html to /out so it's available in runtime
COPY index.html /out/

# ---- Stage 3: minimal runtime ----
# Pinned to a specific minor so two builds on different days share the same
# base image. Still receives Alpine security patches within 3.24; moving to a
# newer minor must be a deliberate change, not a silent one.
FROM alpine:3.24
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=web-builder /out/index.html ./index.html
COPY --from=cli-builder /go/bin/grants-pp-cli ./grants-pp-cli
RUN chmod +x ./server ./grants-pp-cli

# The upstream commit the CLI was built from, readable with docker inspect.
LABEL org.pubvera.cli.commit=${PP_LIBRARY_COMMIT}

ENV CLI_BIN=/app/grants-pp-cli
# Matches defaultPort in main.go. Declared here so the image itself carries the
# value and the healthcheck below can follow it.
ENV PORT=8095
EXPOSE 8095
# $PORT is resolved by the container shell at runtime, not at build time, so an
# overridden PORT keeps the healthcheck pointing at the right port instead of
# reporting unhealthy against a working app.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- "http://localhost:${PORT:-8095}/healthz" || exit 1
CMD ["./server"]