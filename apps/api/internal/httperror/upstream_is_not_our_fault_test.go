package httperror

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"syscall"
	"testing"
)

// An upstream we cannot reach is not an internal error.
//
// GET /api/v1/lists answered 500 because the Listmonk engine on :9000 was not
// running. The dial failed, the handler passed the error to WriteInternal, and
// the caller was told the server had broken. It had not: a dependency was down.
//
// The distinction is not cosmetic. 500 means "this request is broken, retrying
// will not help"; 502 means "the path through us is broken, the request itself
// was fine". Clients retry differently, alerting routes differently, and an
// operator reading 500s hunts for a code bug that does not exist.
//
// The discriminator is *url.Error. net/http's Client wraps EVERY transport
// failure in one, and nothing else in this codebase produces it -- a pgx query
// error, a JSON error and a business-rule error are all something else. So it
// identifies "an outbound HTTP call failed" exactly, with no guessing about
// error strings.

func decode(t *testing.T, rec *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var payload struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %s", rec.Body.String())
	}
	return payload.Error.Code, payload.Error.Message
}

func TestAnUnreachableUpstreamIs502NotAnInternalError(t *testing.T) {
	// Exactly what net/http hands back for a refused dial.
	refused := &url.Error{
		Op:  "Get",
		URL: "http://localhost:9000/api/lists",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
	}
	rec := httptest.NewRecorder()
	WriteInternal(rec, nil, refused, context.Background())

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("a refused dial to a dependency must be 502, got %d", rec.Code)
	}
	code, _ := decode(t, rec)
	if code != "upstream_unavailable" {
		t.Fatalf("code must say which side failed, got %q", code)
	}
}

func TestAWrappedUpstreamFailureIsStillRecognised(t *testing.T) {
	// Handlers add context with %w. The classification must survive it, or the
	// fix only works for callers that happen not to annotate.
	inner := &url.Error{Op: "Post", URL: "http://localhost:8082/v1/predict",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}}
	wrapped := fmt.Errorf("predict: scoring the batch: %w", inner)
	rec := httptest.NewRecorder()
	WriteInternal(rec, nil, wrapped, context.Background())
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("a wrapped upstream failure must still be 502, got %d", rec.Code)
	}
}

func TestOurOwnFailuresAreStill500(t *testing.T) {
	// The narrowing that matters. A database error, a marshalling error and a
	// business-rule error are OURS, and calling them 502 would push our bugs
	// onto somebody else's dashboard.
	for _, err := range []error{
		errors.New("ERROR: null value in column \"x\" violates not-null constraint"),
		errors.New("json: unsupported type"),
		errors.New("approvals: tenant + from + to required"),
	} {
		rec := httptest.NewRecorder()
		WriteInternal(rec, nil, err, context.Background())
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%q must stay 500, got %d", err, rec.Code)
		}
		code, _ := decode(t, rec)
		if code != CodeInternal {
			t.Fatalf("%q must keep the internal code, got %q", err, code)
		}
	}
}

func TestANilErrorIsStill500(t *testing.T) {
	// WriteInternal is called with nil in places; it must not become a 502.
	rec := httptest.NewRecorder()
	WriteInternal(rec, nil, nil, context.Background())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nil must stay 500, got %d", rec.Code)
	}
}

func TestTheUpstreamCaseStillGetsLogged(t *testing.T) {
	// Reclassifying must not also silence it -- an unreachable dependency is
	// exactly what an operator needs to see.
	buf := captureDefaultLogger(t)
	WriteInternal(httptest.NewRecorder(), nil,
		&url.Error{Op: "Get", URL: "http://localhost:9000/api/lists",
			Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}},
		context.Background())
	if buf.String() == "" {
		t.Fatal("a 502 from a dead dependency must still be logged")
	}
}
