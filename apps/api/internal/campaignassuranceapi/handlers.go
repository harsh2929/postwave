// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassuranceapi exposes the tenant-scoped public HTTP contract
// for Campaign Assurance. Public callers select only an optional frozen
// campaign revision/ready plan, a request identity, and one server-owned suite
// profile. When those immutable IDs are omitted, the server owns the exact
// freeze, scenario compilation, and materialization path.
package campaignassuranceapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	createRunBodyMaxBytes int64 = 8 << 10
	appealBodyMaxBytes    int64 = 4 << 10
	applyBodyMaxBytes     int64 = 1 << 10
	cancelBodyMaxBytes    int64 = 1 << 10
	defaultEvidenceLimit        = 100
	maxEvidenceLimit            = 200
	maxEvidenceOffset           = 100_000
)

// AssuranceService is the testable HTTP boundary. Service implements it; no
// worker mutation or arbitrary suite configuration is reachable here.
type AssuranceService interface {
	StartRun(context.Context, StartRunCommand) (*campaignassurance.Run, []string, error)
	Latest(context.Context, string, string) (*RunDetail, error)
	Detail(context.Context, string, string, string) (*RunDetail, error)
	Evidence(context.Context, string, string, string, int, int) (*EvidencePage, error)
	Progress(context.Context, string, string, string) (*ProgressSnapshot, error)
	Appeal(context.Context, AppealCommand) (*campaignassurance.Override, error)
	Cancel(context.Context, string, string, string) (*campaignassurance.Run, error)
}

// FindingRemediator is the narrow campaign-domain mutation boundary. Its
// concrete implementation applies only a closed deterministic typed patch,
// creates an immutable revision, and makes the old run stale atomically.
type FindingRemediator interface {
	ApplyAssuranceFinding(context.Context, string, campaignartifact.ApplyAssuranceFindingInput) (*campaignartifact.ApplyAssuranceFindingResult, error)
}

// SnapshotPreparer is the server-owned boundary that freezes or loads an
// immutable revision, compiles its complete synthetic scenario set, and
// atomically materializes a ready send plan. Public clients may select an
// existing revision, but never supply compiler, policy, fixture, or artifact
// inputs.
type SnapshotPreparer interface {
	PrepareAssuranceSnapshot(context.Context, PrepareSnapshotCommand) (PreparedSnapshot, error)
}

// PlanLimiter reports whether a tenant may consume one more of a metered
// resource. It is the narrow view of limits.Enforcer this package needs, kept
// as an interface so the handler's metering decision is testable without a
// database — the decision is what matters here; the counting is proven in the
// limits package against real rows.
type PlanLimiter interface {
	Check(ctx context.Context, tenantID string, resource limits.Resource, increment int) error
}

type Deps struct {
	Service    AssuranceService
	Remediator FindingRemediator
	Preparer   SnapshotPreparer
	// Entitlements meters run creation. Reads are never metered. A nil value
	// makes CreateRun refuse rather than serve unmetered runs — see
	// requireEntitlements.
	Entitlements PlanLimiter
	Logger       *slog.Logger
}

// Mount registers the complete public surface. Production composition mounts
// it inside the existing tenant/auth/idempotency stack.
func Mount(r chi.Router, deps *Deps) {
	MountRead(r, deps)
	MountWrite(r, deps)
}

func MountRead(r chi.Router, deps *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(
		"/api/v1/campaigns/{id}/assurance", deps.Latest,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}", deps.Detail,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/manifest", deps.Manifest,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/evidence", deps.Evidence,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/events", deps.Events,
	)
}

func MountWrite(r chi.Router, deps *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(
		"/api/v1/campaigns/{id}/assurance-runs", deps.CreateRun,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/apply", deps.ApplyFinding,
	)
	// An allow-send appeal changes dispatch governance. Require both campaign
	// mutation and send authority; the repository additionally re-verifies the
	// current durable owner/admin role for the bound actor ID.
	appealGate := apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)
	r.With(appealGate).Post(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/overrides", deps.Appeal,
	)
	r.With(appealGate).Post(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/appeals", deps.Appeal,
	)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post(
		"/api/v1/campaigns/{id}/assurance-runs/{runID}/cancel", deps.Cancel,
	)
}

type createRunRequest struct {
	Profile           string   `json:"profile"`
	ContentRevisionID string   `json:"content_revision_id"`
	SendPlanID        string   `json:"send_plan_id"`
	RequestID         string   `json:"request_id"`
	IncludeSeedTest   bool     `json:"include_seed_test"`
	ObservedSurfaces  []string `json:"observed_surfaces"`
}

type appealRequest struct {
	RequestID string     `json:"request_id"`
	Decision  string     `json:"decision"`
	Reason    string     `json:"reason"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type applyFindingRequest struct {
	RequestID string `json:"request_id"`
}

type emptyRequest struct{}

type sourceClassDisclosure struct {
	Class   string `json:"class"`
	Present bool   `json:"present"`
	Meaning string `json:"meaning"`
}

type measurementDisclosure struct {
	Name           string                  `json:"name"`
	Interpretation string                  `json:"interpretation"`
	SourceClasses  []sourceClassDisclosure `json:"source_classes"`
}

type responseEnvelope struct {
	Measurement measurementDisclosure `json:"measurement"`
	Data        any                   `json:"data"`
}

type startRunResponse struct {
	RunID                   string `json:"run_id"`
	CampaignID              string `json:"campaign_id"`
	ContentRevisionID       string `json:"content_revision_id"`
	SendPlanID              string `json:"send_plan_id"`
	RequestID               string `json:"request_id"`
	Profile                 string `json:"profile"`
	State                   string `json:"state"`
	RequiredScenarioCount   int    `json:"required_scenario_count"`
	RequiredExtractionCount int    `json:"required_extraction_count"`
	StatusURL               string `json:"status_url"`
	EvidenceURL             string `json:"evidence_url"`
	EventsURL               string `json:"events_url"`
}

func (d *Deps) CreateRun(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, actorID, ok := writeIdentity(w, r, false, false)
	if !ok || !requireService(w, d) || !requireEntitlements(w, d) || !requireIdempotencyKey(w, r) {
		return
	}
	// Metered before anything expensive happens. Preparation compiles and
	// materialises the whole scenario set, so checking afterwards would still
	// spend the compute on a run the tenant is not allowed to start.
	if err := d.Entitlements.Check(r.Context(), tenantID, limits.ResourceAssuranceRuns, 1); err != nil {
		if limits.WriteExceeded(w, err) {
			return
		}
		d.writeError(w, r, err)
		return
	}
	var input createRunRequest
	if err := httpbody.DecodeJSON(w, r, createRunBodyMaxBytes, &input); err != nil {
		writeBodyError(w, err)
		return
	}
	requestID, valid := parseBodyUUID(w, input.RequestID, "request_id")
	if !valid {
		return
	}
	profile := strings.TrimSpace(input.Profile)
	switch profile {
	case campaignassurance.ProfileFast, campaignassurance.ProfileFull, campaignassurance.ProfileCalibration:
	default:
		httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_assurance_profile",
			"profile must be fast, full, or calibration")
		return
	}
	if input.ObservedSurfaces != nil && !input.IncludeSeedTest {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_observed_surfaces",
			"observed_surfaces may be selected only when include_seed_test is true")
		return
	}
	if _, valid = normalizeObservedSurfaces(input.ObservedSurfaces); !valid {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_observed_surfaces",
			"observed_surfaces must contain at most 32 unique stable surface identifiers of 1-128 ASCII characters")
		return
	}
	if input.IncludeSeedTest {
		writeControlledObservationUnavailable(w)
		return
	}
	contentRevisionID := strings.TrimSpace(input.ContentRevisionID)
	sendPlanID := strings.TrimSpace(input.SendPlanID)
	if sendPlanID != "" && contentRevisionID == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_assurance_snapshot",
			"send_plan_id requires its exact content_revision_id")
		return
	}
	if contentRevisionID != "" {
		if contentRevisionID, valid = parseBodyUUID(w, contentRevisionID, "content_revision_id"); !valid {
			return
		}
	}
	if sendPlanID != "" {
		if sendPlanID, valid = parseBodyUUID(w, sendPlanID, "send_plan_id"); !valid {
			return
		}
	} else {
		if d.Preparer == nil {
			d.writeError(w, r, ErrPreparationUnavailable)
			return
		}
		prepared, prepareErr := d.Preparer.PrepareAssuranceSnapshot(r.Context(), PrepareSnapshotCommand{
			TenantID: tenantID, CampaignID: campaignID, ContentRevisionID: contentRevisionID,
			RequestID: requestID, ActorID: actorID,
		})
		if prepareErr != nil {
			d.writeError(w, r, prepareErr)
			return
		}
		contentRevisionID, sendPlanID = prepared.ContentRevisionID, prepared.SendPlanID
		if _, err := uuid.Parse(contentRevisionID); err != nil {
			d.writeError(w, r, ErrPreparationUnavailable)
			return
		}
		if _, err := uuid.Parse(sendPlanID); err != nil {
			d.writeError(w, r, ErrPreparationUnavailable)
			return
		}
	}
	run, sourceClasses, err := d.Service.StartRun(r.Context(), StartRunCommand{
		TenantID: tenantID, CampaignID: campaignID, ContentRevisionID: contentRevisionID,
		SendPlanID: sendPlanID, RequestID: requestID, Profile: profile, ActorID: actorID,
	})
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	base := fmt.Sprintf("/api/v1/campaigns/%s/assurance-runs/%s", campaignID, run.ID)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Location", base)
	writeResponse(w, http.StatusAccepted, sourceClasses, startRunResponse{
		RunID: run.ID, CampaignID: run.CampaignID,
		ContentRevisionID: run.ContentRevisionID, SendPlanID: run.SendPlanID,
		RequestID: run.RequestID, Profile: run.Profile, State: run.State,
		RequiredScenarioCount:   run.RequiredScenarioCount,
		RequiredExtractionCount: run.RequiredExtractionCount,
		StatusURL:               base, EvidenceURL: base + "/evidence", EventsURL: base + "/events",
	})
}

func normalizeObservedSurfaces(values []string) ([]string, bool) {
	if len(values) > 32 {
		return nil, false
	}
	normalized := make([]string, len(values))
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		if value == "" || value != strings.TrimSpace(value) || len(value) > 128 || !utf8.ValidString(value) {
			return nil, false
		}
		for _, current := range value {
			valid := current >= 'a' && current <= 'z' || current >= 'A' && current <= 'Z' ||
				current >= '0' && current <= '9' || strings.ContainsRune("._:-", current)
			if !valid {
				return nil, false
			}
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, false
		}
		seen[value] = struct{}{}
		normalized[index] = value
	}
	return normalized, true
}

// writeControlledObservationUnavailable is a stable capability response, not
// an internal failure. It intentionally bypasses httperror.Write's blanket 5xx
// sanitizer so clients can distinguish an unconfigured controlled-client
// adapter from an ambiguous infrastructure error and never claim a seed test
// was included.
func writeControlledObservationUnavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":         "controlled_observation_unavailable",
			"message":      "controlled seed observation is not configured; retry without include_seed_test or after an adapter is enabled",
			"retryable":    false,
			"source_class": campaignassurance.SourceControlledObservation,
		},
	})
}

type applicability struct {
	ApplicableToFrozenSnapshot bool   `json:"applicable_to_frozen_snapshot"`
	Freshness                  string `json:"freshness"`
	Basis                      string `json:"basis"`
}

type latestResponse struct {
	Detail        *RunDetail    `json:"detail"`
	Applicability applicability `json:"applicability"`
}

func (d *Deps) Latest(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, _, _, ok := readIdentity(w, r, false, false)
	if !ok || !requireService(w, d) {
		return
	}
	detail, err := d.Service.Latest(r.Context(), tenantID, campaignID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	applicable := detail.Run.State != campaignassurance.StateStale && detail.Run.State != campaignassurance.StateCancelled
	freshness := "frozen_snapshot_current"
	if detail.Run.State == campaignassurance.StateStale {
		freshness = "stale"
	} else if detail.Run.State == campaignassurance.StateCancelled {
		freshness = "cancelled"
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeResponse(w, http.StatusOK, detail.SourceClasses, latestResponse{
		Detail: detail,
		Applicability: applicability{
			ApplicableToFrozenSnapshot: applicable, Freshness: freshness,
			Basis: "durable run state and exact frozen revision/plan/artifact identity; this does not compare against an unsaved mutable draft",
		},
	})
}

func (d *Deps) Detail(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, runID, _, ok := readIdentity(w, r, true, false)
	if !ok || !requireService(w, d) {
		return
	}
	detail, err := d.Service.Detail(r.Context(), tenantID, campaignID, runID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeResponse(w, http.StatusOK, detail.SourceClasses, detail)
}

func (d *Deps) Manifest(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, runID, _, ok := readIdentity(w, r, true, false)
	if !ok || !requireService(w, d) {
		return
	}
	detail, err := d.Service.Detail(r.Context(), tenantID, campaignID, runID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeResponse(w, http.StatusOK, detail.SourceClasses, detail.Manifest)
}

func (d *Deps) Evidence(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, runID, _, ok := readIdentity(w, r, true, false)
	if !ok || !requireService(w, d) {
		return
	}
	offset, limit, ok := evidencePageInput(w, r)
	if !ok {
		return
	}
	evidence, err := d.Service.Evidence(r.Context(), tenantID, campaignID, runID, offset, limit)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeResponse(w, http.StatusOK, evidence.SourceClasses, evidence)
}

func (d *Deps) Events(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, runID, _, ok := readIdentity(w, r, true, false)
	if !ok || !requireService(w, d) {
		return
	}
	progress, err := d.Service.Progress(r.Context(), tenantID, campaignID, runID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeResponse(w, http.StatusOK, progress.SourceClasses, progress)
}

// ApplyFinding creates an audited authoring revision from one exact
// deterministic typed patch. The caller must supply the strong ETag of the
// mutable campaign version they reviewed; weak, wildcard, and multi-value
// validators are deliberately rejected because they do not prevent lost edits.
func (d *Deps) ApplyFinding(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, actorID, ok := writeIdentity(w, r, true, true)
	if !ok || !requireRemediator(w, d) || !requireIdempotencyKey(w, r) {
		return
	}
	runID, valid := parsePathUUID(w, chi.URLParam(r, "runID"), "run_id")
	if !valid {
		return
	}
	findingID, valid := parsePathUUID(w, chi.URLParam(r, "findingID"), "finding_id")
	if !valid {
		return
	}
	ifMatch, ok := exactIfMatch(w, r)
	if !ok {
		return
	}
	var input applyFindingRequest
	if err := httpbody.DecodeJSON(w, r, applyBodyMaxBytes, &input); err != nil {
		writeBodyError(w, err)
		return
	}
	requestID, valid := parseBodyUUID(w, input.RequestID, "request_id")
	if !valid {
		return
	}
	result, err := d.Remediator.ApplyAssuranceFinding(r.Context(), tenantID,
		campaignartifact.ApplyAssuranceFindingInput{
			CampaignID: campaignID, RunID: runID, FindingID: findingID,
			RequestID: requestID, ActorID: actorID, IfMatchToken: ifMatch,
		})
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("ETag", result.CampaignETag)
	w.Header().Set("Location", fmt.Sprintf(
		"/api/v1/campaigns/%s/content-revisions/%s", campaignID, result.Revision.ID,
	))
	writeResponse(w, http.StatusCreated, []string{campaignassurance.SourceDeterministic}, result)
}

func (d *Deps) Appeal(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, actorID, ok := writeIdentity(w, r, true, true)
	if !ok || !requireService(w, d) || !requireIdempotencyKey(w, r) {
		return
	}
	runID, valid := parsePathUUID(w, chi.URLParam(r, "runID"), "run_id")
	if !valid {
		return
	}
	findingID, valid := parsePathUUID(w, chi.URLParam(r, "findingID"), "finding_id")
	if !valid {
		return
	}
	var input appealRequest
	if err := httpbody.DecodeJSON(w, r, appealBodyMaxBytes, &input); err != nil {
		writeBodyError(w, err)
		return
	}
	requestID, valid := parseBodyUUID(w, input.RequestID, "request_id")
	if !valid {
		return
	}
	decision := strings.TrimSpace(input.Decision)
	if decision != "allow_send" && decision != "reject" {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_appeal_decision",
			"decision must be allow_send or reject")
		return
	}
	override, err := d.Service.Appeal(r.Context(), AppealCommand{
		TenantID: tenantID, CampaignID: campaignID, RunID: runID,
		FindingID: findingID, RequestID: requestID, ActorID: actorID,
		Decision: decision, Reason: input.Reason, ExpiresAt: input.ExpiresAt,
	})
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeResponse(w, http.StatusOK, nil, override)
}

func (d *Deps) Cancel(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, _, ok := writeIdentity(w, r, true, false)
	if !ok || !requireService(w, d) || !requireIdempotencyKey(w, r) {
		return
	}
	runID, valid := parsePathUUID(w, chi.URLParam(r, "runID"), "run_id")
	if !valid {
		return
	}
	var input emptyRequest
	if err := httpbody.DecodeJSONWith(w, r, cancelBodyMaxBytes, &input, httpbody.Options{AllowEmptyBody: true}); err != nil {
		writeBodyError(w, err)
		return
	}
	run, err := d.Service.Cancel(r.Context(), tenantID, campaignID, runID)
	if err != nil {
		d.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeResponse(w, http.StatusOK, nil, run)
}

// NotEnabledCode is the stable code every Campaign Assurance route answers
// with when the deployment runs without the assurance runtime
// (POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME unset). It is a capability
// state, not a failure: retrying cannot help, and clients render it as
// "not available here" rather than as an error.
const NotEnabledCode = "campaign_assurance_not_enabled"

func requireService(w http.ResponseWriter, deps *Deps) bool {
	if deps != nil && deps.Service != nil {
		return true
	}
	writeNotEnabled(w)
	return false
}

func writeNotEnabled(w http.ResponseWriter) {
	httperror.WriteUnavailable(w, NotEnabledCode,
		"Campaign Assurance is not enabled on this deployment", false)
}

// requireEntitlements refuses rather than serving unmetered runs. A deployment
// that forgot to wire the meter would otherwise look healthy while every tenant
// spent model budget without a ceiling — the failure would surface as an
// invoice, not as an error.
func requireEntitlements(w http.ResponseWriter, deps *Deps) bool {
	if deps != nil && deps.Entitlements != nil {
		return true
	}
	httperror.WriteUnavailable(w, "campaign_assurance_metering_unavailable",
		"Campaign Assurance run metering is not configured on this deployment", false)
	return false
}

func requireRemediator(w http.ResponseWriter, deps *Deps) bool {
	if deps != nil && deps.Remediator != nil {
		return true
	}
	if deps == nil || deps.Service == nil {
		// Remediation is part of the assurance runtime; with the runtime off,
		// that is the whole answer.
		writeNotEnabled(w)
		return false
	}
	httperror.WriteUnavailable(w, "campaign_assurance_remediation_unavailable",
		"Campaign Assurance remediation is not configured on this deployment", false)
	return false
}

func exactIfMatch(w http.ResponseWriter, r *http.Request) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 || strings.TrimSpace(strings.Join(values, "")) == "" {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	if len(values) != 1 {
		httpcache.WritePreconditionFailed(w)
		return "", false
	}
	value := strings.TrimSpace(values[0])
	if value == "*" || strings.HasPrefix(value, "W/") || strings.Contains(value, ",") ||
		len(value) < 3 || len(value) > 512 || value[0] != '"' || value[len(value)-1] != '"' ||
		!utf8.ValidString(value) {
		httpcache.WritePreconditionFailed(w)
		return "", false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			httpcache.WritePreconditionFailed(w)
			return "", false
		}
	}
	return value, true
}

func readIdentity(w http.ResponseWriter, r *http.Request, requireRun, requireFinding bool) (tenantID, campaignID, runID, findingID string, ok bool) {
	tenant, found := middleware.TenantFromContext(r.Context())
	if !found || tenant == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context is required")
		return "", "", "", "", false
	}
	var valid bool
	tenantID, valid = canonicalContextUUID(tenant.ID)
	if !valid {
		httperror.Write(w, http.StatusUnauthorized, "invalid_tenant_context", "tenant context is invalid")
		return "", "", "", "", false
	}
	campaignID, valid = parsePathUUID(w, chi.URLParam(r, "id"), "campaign_id")
	if !valid {
		return "", "", "", "", false
	}
	if requireRun {
		runID, valid = parsePathUUID(w, chi.URLParam(r, "runID"), "run_id")
		if !valid {
			return "", "", "", "", false
		}
	}
	if requireFinding {
		findingID, valid = parsePathUUID(w, chi.URLParam(r, "findingID"), "finding_id")
		if !valid {
			return "", "", "", "", false
		}
	}
	return tenantID, campaignID, runID, findingID, true
}

func writeIdentity(w http.ResponseWriter, r *http.Request, requireRun, requireFinding bool) (tenantID, campaignID, actorID string, ok bool) {
	tenantID, campaignID, _, _, ok = readIdentity(w, r, requireRun, requireFinding)
	if !ok {
		return "", "", "", false
	}
	user, found := middleware.UserFromContext(r.Context())
	if !found || user == nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_principal",
			"an authenticated tenant-bound actor is required")
		return "", "", "", false
	}
	var valid bool
	actorID, valid = canonicalContextUUID(user.ID)
	if !valid {
		httperror.Write(w, http.StatusUnauthorized, "invalid_principal",
			"authenticated actor context is invalid")
		return "", "", "", false
	}
	userTenantID, valid := canonicalContextUUID(user.TenantID)
	if !valid || userTenantID != tenantID {
		httperror.Write(w, http.StatusUnauthorized, "principal_tenant_mismatch",
			"authenticated actor is not bound to the active tenant")
		return "", "", "", false
	}
	return tenantID, campaignID, actorID, true
}

func canonicalContextUUID(value string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	return parsed.String(), err == nil
}

func parsePathUUID(w http.ResponseWriter, value, name string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_"+name, strings.ReplaceAll(name, "_", " ")+" must be a UUID")
		return "", false
	}
	return parsed.String(), true
}

func parseBodyUUID(w http.ResponseWriter, value, name string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_"+name, strings.ReplaceAll(name, "_", " ")+" must be a UUID")
		return "", false
	}
	return parsed.String(), true
}

func requireIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) != 1 {
		httperror.Write(w, http.StatusBadRequest, "idempotency_key_required",
			"exactly one Idempotency-Key header is required")
		return false
	}
	value := strings.TrimSpace(values[0])
	if value == "" || len(value) > idempotency.MaxKeyLength || !utf8.ValidString(value) {
		httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key",
			"Idempotency-Key must be non-empty, valid UTF-8, and within the documented limit")
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key",
				"Idempotency-Key cannot contain control characters")
			return false
		}
	}
	return true
}

func evidencePageInput(w http.ResponseWriter, r *http.Request) (offset, limit int, ok bool) {
	limit = defaultEvidenceLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxEvidenceLimit {
			httperror.Write(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 200")
			return 0, 0, false
		}
		limit = parsed
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > maxEvidenceOffset {
			httperror.Write(w, http.StatusBadRequest, "invalid_offset", "offset must be between 0 and 100000")
			return 0, 0, false
		}
		offset = parsed
	}
	return offset, limit, true
}

func writeBodyError(w http.ResponseWriter, err error) {
	httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
}

func (d *Deps) writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, campaignassurance.ErrNotFound), errors.Is(err, campaignartifact.ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "assurance_not_found", "campaign assurance resource was not found")
	case errors.Is(err, campaignartifact.ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, campaignartifact.ErrPatchUnavailable):
		httperror.Write(w, http.StatusConflict, "assurance_patch_unavailable", "the finding has no server-applicable deterministic patch")
	case errors.Is(err, campaignartifact.ErrPatchUnsupported):
		httperror.Write(w, http.StatusUnprocessableEntity, "assurance_patch_unsupported", "the typed patch operation is not supported")
	case errors.Is(err, campaignartifact.ErrPatchAlreadyApplied):
		httperror.Write(w, http.StatusConflict, "assurance_patch_already_applied", "the finding patch was already applied to a campaign revision")
	case errors.Is(err, campaignartifact.ErrPatchNoop):
		httperror.Write(w, http.StatusConflict, "assurance_patch_no_change", "the typed patch would not change the campaign source")
	case errors.Is(err, campaignartifact.ErrRevisionStale):
		httperror.Write(w, http.StatusConflict, "assurance_revision_stale", "the campaign draft no longer matches the finding revision; run assurance again")
	case errors.Is(err, campaignartifact.ErrCampaignLocked):
		httperror.Write(w, http.StatusConflict, "campaign_edit_lease_held", "another editor currently holds the campaign editing lease")
	case errors.Is(err, campaignartifact.ErrCampaignDispatched):
		httperror.Write(w, http.StatusConflict, "campaign_dispatching", "campaign content cannot be changed after dispatch starts")
	case errors.Is(err, campaignartifact.ErrRunNotActionable):
		httperror.Write(w, http.StatusConflict, "assurance_run_not_actionable", "the assurance run is not in an actionable completed state")
	case errors.Is(err, campaignartifact.ErrUnauthorized):
		httperror.Write(w, http.StatusForbidden, "assurance_forbidden", "the authenticated actor cannot edit this campaign")
	case errors.Is(err, campaignartifact.ErrConcurrentMutation):
		w.Header().Set("Retry-After", "1")
		httperror.Write(w, http.StatusConflict, "assurance_concurrent_mutation", "the assurance patch could not be serialized; retry with the same identities")
	case errors.Is(err, campaignartifact.ErrIdempotencyConflict):
		httperror.Write(w, http.StatusConflict, "assurance_request_conflict", "request_id was already used with different immutable inputs")
	case errors.Is(err, campaignartifact.ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_assurance_patch", "the assurance patch request is invalid")
	case errors.Is(err, campaignartifact.ErrSourceIncomplete), errors.Is(err, ErrSnapshotUnsupported):
		httperror.Write(w, http.StatusUnprocessableEntity, "assurance_snapshot_unsupported", "the exact campaign revision cannot produce complete semantic scenario coverage")
	case errors.Is(err, campaignassurance.ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_assurance_request", "campaign assurance request is invalid")
	case errors.Is(err, campaignassurance.ErrIdempotencyConflict):
		httperror.Write(w, http.StatusConflict, "assurance_request_conflict", "request_id was already used with different frozen inputs")
	case errors.Is(err, campaignassurance.ErrRunInFlight):
		httperror.Write(w, http.StatusConflict, "assurance_run_in_flight", "a matching Predicted Agent Comprehension run is already active")
	case errors.Is(err, campaignassurance.ErrPlanNotReady):
		httperror.Write(w, http.StatusConflict, "assurance_plan_not_ready", "the exact frozen send plan is not ready for assurance")
	case errors.Is(err, campaignassurance.ErrSnapshotIncomplete):
		httperror.Write(w, http.StatusConflict, "assurance_snapshot_incomplete", "the immutable assurance snapshot is incomplete")
	case errors.Is(err, campaignassurance.ErrInvalidTransition):
		httperror.Write(w, http.StatusConflict, "assurance_state_conflict", "the assurance run cannot perform this transition")
	case errors.Is(err, campaignassurance.ErrUnauthorized):
		httperror.Write(w, http.StatusForbidden, "assurance_forbidden", "the authenticated actor cannot perform this assurance action")
	case errors.Is(err, campaignassurance.ErrOverrideNotAllowed):
		httperror.Write(w, http.StatusConflict, "assurance_appeal_not_allowed", "the finding is not eligible for this governed appeal")
	case errors.Is(err, campaignassurance.ErrConcurrentMutation):
		w.Header().Set("Retry-After", "1")
		httperror.Write(w, http.StatusConflict, "assurance_concurrent_mutation", "the assurance request could not be serialized; retry safely with the same identities")
	case errors.Is(err, ErrDispatchUnavailable), errors.Is(err, ErrServiceUnavailable), errors.Is(err, ErrPreparationUnavailable):
		w.Header().Set("Retry-After", "5")
		httperror.WriteUnavailable(w, "campaign_assurance_unavailable", "Predicted Agent Comprehension is temporarily unavailable; retry with the same request_id and Idempotency-Key", true)
	default:
		var logger *slog.Logger
		if d != nil {
			logger = d.Logger
		}
		httperror.WriteInternal(w, logger, err, r.Context())
	}
}

func writeResponse(w http.ResponseWriter, status int, presentSourceClasses []string, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(responseEnvelope{
		Measurement: disclosure(presentSourceClasses),
		Data:        data,
	})
}

func disclosure(present []string) measurementDisclosure {
	seen := make(map[string]struct{}, len(present))
	for _, value := range present {
		seen[value] = struct{}{}
	}
	definitions := []sourceClassDisclosure{
		{Class: campaignassurance.SourceDeterministic, Meaning: "versioned rule-based analysis of the exact frozen MIME artifact"},
		{Class: campaignassurance.SourceModeled, Meaning: "modeled prediction with recorded model and prompt provenance; not an inbox provider's actual summary"},
		{Class: campaignassurance.SourceControlledObservation, Meaning: "an observation from an explicitly named controlled seed environment; not universal provider behavior"},
	}
	for index := range definitions {
		_, definitions[index].Present = seen[definitions[index].Class]
	}
	return measurementDisclosure{
		Name:           "Predicted Agent Comprehension",
		Interpretation: "A versioned prediction and evidence receipt. It does not report how Gemini or any other inbox agent actually saw a stranger's email.",
		SourceClasses:  definitions,
	}
}
