// SPDX-License-Identifier: AGPL-3.0-only

package snowflakeminicoretest

import (
	"context"
	"database/sql/driver"
	"errors"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Whether the driver obeys Env, and whether the guard runs before it, can only
// be seen in a binary that links both. That is RequireLoaderOff itself, run by
// TestTheSnowflakeDriverStartsWithItsMinicoreLoaderOff in internal/warehouse
// and in internal/zerocopy_triggers. This file covers the rest.

// A test binary that uses this package must link the guard only through the
// package under test. If this package brought the guard in, the order check
// would pass with the guard import beside the driver import deleted. So
// outside the standard library this package imports only internal/httpbody,
// and internal/httpbody imports only the standard library. Together they link
// nothing else, so neither the guard nor the driver.
func TestLinksNeitherTheGuardNorTheDriver(t *testing.T) {
	reader := reflect.TypeOf(httpbody.Options{}).PkgPath()
	for _, imp := range nonTestImports(t, ".") {
		if !isStandardLibrary(imp.path) && imp.path != reader {
			t.Errorf("%s imports %s; outside the standard library this package may import only %s", imp.file, imp.path, reader)
		}
	}
	for _, imp := range nonTestImports(t, packageDir(reader)) {
		if !isStandardLibrary(imp.path) {
			t.Errorf("%s imports %s. Package snowflakeminicoretest imports %s, so this import could link the guard into the test binaries that check the guard. Keep %s to the standard library, or show here that the new import reaches neither %s nor %s.",
				imp.file, imp.path, reader, reader, GuardPackage, DriverPackage)
		}
	}
}

type importOf struct{ file, path string }

// nonTestImports lists the imports of every non-test Go file in dir, in file
// order. Build constraints are ignored, so a file counts on every platform.
func nonTestImports(t *testing.T, dir string) []importOf {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	var out []importOf
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, parseErr := parser.ParseFile(token.NewFileSet(), name, nil, parser.ImportsOnly)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", name, parseErr)
		}
		checked++
		for _, spec := range file.Imports {
			importPath, unquoteErr := strconv.Unquote(spec.Path.Value)
			if unquoteErr != nil {
				t.Fatalf("%s: import %s: %v", name, spec.Path.Value, unquoteErr)
			}
			out = append(out, importOf{file: name, path: importPath})
		}
	}
	if checked == 0 {
		t.Fatalf("found no non-test Go file in %s; the test is reading the wrong directory", dir)
	}
	return out
}

// isStandardLibrary reports whether importPath names a standard-library
// package. A standard-library path has no dot in its first element.
func isStandardLibrary(importPath string) bool {
	first, _, _ := strings.Cut(importPath, "/")
	return !strings.Contains(first, ".")
}

// packageDir is the directory of the package at importPath, relative to this
// package's directory. Inside one module, directories follow import paths. A
// package in another module gives a directory with no Go files in it, which
// nonTestImports refuses.
func packageDir(importPath string) string {
	self := strings.Split(reflect.TypeOf(probeReport{}).PkgPath(), "/")
	target := strings.Split(importPath, "/")
	shared := 0
	for shared < len(self) && shared < len(target) && self[shared] == target[shared] {
		shared++
	}
	parts := make([]string, 1, 1+len(self)-shared+len(target)-shared)
	parts[0] = "." // filepath.Join of nothing is "", not "."
	for range self[shared:] {
		parts = append(parts, "..")
	}
	return filepath.Join(append(parts, target[shared:]...)...)
}

func TestPackageDir(t *testing.T) {
	self := reflect.TypeOf(probeReport{}).PkgPath()
	parent, _ := strings.CutSuffix(self, "/snowflakeminicoretest")
	grandparent, _ := strings.CutSuffix(parent, "/snowflakeminicore")
	for _, tc := range []struct{ importPath, want string }{
		{self, "."},
		{parent, ".."},
		{grandparent + "/httpbody", filepath.Join("..", "..", "httpbody")},
		{self + "/sub", "sub"},
	} {
		if got := packageDir(tc.importPath); got != tc.want {
			t.Errorf("packageDir(%q) = %q, want %q", tc.importPath, got, tc.want)
		}
	}
}

// captureCoreTelemetry reads what the driver wrote about its minicore into its
// login request. Here a connector that posts a chosen login body through the
// probe's transport stands in for the driver, so each way the capture can go
// wrong is seen to fail. RequireLoaderOff runs it against the real driver.
func TestCaptureCoreTelemetry(t *testing.T) {
	const disabled = "Minicore is disabled with SF_DISABLE_MINICORE env variable"
	login := func(clientEnvironment string) string {
		return `{"data":{"CLIENT_ENVIRONMENT":` + clientEnvironment + `}}`
	}
	disabledLogin := login(`{"CORE_VERSION":"","CORE_LOAD_ERROR":"` + disabled + `"}`)
	padTo := func(body string, size int) string {
		return body + strings.Repeat(" ", size-len(body)) // JSON allows trailing space
	}
	for _, tc := range []struct {
		name        string
		path        string
		body        string
		accept      bool // the connector reports a successful login
		wantVersion string
		wantLoadErr string
		wantErr     string
		wantErrIs   error
	}{
		{
			name:        "the login reports the loader disabled",
			path:        loginPath,
			body:        disabledLogin,
			wantLoadErr: disabled,
		},
		{
			name:        "the login reports a loaded minicore",
			path:        loginPath,
			body:        login(`{"CORE_VERSION":"0.0.1","CORE_LOAD_ERROR":""}`),
			wantVersion: "0.0.1",
		},
		{
			name:        "a login body of exactly the bound is kept whole",
			path:        loginPath,
			body:        padTo(disabledLogin, maxLoginRequestBytes),
			wantLoadErr: disabled,
		},
		{
			name:      "a login body over the bound is reported, not cut short",
			path:      loginPath,
			body:      padTo(disabledLogin, maxLoginRequestBytes+1),
			wantErr:   "read the driver's login request",
			wantErrIs: httpbody.ErrTooLarge,
		},
		{
			name:    "the driver sends no login request",
			path:    "/session/v1/something-else",
			body:    disabledLogin,
			wantErr: "the driver sent no login request",
		},
		{
			name:    "the login has no client environment",
			path:    loginPath,
			body:    `{"data":{}}`,
			wantErr: "no data.CLIENT_ENVIRONMENT",
		},
		{
			name:    "the login is not JSON",
			path:    loginPath,
			body:    "{not json",
			wantErr: "decode login request",
		},
		{
			name:    "the login succeeds",
			path:    loginPath,
			body:    disabledLogin,
			accept:  true,
			wantErr: "login succeeded",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var answers []string
			var roundTripErr error
			connect := func(transport http.RoundTripper) driver.Connector {
				return connectorFunc(func(ctx context.Context) (driver.Conn, error) {
					request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://minicore-probe.invalid"+tc.path, strings.NewReader(tc.body))
					if err != nil {
						return nil, err
					}
					response, err := transport.RoundTrip(request)
					if err != nil {
						roundTripErr = err
						return nil, err
					}
					answer, err := io.ReadAll(response.Body)
					_ = response.Body.Close()
					if err != nil {
						return nil, err
					}
					answers = append(answers, string(answer))
					if tc.accept {
						return acceptedConn{}, nil
					}
					return nil, errors.New("login refused")
				})
			}
			version, loadErr, err := captureCoreTelemetry(connect)
			if roundTripErr != nil {
				t.Fatalf("the transport failed the request instead of refusing the login: %v", roundTripErr)
			}
			if len(answers) == 0 {
				t.Fatal("the connector was never asked to log in")
			}
			for _, answer := range answers {
				if !strings.Contains(answer, `"success":false`) {
					t.Errorf("the transport answered %q; want a refused login", answer)
				}
			}
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("captureCoreTelemetry error = %v, want one mentioning %q", err, tc.wantErr)
				}
				if tc.wantErrIs != nil && !errors.Is(err, tc.wantErrIs) {
					t.Fatalf("captureCoreTelemetry error = %v, want it to wrap %v", err, tc.wantErrIs)
				}
				return
			}
			if err != nil {
				t.Fatalf("captureCoreTelemetry: %v", err)
			}
			if version != tc.wantVersion || loadErr != tc.wantLoadErr {
				t.Fatalf("captureCoreTelemetry = (%q, %q), want (%q, %q)", version, loadErr, tc.wantVersion, tc.wantLoadErr)
			}
		})
	}
}

type connectorFunc func(context.Context) (driver.Conn, error)

func (f connectorFunc) Connect(ctx context.Context) (driver.Conn, error) { return f(ctx) }
func (f connectorFunc) Driver() driver.Driver                            { return nil }

// acceptedConn is a connection from a login that went through.
type acceptedConn struct{}

func (acceptedConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not a real connection")
}
func (acceptedConn) Close() error              { return nil }
func (acceptedConn) Begin() (driver.Tx, error) { return nil, errors.New("not a real connection") }

func TestRunPatternSelectsExactlyOneTest(t *testing.T) {
	for _, tc := range []struct {
		name     string
		want     string
		matches  []string
		excludes []string
	}{
		{
			name:     "TestProbe",
			want:     "^TestProbe$",
			matches:  []string{"TestProbe"},
			excludes: []string{"TestProbeMore", "XTestProbe"},
		},
		{
			name:     "TestProbe/the_operator_set_nothing",
			want:     "^TestProbe$/^the_operator_set_nothing$",
			matches:  []string{"TestProbe/the_operator_set_nothing"},
			excludes: []string{"TestProbe/the_operator_set_nothing_else"},
		},
		{
			name:     "TestProbe/a.b+c(d)",
			want:     `^TestProbe$/^a\.b\+c\(d\)$`,
			matches:  []string{"TestProbe/a.b+c(d)"},
			excludes: []string{"TestProbe/aXb+c(d)"},
		},
	} {
		got := runPattern(tc.name)
		if got != tc.want {
			t.Errorf("runPattern(%q) = %q, want %q", tc.name, got, tc.want)
			continue
		}
		// go test matches each slash-separated level on its own.
		levels := strings.Split(got, "/")
		match := func(name string) bool {
			parts := strings.Split(name, "/")
			if len(parts) != len(levels) {
				return false
			}
			for i, level := range levels {
				if !regexp.MustCompile(level).MatchString(parts[i]) {
					return false
				}
			}
			return true
		}
		for _, name := range tc.matches {
			if !match(name) {
				t.Errorf("runPattern(%q) = %q does not select %q", tc.name, got, name)
			}
		}
		for _, name := range tc.excludes {
			if match(name) {
				t.Errorf("runPattern(%q) = %q also selects %q", tc.name, got, name)
			}
		}
	}
}

func TestProbeEnvironment(t *testing.T) {
	for _, tc := range []struct {
		name   string
		parent []string
		want   []string
	}{
		{
			name:   "the variable under test and stale switches are dropped",
			parent: []string{"PATH=/bin", Env + "=false", probeEnv + "=0", "SNOWFLAKE_DISABLE_PLATFORM_DETECTION=false", "HOME=/h"},
			want:   []string{"PATH=/bin", "HOME=/h", probeEnv + "=1", "GODEBUG=inittrace=1", "SNOWFLAKE_DISABLE_PLATFORM_DETECTION=true"},
		},
		{
			name:   "an existing GODEBUG is kept and extended",
			parent: []string{"GODEBUG=madvdontneed=1", "PATH=/bin"},
			want:   []string{"PATH=/bin", probeEnv + "=1", "GODEBUG=madvdontneed=1,inittrace=1", "SNOWFLAKE_DISABLE_PLATFORM_DETECTION=true"},
		},
		{
			name:   "a blank GODEBUG is replaced",
			parent: []string{"GODEBUG="},
			want:   []string{probeEnv + "=1", "GODEBUG=inittrace=1", "SNOWFLAKE_DISABLE_PLATFORM_DETECTION=true"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := probeEnvironment(tc.parent); !slices.Equal(got, tc.want) {
				t.Errorf("probeEnvironment(%q)\n got %q\nwant %q", tc.parent, got, tc.want)
			}
		})
	}
}

func TestInitOrder(t *testing.T) {
	stderr := strings.Join([]string{
		"init internal/bytealg @0.004 ms, 0 ms clock, 0 bytes, 0 allocs",
		"init " + GuardPackage + " @1.2 ms, 0.001 ms clock, 16 bytes, 1 allocs",
		"some other line on stderr",
		"init: not a trace line",
		"init " + DriverPackage + " @3.4 ms, 0.2 ms clock, 2048 bytes, 30 allocs",
		"",
	}, "\n")
	want := []string{"internal/bytealg", GuardPackage, DriverPackage}
	if got := initOrder(stderr); !slices.Equal(got, want) {
		t.Fatalf("initOrder = %q, want %q", got, want)
	}
}

// verdict is the whole decision. Each case feeds it what a probe process would
// print, so every way the guard can fail is seen to fail.
func TestVerdict(t *testing.T) {
	trace := func(packages ...string) string {
		var b strings.Builder
		for i, p := range packages {
			b.WriteString("init " + p + " @" + strconv.Itoa(i) + " ms, 0 ms clock, 0 bytes, 0 allocs\n")
		}
		return b.String()
	}
	report := func(fields string) string {
		return "=== RUN whatever\n" + probePrefix + "{" + fields + "}\nPASS\n"
	}
	const disabled = `"env":"true","core_version":"","core_load_error":"Minicore is disabled with SF_DISABLE_MINICORE env variable"`
	for _, tc := range []struct {
		name   string
		stdout string
		stderr string
		want   []string // substrings, one per expected problem, in order
	}{
		{
			name:   "guard first, variable set, loader reported disabled",
			stdout: report(disabled),
			stderr: trace("os", GuardPackage, "net/http", DriverPackage),
		},
		{
			name:   "the binary does not start the driver",
			stdout: report(disabled),
			stderr: trace("os", GuardPackage),
			want:   []string{"listed no init for " + DriverPackage},
		},
		{
			name:   "nothing imports the guard",
			stdout: report(disabled),
			stderr: trace("os", DriverPackage),
			want:   []string{"listed no init for " + GuardPackage},
		},
		{
			name:   "the guard runs after the driver",
			stdout: report(disabled),
			stderr: trace("os", DriverPackage, GuardPackage),
			want:   []string{"after " + DriverPackage},
		},
		{
			name:   "the child printed no report",
			stdout: "PASS\n",
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{"printed no"},
		},
		{
			name:   "the report does not decode",
			stdout: probePrefix + "{not json\n",
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{"decode probe report"},
		},
		{
			name:   "the probe could not capture a login",
			stdout: report(`"error":"the driver sent no login request"`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{"could not capture the driver's login request: the driver sent no login request"},
		},
		{
			name:   "the variable is not set in the child",
			stdout: report(`"env":"","core_load_error":"Minicore is disabled with SF_DISABLE_MINICORE env variable"`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{`initialized with SF_DISABLE_MINICORE=""`},
		},
		{
			name:   "the driver loaded its minicore",
			stdout: report(`"env":"true","core_version":"0.0.1","core_load_error":""`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{`CORE_VERSION="0.0.1"`},
		},
		{
			name:   "the driver reports a load failure, not a disabled loader",
			stdout: report(`"env":"true","core_load_error":"Failed to load binary: load"`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{"Failed to load binary"},
		},
		{
			name:   "the driver is still loading",
			stdout: report(`"env":"true","core_load_error":"Minicore is still loading"`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{"still loading"},
		},
		{
			name:   "both the variable and the telemetry are wrong",
			stdout: report(`"env":"false","core_version":"0.0.1"`),
			stderr: trace(GuardPackage, DriverPackage),
			want:   []string{`SF_DISABLE_MINICORE="false"`, `CORE_VERSION="0.0.1"`},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := verdict(tc.stdout, tc.stderr)
			if len(got) != len(tc.want) {
				t.Fatalf("verdict returned %d problems, want %d:\n%s", len(got), len(tc.want), strings.Join(got, "\n"))
			}
			for i, want := range tc.want {
				if !strings.Contains(got[i], want) {
					t.Errorf("problem %d = %q, want it to mention %q", i, got[i], want)
				}
			}
		})
	}
}

// The child must not inherit a value for the variable from the parent's own
// environment, or the check would measure the developer's shell.
func TestProbeEnvironmentIgnoresTheCallersValue(t *testing.T) {
	t.Setenv(Env, "true")
	for _, entry := range probeEnvironment(os.Environ()) {
		if name, _, _ := strings.Cut(entry, "="); name == Env {
			t.Fatalf("the probe environment keeps %q from the caller", entry)
		}
	}
}
