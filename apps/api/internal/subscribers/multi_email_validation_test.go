// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func reviewedAddressConsent(at time.Time) ConsentProvenanceInput {
	return ConsentProvenanceInput{
		Source:        "double_optin",
		Channel:       "web",
		LegalBasis:    "consent",
		OccurredAt:    &at,
		Jurisdiction:  "IN",
		Evidence:      "confirmed through the hosted double-opt-in receipt",
		Reason:        "subscriber confirmed this exact address",
		PolicyVersion: "privacy-2026-07",
	}
}

func TestNormalizeEmailConsentIntentFailClosed(t *testing.T) {
	t.Run("omitted add starts never subscribed", func(t *testing.T) {
		status, provenance, explicit, err := normalizeEmailConsentIntent(nil, ConsentProvenanceInput{}, "never_subscribed")
		if err != nil {
			t.Fatalf("normalize: %v", err)
		}
		if status != "never_subscribed" || provenance != nil || explicit {
			t.Fatalf("got status=%q provenance=%#v explicit=%v", status, provenance, explicit)
		}
	})

	t.Run("evidence without an explicit state is rejected", func(t *testing.T) {
		in := reviewedAddressConsent(time.Now().UTC().Add(-time.Hour))
		if _, _, _, err := normalizeEmailConsentIntent(nil, in, "never_subscribed"); err == nil || !strings.Contains(err.Error(), "consent_status is required") {
			t.Fatalf("expected consent_status validation error, got %v", err)
		}
	})

	t.Run("every explicit state requires complete evidence", func(t *testing.T) {
		for _, state := range []string{"subscribed", "unsubscribed", "pending", "unknown", "never_subscribed"} {
			state := state
			t.Run(state, func(t *testing.T) {
				if _, _, _, err := normalizeEmailConsentIntent(&state, ConsentProvenanceInput{}, ""); err == nil {
					t.Fatal("expected missing-evidence error")
				}
			})
		}
	})

	t.Run("reviewed state normalizes provenance", func(t *testing.T) {
		state := " SUBSCRIBED "
		at := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
		in := reviewedAddressConsent(at)
		in.Source = " DOUBLE_OPTIN "
		in.Jurisdiction = " in "
		status, provenance, explicit, err := normalizeEmailConsentIntent(&state, in, "")
		if err != nil {
			t.Fatalf("normalize: %v", err)
		}
		if status != "subscribed" || provenance == nil || !explicit {
			t.Fatalf("got status=%q provenance=%#v explicit=%v", status, provenance, explicit)
		}
		if provenance.Source != "double_optin" || provenance.Jurisdiction != "IN" || !provenance.OccurredAt.Equal(at) {
			t.Fatalf("provenance was not normalized: %#v", provenance)
		}
	})
}

func TestNormalizeEmailSuppressionIntentRequiresReviewEvidence(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name string
		in   UpdateEmailInput
		want string
	}{
		{name: "evidence without decision", in: UpdateEmailInput{SuppressionReason: "reviewed"}, want: "suppressed is required"},
		{name: "suppress without reason", in: UpdateEmailInput{Suppressed: &yes}, want: "suppression_reason is required"},
		{name: "unsuppress without evidence", in: UpdateEmailInput{Suppressed: &no, SuppressionReason: "false positive"}, want: "suppression_evidence is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := normalizeEmailSuppressionIntent(&tc.in); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}

	valid := UpdateEmailInput{
		Suppressed:          &no,
		SuppressionReason:   "  reviewed false positive  ",
		SuppressionEvidence: "ticket PW-1042 and provider trace",
	}
	changed, err := normalizeEmailSuppressionIntent(&valid)
	if err != nil || !changed || valid.SuppressionReason != "reviewed false positive" {
		t.Fatalf("valid review was not normalized: changed=%v in=%#v err=%v", changed, valid, err)
	}
}

func TestUpdateEmailRejectsDecorativePrimaryBeforeDatabase(t *testing.T) {
	yes := true
	_, err := (&Repo{}).UpdateEmail(context.Background(), "tenant", "subscriber", "email", UpdateEmailInput{IsPrimary: &yes}, db.AuditMeta{})
	if err != ErrEmailActivationUnavailable {
		t.Fatalf("UpdateEmail error = %v, want ErrEmailActivationUnavailable", err)
	}
}

func TestUpdateEmailRejectsAbsenceOfEvidenceStatesBeforeDatabase(t *testing.T) {
	for _, status := range []string{"unknown", "never_subscribed"} {
		t.Run(status, func(t *testing.T) {
			_, err := (&Repo{}).UpdateEmail(
				context.Background(), "tenant", "subscriber", "email",
				UpdateEmailInput{
					ConsentStatus:          &status,
					ConsentProvenanceInput: reviewedAddressConsent(time.Now().UTC()),
				}, db.AuditMeta{},
			)
			if err == nil || !errors.Is(err, ErrInvalidInput) ||
				!strings.Contains(err.Error(), "read-only absence-of-evidence states") {
				t.Fatalf("UpdateEmail(%s) error = %v, want read-only ErrInvalidInput", status, err)
			}
		})
	}
}

func TestMultiEmailMutationsRequireCurrentIfMatch(t *testing.T) {
	d := &Deps{}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"})

	for _, tc := range []struct {
		name   string
		method string
		body   string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{name: "add", method: http.MethodPost, body: `{"email":"alternate@example.com"}`, call: d.AddEmail},
		{name: "patch", method: http.MethodPatch, body: `{"suppressed":true,"suppression_reason":"reviewed"}`, call: d.UpdateEmail},
		{name: "delete", method: http.MethodDelete, call: d.DeleteEmail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, header := range []string{"", "*", `W/"subscriber:s:v1"`, `"subscriber:s:v1", "subscriber:s:v2"`} {
				req := httptest.NewRequest(tc.method, "/api/v1/subscribers/s/emails/e", strings.NewReader(tc.body)).WithContext(ctx)
				if tc.body != "" {
					req.Header.Set("Content-Type", "application/json")
				}
				if header != "" {
					req.Header.Set("If-Match", header)
				}
				rec := httptest.NewRecorder()
				tc.call(rec, req)
				if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), "precondition_required") {
					t.Fatalf("If-Match %q: status/body = %d %s", header, rec.Code, rec.Body.String())
				}
			}
		})
	}
}
