package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunCLIInvalidJSONFails(t *testing.T) {
	for _, mode := range []string{"json-truncated", "stdout-empty"} {
		t.Run(mode, func(t *testing.T) {
			useHelper(t, mode)
			var out []byte
			var err error
			logs := captureLog(t, func() { out, err = runCLI(context.Background(), "search", "x") })
			if err == nil {
				t.Fatalf("runCLI succeeded with %q, want an error for invalid JSON", out)
			}
			if out != nil {
				t.Errorf("runCLI returned %d bytes with the error, want none", len(out))
			}
			rec := httptest.NewRecorder()
			writeCLIError(rec, err)
			if rec.Code != 502 {
				t.Errorf("status = %d, want 502", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "invalid JSON") {
				t.Errorf("body = %q, want it to contain invalid JSON", rec.Body.String())
			}
			if !strings.Contains(logs, "err=invalid_json") {
				t.Errorf("log lacks err=invalid_json:\n%s", logs)
			}
			if strings.Contains(logs, `"results"`) {
				t.Errorf("log carries stdout content:\n%s", logs)
			}
		})
	}
}

func TestRunCLIValidJSONUnchanged(t *testing.T) {
	useHelper(t, "json-valid")
	var out []byte
	var err error
	captureLog(t, func() { out, err = runCLI(context.Background(), "search", "x") })
	if err != nil {
		t.Fatalf("runCLI: %v", err)
	}
	if string(out) != `{"results":[]}` {
		t.Errorf("stdout = %q, want it unchanged", out)
	}
}
