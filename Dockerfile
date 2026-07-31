# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go semaphore.go index.html ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .
# Copy index.html to /out so it's available in runtime
COPY index.html /out/

FROM alpine:latest
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=web-builder /out/index.html ./index.html
COPY bin/grants-pp-cli-linux ./grants-pp-cli
RUN chmod +x ./server ./grants-pp-cli
ENV CLI_BIN=/app/grants-pp-cli
EXPOSE 8093
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- http://localhost:8093/healthz || exit 1
CMD ["./server"]
