package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
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

// runCLI runs the child CLI once and returns its stdout.
//
// The context comes from the request, so a client that goes away kills the
// child instead of leaving it to finish work nobody will read. CommandContext
// is what makes that true: exec.Command ignores cancellation entirely.
func runCLI(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()

	bin := cliBinary()
	// #nosec G204 -- fixed subcommands and flags; user text is passed as
	// discrete argv elements, never through a shell.
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.Output()
	if err != nil {
		// Distinguish the deadline from a genuine CLI failure: "CLI error:
		// signal: killed" is what a timeout looks like otherwise, and it sends
		// the reader hunting for a crash that never happened.
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("CLI timed out after %s", cliTimeout)
		}
		return nil, fmt.Errorf("CLI error: %v", err)
	}
	return out, nil
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
		http.Error(w, err.Error(), http.StatusBadGateway)
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
		http.Error(w, err.Error(), http.StatusBadGateway)
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
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeRaw(w, out)
}
