// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Each handler must short-circuit with 401 when no tenant is on the context,
// before any DB access — mirroring the project-wide no-tenant gate convention.
func TestHandlers_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}, Detector: newTestDetector(t)}

	// ListFindings
	{
		r := httptest.NewRequest("GET", "/api/v1/pii-findings", nil)
		w := httptest.NewRecorder()
		d.ListFindings(w, r)
		if w.Code != 401 {
			t.Errorf("ListFindings status = %d, want 401", w.Code)
		}
	}
	// ListFindingsForSubscriber
	{
		r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/pii-findings", nil)
		w := httptest.NewRecorder()
		d.ListFindingsForSubscriber(w, r)
		if w.Code != 401 {
			t.Errorf("ListFindingsForSubscriber status = %d, want 401", w.Code)
		}
	}
	// UpdateFinding
	{
		r := httptest.NewRequest("PATCH", "/api/v1/pii-findings/abc", strings.NewReader(`{"status":"reviewed"}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.UpdateFinding(w, r)
		if w.Code != 401 {
			t.Errorf("UpdateFinding status = %d, want 401", w.Code)
		}
	}
	// GetScanConfig
	{
		r := httptest.NewRequest("GET", "/api/v1/pii-scan-config", nil)
		w := httptest.NewRecorder()
		d.GetScanConfig(w, r)
		if w.Code != 401 {
			t.Errorf("GetScanConfig status = %d, want 401", w.Code)
		}
	}
	// UpsertScanConfig
	{
		r := httptest.NewRequest("POST", "/api/v1/pii-scan-config", strings.NewReader(`{"scan_enabled":true}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.UpsertScanConfig(w, r)
		if w.Code != 401 {
			t.Errorf("UpsertScanConfig status = %d, want 401", w.Code)
		}
	}
}

func TestIsValidDetectionType(t *testing.T) {
	for _, ty := range []string{"ssn", "credit_card", "date_of_birth", "passport",
		"drivers_license", "email", "phone", "ip_address", "iban", "other"} {
		if !IsValidDetectionType(ty) {
			t.Errorf("detection type %q should be valid", ty)
		}
	}
	for _, ty := range []string{"", "SSN", "address", "name"} {
		if IsValidDetectionType(ty) {
			t.Errorf("detection type %q should be invalid", ty)
		}
	}
}

func TestIsValidStatus(t *testing.T) {
	for _, s := range []string{"pending", "reviewed", "dismissed"} {
		if !IsValidStatus(s) {
			t.Errorf("status %q should be valid", s)
		}
	}
	for _, s := range []string{"", "open", "closed", "PENDING"} {
		if IsValidStatus(s) {
			t.Errorf("status %q should be invalid", s)
		}
	}
}

// ScanSubscriber fails closed without its fingerprint key and is a no-op only
// when a configured detector receives no fields.
func TestScanSubscriber_NoOpPaths(t *testing.T) {
	// Nil detector → explicit unavailable, no panic.
	d := &Deps{Repo: &Repo{Pool: nil}}
	if n, err := d.ScanSubscriber(context.Background(), "t", "s", map[string]any{"notes": "ssn 123-45-6789"}, nil); n != 0 || !errors.Is(err, ErrScannerUnavailable) {
		t.Errorf("nil-detector ScanSubscriber = (%d,%v), want (0,ErrScannerUnavailable)", n, err)
	}
	// Empty fields → no-op.
	d2 := &Deps{Repo: &Repo{Pool: nil}, Detector: newTestDetector(t)}
	if n, err := d2.ScanSubscriber(context.Background(), "t", "s", nil, nil); n != 0 || err != nil {
		t.Errorf("empty-fields ScanSubscriber = (%d,%v), want (0,nil)", n, err)
	}
}

func TestUpdateFindingInput_StrictReceiptValidation(t *testing.T) {
	valid := UpdateFindingInput{
		Status: StatusReviewed, Reason: ReasonConfirmedPII,
		Comment:           "Confirmed by the DPO and queued for remediation.",
		EvidenceReference: "ticket:DPO-123", ExpectedUpdatedAt: time.Now().UTC(),
	}
	if err := valid.NormalizeAndValidate(); err != nil {
		t.Fatalf("valid review rejected: %v", err)
	}
	nonEmailAt := valid
	nonEmailAt.Comment = "Confirmed @ the weekly privacy review; no address was copied."
	if err := nonEmailAt.NormalizeAndValidate(); err != nil {
		t.Fatalf("non-email @ comment must remain valid: %v", err)
	}

	tests := []struct {
		name string
		edit func(*UpdateFindingInput)
	}{
		{"pending outcome", func(in *UpdateFindingInput) { in.Status = StatusPending }},
		{"mismatched reason", func(in *UpdateFindingInput) { in.Status = StatusDismissed }},
		{"legacy input reason", func(in *UpdateFindingInput) { in.Reason = ReasonLegacyMigrated }},
		{"blank comment", func(in *UpdateFindingInput) { in.Comment = "  " }},
		{"raw email in comment", func(in *UpdateFindingInput) { in.Comment = "Confirmed jane@example.test" }},
		{"raw SSN in comment", func(in *UpdateFindingInput) { in.Comment = "Confirmed 123-45-6789" }},
		{"long numeric reference", func(in *UpdateFindingInput) { in.Comment = "Reviewed internal reference 1234567890123" }},
		{"IPv4 shape", func(in *UpdateFindingInput) { in.Comment = "Reviewed host 999.999.999.999" }},
		{"IPv6 shape", func(in *UpdateFindingInput) { in.Comment = "Reviewed host 2001:db8::1" }},
		{"untyped evidence", func(in *UpdateFindingInput) { in.EvidenceReference = "https://example.test/case" }},
		{"zero version", func(in *UpdateFindingInput) { in.ExpectedUpdatedAt = time.Time{} }},
		{"overlong unicode comment", func(in *UpdateFindingInput) { in.Comment = strings.Repeat("界", 2001) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := valid
			tt.edit(&in)
			if err := in.NormalizeAndValidate(); err == nil {
				t.Fatal("invalid receipt accepted")
			}
		})
	}
	if IsValidReviewReason(StatusReviewed, ReasonLegacyMigrated) {
		t.Fatal("legacy_migrated must remain response-only")
	}
}

func TestFindingFilterFromRequest_StrictPrivacySafeContract(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/pii-findings?status=pending&detected_type=ssn&q=notes&page=2&per_page=25", nil)
	filter, err := findingFilterFromRequest(r, true)
	if err != nil {
		t.Fatalf("valid filter: %v", err)
	}
	if filter.Status != StatusPending || filter.DetectedType != "ssn" || filter.Query != "notes" || filter.Page != 2 || filter.PerPage != 25 {
		t.Fatalf("filter=%+v", filter)
	}
	for _, rawURL := range []string{
		"/api/v1/pii-findings?unknown=x",
		"/api/v1/pii-findings?page=zero",
		"/api/v1/pii-findings?page=1000001",
		"/api/v1/pii-findings?per_page=201",
		"/api/v1/pii-findings?status=pending&status=reviewed",
		"/api/v1/pii-findings?detected_type=name",
	} {
		if _, err := findingFilterFromRequest(httptest.NewRequest(http.MethodGet, rawURL, nil), true); err == nil {
			t.Errorf("invalid filter accepted: %s", rawURL)
		}
	}
	if _, err := findingFilterFromRequest(httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/s/pii-findings?q=secret", nil), false); err == nil {
		t.Fatal("subscriber detail accepted unsupported q")
	}
	if got := escapeLikeLiteral(`50%_\done`); got != `50\%\_\\done` {
		t.Fatalf("LIKE literal escaping=%q", got)
	}
}

func TestUpdateFinding_StrictJSONAndValidationBeforeStorage(t *testing.T) {
	d := &Deps{}
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPatch, "/api/v1/pii-findings/finding", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"})
		ctx = middleware.WithUser(ctx, &middleware.User{ID: "reviewer-1"})
		r = r.WithContext(ctx)
		w := httptest.NewRecorder()
		d.UpdateFinding(w, r)
		return w
	}

	unknown := request(`{"status":"reviewed","reason":"confirmed_pii","comment":"Reviewed.","evidence_reference":"ticket:DPO-1","expected_updated_at":"2026-07-18T00:00:00Z","raw_value":"secret"}`)
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown JSON status=%d body=%s", unknown.Code, unknown.Body.String())
	}
	missing := request(`{"status":"reviewed","reason":"confirmed_pii"}`)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing receipt status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestDecorateScanConfig_TruthfulAvailability(t *testing.T) {
	unavailable := decorateScanConfig(&ScanConfig{ScanEnabled: true}, nil)
	if unavailable.ScanEnabled || unavailable.Available || unavailable.Status != "unavailable" || unavailable.ExecutionMode != "transactional_revision_outbox" || unavailable.ScheduledScansAvailable ||
		unavailable.Reliability != "at_least_once_with_dlq" || unavailable.Coverage != "unavailable" || len(unavailable.CoverageLimitations) != 1 ||
		unavailable.FingerprintScheme != "" || unavailable.FingerprintKeyVersion != "" {
		t.Fatalf("unavailable config=%+v", unavailable)
	}
	detector := newTestDetector(t)
	enabled := decorateScanConfig(&ScanConfig{ScanEnabled: true}, detector)
	if !enabled.Available || enabled.Status != "enabled_backfilling" || enabled.ScannerVersion != ScannerVersion || enabled.PolicyVersion != PolicyVersion ||
		enabled.FingerprintScheme != FingerprintSchemeHMACSHA256V1 || enabled.FingerprintKeyVersion != "test-v1" ||
		enabled.Reliability != "at_least_once_with_dlq" || enabled.Coverage != "reconciling" || len(enabled.CoverageLimitations) != 3 ||
		enabled.MaxScanFields != MaxScanFields || enabled.MaxScanFieldBytes != MaxScanFieldBytes ||
		enabled.MaxScanSubscriberBytes != MaxScanSubscriberBytes ||
		enabled.MaxDetectionsPerField != MaxDetectionsPerField || enabled.MaxDetectionsPerSubscriber != MaxDetectionsPerSubscriber {
		t.Fatalf("enabled config=%+v", enabled)
	}
	contract, ok := currentCoverageScanContract(detector)
	if !ok {
		t.Fatal("test detector did not produce a coverage contract")
	}
	caughtUp := decorateScanConfig(&ScanConfig{ScanEnabled: true, CoverageEvidence: &CoverageSnapshot{
		ScanContract: contract, Status: "caught_up", SnapshotExact: true,
	}}, detector)
	if caughtUp.Status != "enabled_caught_up" || !caughtUp.CoverageEvidence.SnapshotExact {
		t.Fatalf("matching coverage contract config=%+v", caughtUp)
	}
	clusterOnKeylessReplica := decorateScanConfig(&ScanConfig{
		ScanEnabled: true, RuntimeAvailability: "available", RuntimeScanContract: contract,
		CoverageEvidence: &CoverageSnapshot{ScanContract: contract, Status: "caught_up", SnapshotExact: true},
	}, nil)
	if !clusterOnKeylessReplica.Available || !clusterOnKeylessReplica.ScanEnabled ||
		clusterOnKeylessReplica.Status != "enabled_caught_up" ||
		clusterOnKeylessReplica.FingerprintKeyVersion != detector.FingerprintKeyVersion() {
		t.Fatalf("cluster availability depended on the serving replica: %+v", clusterOnKeylessReplica)
	}
	clusterUnavailable := decorateScanConfig(&ScanConfig{
		ScanEnabled: true, RuntimeAvailability: "unavailable", RuntimeScanContract: contract,
		CoverageEvidence: &CoverageSnapshot{ScanContract: contract, Status: "unavailable"},
	}, detector)
	if clusterUnavailable.Available || !clusterUnavailable.ScanEnabled ||
		clusterUnavailable.Status != "unavailable" || clusterUnavailable.Coverage != "unavailable" ||
		clusterUnavailable.CoverageEvidence.SnapshotExact || clusterUnavailable.FingerprintScheme != "" ||
		clusterUnavailable.FingerprintKeyVersion != "" {
		t.Fatalf("cluster outage erased tenant opt-in or advertised execution: %+v", clusterUnavailable)
	}
	missingRuntimeSingleton := decorateScanConfig(&ScanConfig{
		ScanEnabled: true, RuntimeAvailability: "unknown",
	}, detector)
	if missingRuntimeSingleton.Available || !missingRuntimeSingleton.ScanEnabled ||
		missingRuntimeSingleton.Status != "unavailable" ||
		missingRuntimeSingleton.Coverage != "unavailable" ||
		missingRuntimeSingleton.FingerprintScheme != "" ||
		missingRuntimeSingleton.FingerprintKeyVersion != "" {
		t.Fatalf("missing runtime singleton did not fail closed: %+v", missingRuntimeSingleton)
	}
	staleContract := decorateScanConfig(&ScanConfig{ScanEnabled: true, CoverageEvidence: &CoverageSnapshot{
		ScanContract: contract + "-old", Status: "caught_up", SnapshotExact: true,
	}}, detector)
	if staleContract.Status != "enabled_backfilling" || staleContract.CoverageEvidence.SnapshotExact ||
		staleContract.CoverageEvidence.Status != "backfill_pending" {
		t.Fatalf("stale coverage contract was reported exact: %+v", staleContract)
	}
}
