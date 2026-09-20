package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/api/nih", handleNIH)
	mux.HandleFunc("/api/nsf", handleNSF)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/", handleRoot)

	srv := &http.Server{
		Addr: "0.0.0.0:" + port,
		// Wrapped rather than applied per handler: a new endpoint cannot
		// forget to ask for the headers, the same reason the CLI semaphore
		// lives in runCLI instead of in each handler.
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: srvReadHeaderTimeout,
		ReadTimeout:       srvReadTimeout,
		WriteTimeout:      srvWriteTimeout,
		IdleTimeout:       srvIdleTimeout,
	}

	log.Printf("grantvera listening on 0.0.0.0:%s (CLI=%s)", port, cliBinary())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// securityHeaders sets response headers that do not depend on the request.
//
// They are set BEFORE the next handler runs, because headers written after the
// body has started are silently dropped: once a handler calls Write or
// WriteHeader the status line is on the wire and the header map is frozen.
// handleRoot and writeRaw both write bodies, so there is no safe place to add
// these afterwards.
//
// What is deliberately NOT here is a full Content-Security-Policy with a
// script-src directive. index.html uses inline <script> blocks and onclick=
// attributes, so any working policy would need 'unsafe-inline', which permits
// exactly the injection a CSP exists to stop. A real policy becomes possible
// once the inline JavaScript moves into its own file; until then a policy that
// looks protective without being so is worse than none, because it invites the
// reader to stop worrying.
//
// frame-ancestors is the exception: it governs framing, not scripts, so it is
// unaffected by the inline problem and works today. X-Frame-Options repeats it
// for browsers that predate frame-ancestors; where both are understood,
// frame-ancestors wins.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// The CLI output is served as application/json. Without nosniff a
		// browser may disregard that and interpret a response as HTML.
		h.Set("X-Content-Type-Options", "nosniff")
		// The page loads code from cdn.jsdelivr.net and esm.sh and talks to
		// Supabase. Send only the origin on those cross-origin requests, never
		// the path or query.
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// Clickjacking: no site may frame this one.
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// defaultPort is the port used when PORT is unset. It matches the Dockerfile's
// EXPOSE and HEALTHCHECK and the compose file's PORT, so all four agree.
//
// It was 8093, which is retractis' port on the platform port map. In the
// container that default never applied — compose sets PORT explicitly — but a
// local run without the variable collided with another app for no reason.
const defaultPort = "8095"

// Server-side timeouts. ReadHeaderTimeout was the only one set, which left the
// request BODY with no deadline at all: the handlers decode a small JSON body,
// but a size limit is not a time limit, and a client that sends those bytes one
// per minute holds a handler goroutine for as long as it likes. Caddy sits in
// front in production and sets no request timeout of its own, so this is the
// only place the limit exists.
//
// WriteTimeout is the one that must not be guessed. It covers the whole
// response, and a CLI run is allowed cliTimeout to produce it, so anything at
// or below cliTimeout would cut off legitimate slow searches rather than
// attacks. It is derived from cliTimeout here for that reason: if the CLI
// budget ever changes, this follows it instead of silently becoming too short.
const (
	srvReadHeaderTimeout = 10 * time.Second
	// The body is a small JSON object. Thirty seconds is far more than a real
	// client needs and far less than a slow-loris attacker wants.
	srvReadTimeout = 30 * time.Second
	// The full CLI budget plus room to write the response.
	srvWriteTimeout = cliTimeout + 30*time.Second
	// Keep-alive connections that go quiet are released rather than held.
	srvIdleTimeout = 120 * time.Second
)

// Request-shape limits.
//
// maxBodyBytes is the size limit the ReadTimeout comment above says a time
// limit cannot replace. Every request body here is a JSON object with at most
// four small fields; 64 KiB is orders of magnitude more than any real client
// sends, and it stops the decoder from being handed an unbounded stream.
//
// maxRows is the ceiling on the --rows value handed to the child CLI. Only the
// lower bound existed before, so rows=1000000 travelled straight through to the
// child and became an upstream request nobody asked for. Values above the
// ceiling are REJECTED rather than clamped: clamping returns a different result
// than the caller asked for without saying so, and a caller that wants 500 rows
// should learn that it cannot have them.
//
// defaultRows keeps the previous behaviour for missing or non-positive values.
// A negative rows is still treated as "unset" rather than rejected, because
// that is what every currently deployed frontend relies on.
const (
	maxBodyBytes = 64 << 10
	maxRows      = 100
	defaultRows  = 15
)

// browserConfig is the bootstrap payload /config.json hands to the page so it
// can build its Supabase client. SupabaseAnonKey is the PUBLISHABLE
// (browser-side) key, never the secret one: it is designed to be visible in a
// browser and Row Level Security is what protects the data. It is still never
// logged.
type browserConfig struct {
	SupabaseURL     string `json:"supabase_url"`
	SupabaseAnonKey string `json:"supabase_anon_key"`
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/config.json":
		// Deliberately NOT under /api/: Caddy protects /api/* with forward_auth,
		// and the page needs this config BEFORE it can sign anyone in. Serving it
		// from a protected path would make the requirement circular and force a
		// special-case exception into the Caddy matcher.
		//
		// A missing variable is not an error. An empty pair with status 200 is a
		// valid answer that puts the page into unauthenticated mode, which is what
		// keeps local development and the current deployment working until the
		// environment is set.
		supaURL := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
		supaKey := strings.TrimSpace(os.Getenv("SUPABASE_PUBLISHABLE_KEY"))
		if supaURL == "" || supaKey == "" {
			supaURL, supaKey = "", ""
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// Never cache: a stale key surviving a key rotation would be hard to
		// diagnose from the browser side.
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(browserConfig{SupabaseURL: supaURL, SupabaseAnonKey: supaKey})
	case "/":
		http.ServeFile(w, r, "index.html")
	default:
		http.NotFound(w, r)
	}
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func cliBinary() string {
	if b := os.Getenv("CLI_BIN"); b != "" {
		return b
	}
	return "./grants-pp-cli"
}

// cliTimeout bounds a single child CLI run.
//
// Before this, runCLI had no deadline at all: a child that hung — a stalled
// NIH or NSF request, a DNS failure inside the CLI — held the HTTP request
// open forever, and the goroutine and the process with it. Nothing reclaimed
// either.
//
// The value is inherited from corpova rather than measured here. It is the
// same 120s budget that app gives a CLI run, chosen so the ceiling sits above
// any legitimate run rather than at the edge of one. If grantvera turns out to
// need a different figure, measure a real run first — do not adjust it to make
// a symptom go away.
const cliTimeout = 120 * time.Second

// cliCmdLabel names the subcommand for the log without leaking user input.
// Every caller in this file builds args with a fixed verb first and the user's
// query second (search <query>, nih <query>, nsf <query>), so only the first
// element is safe to log.
func cliCmdLabel(args []string) string {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return "?"
	}
	return args[0]
}

// runCLI runs the child CLI once and returns its stdout.
//
// The context comes from the request, so a client that goes away kills the
// child instead of leaving it to finish work nobody will read. CommandContext
// is what makes that true: exec.Command ignores cancellation entirely.
//
// The two measurements are split deliberately. wait_ms is the only way to tell
// whether the slot count is right: queue time is invisible in the CLI's own
// runtime, so a saturated semaphore and a slow upstream look identical from
// outside — both surface as one slow page and nothing else. Only wait_ms
// separates "we are out of slots" from "the far end is slow", and they need
// opposite fixes. bytes is the other half: a run that still succeeds but
// suddenly returns far less than it used to is the earliest sign of a quota
// being enforced or an upstream API degrading, well before it fails outright.
func runCLI(ctx context.Context, args ...string) ([]byte, error) {
	started := time.Now()
	label := cliCmdLabel(args)

	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()

	// Take a concurrency slot before spawning. Bounded here rather than in the
	// handlers so every CLI path is covered by construction: a new endpoint
	// cannot forget to ask.
	slotErr := cliSem.acquire(ctx)
	waitMS := time.Since(started).Milliseconds()
	if slotErr != nil {
		log.Printf("cli: busy cmd=%s wait_ms=%d err=%v", label, waitMS, slotErr)
		return nil, slotErr
	}
	defer cliSem.release()

	bin := cliBinary()
	// #nosec G204 -- fixed subcommands and flags; user text is passed as
	// discrete argv elements, never through a shell.
	cmd := exec.CommandContext(ctx, bin, args...)
	// stderr is captured separately: cmd.Output() discards it, so a CLI that
	// explains itself on stderr and exits non-zero left only "exit status 1"
	// for the reader. This app is keyless, so there is no BYOK secret that
	// could ride along in upstream text — stderr can go to the log verbatim.
	//
	// It does NOT go to the client. The error returned here reaches the browser
	// as the response body via writeCLIError, and what the CLI writes to stderr
	// on failure is its own usage text, its version banner and raw upstream
	// messages, none of it bounded. That is operator information: it belongs in
	// the log, where it is already recorded and capped, not in an HTTP response.
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runStart := time.Now()
	err := cmd.Run()
	elapsed := time.Since(runStart).Milliseconds()
	if err != nil {
		// Distinguish the deadline from a genuine CLI failure: "CLI error:
		// signal: killed" is what a timeout looks like otherwise, and it sends
		// the reader hunting for a crash that never happened.
		if ctx.Err() == context.DeadlineExceeded {
			log.Printf("cli: fail cmd=%s wait_ms=%d elapsed_ms=%d err=deadline", label, waitMS, elapsed)
			return nil, fmt.Errorf("CLI timed out after %s", cliTimeout)
		}
		// The exit status alone never says why. stderr does, so it is logged
		// next to the error — trimmed, and bounded so one runaway child cannot
		// flood the log.
		if e := strings.TrimSpace(stderr.String()); e != "" {
			log.Printf("cli: fail cmd=%s wait_ms=%d elapsed_ms=%d err=%v stderr=%s", label, waitMS, elapsed, err, truncate(e, 2000))
		} else {
			log.Printf("cli: fail cmd=%s wait_ms=%d elapsed_ms=%d err=%v", label, waitMS, elapsed, err)
		}
		return nil, fmt.Errorf("CLI error: %v", err)
	}
	// A successful run can still have written to stderr, and those messages are
	// the ones worth seeing: the CLI prints its rate-limit and server-error
	// retries there while the command goes on to succeed. Logging stderr only on
	// failure discarded exactly the warnings that explain a slow but successful
	// request. Operator information, never sent to the client.
	if w := strings.TrimSpace(stderr.String()); w != "" {
		log.Printf("cli: ok cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d stderr=%s", label, waitMS, elapsed, stdout.Len(), truncate(w, 300))
	} else {
		log.Printf("cli: ok cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d", label, waitMS, elapsed, stdout.Len())
	}
	return stdout.Bytes(), nil
}

func writeRaw(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

// decodeJSONRequest reads one JSON object from the request body into dst and
// reports whether the handler may continue. It writes the error response
// itself, so a caller that gets false must simply return.
//
// It exists because the three handlers each repeated the same four checks, and
// a rule that lives in three places drifts: /search and /nih would eventually
// disagree about what a valid request is, and nothing would catch it.
//
// Three things it enforces that a bare Decode did not:
//
//   - A body size ceiling. MaxBytesReader caps what the decoder can be handed
//     and, unlike a timeout, it fires on a client that is fast rather than slow.
//   - Unknown fields are refused. A frontend that sends "row" instead of "rows"
//     used to get the default silently; now it learns it sent nonsense.
//   - Trailing data is refused. Decode stops at the end of the first JSON value,
//     so `{"query":"cancer"} garbage` used to succeed and the garbage was never
//     read by anyone. A second Decode must report io.EOF — anything else means
//     the body held more than the one object the API accepts.
func decodeJSONRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return false
	}
	if err := dec.Decode(new(struct{})); err != io.EOF {
		http.Error(w, "invalid JSON: trailing data after the request object", http.StatusBadRequest)
		return false
	}
	return true
}

// validateQueryRows normalises the two fields every endpoint shares and reports
// whether the handler may continue. Like decodeJSONRequest it writes its own
// error response.
//
// The leading-dash rule is the one that is not obvious. The child CLI is
// invoked as `<verb> <query> --rows N --json`, and its flag parser reads the
// query as an ordinary argument only because it does not start with a dash.
// Measured against the real binary: a query of "--help" exits 2 with the usage
// text on stderr, and "-json" exits 2 with "a keyword is required". Neither is
// a gateway failure, but both reached the client as 502 by way of
// writeCLIError — after spawning a process and holding one of the four CLI
// slots. Rejecting the shape here means the bad input costs nothing and gets
// the status code it deserves.
//
// TrimSpace is the other half: Query != "" let a query of spaces through, and
// the CLI then went out to the network for it.
func validateQueryRows(w http.ResponseWriter, query *string, rows *int) bool {
	*query = strings.TrimSpace(*query)
	if *query == "" {
		http.Error(w, "missing query", http.StatusBadRequest)
		return false
	}
	if strings.HasPrefix(*query, "-") {
		http.Error(w, "query must not start with '-'", http.StatusBadRequest)
		return false
	}
	if *rows > maxRows {
		http.Error(w, fmt.Sprintf("rows must be at most %d", maxRows), http.StatusBadRequest)
		return false
	}
	if *rows <= 0 {
		*rows = defaultRows
	}
	return true
}

// POST /api/search
type searchRequest struct {
	Query         string `json:"query"`
	ClosingBefore string `json:"closing_before,omitempty"`
	Agency        string `json:"agency,omitempty"`
	Rows          int    `json:"rows,omitempty"`
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	var req searchRequest
	if !decodeJSONRequest(w, r, &req) {
		return
	}
	if !validateQueryRows(w, &req.Query, &req.Rows) {
		return
	}

	args := []string{"search", req.Query, "--rows", fmt.Sprintf("%d", req.Rows)}
	if req.ClosingBefore != "" {
		args = append(args, "--closing-before", req.ClosingBefore)
	}
	if req.Agency != "" {
		args = append(args, "--agency", req.Agency)
	}
	args = append(args, "--json")

	out, err := runCLI(r.Context(), args...)
	if err != nil {
		log.Print(err)
		writeCLIError(w, err)
		return
	}
	writeRaw(w, out)
}

// POST /api/nih
type nihRequest struct {
	Query     string `json:"query"`
	MinAmount int    `json:"min_amount,omitempty"`
	Year      int    `json:"year,omitempty"`
	Rows      int    `json:"rows,omitempty"`
}

func handleNIH(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	var req nihRequest
	if !decodeJSONRequest(w, r, &req) {
		return
	}
	if !validateQueryRows(w, &req.Query, &req.Rows) {
		return
	}

	args := []string{"nih", req.Query, "--rows", fmt.Sprintf("%d", req.Rows)}
	if req.MinAmount > 0 {
		args = append(args, "--min-amount", fmt.Sprintf("%d", req.MinAmount))
	}
	if req.Year > 0 {
		args = append(args, "--year", fmt.Sprintf("%d", req.Year))
	}
	args = append(args, "--json")

	out, err := runCLI(r.Context(), args...)
	if err != nil {
		log.Print(err)
		writeCLIError(w, err)
		return
	}
	writeRaw(w, out)
}

// POST /api/nsf
type nsfRequest struct {
	Query     string `json:"query"`
	MinAmount int    `json:"min_amount,omitempty"`
	Rows      int    `json:"rows,omitempty"`
}

func handleNSF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	var req nsfRequest
	if !decodeJSONRequest(w, r, &req) {
		return
	}
	if !validateQueryRows(w, &req.Query, &req.Rows) {
		return
	}

	args := []string{"nsf", req.Query, "--rows", fmt.Sprintf("%d", req.Rows)}
	if req.MinAmount > 0 {
		args = append(args, "--min-amount", fmt.Sprintf("%d", req.MinAmount))
	}
	args = append(args, "--json")

	out, err := runCLI(r.Context(), args...)
	if err != nil {
		log.Print(err)
		writeCLIError(w, err)
		return
	}
	writeRaw(w, out)
}

// truncate caps a log line at max runes. Rune-based, not byte-based: a stderr
// message can carry UTF-8, and slicing bytes would split a character and put
// an invalid sequence in the log. Same shape as pubvera-corpova's.
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "..."
}
