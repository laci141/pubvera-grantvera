package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// helperEnv selects a helper mode. When it is set, the test binary acts as the
// child CLI instead of running tests: CLI_BIN points at os.Args[0], so runCLI
// spawns a real process on Linux CI and on Windows without a shell script.
const helperEnv = "GRANTVERA_TEST_HELPER"

const helperStderrMarker = "HELPER-STDERR-MARKER"

func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnv); mode != "" {
		os.Exit(runHelper(mode))
	}
	os.Exit(m.Run())
}

func runHelper(mode string) int {
	bigStderr := func() {
		chunk := bytes.Repeat([]byte(helperStderrMarker+"\n"), 1024)
		for n := 0; n < 10<<20; n += len(chunk) {
			os.Stderr.Write(chunk)
		}
	}
	switch mode {
	case "stdout-over":
		os.Stdout.Write(bytes.Repeat([]byte("x"), maxCLIStdout+1))
		return 0
	case "stdout-exact":
		os.Stdout.Write(bytes.Repeat([]byte("x"), maxCLIStdout))
		return 0
	case "stderr-flood-ok":
		os.Stdout.Write([]byte(`{"ok":true}`))
		bigStderr()
		return 0
	case "stderr-flood-fail":
		os.Stdout.Write([]byte(`{}`))
		bigStderr()
		return 1
	}
	return 2
}

// useHelper points runCLI at this test binary in the given mode. The child
// inherits the environment, so the env var reaches it.
func useHelper(t *testing.T, mode string) {
	t.Helper()
	t.Setenv("CLI_BIN", os.Args[0])
	t.Setenv(helperEnv, mode)
}

func TestRunCLIStdoutOverLimitFails(t *testing.T) {
	useHelper(t, "stdout-over")
	start := time.Now()
	var out []byte
	var err error
	logs := captureLog(t, func() { out, err = runCLI(context.Background(), "search", "x") })
	if err == nil {
		t.Fatalf("runCLI succeeded with %d bytes, want an error above maxCLIStdout", len(out))
	}
	if out != nil {
		t.Errorf("runCLI returned %d bytes with the error, want none", len(out))
	}
	if d := time.Since(start); d > cliTimeout/4 {
		t.Errorf("runCLI took %s, want well within cliTimeout", d)
	}
	if !strings.Contains(logs, "err=stdout_limit") {
		t.Errorf("log lacks err=stdout_limit:\n%s", logs)
	}
	if strings.Contains(logs, "err=deadline") {
		t.Errorf("overflow was logged as a deadline:\n%s", logs)
	}
}

func TestSearchStdoutOverLimitIsNot200(t *testing.T) {
	useHelper(t, "stdout-over")
	var code int
	var body string
	captureLog(t, func() { code, body, _ = postSearch(t, "cancer") })
	if code == 200 {
		t.Fatalf("status 200 for an over-limit CLI output (body %d bytes)", len(body))
	}
	if code < 500 {
		t.Errorf("status = %d, want a 5xx", code)
	}
	if strings.Contains(body, "xxxx") {
		t.Errorf("response body carries CLI output: %.80q", body)
	}
}

func TestRunCLIStdoutExactLimitSucceeds(t *testing.T) {
	useHelper(t, "stdout-exact")
	var out []byte
	var err error
	captureLog(t, func() { out, err = runCLI(context.Background(), "search", "x") })
	if err != nil {
		t.Fatalf("runCLI: %v", err)
	}
	if len(out) != maxCLIStdout {
		t.Errorf("got %d bytes, want exactly %d", len(out), maxCLIStdout)
	}
}

func TestRunCLIStderrFloodOnSuccess(t *testing.T) {
	useHelper(t, "stderr-flood-ok")
	start := time.Now()
	var out []byte
	var err error
	logs := captureLog(t, func() { out, err = runCLI(context.Background(), "search", "x") })
	if err != nil {
		t.Fatalf("runCLI: %v", err)
	}
	if string(out) != `{"ok":true}` {
		t.Errorf("stdout = %q, want it intact", out)
	}
	if d := time.Since(start); d > cliTimeout/4 {
		t.Errorf("runCLI took %s: the helper was blocked on stderr", d)
	}
	if !strings.Contains(logs, "stderr_truncated=true") {
		t.Errorf("log lacks stderr_truncated=true:\n%.300s", logs)
	}
}

func TestRunCLIStderrFloodOnFailure(t *testing.T) {
	useHelper(t, "stderr-flood-fail")
	var err error
	logs := captureLog(t, func() { _, err = runCLI(context.Background(), "search", "x") })
	if err == nil {
		t.Fatal("runCLI succeeded, want an error for exit 1")
	}
	if strings.Contains(err.Error(), helperStderrMarker) {
		t.Errorf("error text carries stderr: %.200q", err.Error())
	}
	if !strings.Contains(logs, "stderr_truncated=true") {
		t.Errorf("log lacks stderr_truncated=true:\n%.300s", logs)
	}
}

func TestCappedStdoutBoundary(t *testing.T) {
	cancelled := false
	w := &cappedStdout{max: 4, cancel: func() { cancelled = true }}
	if n, err := w.Write([]byte("abcd")); n != 4 || err != nil {
		t.Fatalf("Write at cap = %d, %v", n, err)
	}
	if w.overflow || cancelled || w.Len() != 4 {
		t.Fatalf("at cap: overflow=%v cancelled=%v len=%d", w.overflow, cancelled, w.Len())
	}
	if n, err := w.Write([]byte("e")); n != 1 || err != nil {
		t.Fatalf("Write past cap = %d, %v", n, err)
	}
	if !w.overflow || !cancelled {
		t.Errorf("past cap: overflow=%v cancelled=%v, want both", w.overflow, cancelled)
	}
	w.Write([]byte("fgh"))
	if w.Len() != 4 || string(w.Bytes()) != "abcd" {
		t.Errorf("stored %q after overflow, want abcd", w.Bytes())
	}
}

func TestCappedStderrDrains(t *testing.T) {
	w := &cappedStderr{max: 4}
	if n, _ := w.Write([]byte("abcd")); n != 4 || w.truncated {
		t.Fatalf("at cap: n=%d truncated=%v", n, w.truncated)
	}
	if n, err := w.Write([]byte("efgh")); n != 4 || err != nil {
		t.Errorf("past cap Write = %d, %v; want a full count so the child keeps writing", n, err)
	}
	if !w.truncated || w.Len() != 4 || w.String() != "abcd" {
		t.Errorf("truncated=%v stored=%q, want true and abcd", w.truncated, w.String())
	}
	w2 := &cappedStderr{max: 4}
	if n, _ := w2.Write([]byte("abcdef")); n != 6 || w2.String() != "abcd" {
		t.Errorf("split write: n=%d stored=%q", n, w2.String())
	}
}
