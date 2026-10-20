package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// index.html no longer carries onclick=/oninput=/onkeydown= attributes, so the
// policy can forbid them outright. script-src-attr 'none' is what makes an
// event handler attribute injected through markup inert; losing it would
// re-open that path without any visible change on the page, which is why it is
// asserted here rather than left to a browser test alone.
func TestSecurityHeadersCSP(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"script-src-attr 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("Content-Security-Policy = %q, want it to contain %q", csp, want)
		}
	}

	// The other headers set alongside the CSP stay as they were.
	for name, want := range map[string]string{
		"X-Frame-Options":        "DENY",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	} {
		if got := rec.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// The two inline <script> blocks moved to app.js and app-module.js, so the
// policy can name where scripts may come from: this origin and the CDN that
// serves supabase-js and xlsx with SRI. Each directive is checked on its own,
// because dropping any one of them leaves the page working and the protection
// gone.
func TestSecurityHeadersCSPScriptSrc(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"script-src 'self' https://cdn.jsdelivr.net",
		"script-src-attr 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("Content-Security-Policy = %q, want it to contain %q", csp, want)
		}
	}
	if strings.Contains(csp, "'unsafe-inline'") {
		t.Errorf("Content-Security-Policy = %q, must not contain 'unsafe-inline'", csp)
	}
}

// The page's scripts are served by exact path from the working directory,
// the same way index.html is. A missing route would leave the page without
// its code under script-src 'self'.
func TestHandleRootServesScripts(t *testing.T) {
	for _, name := range []string{"app.js", "app-module.js"} {
		want, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		rec := httptest.NewRecorder()
		securityHeaders(http.HandlerFunc(handleRoot)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/"+name, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET /%s status = %d, want %d", name, rec.Code, http.StatusOK)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Errorf("GET /%s Content-Type = %q, want text/javascript", name, ct)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("GET /%s body (%d bytes) differs from %s on disk (%d bytes)", name, rec.Body.Len(), name, len(want))
		}

		rec = httptest.NewRecorder()
		handleRoot(rec, httptest.NewRequest(http.MethodPost, "/"+name, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST /%s status = %d, want %d", name, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}

// Only the listed paths are served: no other file in the working directory,
// the Go source included, may be reachable through or next to the script
// routes.
func TestHandleRootDoesNotServeOtherFiles(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	for _, p := range []string{"/main.go", "/app.js/../main.go"} {
		rec := httptest.NewRecorder()
		handleRoot(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code == http.StatusOK {
			t.Errorf("GET %s status = 200, want it refused", p)
		}
		if bytes.Contains(rec.Body.Bytes(), []byte("package main")) || bytes.Equal(rec.Body.Bytes(), src) {
			t.Errorf("GET %s returned main.go content", p)
		}
	}
}
