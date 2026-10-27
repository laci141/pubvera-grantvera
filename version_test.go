package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// /version reports the CalVer build version the release workflow stamps into
// the binary with -ldflags "-X main.appVersion=...". An unstamped build says
// "dev". The page footer reads it from app.js.

func requestVersion(t *testing.T, h http.Handler, method string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, "/version", nil))
	return rec
}

func checkVersionHeaders(t *testing.T, method string, rec *httptest.ResponseRecorder) {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("%s Content-Type = %q, want application/json; charset=utf-8", method, ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("%s Cache-Control = %q, want no-store", method, cc)
	}
}

func TestVersionGetDefaultDev(t *testing.T) {
	rec := requestVersion(t, http.HandlerFunc(handleVersion), http.MethodGet)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", rec.Code)
	}
	checkVersionHeaders(t, http.MethodGet, rec)
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if body["version"] != "dev" || len(body) != 1 {
		t.Errorf("body = %v, want {\"version\":\"dev\"}", body)
	}
}

func TestVersionHead(t *testing.T) {
	rec := requestVersion(t, http.HandlerFunc(handleVersion), http.MethodHead)
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", rec.Code)
	}
	checkVersionHeaders(t, http.MethodHead, rec)
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
}

func TestVersionRejectsOtherMethods(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := requestVersion(t, http.HandlerFunc(handleVersion), method)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s status = %d, want 405", method, rec.Code)
		}
		if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
			t.Errorf("%s Allow = %q, want \"GET, HEAD\"", method, allow)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == "" {
			t.Errorf("%s body %q is not a JSON error", method, rec.Body.String())
		}
	}
}

// main() wraps the whole mux in securityHeaders, so /version is served with
// the CSP and friends and must still answer with the stamped version.
func TestVersionBehindSecurityHeaders(t *testing.T) {
	old := appVersion
	appVersion = "2026.10.27.1"
	t.Cleanup(func() { appVersion = old })

	rec := requestVersion(t, securityHeaders(http.HandlerFunc(handleVersion)), http.MethodGet)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", rec.Code)
	}
	checkVersionHeaders(t, http.MethodGet, rec)
	if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("security headers missing: CSP=%q X-Content-Type-Options=%q",
			rec.Header().Get("Content-Security-Policy"), rec.Header().Get("X-Content-Type-Options"))
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if body["version"] != "2026.10.27.1" {
		t.Errorf("version = %q, want 2026.10.27.1", body["version"])
	}
}

// main() builds its mux inline, so the route is checked in the source: exactly
// one registration, directly after /healthz (outside /api/, so the Caddy
// forward_auth does not apply).
func TestVersionRouteRegistered(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	const route = `mux.HandleFunc("/version", handleVersion)`
	const healthz = `mux.HandleFunc("/healthz", handleHealthz)`
	lines := strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n")
	at, n := -1, 0
	for i, l := range lines {
		if strings.TrimSpace(l) == route {
			at, n = i, n+1
		}
	}
	if n != 1 {
		t.Fatalf("main.go registers %q %d times, want 1", route, n)
	}
	if at == 0 || strings.TrimSpace(lines[at-1]) != healthz {
		t.Errorf("main.go: %q is not directly after %q", route, healthz)
	}
}
