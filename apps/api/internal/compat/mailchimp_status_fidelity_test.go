package compat

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

func TestCommerceFacadePreservesExactMailchimpStatuses(t *testing.T) {
	tests := []struct {
		mailchimp string
		postwave  string
	}{
		{mailchimp: "pending", postwave: subscribers.StatusUnconfirmed},
		{mailchimp: "transactional", postwave: subscribers.StatusDisabled},
		{mailchimp: "non_subscribed", postwave: subscribers.StatusUnconfirmed},
	}
	for _, tt := range tests {
		t.Run(tt.mailchimp, func(t *testing.T) {
			if got := normalizeMailchimpMemberStatus(tt.mailchimp); got != tt.mailchimp {
				t.Fatalf("normalizeMailchimpMemberStatus(%q) = %q, want exact source status", tt.mailchimp, got)
			}
			if got := listmonkStatusFromMailchimp(tt.mailchimp); got != tt.postwave {
				t.Fatalf("listmonkStatusFromMailchimp(%q) = %q, want %q", tt.mailchimp, got, tt.postwave)
			}
		})
	}
	if validMailchimpMemberStatus("invalid") {
		t.Fatal("invalid Mailchimp member status was accepted")
	}
}

func TestCommerceFacadeRejectsInvalidMailchimpStatusBeforePersistence(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mailchimp/lists/default/members", strings.NewReader(`{
		"email_address":"status@example.com",
		"status":"invalid"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	(&Deps{}).MailchimpCreateMember(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "status must be") {
		t.Fatalf("body = %s, want status validation error", rec.Body.String())
	}
}
