// SPDX-License-Identifier: AGPL-3.0-only
package listmonk_events

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type countingMembershipResolver struct {
	calls int
	id    string
}

func (r *countingMembershipResolver) GetListUUIDByBigintID(
	_ context.Context,
	_ string,
	_ int64,
) (string, error) {
	r.calls++
	return r.id, nil
}

func TestMembershipWrapperNeverWritesBeforeBaseAuthentication(t *testing.T) {
	resolver := &countingMembershipResolver{id: "00000000-0000-4000-8000-000000000001"}
	d := &Deps{Secret: "required-secret"}
	body := []byte(`{
		"type":"subscriber.added",
		"tenant_id":"00000000-0000-4000-8000-000000000002",
		"data":{"subscriber":{"email":"person@example.com"},"list":{"id":42}}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	d.HandleWithMemberships(resolver)(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body=%s)", rec.Code, rec.Body.String())
	}
	if resolver.calls != 0 {
		t.Fatalf("membership resolver called %d times before authentication", resolver.calls)
	}
}

func TestMembershipWrapperFailsClosedWhenPersistenceUnavailable(t *testing.T) {
	resolver := &countingMembershipResolver{id: "00000000-0000-4000-8000-000000000001"}
	d := &Deps{AllowUnsignedDevBypass: true}
	body := []byte(`{
		"type":"subscriber.added",
		"tenant_id":"00000000-0000-4000-8000-000000000002",
		"data":{"subscriber":{"email":"person@example.com"},"list":{"id":42}}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	d.HandleWithMemberships(resolver)(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body=%s)", rec.Code, rec.Body.String())
	}
	if resolver.calls != 0 {
		t.Fatalf("membership resolver called despite unavailable store: %d", resolver.calls)
	}
}

func TestRewriteMembershipAcceptedCount(t *testing.T) {
	response := newMembershipBufferedResponse()
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte(`{"accepted":2}`))
	rewriteMembershipAcceptedCount(response, 3)
	if got := response.body.String(); got != `{"accepted":5}` {
		t.Fatalf("body = %s, want accepted=5", got)
	}
}
