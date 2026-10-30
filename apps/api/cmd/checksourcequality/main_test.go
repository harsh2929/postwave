package main

import (
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

func TestErrorBoundaryGateRejectsLeakMutations(t *testing.T) {
	tests := []struct {
		name   string
		source string
		want   string
	}{
		{
			name: "explicit server error through custom writer",
			source: `package fixture
import "net/http"
func handler(w any, err error) { writeJSON(w, http.StatusBadGateway, envelope(err.Error())) }
`,
			want: "explicit 5xx response",
		},
		{
			name: "explicit not implemented status through custom writer",
			source: `package fixture
import "net/http"
func handler(w any, err error) { writeJSON(w, http.StatusNotImplemented, envelope(err.Error())) }
`,
			want: "explicit 5xx response",
		},
		{
			name: "inline decoder branch",
			source: `package fixture
func handler(w, r, dst any) {
	if err := httpbody.DecodeJSON(w, r, 10, dst); err != nil { writeJSON(w, 400, err.Error()) }
}
`,
			want: "raw httpbody decoder error",
		},
		{
			name: "separate signed body assignment",
			source: `package fixture
func handler(w, r any) {
	body, err := httpbody.ReadJSONAtMost(r, 10, httpbody.Options{})
	if err != nil { writeJSON(w, 400, err.Error()) }
	_ = body
}
`,
			want: "raw httpbody decoder error",
		},
		{
			name: "authentication error",
			source: `package fixture
import "net/http"
func handler(w any, err error) { writeJSON(w, http.StatusUnauthorized, envelope(err.Error())) }
`,
			want: "authentication response",
		},
		{
			name: "unsafe parser code",
			source: `package fixture
import "net/http"
func handler(w any, err error) { writeJSON(w, http.StatusBadRequest, envelope("invalid_payload", err.Error())) }
`,
			want: `unsafe code "invalid_payload"`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			findings := parseErrorBoundaryFixture(t, tc.source)
			if !findingsContain(findings, tc.want) {
				t.Fatalf("findings = %+v, want substring %q", findings, tc.want)
			}
		})
	}
}

func TestErrorBoundaryGateAcceptsPublicMessages(t *testing.T) {
	source := `package fixture
import "net/http"
func handler(w, r, dst any) {
	if err := httpbody.DecodeJSON(w, r, 10, dst); err != nil {
		writeJSON(w, httpbody.StatusCode(err), httpbody.PublicMessage(err))
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, "service unavailable")
}
`
	if findings := parseErrorBoundaryFixture(t, source); len(findings) != 0 {
		t.Fatalf("safe fixture findings = %+v", findings)
	}
}

func TestErrorBoundaryDoesNotScanIntoClosureArguments(t *testing.T) {
	// A closure handed to a mount helper contains a fixed-text 5xx in one
	// handler and an err.Error() in an unrelated log line. Neither is a raw
	// error reaching a response, and the call that receives the closure must
	// not be blamed for the closure's contents; the closure's own calls are
	// still inspected individually.
	source := `package fixture

import "net/http"

func mount(r any, fn func(r any)) { fn(r) }

func register(r any, logger interface{ Warn(string, ...any) }, err error) {
	mount(r, func(r any) {
		logger.Warn("worker exited", "err", err.Error())
		handle(func(w http.ResponseWriter) {
			http.Error(w, "list failed", http.StatusInternalServerError)
		})
	})
}

func handle(fn func(w http.ResponseWriter)) {}
`
	if findings := parseErrorBoundaryFixture(t, source); len(findings) != 0 {
		t.Fatalf("closure argument findings = %+v", findings)
	}

	leaking := `package fixture

import "net/http"

func mount(r any, fn func(r any)) { fn(r) }

func register(r any, err error) {
	mount(r, func(r any) {
		handle(func(w http.ResponseWriter) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		})
	})
}

func handle(fn func(w http.ResponseWriter)) {}
`
	findings := parseErrorBoundaryFixture(t, leaking)
	if !findingsContain(findings, "raw error text to an explicit 5xx response") {
		t.Fatalf("a direct 5xx write inside the closure must still be caught: %+v", findings)
	}
}

func parseErrorBoundaryFixture(t *testing.T, source string) []finding {
	t.Helper()
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "fixture.go", source, parser.AllErrors)
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return errorBoundaryFindings("fixture.go", fileSet, file)
}

func findingsContain(findings []finding, want string) bool {
	for _, item := range findings {
		if strings.Contains(item.message, want) {
			return true
		}
	}
	return false
}
