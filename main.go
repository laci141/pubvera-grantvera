package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
		port = "8093"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/api/nih", handleNIH)
	mux.HandleFunc("/api/nsf", handleNSF)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/", handleRoot)

	srv := &http.Server{
		Addr:              "0.0.0.0:" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("grantvera listening on 0.0.0.0:%s (CLI=%s)", port, cliBinary())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, "index.html")
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
	// for the reader. The message goes to the caller, never to the log — a
	// keyless request has no redaction in front of upstream text.
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
		log.Printf("cli: fail cmd=%s wait_ms=%d elapsed_ms=%d err=%v", label, waitMS, elapsed, err)
		return nil, fmt.Errorf("CLI error: %v — stderr: %s", err, stderr.String())
	}
	log.Printf("cli: ok cmd=%s wait_ms=%d elapsed_ms=%d bytes=%d", label, waitMS, elapsed, stdout.Len())
	return stdout.Bytes(), nil
}

func writeRaw(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		http.Error(w, "missing query", http.StatusBadRequest)
		return
	}
	if req.Rows <= 0 {
		req.Rows = 15
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		http.Error(w, "missing query", http.StatusBadRequest)
		return
	}
	if req.Rows <= 0 {
		req.Rows = 15
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		http.Error(w, "missing query", http.StatusBadRequest)
		return
	}
	if req.Rows <= 0 {
		req.Rows = 15
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
