// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface.
//
//	GET  /api/v1/inbox-reality/providers
//	POST /api/v1/inbox-reality/tests
//	GET  /api/v1/inbox-reality/tests
//	GET  /api/v1/inbox-reality/tests/{id}
//	POST /api/v1/inbox-reality/tests/{id}/cancel
//
// The pivot endpoint that the deliverability-service worker hits
// to record a classified message is mounted under an internal-only
// path; see MountInternal below.

package inboxreality

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"

	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxRequestBytes = 1 << 20 // 1 MiB; subject + HTML + text well within

// Deps bundles the handler dependencies.
type Deps struct {
	Orchestrator *Orchestrator
	Store        Store
	Seeds        SeedRegistry
	// ActiveSeedCount is used by FinalizeIfReady to decide "are we
	// done?". The deliverability service publishes this; the gateway
	// reads it via /providers (sum of SeedCount). 0 disables the
	// auto-complete and relies on expires_at instead.
	ActiveSeedCount int
	// Logger is used by httperror.WriteInternal to log internal
	// failures with request_id+tenant_id+err context. May be nil; in
	// that case the response is still written but nothing is logged.
	Logger *slog.Logger
	// Quota, when set, meters inbox-reality tests against the tenant's
	// deliverability entitlement. nil ⇒ unmetered (current behaviour).
	Quota QuotaMeter
	// InternalSigningSecrets authenticates exact dispatch/observation bodies
	// in addition to the service bearer-token middleware. CSV supports overlap
	// rotation. Empty always fails closed for the signed callback route.
	InternalSigningSecrets string
	Clock                  func() time.Time
}

// QuotaMeter consumes one unit of a metered deliverability resource for a
// tenant. allowed=false means the quota is exhausted (the caller should reply
// 402). A non-nil err is the caller's cue to fail open (don't block a paid
// feature on a transient metering failure).
type QuotaMeter interface {
	// Consume takes one unit. On refusal (allowed=false) it also returns the
	// ceiling the refusal was MEASURED AGAINST, read in the same transaction
	// that made the decision.
	//
	// Same transaction on purpose. Reading the allowance afterwards produced
	// denials that contradicted themselves: an admin raising the limit in
	// between yielded "monthly quota exhausted" reporting 1 of 10 used — and an
	// admin PUT is the very remedy such a denial names.
	//
	// A nil ceiling means the numbers are unknown (ungated tenant, or the read
	// failed). Callers must omit limit/current entirely rather than send a
	// sentinel.
	Consume(ctx context.Context, tenantID, resource string) (remaining int, allowed bool, ceiling *deliverability_control.Ceiling, err error)
}

// MountRoutes wires the customer-facing routes onto r.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/inbox-reality/providers", d.ListProviders)
	r.Post("/api/v1/inbox-reality/tests", d.CreateTest)
	r.Get("/api/v1/inbox-reality/tests", d.ListTests)
	r.Get("/api/v1/inbox-reality/tests/{id}", d.GetTest)
	r.Post("/api/v1/inbox-reality/tests/{id}/cancel", d.CancelTest)
}

// MountInternal wires the cross-tenant pivot endpoint. This is the
// route the deliverability service hits when its poller classifies
// a message tagged with a known token. Both routes are mounted behind the
// composition root's constant-time `Authorization: Bearer` internal-service
// guard. ObservationCallback additionally verifies an HMAC over the exact
// request body, method, path, observation key, and timestamp; the bearer is a
// perimeter credential, not a substitute for that signed-receipt contract.
// These handlers therefore do not duplicate the bearer comparison themselves.
func (d *Deps) MountInternal(r chi.Router) {
	r.Post("/api/internal/inbox-reality/pivot", d.PivotResult)
	r.Post(inboxrealitycontract.ObservationPath, d.ObservationCallback)
}

// ListProviders returns the static provider catalog. Public to any
// authenticated tenant — the catalog is the same for every tenant.
func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Seeds == nil {
		writeJSON(w, http.StatusOK, map[string]any{"providers": []ProviderInfo{}})
		return
	}
	out, err := d.Seeds.ProviderInfo(r.Context())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

// createTestRequest is the wire format.
type createTestRequest struct {
	Kind                  Kind                   `json:"kind"`
	Subject               string                 `json:"subject"`
	FromAddress           string                 `json:"from"`
	TTLSeconds            int                    `json:"ttlSeconds"`
	ArtifactID            string                 `json:"artifactId"`
	ScenarioID            string                 `json:"scenarioId"`
	RequestedCapabilities CapabilityRequirements `json:"requestedCapabilities"`
}

// CreateTest serves POST /api/v1/inbox-reality/tests.
func (d *Deps) CreateTest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Orchestrator == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "orchestrator_unavailable", "")
		return
	}
	var in createTestRequest
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	// Meter the test BEFORE the orchestrator fires seed mail, so a blocked test
	// never consumes provider resources. Fail open on a metering error.
	if d.Quota != nil {
		if _, allowed, ceiling, err := d.Quota.Consume(r.Context(), t.ID, "inbox_tests"); err != nil {
			if d.Logger != nil {
				d.Logger.Warn("inboxreality: quota meter error; allowing", "tenant_id", t.ID, "err", err.Error())
			}
		} else if !allowed {
			denial := entitlement.Denial{
				Subject:  "inbox_tests",
				Reason:   entitlement.ReasonPlan,
				Resource: "inbox_tests",
				// A distinct code, NOT plan_limit_exceeded. Nothing in this repo
				// raises these ceilings on a plan change — the only writer of
				// `deliverability_entitlements` limits is the tenant-admin PUT —
				// and reusing the plan-ceiling code routed the denial into
				// apps/web's "Upgrade your plan" copy, so the server withheld the
				// upgrade claim while the client asserted it from the code string.
				Code:    "deliverability_allowance_exhausted",
				Message: "monthly inbox-test quota exhausted",
				Remedy:  entitlement.RemedyContactWorkspaceAdmin,
			}
			// The numbers ONLY when the refusal actually measured them. A nil
			// ceiling means ungated or unreadable, and a sentinel would be worse
			// than omission: `-1` is a number to a client, and `limit - current`
			// renders it as a plausible zero.
			if ceiling != nil {
				limit, current := int64(ceiling.Limit), int64(ceiling.Used)
				denial.Limit, denial.Current, denial.Tier = &limit, &current, ceiling.Tier
			}
			entitlement.Write(w, denial)
			return
		}
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	exactRequested := in.ArtifactID != "" || in.ScenarioID != "" || in.Kind == KindCampaignAssurance
	if exactRequested && idempotencyKey == "" {
		writeJSONErr(w, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key is required for an exact-artifact test")
		return
	}
	if exactRequested && d.Orchestrator.Lifecycle == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "exact_lifecycle_unavailable", "")
		return
	}
	out, err := d.Orchestrator.CreateTest(r.Context(), t.ID, CreateTestInput{
		Kind:        in.Kind,
		Subject:     in.Subject,
		FromAddress: in.FromAddress,
		// Convert seconds → duration, clamping at the orchestrator's
		// own validator (1h).
		TTL:        secondsToDuration(in.TTLSeconds),
		ArtifactID: in.ArtifactID, ScenarioID: in.ScenarioID,
		IdempotencyKey: idempotencyKey, RequestedCapabilities: in.RequestedCapabilities,
	})
	if err != nil {
		if errors.Is(err, ErrIdempotencyConflict) {
			writeJSONErr(w, http.StatusConflict, "idempotency_conflict", "")
			return
		}
		if errors.Is(err, ErrArtifactUnavailable) || errors.Is(err, ErrInvalidLifecycle) {
			writeJSONErr(w, http.StatusUnprocessableEntity, "exact_artifact_unavailable", "")
			return
		}
		if errors.Is(err, ErrNoActiveSeeds) {
			writeJSONErr(w, http.StatusServiceUnavailable, "no_active_controlled_seeds", "")
			return
		}
		// Orchestrator.CreateTest mixes validator errors with underlying
		// store/DB failures; none are typed sentinels with caller-safe
		// text, so route through WriteInternal (logs err, opaque 500).
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// ListTests serves GET /api/v1/inbox-reality/tests?limit=50
func (d *Deps) ListTests(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "store_unavailable", "")
		return
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	out, err := d.Store.ListTests(r.Context(), t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// GetTest serves GET /api/v1/inbox-reality/tests/{id}.
func (d *Deps) GetTest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "store_unavailable", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	// FinalizeIfReady advances status if the test is done (or
	// expired). It's a read-modify-write but with conditional UPDATE,
	// so concurrent readers all converge to the same final state.
	var test Test
	if d.Orchestrator != nil {
		t2, err := d.Orchestrator.FinalizeIfReady(r.Context(), t.ID, id, d.ActiveSeedCount)
		if err == nil {
			test = t2
		}
	}
	if test.ID == "" {
		got, err := d.Store.GetTest(r.Context(), t.ID, id)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeJSONErr(w, http.StatusNotFound, "test_not_found", "")
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		test = got
	}
	results, err := d.Store.ListResults(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	view := TestView{
		Test:    test,
		Results: results,
		Summary: SummariseResults(results),
	}
	if test.ArtifactID != "" && d.Orchestrator != nil && d.Orchestrator.Lifecycle != nil {
		if dispatch, dispatchErr := d.Orchestrator.Lifecycle.GetDispatch(r.Context(), t.ID, id); dispatchErr == nil {
			view.Dispatch = &dispatch
		}
	}
	writeJSON(w, http.StatusOK, view)
}

// CancelTest stops a queued/retrying exact test. A provider acceptance that
// already happened cannot be recalled; any such controlled observation stays
// as evidence while the public lifecycle remains cancelled.
func (d *Deps) CancelTest(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Orchestrator == nil || d.Orchestrator.Lifecycle == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "lifecycle_unavailable", "")
		return
	}
	now := time.Now().UTC()
	if d.Clock != nil {
		now = d.Clock().UTC()
	}
	if err := d.Orchestrator.Lifecycle.CancelTest(r.Context(), tenant.ID, chi.URLParam(r, "id"), now); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONErr(w, http.StatusNotFound, "test_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ObservationCallback accepts only a signed sanitized receipt. Raw RFC-822,
// seed addresses, selected headers, and modeled/provider UI summaries are not
// members of this contract.
func (d *Deps) ObservationCallback(w http.ResponseWriter, r *http.Request) {
	if d.Orchestrator == nil || d.Orchestrator.Lifecycle == nil || strings.TrimSpace(d.InternalSigningSecrets) == "" {
		writeJSONErr(w, http.StatusServiceUnavailable, "observation_callback_unavailable", "")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, maxRequestBytes)
	if err != nil {
		writeJSONErr(w, http.StatusRequestEntityTooLarge, "body_too_large", "")
		return
	}
	now := time.Now().UTC()
	if d.Clock != nil {
		now = d.Clock().UTC()
	}
	if err := internalsign.Verify(d.InternalSigningSecrets, r.Method, r.URL.EscapedPath(), body,
		internalsign.FromHTTP(r.Header), now, 0); err != nil {
		writeJSONErr(w, http.StatusUnauthorized, "invalid_internal_signature", "")
		return
	}
	var receipt ObservationReceipt
	if err := httpbody.DecodeJSONValue(body, &receipt, httpbody.Options{}); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_observation", "")
		return
	}
	if strings.TrimSpace(internalsign.FromHTTP(r.Header).RequestID) != receipt.ObservationKey {
		writeJSONErr(w, http.StatusConflict, "observation_identity_conflict", "")
		return
	}
	result, err := d.Orchestrator.Lifecycle.RecordObservation(r.Context(), receipt)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONErr(w, http.StatusNotFound, "test_not_found", "")
			return
		}
		if errors.Is(err, ErrInvalidLifecycle) {
			writeJSONErr(w, http.StatusUnprocessableEntity, "observation_identity_mismatch", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// pivotRequest is what the deliverability service POSTs to the
// internal pivot endpoint.
type pivotRequest struct {
	HeaderToken string          `json:"headerToken"`
	MailboxID   string          `json:"mailboxId"`
	Provider    Provider        `json:"provider"`
	Folder      string          `json:"folder"`
	Labels      []string        `json:"labels"`
	Headers     json.RawMessage `json:"headers"`
}

// PivotResult is the internal endpoint the deliverability service
// hits after its categorizer classifies a tagged message. Validates
// inputs, looks up the test by token, applies our classifier (defence
// in depth — the service classifies on its side, we re-classify on
// ours so a bug in either layer can't quietly mis-route a result),
// records the row.
func (d *Deps) PivotResult(w http.ResponseWriter, r *http.Request) {
	if d.Store == nil || d.Orchestrator == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "pivot_unavailable", "")
		return
	}
	var in pivotRequest
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if in.HeaderToken == "" || in.MailboxID == "" || in.Provider == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_fields", "headerToken, mailboxId, provider required")
		return
	}
	if !in.Provider.IsKnown() {
		writeJSONErr(w, http.StatusBadRequest, "unknown_provider", string(in.Provider))
		return
	}
	token := ParseHeaderValue(in.HeaderToken)
	test, err := d.Store.FindTestByToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONErr(w, http.StatusNotFound, "token_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Defence in depth: classify here from the folder/labels/headers
	// the service gave us. The result may differ from what the
	// service stored locally if our taxonomy has diverged; we record
	// our own canonical placement in our table.
	placement := Classify(in.Provider, Message{
		Folder:  in.Folder,
		Labels:  in.Labels,
		Headers: nil, // not used by the current Classify rules
	})
	rec, err := d.Orchestrator.RecordResult(r.Context(), RecordResultParams{
		TestID:     test.ID,
		MailboxID:  in.MailboxID,
		Provider:   in.Provider,
		Placement:  placement,
		FolderName: in.Folder,
		RawHeaders: []byte(in.Headers),
	}, d.ActiveSeedCount)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// --- helpers ---

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// secondsToDuration converts the wire-format `ttlSeconds` into a
// time.Duration. Non-positive input → 0 (the orchestrator's default
// kicks in). Clamping at 1h is done by the orchestrator.
func secondsToDuration(seconds int) time.Duration {
	if seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}
