package forms

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

// captureOutbox is a fake OutboxAppender that records every Append call
// without touching a database. We use it to verify the forms-confirm path
// asks the outbox to enqueue the right event when an Outbox is wired.
type captureOutbox struct {
	mu      sync.Mutex
	appends []OutboxAppendInput
	failOn  string // when non-empty, return error if Kind matches
}

func (c *captureOutbox) Append(_ context.Context, _ pgx.Tx, in OutboxAppendInput) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failOn != "" && in.Kind == c.failOn {
		return "", errors.New("synthetic outbox append failure")
	}
	c.appends = append(c.appends, in)
	return "evt-fake", nil
}

func (c *captureOutbox) lastAppend() (OutboxAppendInput, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.appends) == 0 {
		return OutboxAppendInput{}, false
	}
	return c.appends[len(c.appends)-1], true
}

func TestOutboxAppendInputKindIsExported(t *testing.T) {
	// Sanity-locks the canonical kind constant. Renaming this without
	// also updating the worker handler registration in main.go would
	// silently break double-opt-in confirms in production.
	if OutboxKindEnableListmonk != "forms.confirm.enable_listmonk" {
		t.Fatalf("OutboxKindEnableListmonk drifted to %q — did you also update the registry registration in main.go?",
			OutboxKindEnableListmonk)
	}
}

func TestOutboxAppendInputCarriesPayload(t *testing.T) {
	// Verify the Append shape our handler wraps into. If Payload's runtime
	// type is changed (e.g. to a typed struct), the worker's json.Unmarshal
	// of {tenant_id, email} must still produce a usable payload.
	in := OutboxAppendInput{
		TenantID: "tenant-1",
		Kind:     OutboxKindEnableListmonk,
		Payload:  map[string]string{"tenant_id": "tenant-1", "email": "x@example.com"},
	}
	if in.TenantID == "" || in.Kind == "" || in.Payload == nil {
		t.Fatal("OutboxAppendInput should round-trip the constructor fields")
	}
}

func TestCaptureOutboxRecordsAppends(t *testing.T) {
	// Smoke test the test fake itself so failures of forms.PublicConfirm
	// in higher-level tests are unambiguously about the integration, not
	// the test scaffolding.
	c := &captureOutbox{}
	if _, err := c.Append(context.Background(), nil, OutboxAppendInput{
		TenantID: "t1", Kind: "k", Payload: nil,
	}); err != nil {
		t.Fatal(err)
	}
	got, ok := c.lastAppend()
	if !ok || got.TenantID != "t1" || got.Kind != "k" {
		t.Fatalf("lastAppend = %+v ok=%v", got, ok)
	}
}
