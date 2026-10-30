package paywall

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// These tests cover the pre-DB validation paths in the paywall HTTP
// handlers. The happy paths require Postgres + RLS and are exercised
// by the smoke spec at tests/smoke/local-docker.spec.ts.

func TestList_NoTenantReturns401(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/paid-members", nil)
	rec := httptest.NewRecorder()
	d.List(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestGrant_NoTenantReturns401(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/paid-members",
		strings.NewReader(`{"subscriber_email":"x@y.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Grant(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestGrant_BadJSONReturns400(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/paid-members", strings.NewReader(`{not json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Grant(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_json") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestGrant_MissingEmailReturns400(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/paid-members", strings.NewReader(`{"tier":"Pro"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Grant(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "email_required") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestGrant_OversizedBodyReturns413(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	body := `{"subscriber_email":"x@y.com","metadata":{"blob":"` + strings.Repeat("a", int(paywallJSONMaxBodyBytes)+1) + `"}}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/paid-members", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Grant(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestErrEnv_Shape(t *testing.T) {
	out := errEnv("foo", "bar baz")
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Error.Code != "foo" || got.Error.Message != "bar baz" {
		t.Fatalf("unexpected envelope: %+v", got)
	}
}

func TestTierReadSetTooLargeContract(t *testing.T) {
	t.Parallel()
	err := &TierReadSetTooLargeError{Limit: MaxTierReadRows}
	if !errors.Is(err, ErrTierReadSetTooLarge) {
		t.Fatalf("errors.Is(%v, ErrTierReadSetTooLarge) = false", err)
	}
	var typed *TierReadSetTooLargeError
	if !errors.As(err, &typed) || typed.Limit != 1000 {
		t.Fatalf("typed error = %+v, want limit 1000", typed)
	}

	rec := httptest.NewRecorder()
	if !writeTierReadSetTooLarge(rec, err) {
		t.Fatal("writeTierReadSetTooLarge returned false for typed limit error")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	if !strings.Contains(rec.Body.String(), `"code":"result_set_too_large"`) {
		t.Fatalf("body = %s, want stable result_set_too_large code", rec.Body.String())
	}

	unknown := httptest.NewRecorder()
	if writeTierReadSetTooLarge(unknown, errors.New("database unavailable")) {
		t.Fatal("unknown error must fall through to the internal-error path")
	}
	if unknown.Body.Len() != 0 {
		t.Fatalf("fall-through helper wrote a response: %q", unknown.Body.String())
	}
}

func TestTierFieldBoundsAndStableReadFailure(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		field   string
		value   string
		maximum int
		wantErr bool
	}{
		{field: "name", value: strings.Repeat("n", MaxTierNameBytes), maximum: MaxTierNameBytes},
		{field: "name", value: strings.Repeat("🙂", MaxTierNameBytes/4), maximum: MaxTierNameBytes},
		{field: "name", value: strings.Repeat("n", MaxTierNameBytes+1), maximum: MaxTierNameBytes, wantErr: true},
		{field: "description", value: strings.Repeat("d", MaxTierDescriptionBytes+1), maximum: MaxTierDescriptionBytes, wantErr: true},
		{field: "stripe_price_id", value: strings.Repeat("p", MaxTierProviderReferenceBytes+1), maximum: MaxTierProviderReferenceBytes, wantErr: true},
		{field: "name", value: "safe\u202eunsafe", maximum: MaxTierNameBytes, wantErr: true},
	} {
		err := validateTierString(tc.field, tc.value, tc.maximum)
		if tc.wantErr {
			if !errors.Is(err, ErrTierFieldInvalid) {
				t.Fatalf("%s error = %v, want ErrTierFieldInvalid", tc.field, err)
			}
			var typed *TierFieldError
			if !errors.As(err, &typed) || typed.Field != tc.field || typed.MaxBytes != tc.maximum {
				t.Fatalf("typed tier field error = %+v", typed)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s exact-bound error: %v", tc.field, err)
		}
	}

	rec := httptest.NewRecorder()
	if !writeStoredTierInvalid(rec, &TierFieldError{Field: "description", MaxBytes: MaxTierDescriptionBytes}) {
		t.Fatal("writeStoredTierInvalid returned false for typed field error")
	}
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"stored_tier_contract_invalid"`) {
		t.Fatalf("stored tier failure = (%d, %s)", rec.Code, rec.Body.String())
	}
}
