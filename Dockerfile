# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go semaphore.go index.html ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .
# Copy index.html to /out so it's available in runtime
COPY index.html /out/
# Pinned to a specific minor so two builds on different days share the same
# base image. Still receives Alpine security patches within 3.24; moving to a
# newer minor must be a deliberate change, not a silent one.
FROM alpine:3.24
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=web-builder /out/index.html ./index.html
COPY bin/grants-pp-cli-linux ./grants-pp-cli
RUN chmod +x ./server ./grants-pp-cli
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