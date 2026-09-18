package main

import (
	"bytes"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The CLI explains itself on stderr and exits non-zero: an unknown command
// prints its whole usage text, its version banner, and on a network failure
// whatever the upstream API said, all unbounded. runCLI captures that and logs
// it, which is right. What it must not do is put it in the error it returns,
// because writeCLIError writes that error straight into the HTTP response body
// for all three endpoints.
//
// This test drives the real handler with a stub CLI that behaves the way the
// real one does on failure, and asserts on what the client receives.

// stubStderr is what the fake CLI writes to stderr before failing. It stands in
// for the real CLI's usage banner: distinctive enough that finding any part of
// it in an HTTP body is unambiguous.
const stubStderr = "UNKNOWN-COMMAND-BANNER usage: grants-pp-cli search <keyword> --rows N"

// buildFailingStubCLI compiles a child CLI that writes to stderr and exits 1,
// then points CLI_BIN at it for the duration of the test. Same mechanism as the
// concurrency stub: a real child process, so the exec path under test is the
// one that runs in production rather than a mock of it.
func buildFailingStubCLI(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	src := `package main
import (
	"fmt"
	"os"
)
func main() {
	fmt.Fprintln(os.Stderr, ` + "`" + stubStderr + "`" + `)
	os.Exit(1)
}
`
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(src), 0o600); err != nil {
		t.Fatalf("write stub source: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module failstub\n\ngo 1.26\n"), 0o600); err != nil {
		t.Fatalf("write stub go.mod: %v", err)
	}
	bin := filepath.Join(dir, "failstub")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build failing stub CLI: %v\n%s", err, out)
	}
	t.Setenv("CLI_BIN", bin)
}

// captureLog redirects the standard logger for the duration of fn and returns
// what was written. The logger is process-global, so the previous destination
// and flags are restored on the way out and the tests using this must not run
// in parallel with anything that logs.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	}()
	fn()
	return buf.String()
}

// TestCLIFailureKeepsStderrOutOfTheResponse is the guard. The stub always
// fails, so the handler always takes the error path, and the assertion is on
// the body the client gets.
func TestCLIFailureKeepsStderrOutOfTheResponse(t *testing.T) {
	buildFailingStubCLI(t)

	code, body, _ := postSearch(t, "anything")

	if code != 502 {
		t.Errorf("status = %d, want 502: a failing CLI is an upstream failure", code)
	}

	// The whole point: no fragment of the child's stderr may appear. Checking
	// several fragments rather than the full line, because a future change that
	// truncates or reformats stderr before embedding it would still be a leak
	// and must still fail here.
	for _, fragment := range []string{
		"UNKNOWN-COMMAND-BANNER",
		"usage:",
		"grants-pp-cli",
		"--rows",
	} {
		if strings.Contains(body, fragment) {
			t.Errorf("response body contains child stderr fragment %q\nbody: %s", fragment, body)
		}
	}

	// The client still needs to be told something went wrong; a blank body
	// would be its own defect.
	if !strings.Contains(body, "CLI error") {
		t.Errorf("response body = %q, want it to still name the failure", body)
	}
}

// TestCLIFailureStillLogsStderr is the other half of the contract. Removing the
// leak must not remove the operator's only explanation of why the run failed,
// so this asserts stderr is still written to the log.
func TestCLIFailureStillLogsStderr(t *testing.T) {
	buildFailingStubCLI(t)

	logged := captureLog(t, func() {
		postSearch(t, "anything")
	})

	if !strings.Contains(logged, "UNKNOWN-COMMAND-BANNER") {
		t.Errorf("log does not carry the child stderr; operators lose the only\nexplanation of the failure.\nlog: %s", logged)
	}
}
