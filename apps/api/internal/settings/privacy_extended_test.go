package settings

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Patch handler boundary tests for the retention knobs added in
// migration 0238. The handler runs purely against the in-memory
// JSON body validator before it hits the DB — Pool can be nil for
// these rejection paths because the validator short-circuits.

func TestPrivacyPatchRejectsEngagementRetentionBelowMin(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy",
		`{"engagement_event_retention_days": 1}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_engagement_retention") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPrivacyPatchRejectsInboundEmailRetentionAboveMax(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy",
		`{"inbound_email_retention_days": 9999}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_inbound_email_retention") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPrivacyPatchRejectsExportGraceNegative(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy",
		`{"export_grace_days": -1}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_export_grace") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPrivacyPatchRejectsWebhookDeliveryRetentionBelowMin(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy",
		`{"webhook_delivery_retention_days": 0}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_webhook_delivery_retention") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPrivacyPatchRejectsFormSubmissionRetentionAboveMax(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy",
		`{"form_submission_retention_days": 9999}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_form_submission_retention") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestDefaultRetentionConstantsInRange guards the package-level
// fallback constants against accidental drift: each new knob's
// default must sit inside its CHECK range so a fresh tenant
// doesn't pin themselves to a value the table would reject on
// the next Patch.
func TestDefaultRetentionConstantsInRange(t *testing.T) {
	cases := []struct {
		name        string
		v, min, max int
	}{
		{"audit_log", defaultAuditLogRetentionDays, auditLogMin, auditLogMax},
		{"email_event", defaultEmailEventRetentionDays, emailEventMin, emailEventMax},
		{"unsub", defaultUnsubRetentionDays, unsubMin, unsubMax},
		{"engagement", defaultEngagementEventRetentionDays, engagementEventMin, engagementEventMax},
		{"inbound_email", defaultInboundEmailRetentionDays, inboundEmailMin, inboundEmailMax},
		{"webhook_delivery", defaultWebhookDeliveryRetentionDays, webhookDeliveryMin, webhookDeliveryMax},
		{"form_submission", defaultFormSubmissionRetentionDays, formSubmissionMin, formSubmissionMax},
		{"export_grace", defaultExportGraceDays, exportGraceMin, exportGraceMax},
	}
	for _, c := range cases {
		if c.v < c.min || c.v > c.max {
			t.Fatalf("%s default %d outside CHECK range [%d, %d]", c.name, c.v, c.min, c.max)
		}
	}
}
