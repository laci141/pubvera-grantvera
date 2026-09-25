# Grantvera

Grant opportunity search for the Pubvera platform. A small Go HTTP server that
serves a single-page frontend and forwards searches to the `grants-pp-cli`
binary, which talks to Grants.gov, NIH RePORTER and NSF. The image builds that
CLI itself from one pinned printing-press-library commit; no binary is kept in
this repository.

Part of the eight-app Pubvera suite. Runs behind Caddy in production, which
protects `/api/*` with `forward_auth`.

## Requirements

- Go 1.26 (matches the Docker builder stages)
- Docker and Docker Compose for deployment
- For local runs only: a `grants-pp-cli` binary, built from the same commit the
  Dockerfile pins (see [The CLI](#the-cli))

## Configuration

All configuration is environment variables. None is mandatory: the app starts
and serves searches with all of them unset.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8095` | Listen port, bound on `0.0.0.0`. Matches the Dockerfile `EXPOSE`/`HEALTHCHECK` and the compose file. |
| `CLI_BIN` | `./grants-pp-cli` | Path to the child CLI binary. Set to `/app/grants-pp-cli` inside the image. |
| `CLI_MAX_CONCURRENT` | `4` | Child CLI processes allowed to run at once. `0` or negative disables the bound; an unparseable value falls back to the default. |
| `SUPABASE_URL` | empty | Browser-side Supabase URL, served via `/config.json`. |
| `SUPABASE_PUBLISHABLE_KEY` | empty | Supabase **publishable** key. Never the secret key — this one is designed to be visible in a browser, and Row Level Security protects the data. |

If either Supabase variable is missing, **both** are served as empty strings and
the page runs in unauthenticated mode. This is deliberate, not a failure state.

## Endpoints

| Path | Method | Request body |
| --- | --- | --- |
| `/api/search` | POST | `query`, `closing_before`, `agency`, `rows` |
| `/api/nih` | POST | `query`, `min_amount`, `year`, `rows` |
| `/api/nsf` | POST | `query`, `min_amount`, `rows` |
| `/healthz` | GET | — returns `ok` |
| `/config.json` | GET | — Supabase bootstrap |
| `/` | GET | — serves `index.html` |

`/config.json` sits outside `/api/` on purpose. Caddy guards `/api/*` with
`forward_auth`, and the page needs this config *before* it can sign anyone in;
serving it from a protected path would make the requirement circular.

### Request limits

- Request body: 64 KiB maximum.
- `rows`: defaults to 15, maximum 100. A value above the maximum is **rejected
  with 400**, not clamped — a caller asking for 500 rows should learn it cannot
  have them rather than silently receive 100.
- `rows` of zero or negative is treated as unset and becomes the default.
- `query` is trimmed, must not be empty, and must not start with `-`. The CLI
  reads the query as a positional argument, so a leading dash would be parsed
  as a flag.
- Unknown JSON fields are rejected, so a typo like `row` instead of `rows` is
  reported rather than silently defaulted.
- Trailing data after the JSON object is rejected.

### Status codes worth distinguishing

| Code | Meaning | What to do |
| --- | --- | --- |
| `400` | Malformed or out-of-range request | Fix the request. |
| `502` | The child CLI failed | Check `docker logs grantvera`; stderr is recorded there, never sent to the client. |
| `503` | No free CLI slot within 3 s | Retry; a `Retry-After: 30` header is sent. Raising `CLI_MAX_CONCURRENT` is a last resort — see below. |

A 503 and a 502 must not be confused: 502 says the CLI broke, 503 says the
server is full and the same request will work shortly.

### Timeouts

- A single CLI run is bounded at 120 s.
- The server write timeout is derived from that budget (CLI timeout + 30 s), so
  a slow but legitimate search is not cut off mid-response.
- Read header 10 s, read body 30 s, idle 120 s.

## Concurrency

The default of four CLI slots is measured, not chosen for roundness. The host
is a two-core CX23; a single CLI run peaks near 12% of one core, so saturation
arithmetic points to roughly sixteen concurrent runs. Sixteen is the saturation
point, not the safe one: seven other Pubvera apps share the same two cores, and
a saturated host makes Docker's healthcheck queue behind the very work it is
meant to check.

Before raising `CLI_MAX_CONCURRENT`, read the `wait_ms` field in the logs. It
separates "we are out of slots" from "the upstream API is slow" — the two look
identical from outside and need opposite fixes.

## Logging

Every CLI run logs one line:

```
cli: ok cmd=search wait_ms=0 elapsed_ms=1843 bytes=20114
```

- `cmd` is the subcommand only. User query text is never logged.
- `wait_ms` is time spent queueing for a slot.
- `elapsed_ms` is the CLI's own runtime.
- `bytes` is the response size. A run that still succeeds but suddenly returns
  far less than usual is the earliest sign of a quota being enforced or an
  upstream API degrading.

CLI stderr goes to the log — trimmed and capped — including on successful runs,
because the CLI reports its rate-limit and retry warnings there. It is never
sent to the client: it is operator information and its size is unbounded.

## Local development

```
go build ./... && go test ./...
go run .
```

Then open `http://localhost:8095`. The CLI binary must be reachable; set
`CLI_BIN` if it is not at `./grants-pp-cli`.

## The CLI

The Dockerfile builds `grants-pp-cli` with `go install` from one pinned
printing-press-library commit, set by the global `ARG PP_LIBRARY_COMMIT` line,
and stamps that commit on the image as the label `org.pubvera.cli.commit`.

To get the same CLI for a local run, use the commit from that line:

```
go install github.com/mvanhorn/printing-press-library/library/health/grants/cmd/grants-pp-cli@<commit>
```

To move to a newer CLI, change the commit on that one line. Before merging,
compare the new CLI's `version` and the output of a stable query against the
running one, so any difference is known and explained.

CI builds the image before pushing and fails if the label does not match the
commit in the Dockerfile, so an image that cannot say which upstream commit its
CLI came from never reaches `:latest`.

The CLI used to be a pre-built binary in `bin/`, produced by `vendor-cli.sh`
and stored with Git LFS. Both were removed; the old copies remain only in the
history.

## Deployment

Pushing to `main` triggers CI: formatting, vet, test, govulncheck, inline JS
check, the CLI label check, build, push to GHCR. Wait for green before
deploying.

```
ssh root@178.105.220.79
cd /opt/pubvera/pubvera-grantvera
docker inspect grantvera --format '{{.Image}}'
docker compose pull
docker compose up -d
docker inspect grantvera --format '{{.Image}}'
docker inspect grantvera --format '{{index .Config.Labels "org.opencontainers.image.revision"}} cli={{index .Config.Labels "org.pubvera.cli.commit"}}'
```

The proof of a deploy is that the two image IDs **differ** — not that the
container is running. A container that is up may well be running the old image.
The last line shows which app commit and which CLI commit are actually live;
the first must match `git rev-parse HEAD` locally.

The Alpine base is pinned to a specific minor so two builds made on different
days share the same base. Moving to a newer minor is a deliberate change.