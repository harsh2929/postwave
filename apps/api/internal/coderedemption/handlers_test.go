// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type redemptionReplayStore struct {
	mu   sync.Mutex
	rows map[string]*idempotency.Record
}

func (s *redemptionReplayStore) key(tenantID, key string) string {
	return tenantID + "\x00" + key
}

func cloneRedemptionRecord(in *idempotency.Record) *idempotency.Record {
	if in == nil {
		return nil
	}
	out := *in
	out.ResponseBody = append([]byte(nil), in.ResponseBody...)
	out.ResponseHeaders = in.ResponseHeaders.Clone()
	return &out
}

func (s *redemptionReplayStore) Get(_ context.Context, tenantID, key string) (*idempotency.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.rows[s.key(tenantID, key)]
	if record == nil {
		return nil, idempotency.ErrNotFound
	}
	return cloneRedemptionRecord(record), nil
}

func (s *redemptionReplayStore) Claim(_ context.Context, record *idempotency.Record) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(record.TenantID, record.Key)
	if s.rows[key] != nil {
		return false, nil
	}
	s.rows[key] = cloneRedemptionRecord(record)
	return true, nil
}

func (s *redemptionReplayStore) Complete(_ context.Context, record *idempotency.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(record.TenantID, record.Key)
	existing := s.rows[key]
	completed := cloneRedemptionRecord(record)
	if existing != nil {
		completed.CreatedAt = existing.CreatedAt
		completed.RequestHash = existing.RequestHash
		completed.Route = existing.Route
	}
	s.rows[key] = completed
	return nil
}

func (s *redemptionReplayStore) DeletePending(_ context.Context, tenantID, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, s.key(tenantID, key))
	return nil
}

func TestRedemptionRequiresOneValidIdempotencyKey(t *testing.T) {
	d := &Deps{}
	tests := []struct {
		name   string
		values []string
		code   string
	}{
		{name: "missing", code: "idempotency_key_required"},
		{name: "blank", values: []string{"   "}, code: "invalid_idempotency_key"},
		{name: "duplicate", values: []string{"one", "two"}, code: "invalid_idempotency_key"},
		{name: "control", values: []string{"unsafe\nkey"}, code: "invalid_idempotency_key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/codes/redeem", strings.NewReader(`{"code":"SAVE"}`))
			for _, value := range test.values {
				request.Header.Add(idempotency.HeaderName, value)
			}
			response := httptest.NewRecorder()
			d.Redeem(response, request)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestRedemptionFailsClosedWithoutMountedReplayBoundary(t *testing.T) {
	tenantID := uuid.NewString()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/codes/redeem", strings.NewReader(`{"code":"SAVE"}`))
	request.Header.Set(idempotency.HeaderName, "redeem-1")
	request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: tenantID}))
	response := httptest.NewRecorder()
	(&Deps{}).Redeem(response, request)
	if response.Code != http.StatusServiceUnavailable ||
		!strings.Contains(response.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestCampaignEvidencePaginationIsStrictAndBounded(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want CampaignEvidenceInput
		bad  bool
	}{
		{name: "defaults", url: "/evidence", want: CampaignEvidenceInput{Limit: DefaultCampaignEvidenceLimit}},
		{name: "bounded", url: "/evidence?limit=100&offset=10000", want: CampaignEvidenceInput{Limit: 100, Offset: 10000}},
		{name: "duplicate", url: "/evidence?limit=1&limit=2", bad: true},
		{name: "whitespace", url: "/evidence?limit=%201", bad: true},
		{name: "zero", url: "/evidence?limit=0", bad: true},
		{name: "too large", url: "/evidence?limit=101", bad: true},
		{name: "negative offset", url: "/evidence?offset=-1", bad: true},
		{name: "excessive offset", url: "/evidence?offset=10001", bad: true},
		{name: "not integer", url: "/evidence?limit=1.5", bad: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.url, nil)
			got, err := parseCampaignEvidenceQuery(request)
			if test.bad {
				if err == nil {
					t.Fatalf("parse = %+v, want error", got)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("parse = %+v, %v; want %+v", got, err, test.want)
			}
		})
	}
}

func TestRedemptionStrictFailureIsReplayStableAndBodyBound(t *testing.T) {
	tenantID := uuid.NewString()
	store := &redemptionReplayStore{rows: map[string]*idempotency.Record{}}
	d := &Deps{Repo: &Repo{Pool: &db.Pool{}}}
	inner := idempotency.Process(store, func(r *http.Request) (string, bool) {
		tenant, ok := middleware.TenantFromContext(r.Context())
		return tenant.ID, ok
	})(http.HandlerFunc(d.Redeem))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})))
	})

	body := []byte(`{"code":"SAVE","unexpected":true}`)
	call := func(value []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/codes/redeem", bytes.NewReader(value))
		request.Header.Set(idempotency.HeaderName, "redeem-strict-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	first := call(body)
	if first.Code != http.StatusBadRequest || !strings.Contains(first.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("first = %d %s", first.Code, first.Body.String())
	}
	replay := call(body)
	if replay.Code != first.Code || replay.Body.String() != first.Body.String() ||
		replay.Header().Get(idempotency.ReplayedHeaderName) != "true" {
		t.Fatalf("replay = %d headers=%v body=%s", replay.Code, replay.Header(), replay.Body.String())
	}
	changed := call([]byte(`{"code":"OTHER","unexpected":true}`))
	if changed.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(changed.Body.String(), `"code":"idempotency_key_request_mismatch"`) {
		t.Fatalf("changed = %d %s", changed.Code, changed.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/codes/redeem", io.NopCloser(strings.NewReader("")))
	if got := ReplayBodyLimit(request); got != 8<<10 {
		t.Fatalf("ReplayBodyLimit = %d, want %d", got, 8<<10)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/v1/codes/redeem", nil)
	if got := ReplayBodyLimit(request); got != 0 {
		t.Fatalf("GET ReplayBodyLimit = %d, want 0", got)
	}
}
