// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-071 HTTP surface for shadow-PII discovery.
//
// Endpoints:
//   GET   /api/v1/pii-findings                       list undeclared detections
//   GET   /api/v1/subscribers/{id}/pii-findings       findings for one subscriber
//   PATCH /api/v1/pii-findings/{id}                    mark reviewed/dismissed
//   GET   /api/v1/pii-scan-config                      retrieve scan settings
//   POST  /api/v1/pii-scan-config                      enable/configure scanner
//   POST  /api/v1/pii-scan-operations                  reconcile/requeue gaps
//
// All routes are admin scope — shadow-PII findings are sensitive DPO data.

package pii_scanner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	piiScanConfigMaxBodyBytes int64 = 8 << 10  // 8 KiB
	piiReviewMaxBodyBytes     int64 = 16 << 10 // 2,000 Unicode-rune comment + receipt metadata
	piiRepairMaxBodyBytes     int64 = 4 << 10  // closed action + UUID + confirmation
)

// Deps bundles the repo + detector + optional bus/logger for handler wiring.
type Deps struct {
	Repo     *Repo
	Detector *Detector
	// Bus, when non-nil, receives subscriber.pii_detected events when a scan
	// records a new finding. Optional — nil-safe in tests.
	Bus *events.Bus
	// Logger, when non-nil, is used by httperror.WriteInternal. Optional.
	Logger *slog.Logger
}

// emit publishes a subscriber.* event when the bus is configured. nil-safe.
func (d *Deps) emit(tenantID, topic string, payload map[string]any) {
	if d == nil || d.Bus == nil || tenantID == "" {
		return
	}
	d.Bus.Publish(events.Event{Topic: topic, TenantID: tenantID, Payload: payload})
}

// MountRoutes registers the SUB-071 PII-findings + scan-config routes.
func MountRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/pii-findings", d.ListFindings)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/subscribers/{id}/pii-findings", d.ListFindingsForSubscriber)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/pii-findings/{id}", d.UpdateFinding)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/pii-scan-config", d.GetScanConfig)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/pii-scan-config", d.UpsertScanConfig)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/pii-scan-operations", d.RepairCoverage)
}

// RepairCoverage POST /api/v1/pii-scan-operations. The HTTP transaction only
// records bounded repair intent; scanner work remains on the durable worker.
func (d *Deps) RepairCoverage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ScanRepairInput
	if err := httpbody.DecodeJSON(w, r, piiRepairMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateRepairInput(&in); err != nil {
		httperror.WriteValidation(w, "invalid_pii_coverage_repair", err.Error())
		return
	}
	if d == nil || d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "pii_scanner_unavailable", "the PII scanner is unavailable")
		return
	}
	var affected int64
	var err error
	switch in.Action {
	case "request_reconciliation":
		affected, err = d.Repo.RequestReconciliation(r.Context(), t.ID)
	case "requeue_dead_letters":
		affected, err = d.Repo.RequeueDeadLetters(r.Context(), t.ID, in.SubscriberID, in.Limit)
	default:
		err = ErrInvalidInput
	}
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, ScanRepairResult{
		Action: in.Action, Affected: affected, Status: "queued",
	})
}

// ListFindings GET /api/v1/pii-findings?status=&page=&per_page=
func (d *Deps) ListFindings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	filter, err := findingFilterFromRequest(r, true)
	if err != nil {
		httperror.WriteValidation(w, "invalid_filter", err.Error())
		return
	}
	out, err := d.Repo.ListFindings(r.Context(), t.ID, filter)
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListFindingsForSubscriber GET /api/v1/subscribers/{id}/pii-findings
func (d *Deps) ListFindingsForSubscriber(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	filter, err := findingFilterFromRequest(r, false)
	if err != nil {
		httperror.WriteValidation(w, "invalid_filter", err.Error())
		return
	}
	page, err := d.Repo.ListFindingsForSubscriber(r.Context(), t.ID, chi.URLParam(r, "id"), filter)
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// UpdateFinding PATCH /api/v1/pii-findings/{id}
func (d *Deps) UpdateFinding(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpdateFindingInput
	if err := httpbody.DecodeJSON(w, r, piiReviewMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := in.NormalizeAndValidate(); err != nil {
		httperror.WriteValidation(w, "invalid_review_receipt", err.Error())
		return
	}
	actor, ok := reviewActorFromContext(r)
	if !ok {
		writeStableReviewerRequiredDenial(w)
		return
	}
	out, err := d.Repo.ReviewFinding(r.Context(), t.ID, chi.URLParam(r, "id"), in, actor)
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetScanConfig GET /api/v1/pii-scan-config
func (d *Deps) GetScanConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusOK, decorateScanConfig(&ScanConfig{}, nil))
		return
	}
	cfg, err := d.Repo.GetScanConfig(r.Context(), t.ID)
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, decorateScanConfig(cfg, d.Detector))
}

// UpsertScanConfig POST /api/v1/pii-scan-config
func (d *Deps) UpsertScanConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpdateScanConfigInput
	if err := httpbody.DecodeJSON(w, r, piiScanConfigMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if d == nil || d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "pii_scanner_unavailable", "the PII scanner is unavailable")
		return
	}
	cfg, err := d.Repo.UpsertScanConfig(r.Context(), t.ID, in)
	if err != nil {
		d.writeErr(w, r, t.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, decorateScanConfig(cfg, d.Detector))
}

// ScanConfiguredSubscriber is retained as a compatibility/manual-scan seam. The
// production composition root uses the durable revision worker, not repository
// post-commit hooks. This helper still self-gates and resolves declared fields.
func (d *Deps) ScanConfiguredSubscriber(ctx context.Context, tenantID, subscriberID string, fields map[string]any) (int, error) {
	if d == nil || d.Repo == nil || d.Detector == nil {
		return 0, ErrScannerUnavailable
	}
	cfg, err := d.Repo.GetScanConfig(ctx, tenantID)
	if err != nil || cfg == nil || !cfg.ScanEnabled {
		return 0, err
	}
	declared, err := d.Repo.DeclaredFieldKeys(ctx, tenantID)
	if err != nil {
		return 0, fmt.Errorf("pii_scanner: declared-field lookup: %w", err)
	}
	return d.ScanSubscriber(ctx, tenantID, subscriberID, fields, declared)
}

// ScanSubscriber runs the detector over a subscriber's field maps and records
// any undeclared-PII detections, emitting subscriber.pii_detected when new
// findings land. Exposed for compatibility/manual callers. declared
// is the set of field keys already flagged as PII at the schema level (skipped).
// A nil detector fails closed with ErrScannerUnavailable.
func (d *Deps) ScanSubscriber(ctx context.Context, tenantID, subscriberID string, fields map[string]any, declared map[string]bool) (int, error) {
	if d == nil || d.Detector == nil || d.Repo == nil {
		return 0, ErrScannerUnavailable
	}
	if len(fields) == 0 {
		return 0, nil
	}
	result := d.Detector.ScanFields(tenantID, fields, declared)
	if result.Truncated {
		d.emit(tenantID, "subscriber.pii_scan_truncated", map[string]any{
			"subscriber_id":                 subscriberID,
			"fields_scanned":                result.FieldsScanned,
			"fields_declared":               result.FieldsDeclared,
			"fields_reserved":               result.FieldsReserved,
			"fields_over_limit":             result.FieldsOverLimit,
			"detections_retained":           len(result.Detections),
			"max_scan_fields":               MaxScanFields,
			"max_scan_field_bytes":          MaxScanFieldBytes,
			"max_detections_per_field":      MaxDetectionsPerField,
			"max_detections_per_subscriber": MaxDetectionsPerSubscriber,
		})
	}
	if len(result.Detections) == 0 {
		return 0, nil
	}
	inserted, err := d.Repo.RecordDetections(ctx, tenantID, subscriberID, result.Detections)
	if err != nil {
		return 0, err
	}
	if inserted > 0 {
		d.emit(tenantID, "subscriber.pii_detected", map[string]any{
			"subscriber_id":  subscriberID,
			"finding_count":  inserted,
			"total_detected": len(result.Detections),
			"truncated":      result.Truncated,
		})
	}
	return inserted, nil
}

func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "finding not found")
	case errors.Is(err, ErrReviewConflict):
		httperror.Write(w, http.StatusConflict, "review_conflict", "the finding was already reviewed or changed; reload the immutable receipt")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "validation_failed", err.Error())
	case errors.Is(err, ErrScannerUnavailable):
		httperror.Write(w, http.StatusServiceUnavailable, "pii_scanner_unavailable", "the PII scanner is unavailable")
	default:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

func reviewActorFromContext(r *http.Request) (ReviewActor, bool) {
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && strings.TrimSpace(u.ID) != "" {
		return ReviewActor{Type: "user", ID: strings.TrimSpace(u.ID)}, true
	}
	if id := strings.TrimSpace(middleware.APIKeyIDFromContext(r.Context())); id != "" {
		return ReviewActor{Type: "api_key", ID: id}, true
	}
	return ReviewActor{}, false
}

func findingFilterFromRequest(r *http.Request, allowQuery bool) (FindingFilter, error) {
	q := r.URL.Query()
	allowed := map[string]bool{"status": true, "detected_type": true, "page": true, "per_page": true}
	if allowQuery {
		allowed["q"] = true
	}
	for key := range q {
		if !allowed[key] {
			return FindingFilter{}, errors.New("unknown query parameter: " + key)
		}
		if len(q[key]) != 1 {
			return FindingFilter{}, errors.New("query parameters must not be repeated")
		}
	}

	filter := FindingFilter{
		Status:       strings.ToLower(strings.TrimSpace(q.Get("status"))),
		DetectedType: strings.ToLower(strings.TrimSpace(q.Get("detected_type"))),
		Query:        strings.TrimSpace(q.Get("q")),
		Page:         1,
		PerPage:      50,
	}
	if filter.Status != "" && !IsValidStatus(filter.Status) {
		return FindingFilter{}, errors.New("status must be pending, reviewed, or dismissed")
	}
	if filter.DetectedType != "" && !IsValidDetectionType(filter.DetectedType) {
		return FindingFilter{}, errors.New("detected_type is not supported")
	}
	if utf8.RuneCountInString(filter.Query) > 128 || strings.IndexFunc(filter.Query, func(ch rune) bool { return ch < 0x20 || ch == 0x7f }) >= 0 {
		return FindingFilter{}, errors.New("q must be 128 printable characters or fewer")
	}
	var err error
	if raw := q.Get("page"); raw != "" {
		filter.Page, err = strconv.Atoi(raw)
		if err != nil || filter.Page < 1 || filter.Page > 1_000_000 {
			return FindingFilter{}, errors.New("page must be an integer from 1 to 1000000")
		}
	}
	if raw := q.Get("per_page"); raw != "" {
		filter.PerPage, err = strconv.Atoi(raw)
		if err != nil || filter.PerPage < 1 || filter.PerPage > 200 {
			return FindingFilter{}, errors.New("per_page must be an integer from 1 to 200")
		}
	}
	return filter, nil
}

func decorateScanConfig(cfg *ScanConfig, detector *Detector) *ScanConfig {
	if cfg == nil {
		cfg = &ScanConfig{}
	}
	desiredScanContract, available := currentCoverageScanContract(detector)
	metadata := coverageContractMetadata{
		ScannerName: ScannerName, ScannerVersion: ScannerVersion,
		DetectorName: DetectorName, DetectorVersion: DetectorVersion,
		PolicyName: PolicyName, PolicyVersion: PolicyVersion,
	}
	runtimeProvided := cfg.RuntimeAvailability != ""
	if runtimeProvided {
		desiredScanContract = cfg.RuntimeScanContract
		parsedMetadata, valid := parseCoverageScanContract(desiredScanContract)
		if valid {
			metadata = parsedMetadata
		}
		available = cfg.RuntimeAvailability == "available" && valid
	}
	cfg.Available = available
	cfg.ExecutionMode = "transactional_revision_outbox"
	cfg.ScheduledScansAvailable = false
	cfg.ScannerName = metadata.ScannerName
	cfg.ScannerVersion = metadata.ScannerVersion
	cfg.DetectorName = metadata.DetectorName
	cfg.DetectorVersion = metadata.DetectorVersion
	cfg.PolicyName = metadata.PolicyName
	cfg.PolicyVersion = metadata.PolicyVersion
	cfg.Reliability = "at_least_once_with_dlq"
	if cfg.CoverageEvidence == nil {
		cfg.CoverageEvidence = &CoverageSnapshot{Status: "disabled"}
	}
	cfg.MaxScanFields = MaxScanFields
	cfg.MaxScanFieldBytes = MaxScanFieldBytes
	cfg.MaxScanSubscriberBytes = MaxScanSubscriberBytes
	cfg.MaxDetectionsPerField = MaxDetectionsPerField
	cfg.MaxDetectionsPerSubscriber = MaxDetectionsPerSubscriber
	if available {
		cfg.FingerprintScheme = metadata.FingerprintScheme
		cfg.FingerprintKeyVersion = metadata.FingerprintKeyVersion
		if !runtimeProvided {
			cfg.FingerprintScheme = FingerprintSchemeHMACSHA256V1
			cfg.FingerprintKeyVersion = detector.FingerprintKeyVersion()
		}
		// The worker durably advances generation when executable provenance
		// changes. Until that transition runs, never pair the new advertised
		// detector/key version with an exact snapshot produced by the old one.
		if cfg.ScanEnabled && cfg.CoverageEvidence.ScanContract != desiredScanContract {
			cfg.CoverageEvidence.Status = "backfill_pending"
			cfg.CoverageEvidence.SnapshotExact = false
		}
	} else {
		// Before migration 1762/runtime-contract state exists, the only truthful
		// fallback is a locally unavailable and effectively disabled scanner. Once
		// cluster state is present, preserve the tenant's persisted opt-in while
		// `available`/`status` separately report that no worker can execute it.
		if !runtimeProvided {
			cfg.ScanEnabled = false
		}
		cfg.FingerprintScheme = ""
		cfg.FingerprintKeyVersion = ""
		cfg.CoverageEvidence.Status = "unavailable"
		cfg.CoverageEvidence.SnapshotExact = false
	}
	switch {
	case !available:
		cfg.Status = "unavailable"
		cfg.Coverage = "unavailable"
		cfg.CoverageLimitations = []string{"scanner_dependency_unavailable"}
	case !cfg.ScanEnabled:
		cfg.Status = "disabled"
		cfg.Coverage = "disabled"
		cfg.CoverageLimitations = []string{"scanning_disabled"}
	case cfg.CoverageEvidence.Status == "caught_up" && cfg.CoverageEvidence.SnapshotExact:
		cfg.Status = "enabled_caught_up"
		cfg.Coverage = "current_snapshot_covered"
		cfg.CoverageLimitations = []string{
			"current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
			"retained_attribute_history_notes_and_event_content_not_scanned",
			"bounded_detector_truncation_requires_operator_repair",
		}
	case cfg.CoverageEvidence.Status == "degraded":
		cfg.Status = "enabled_degraded"
		cfg.Coverage = "known_gaps"
		cfg.CoverageLimitations = []string{
			"current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
			"retained_attribute_history_notes_and_event_content_not_scanned",
			"bounded_detector_truncation_requires_operator_repair",
			"dead_letters_require_operator_requeue",
		}
	default:
		cfg.Status = "enabled_backfilling"
		cfg.Coverage = "reconciling"
		cfg.CoverageLimitations = []string{
			"current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
			"retained_attribute_history_notes_and_event_content_not_scanned",
			"coverage_snapshot_reconciliation_pending",
		}
	}
	return cfg
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
