package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// The three endpoints share one input contract, and until these tests existed
// nothing held them to it. The existing suite is strong on what happens AFTER
// the child CLI is reached — concurrency, timeouts, stderr handling — and had
// nothing at all on what is allowed to reach it.
//
// The whole file turns on one mechanism: CLI_BIN is pointed at a path that does
// not exist, so ANY request that survives validation spawns nothing, fails in
// exec, and comes back 502 through writeCLIError. That makes the status code a
// direct readout of where the request died:
//
//	400 or 413 → rejected by validation, no process was ever spawned
//	502        → validation passed and the CLI was attempted
//
// So "rejected before the CLI runs" is not asserted by reading the handler and
// hoping; it is the difference between two status codes. No network, no real
// binary, no timing.

// missingCLI points CLI_BIN at a path that cannot exist, for the duration of
// one test. t.Setenv restores the previous value, and t.TempDir is removed on
// the way out, so nothing leaks between tests.
func missingCLI(t *testing.T) {
	t.Helper()
	t.Setenv("CLI_BIN", filepath.Join(t.TempDir(), "no-such-cli"))
}

// apiEndpoint names one of the three handlers under test. They accept slightly
// different optional fields, but query and rows are common to all three and are
// the entire subject of this file.
type apiEndpoint struct {
	name string
	path string
	fn   func(http.ResponseWriter, *http.Request)
}

func apiEndpoints() []apiEndpoint {
	return []apiEndpoint{
		{"search", "/api/search", handleSearch},
		{"nih", "/api/nih", handleNIH},
		{"nsf", "/api/nsf", handleNSF},
	}
}

// postBody drives one handler with a raw body string. Raw rather than a
// marshalled struct on purpose: several cases here are bodies that no Go struct
// can express — truncated JSON, a second object after the first, a field the
// struct does not have.
func postBody(t *testing.T, ep apiEndpoint, body string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, ep.path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ep.fn(rec, req)
	return rec.Code, rec.Body.String()
}

// TestOnlyPOSTIsAccepted covers the one rule that already existed, so that a
// refactor of the shared helpers cannot quietly drop it.
func TestOnlyPOSTIsAccepted(t *testing.T) {
	missingCLI(t)
	for _, ep := range apiEndpoints() {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
			req := httptest.NewRequest(method, ep.path, strings.NewReader(`{"query":"cancer"}`))
			rec := httptest.NewRecorder()
			ep.fn(rec, req)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s: status = %d, want 405", method, ep.name, rec.Code)
			}
		}
	}
}

// TestMalformedBodiesAreRejected covers the shape of the body itself.
//
// The trailing-data case is the one that used to pass. json.Decoder.Decode
// stops at the end of the first JSON value and never looks further, so
// `{"query":"cancer"} garbage` decoded cleanly and the garbage was silently
// discarded — an API that accepts a body it does not read cannot tell a client
// that the client is confused.
//
// The unknown-field case is the same failure seen from the other side: a
// frontend sending "row" for "rows" used to receive the default and no
// indication that its field was thrown away.
func TestMalformedBodiesAreRejected(t *testing.T) {
	missingCLI(t)
	cases := []struct {
		name string
		body string
	}{
		{"empty body", ``},
		{"not JSON at all", `hello`},
		{"truncated object", `{"query":"cancer"`},
		{"array instead of object", `["cancer"]`},
		{"trailing garbage", `{"query":"cancer"} garbage`},
		{"second object", `{"query":"cancer"}{"query":"cancer"}`},
		{"unknown field", `{"query":"cancer","row":5}`},
		{"wrong type for rows", `{"query":"cancer","rows":"ten"}`},
	}
	for _, ep := range apiEndpoints() {
		for _, c := range cases {
			code, body := postBody(t, ep, c.body)
			if code != http.StatusBadRequest {
				t.Errorf("%s / %s: status = %d, want 400 (body: %s)", ep.name, c.name, code, body)
			}
		}
	}
}

// TestOversizedBodyIsRejected is the size limit the ReadTimeout cannot provide.
// A timeout only catches a client that is SLOW; a client that sends a hundred
// megabytes as fast as the link allows beats every deadline in the server and
// used to be handed straight to the decoder.
//
// 413 rather than 400 is deliberate: the body was well-formed, it was merely
// too big, and the client can act on that distinction.
func TestOversizedBodyIsRejected(t *testing.T) {
	missingCLI(t)
	huge := fmt.Sprintf(`{"query":%q}`, strings.Repeat("a", maxBodyBytes+1))
	for _, ep := range apiEndpoints() {
		code, body := postBody(t, ep, huge)
		if code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status = %d, want 413 (body: %s)", ep.name, code, body)
		}
	}
}

// TestEmptyAndWhitespaceQueriesAreRejected.
//
// The whitespace case is the one that was live: the check was Query != "", so
// a query of three spaces passed it, was handed to the child, and became a real
// upstream request for nothing.
func TestEmptyAndWhitespaceQueriesAreRejected(t *testing.T) {
	missingCLI(t)
	for _, ep := range apiEndpoints() {
		for _, q := range []string{"", " ", "   ", "\t", "\n", " \t\n "} {
			code, _ := postBody(t, ep, fmt.Sprintf(`{"query":%q}`, q))
			if code != http.StatusBadRequest {
				t.Errorf("%s: query %q gave status %d, want 400", ep.name, q, code)
			}
		}
	}
}

// TestDashPrefixedQueryIsRejectedBeforeTheCLIRuns guards the rule that was
// found by measurement rather than by reading.
//
// The child is invoked as `<verb> <query> --rows N --json`. Its flag parser
// treats the query as an ordinary argument only because it does not begin with
// a dash. Measured against the real vendored binary: a query of "--help" exits
// 2 having written its usage text to stderr, and "-json" exits 2 with "a
// keyword is required". Neither is an upstream failure, but both reached the
// browser as 502 — after spawning a process and holding one of the four CLI
// slots, which a client could do in a loop.
//
// 400 here is therefore two assertions at once: the right status code, AND the
// fact that no process was spawned, since a spawned one would have failed on
// the missing binary and returned 502 instead.
func TestDashPrefixedQueryIsRejectedBeforeTheCLIRuns(t *testing.T) {
	missingCLI(t)
	for _, ep := range apiEndpoints() {
		for _, q := range []string{"--help", "-json", "--rows", "-", "  --help  "} {
			code, _ := postBody(t, ep, fmt.Sprintf(`{"query":%q}`, q))
			if code == http.StatusBadGateway {
				t.Errorf("%s: query %q reached the CLI (502); it must be refused at the edge", ep.name, q)
				continue
			}
			if code != http.StatusBadRequest {
				t.Errorf("%s: query %q gave status %d, want 400", ep.name, q, code)
			}
		}
	}
}

// TestRowsBoundary walks the whole range in one place, because the interesting
// part is not any single value but where the line sits.
//
// Above the ceiling the request is REJECTED, not clamped. Clamping would return
// a different number of rows than the caller asked for with nothing saying so,
// which is the same class of silent substitution the platform refuses
// elsewhere.
//
// Non-positive values still mean "unset" and fall back to defaultRows. That is
// not new behaviour being blessed; it is behaviour every deployed frontend
// already relies on, pinned here so a future tightening is a deliberate choice
// rather than an accident.
func TestRowsBoundary(t *testing.T) {
	missingCLI(t)
	cases := []struct {
		rows int
		want int // 400 = refused by validation, 502 = reached the CLI
	}{
		{-1000, http.StatusBadGateway},
		{-1, http.StatusBadGateway},
		{0, http.StatusBadGateway},
		{1, http.StatusBadGateway},
		{maxRows - 1, http.StatusBadGateway},
		{maxRows, http.StatusBadGateway},
		{maxRows + 1, http.StatusBadRequest},
		{1000, http.StatusBadRequest},
		{1000000, http.StatusBadRequest},
	}
	for _, ep := range apiEndpoints() {
		for _, c := range cases {
			code, body := postBody(t, ep, fmt.Sprintf(`{"query":"cancer","rows":%d}`, c.rows))
			if code != c.want {
				t.Errorf("%s: rows=%d gave status %d, want %d (body: %s)", ep.name, c.rows, code, c.want, body)
			}
		}
	}
}

// TestValidRequestReachesTheCLI is the control for every test above it.
//
// Without it the whole file could pass by rejecting everything: a validator
// that returns 400 unconditionally satisfies all the negative cases. This one
// asserts the opposite direction — a well-formed request must get PAST
// validation and be attempted — and 502 is the proof it was, because the only
// thing that fails at that point is the missing binary.
func TestValidRequestReachesTheCLI(t *testing.T) {
	missingCLI(t)
	for _, ep := range apiEndpoints() {
		for _, body := range []string{
			`{"query":"cancer"}`,
			`{"query":"cancer","rows":10}`,
			`{"query":"  cancer  "}`,
			`{"query":"e-cadherin"}`,
		} {
			code, got := postBody(t, ep, body)
			if code != http.StatusBadGateway {
				t.Errorf("%s: valid body %s gave status %d, want 502 (body: %s)", ep.name, body, code, got)
			}
		}
	}
}
