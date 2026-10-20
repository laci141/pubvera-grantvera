package main

import (
	"net/http"
	"net/http/httptest"
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
