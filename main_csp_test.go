package main

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
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

// cspNonceRE is the whole policy, so any change to another directive fails it
// too. The nonce exists only so Cloudflare's injected JS-detections script can
// run; the page's own markup never carries it. connect-src carries the
// Supabase origin only when one is configured (TestCSPEnforcesConnectSrc pins
// the exact value per environment).
var cspNonceRE = regexp.MustCompile(`^default-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; script-src 'self' https://cdn\.jsdelivr\.net 'nonce-([A-Za-z0-9+/]{22})'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'self'; connect-src 'self'(?: https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?)?; report-to csp; report-uri /csp-report$`)

func cspNonceOf(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	m := cspNonceRE.FindStringSubmatch(csp)
	if m == nil {
		t.Fatalf("Content-Security-Policy = %q, does not match the expected policy with a 22-char nonce", csp)
	}
	return m[1]
}

func TestCSPNonceFormat(t *testing.T) {
	raw, err := base64.RawStdEncoding.DecodeString(cspNonceOf(t))
	if err != nil {
		t.Fatalf("nonce is not RawStdEncoding base64: %v", err)
	}
	if len(raw) != 16 {
		t.Errorf("nonce decodes to %d bytes, want 16", len(raw))
	}
}

func TestCSPNonceIsFreshPerResponse(t *testing.T) {
	a, b := cspNonceOf(t), cspNonceOf(t)
	if a == b {
		t.Errorf("two responses carried the same nonce %q", a)
	}
}

func TestCSPHasNoUnsafeKeywords(t *testing.T) {
	rec := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	for _, bad := range []string{"'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'"} {
		if strings.Contains(csp, bad) {
			t.Errorf("Content-Security-Policy = %q, must not contain %s", csp, bad)
		}
	}
}

// A cached page would replay one nonce to every visitor.
func TestRootIsNoStoreAndCarriesNoNonce(t *testing.T) {
	rec := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(handleRoot)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("GET / Cache-Control = %q, want %q", got, "no-store")
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "nonce=") {
		t.Errorf("GET / body contains nonce=; the nonce must stay in the header only")
	}
}

// The scripts are revalidated, so the page and its scripts cannot come from
// different deploys; revalidation still has to be cheap (304).
func TestScriptsAreRevalidated(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(handleRoot))
	for _, name := range []string{"/app.js", "/app-module.js"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, name, nil))
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("GET %s Cache-Control = %q, want %q", name, got, "no-cache")
		}
		lm := rec.Header().Get("Last-Modified")
		if lm == "" {
			t.Fatalf("GET %s has no Last-Modified", name)
		}
		req := httptest.NewRequest(http.MethodGet, name, nil)
		req.Header.Set("If-Modified-Since", lm)
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotModified {
			t.Errorf("GET %s with If-Modified-Since status = %d, want 304", name, rec.Code)
		}
	}
}

// GRV-SEC-001 (audit 2026-11-08): default-src 'self' is the fallback for every
// fetch type, and img-src, font-src and form-action are named explicitly. The
// only data: source is img-src, for the inline SVG favicon. Each directive must
// appear exactly once on every path.
func TestCSPDefaultSrcAndExplicitTypes(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.HasPrefix(csp, "default-src 'self'; ") {
		t.Errorf("Content-Security-Policy = %q, must start with default-src 'self'", csp)
	}
	for _, d := range []string{"default-src 'self'", "img-src 'self' data:", "font-src 'self'", "form-action 'self'"} {
		if n := strings.Count(csp, d+";"); n != 1 {
			t.Errorf("Content-Security-Policy = %q, contains %q %d times, want 1", csp, d, n)
		}
	}
	// Never a wider source than the page needs.
	for _, bad := range []string{"img-src *", "font-src *", "form-action *", "unsafe-inline", "unsafe-eval", "default-src *"} {
		if strings.Contains(csp, bad) {
			t.Errorf("Content-Security-Policy = %q, contains %q", csp, bad)
		}
	}
}

// GRV-007 style-src phase 1: the <style> block and the style= attributes moved
// to style.css, served like the scripts. A missing route would leave the page
// unstyled once style-src 'self' is enforced.
func TestHandleRootServesStyle(t *testing.T) {
	want, err := os.ReadFile("style.css")
	if err != nil {
		t.Fatalf("read style.css: %v", err)
	}
	rec := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(handleRoot)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/style.css", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("GET /style.css status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/css; charset=utf-8" {
		t.Errorf("GET /style.css Content-Type = %q, want %q", ct, "text/css; charset=utf-8")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("GET /style.css Cache-Control = %q, want %q", got, "no-cache")
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("GET /style.css body (%d bytes) differs from style.css on disk (%d bytes)", rec.Body.Len(), len(want))
	}

	rec = httptest.NewRecorder()
	handleRoot(rec, httptest.NewRequest(http.MethodPost, "/style.css", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /style.css status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

// GRV-007 style-src phase 2: style-src 'self' is enforced, same nonce, and the
// phase-1 style-src Report-Only policy is gone from every path. No Report-Only
// header is sent at all any more (TestCSPEnforcesConnectSrc).
func TestCSPEnforcesStyleSrc(t *testing.T) {
	rec := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(handleRoot)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	if !cspNonceRE.MatchString(csp) {
		t.Errorf("Content-Security-Policy = %q, does not match the expected policy", csp)
	}
	if n := strings.Count(csp, "style-src 'self'"); n != 1 {
		t.Errorf("Content-Security-Policy = %q, contains style-src 'self' %d times, want 1", csp, n)
	}
	for _, p := range []string{"/", "/style.css"} {
		rec := httptest.NewRecorder()
		securityHeaders(http.HandlerFunc(handleRoot)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		for _, ro := range rec.Header().Values("Content-Security-Policy-Report-Only") {
			if strings.Contains(ro, "style-src") {
				t.Errorf("GET %s Content-Security-Policy-Report-Only = %q, must not carry style-src", p, ro)
			}
		}
	}
}

// connect-src phase 2 (enforced). The enforcing policy ends with connect-src
// 'self', plus the Supabase origin exactly when /config.json hands the page a
// Supabase config, so the page and the header can never disagree, followed by
// the report directives. No Content-Security-Policy-Report-Only header is sent.
// Each case also pins /config.json byte for byte, because the origin helper
// feeds both.
func TestCSPEnforcesConnectSrc(t *testing.T) {
	const self = "; style-src 'self'; connect-src 'self'; report-to csp; report-uri /csp-report"
	const supa = "; style-src 'self'; connect-src 'self' https://abc.supabase.co; report-to csp; report-uri /csp-report"
	const emptyCfg = `{"supabase_url":"","supabase_anon_key":""}` + "\n"
	for _, tc := range []struct {
		name, url, key string
		wantTail       string
		wantCfg        string
	}{
		{"both unset", "", "", self, emptyCfg},
		{"both set with a path", "https://abc.supabase.co/rest/v1?x=1#f", "sb_publishable_k", supa,
			`{"supabase_url":"https://abc.supabase.co/rest/v1?x=1#f","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"both set, padded with spaces", "  https://abc.supabase.co  ", " sb_publishable_k ", supa,
			`{"supabase_url":"https://abc.supabase.co","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"only URL set", "https://abc.supabase.co", "", self, emptyCfg},
		{"only key set", "", "sb_publishable_k", self, emptyCfg},
		{"http URL", "http://abc.supabase.co", "sb_publishable_k", self,
			`{"supabase_url":"http://abc.supabase.co","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"garbage URL", "not a url", "sb_publishable_k", self,
			`{"supabase_url":"not a url","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"unparseable URL", "https://%zz", "sb_publishable_k", self,
			`{"supabase_url":"https://%zz","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"URL with a space in the host", "https://abc .supabase.co", "sb_publishable_k", self,
			`{"supabase_url":"https://abc .supabase.co","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"URL with port", "https://abc.supabase.co:8443/x", "sb_publishable_k",
			"; style-src 'self'; connect-src 'self' https://abc.supabase.co:8443; report-to csp; report-uri /csp-report",
			`{"supabase_url":"https://abc.supabase.co:8443/x","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"URL with userinfo", "https://u:p@abc.supabase.co/", "sb_publishable_k", supa,
			`{"supabase_url":"https://u:p@abc.supabase.co/","supabase_anon_key":"sb_publishable_k"}` + "\n"},
		{"host that would inject a directive", "https://abc.supabase.co;script-src", "sb_publishable_k", self,
			`{"supabase_url":"https://abc.supabase.co;script-src","supabase_anon_key":"sb_publishable_k"}` + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SUPABASE_URL", tc.url)
			t.Setenv("SUPABASE_PUBLISHABLE_KEY", tc.key)
			h := securityHeaders(http.HandlerFunc(handleRoot))
			for _, p := range []string{"/", "/style.css", "/config.json"} {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
				if ro := rec.Header().Values("Content-Security-Policy-Report-Only"); len(ro) != 0 {
					t.Errorf("GET %s Content-Security-Policy-Report-Only = %q, want it absent", p, ro)
				}
				if got := rec.Header().Get("Reporting-Endpoints"); got != `csp="/csp-report"` {
					t.Errorf("GET %s Reporting-Endpoints = %q, want %q", p, got, `csp="/csp-report"`)
				}
				csps := rec.Header().Values("Content-Security-Policy")
				if len(csps) != 1 {
					t.Fatalf("GET %s Content-Security-Policy = %q, want exactly one header", p, csps)
				}
				csp := csps[0]
				if !cspNonceRE.MatchString(csp) || !strings.HasSuffix(csp, tc.wantTail) {
					t.Errorf("GET %s Content-Security-Policy = %q, want the whole policy ending with %q", p, csp, tc.wantTail)
				}
				if n := strings.Count(csp, "connect-src"); n != 1 {
					t.Errorf("GET %s Content-Security-Policy = %q, contains connect-src %d times, want 1", p, csp, n)
				}
				if p == "/config.json" && rec.Body.String() != tc.wantCfg {
					t.Errorf("GET /config.json body = %q, want %q", rec.Body.String(), tc.wantCfg)
				}
			}
		})
	}
}

// The image must ship every file the server serves: the web-builder COPY into
// /out/ and one runtime COPY --from=web-builder per file. A file left out
// builds fine and 404s in production.
func TestDockerfileShipsServedFiles(t *testing.T) {
	b, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	var out string
	runtime := map[string]bool{}
	for _, l := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		f := strings.Fields(l)
		if len(f) > 2 && f[0] == "COPY" && f[len(f)-1] == "/out/" {
			out = l
		}
		if len(f) == 4 && f[0] == "COPY" && f[1] == "--from=web-builder" && strings.HasPrefix(f[2], "/out/") {
			runtime[strings.TrimPrefix(f[2], "/out/")+" "+f[3]] = true
		}
	}
	if out == "" {
		t.Fatal("Dockerfile has no COPY ... /out/ line")
	}
	for _, name := range []string{"index.html", "app.js", "app-module.js", "style.css"} {
		if !strings.Contains(" "+out+" ", " "+name+" ") {
			t.Errorf("Dockerfile line %q does not copy %s to /out/", out, name)
		}
		if !runtime[name+" ./"+name] {
			t.Errorf("Dockerfile has no COPY --from=web-builder /out/%s ./%s", name, name)
		}
	}
}
