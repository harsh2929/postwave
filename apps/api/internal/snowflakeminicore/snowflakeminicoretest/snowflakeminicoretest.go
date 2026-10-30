// SPDX-License-Identifier: AGPL-3.0-only

// Package snowflakeminicoretest checks, on the test binary of a package that
// imports the Snowflake driver, that the driver in it starts with its
// minicore loader off.
//
// Package snowflakeminicore explains why the loader has to be off and how its
// guard gets ahead of the driver. RequireLoaderOff checks each link the guard
// depends on, on the real test binary:
//
//  1. The guard package is initialized before the driver. GODEBUG=inittrace=1
//     prints one line per package as its init completes, in order.
//  2. So the driver's init sees SF_DISABLE_MINICORE=true.
//  3. The driver obeys that variable. Its own login telemetry reports the
//     loader as disabled instead of a version, a load error or "still
//     loading". A rename in a driver upgrade fails here and not silently.
//
// The probe runs in a child process, so the environment is the one under test
// and not whatever the developer's shell exported.
//
// Only test files import this package. It links neither the guard nor the
// driver: outside the standard library it imports only internal/httpbody,
// whose bounded reader keeps the login request, and that package imports only
// the standard library. If this package linked the guard, every test binary
// that uses it would link the guard through the test's own import, and the
// check would keep passing after the guard import beside the driver import
// was deleted. The caller's test files must not import the guard, for the
// same reason. TestLinksNeitherTheGuardNorTheDriver holds this package to
// that, and TestEveryDriverImportComesWithTheGuard in package
// snowflakeminicore holds the callers.
package snowflakeminicoretest

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// The three names below are spelled out because this package must not import
// the packages they belong to.
const (
	// GuardPackage is the import path of the guard.
	GuardPackage = "github.com/postwave/postwave/apps/api/internal/snowflakeminicore"
	// DriverPackage is the import path of the Snowflake driver.
	DriverPackage = "github.com/snowflakedb/gosnowflake"
	// Env is the variable the driver reads, once, in its package init. It is
	// the driver's name, not ours.
	Env = "SF_DISABLE_MINICORE"
)

const (
	probeEnv    = "POSTWAVE_SNOWFLAKE_MINICORE_PROBE"
	probePrefix = "snowflake-minicore-probe: "
	// loginPath is where the driver posts its login request.
	loginPath = "/session/v1/login-request"
	// maxLoginRequestBytes bounds the login request the probe keeps. The
	// driver builds that request itself: with the probe connectors in
	// internal/warehouse and internal/zerocopy_triggers it is under a
	// kilobyte of JSON. The bound keeps the probe on the API's bounded-read
	// contract, which cmd/checkrequestbodies enforces: a larger body is
	// reported, not cut short.
	maxLoginRequestBytes = 1 << 20
	// childTimeout bounds one probe process. The probe needs no network, so it
	// only has to outlast a slow start on a loaded host.
	childTimeout = 2 * time.Minute
)

// Connect returns a connector for the Snowflake driver that sends every HTTP
// request through transport. The caller builds it with the driver's own API,
// which this package cannot import. transport answers every request itself,
// so the connector needs no network.
type Connect func(transport http.RoundTripper) driver.Connector

// RequireLoaderOff fails t unless the Snowflake driver in the running test
// binary starts with its minicore loader off, both when the operator left
// SF_DISABLE_MINICORE unset and when they left it blank.
//
// Call it first thing in a test of its own. It runs the test binary again,
// selecting only that test. In that child process it probes the driver and
// exits, so nothing after the call runs there.
func RequireLoaderOff(t *testing.T, connect Connect) {
	t.Helper()
	if os.Getenv(probeEnv) == "1" {
		os.Exit(runProbe(connect))
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("locate the test binary: %v", err)
	}
	selectThisTest := "-test.run=" + runPattern(t.Name())
	for _, tc := range []struct {
		name     string
		operator []string
	}{
		{name: "the operator set nothing"},
		{name: "the operator left it blank", operator: []string{Env + "="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), childTimeout)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, selectThisTest)
			cmd.Env = append(probeEnvironment(os.Environ()), tc.operator...)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			if runErr := cmd.Run(); runErr != nil {
				t.Fatalf("probe process: %v\nstdout:\n%s\nstderr (tail):\n%s", runErr, stdout.String(), tailLines(stderr.String(), 40))
			}
			for _, problem := range verdict(stdout.String(), stderr.String()) {
				t.Error(problem)
			}
			if t.Failed() {
				t.Logf("probe stdout:\n%s", stdout.String())
			}
		})
	}
}

// runPattern is a -test.run value that selects exactly the test named name,
// which may be a subtest.
func runPattern(name string) string {
	levels := strings.Split(name, "/")
	for i, level := range levels {
		levels[i] = "^" + regexp.QuoteMeta(level) + "$"
	}
	return strings.Join(levels, "/")
}

// probeEnvironment is the parent's environment with the variable under test
// removed and the probe switches on. Platform detection is off because it
// probes cloud metadata endpoints on connect, and the probe needs no network.
func probeEnvironment(parent []string) []string {
	godebug := "inittrace=1"
	env := make([]string, 0, len(parent)+3)
	for _, entry := range parent {
		name, value, _ := strings.Cut(entry, "=")
		switch name {
		case Env, probeEnv, "SNOWFLAKE_DISABLE_PLATFORM_DETECTION":
			continue
		case "GODEBUG":
			if value != "" {
				godebug = value + "," + godebug
			}
			continue
		}
		env = append(env, entry)
	}
	return append(env,
		probeEnv+"=1",
		"GODEBUG="+godebug,
		"SNOWFLAKE_DISABLE_PLATFORM_DETECTION=true",
	)
}

// verdict lists what is wrong, given the stdout and stderr of one probe
// process. An empty list means the driver in that binary started with its
// loader off.
func verdict(stdout, stderr string) []string {
	order := initOrder(stderr)
	guard, drv := slices.Index(order, GuardPackage), slices.Index(order, DriverPackage)
	switch {
	case drv < 0:
		return []string{fmt.Sprintf("GODEBUG=inittrace=1 listed no init for %s among %d packages. This binary does not start the driver, so the check covers nothing here.",
			DriverPackage, len(order))}
	case guard < 0:
		return []string{fmt.Sprintf("GODEBUG=inittrace=1 listed no init for %s: nothing in this binary sets the minicore default before the driver starts its loader. Import the guard beside the driver import; package snowflakeminicore says why.",
			GuardPackage)}
	case guard > drv:
		return []string{fmt.Sprintf("%s initialized at position %d, after %s at %d: the driver read %s before the default was set",
			GuardPackage, guard, DriverPackage, drv, Env)}
	}
	report, err := parseReport(stdout)
	if err != nil {
		return []string{err.Error()}
	}
	if report.Error != "" {
		return []string{"probe could not capture the driver's login request: " + report.Error}
	}
	var problems []string
	if report.Env != "true" {
		problems = append(problems, fmt.Sprintf("the driver initialized with %s=%q, want \"true\"", Env, report.Env))
	}
	if report.CoreVersion != "" || !strings.Contains(report.CoreLoadError, "disabled") {
		problems = append(problems, fmt.Sprintf("the driver's login telemetry reports CORE_VERSION=%q CORE_LOAD_ERROR=%q; want the loader reported as disabled",
			report.CoreVersion, report.CoreLoadError))
	}
	return problems
}

type probeReport struct {
	Env           string `json:"env"`
	CoreVersion   string `json:"core_version"`
	CoreLoadError string `json:"core_load_error"`
	Error         string `json:"error,omitempty"`
}

// runProbe runs in the child. It prints one report line and returns the exit
// code. It never fails the child itself: the parent decides.
func runProbe(connect Connect) int {
	report := probeReport{Env: os.Getenv(Env)}
	version, loadError, err := captureCoreTelemetry(connect)
	if err != nil {
		report.Error = err.Error()
	}
	report.CoreVersion, report.CoreLoadError = version, loadError
	line, err := json.Marshal(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal probe report: %v\n", err)
		return 2
	}
	fmt.Println(probePrefix + string(line))
	return 0
}

func parseReport(stdout string) (probeReport, error) {
	for _, line := range strings.Split(stdout, "\n") {
		payload, ok := strings.CutPrefix(line, probePrefix)
		if !ok {
			continue
		}
		var report probeReport
		if err := json.Unmarshal([]byte(payload), &report); err != nil {
			return probeReport{}, fmt.Errorf("decode probe report %q: %w", payload, err)
		}
		return report, nil
	}
	return probeReport{}, fmt.Errorf("probe printed no %q line", strings.TrimSpace(probePrefix))
}

// captureCoreTelemetry makes the driver attempt one login through a transport
// that records the request and refuses it. It returns what the driver put in
// CLIENT_ENVIRONMENT about its minicore.
func captureCoreTelemetry(connect Connect) (version, loadError string, err error) {
	transport := &refusingLoginTransport{}
	db := sql.OpenDB(connect(transport))
	defer func() { _ = db.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if pingErr := db.PingContext(ctx); pingErr == nil {
		return "", "", errors.New("login succeeded through a transport that refuses every login")
	}
	body, readErr := transport.loginRequest()
	if readErr != nil {
		return "", "", fmt.Errorf("read the driver's login request: %w", readErr)
	}
	if body == nil {
		return "", "", errors.New("the driver sent no login request")
	}
	var request struct {
		Data struct {
			ClientEnvironment *struct {
				CoreVersion   string `json:"CORE_VERSION"`
				CoreLoadError string `json:"CORE_LOAD_ERROR"`
			} `json:"CLIENT_ENVIRONMENT"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &request); decodeErr != nil {
		return "", "", fmt.Errorf("decode login request: %w", decodeErr)
	}
	if request.Data.ClientEnvironment == nil {
		return "", "", errors.New("login request has no data.CLIENT_ENVIRONMENT")
	}
	return request.Data.ClientEnvironment.CoreVersion, request.Data.ClientEnvironment.CoreLoadError, nil
}

// refusingLoginTransport stands in for Snowflake. It keeps the body of the
// login request and answers every request with a refused login, so the driver
// never retries and never reaches the network. When it cannot read a login
// body, it keeps the error for the report and still answers.
type refusingLoginTransport struct {
	mu      sync.Mutex
	login   []byte
	readErr error
}

func (rt *refusingLoginTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == loginPath && r.Body != nil {
		body, err := httpbody.ReadAtMost(r.Body, maxLoginRequestBytes)
		rt.mu.Lock()
		rt.login, rt.readErr = body, err
		rt.mu.Unlock()
	}
	if r.Body != nil {
		_ = r.Body.Close()
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"data":null,"code":"390100","message":"the minicore probe refuses every login","success":false}`)),
		Request:    r,
	}, nil
}

// loginRequest returns the body of the last login request, and the error
// that kept it from being read, if one did.
func (rt *refusingLoginTransport) loginRequest() ([]byte, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.login, rt.readErr
}

// initOrder returns the package paths that GODEBUG=inittrace=1 printed, in the
// order their inits completed. Each line has the form
// "init <package> @<start> ms, <duration> ms clock, <n> bytes, <n> allocs".
func initOrder(stderr string) []string {
	var order []string
	for _, line := range strings.Split(stderr, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "init" && strings.HasPrefix(fields[2], "@") {
			order = append(order, fields[1])
		}
	}
	return order
}

func tailLines(text string, n int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
