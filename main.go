package main

import (
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

func runCLI(args ...string) ([]byte, error) {
	bin := cliBinary()
	cmd := exec.Command(bin, args...)
	var out []byte
	var err error
	out, err = cmd.Output()
	if err != nil {
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

	out, err := runCLI(args...)
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

	out, err := runCLI(args...)
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

	out, err := runCLI(args...)
	if err != nil {
		log.Print(err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeRaw(w, out)
}
