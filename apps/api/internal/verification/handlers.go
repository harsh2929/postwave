// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — the tenant-facing HTTP surface.
//
//	POST   /api/v1/verification/verify                single address
//	POST   /api/v1/verification/verify-batch          synchronous, <= MaxSynchronousBatch
//	GET    /api/v1/verification/health                one derived recipient grade
//	POST   /api/v1/verification/health/batch          derived grades, <= MaxBatch
//	POST   /api/v1/verification/jobs                  async bulk run
//	GET    /api/v1/verification/jobs                  recent jobs
//	GET    /api/v1/verification/jobs/{id}             one job + status summary
//	GET    /api/v1/verification/jobs/{id}/results     per-address page
//	POST   /api/v1/verification/jobs/{id}/cancel      stop a running job
//	GET    /api/v1/verification/providers             configured vendors
//	PUT    /api/v1/verification/providers/{provider}  configure a vendor
//	DELETE /api/v1/verification/providers/{provider}  remove a vendor
//	GET    /api/v1/verification/credits               balance + savings
//	GET    /api/v1/verification/cache                 cache summary
//	DELETE /api/v1/verification/cache                 force re-check
//
// Scope split:
//
//   - Health and stored-result reads require read:subscribers — the caller is
//     asking about their own audience.
//   - Anything that can SPEND CREDITS (single checks, batches, and jobs)
//     requires write:subscribers. Spending money is a write, whatever the HTTP
//     verb says.
//   - Provider configuration requires admin, because the credential
//     ref points at a billable key.

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

// Deps wires the HTTP surface.
type Deps struct {
	Store  *Store
	Logger *slog.Logger
	Runner *Runner
	// Health substitutes the database-backed derived health reader in tests or
	// specialized compositions. Nil uses Store through the default reader.
	Health HealthReadService
	// BulkJobCreationEnabled is an explicit release capability, not a
	// deduction from Runner/Store availability. Production enables it only
	// after durable leases/idempotency are migrated and retains a kill-switch.
	BulkJobCreationEnabled bool

	// recordUsageOverride is a package-local fault-injection seam. Production
	// always persists through Store.RecordUsage.
	recordUsageOverride func(context.Context, string, string, ChainStats) error
}

const (
	safeProviderHealthError = "The provider connection check failed."
	safeJobFailure          = "The verification run failed before it could complete."
)

var verificationBulkRuntime = runtimecapability.Unavailable(
	"verification_bulk_jobs",
	"verification_bulk_unavailable",
	"Async bulk verification is temporarily unavailable.",
)

// Provider and worker errors may include secret references, upstream URLs,
// response fragments, or database detail. Keep the raw value in server-side
// evidence, but expose only a stable operator-safe status at the HTTP boundary.
func publicProviderConfig(cfg ProviderConfig) ProviderConfig {
	if cfg.LastError != "" {
		cfg.LastError = safeProviderHealthError
	}
	return cfg
}

func publicProviderConfigs(configs []ProviderConfig) []ProviderConfig {
	out := make([]ProviderConfig, len(configs))
	for i, cfg := range configs {
		out[i] = publicProviderConfig(cfg)
	}
	return out
}

func publicJob(job Job) Job {
	if len(job.SourceRef) > maxJobSourceRefBytes || hasUnsafeControlText(job.SourceRef) {
		// A malformed legacy source handle is optional response metadata. Omit it
		// rather than reflecting controls/bidi/private-use text to an operator.
		job.SourceRef = ""
	}
	if job.Error != "" {
		job.Error = safeJobFailure
	}
	return job
}

func publicJobs(jobs []Job) []Job {
	out := make([]Job, len(jobs))
	for i, job := range jobs {
		out[i] = publicJob(job)
	}
	return out
}

func jobIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		httperror.WriteValidation(w, "invalid_job_id", "Verification job id must be a UUID.")
		return "", false
	}
	return id, true
}

// MountRoutes registers the surface. A nil Store disables it entirely
// rather than mounting handlers that would nil-panic on first call.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Store == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)

	r.With(write).Post("/api/v1/verification/verify", d.verifyOne)
	r.With(write).Post("/api/v1/verification/verify-batch", d.verifyBatch)
	r.With(read).Get("/api/v1/verification/health", d.getHealth)
	r.With(read).Post("/api/v1/verification/health/batch", d.healthBatch)

	r.With(write).Post("/api/v1/verification/jobs", d.createJob)
	r.With(read).Get("/api/v1/verification/jobs", d.listJobs)
	r.With(read).Get("/api/v1/verification/jobs/{id}", d.getJob)
	r.With(read).Get("/api/v1/verification/jobs/{id}/results", d.jobResults)
	r.With(write).Post("/api/v1/verification/jobs/{id}/cancel", d.cancelJob)

	r.With(admin).Get("/api/v1/verification/providers", d.listProviders)
	r.With(admin).Put("/api/v1/verification/providers/{provider}", d.putProvider)
	r.With(admin).Delete("/api/v1/verification/providers/{provider}", d.deleteProvider)

	r.With(admin).Get("/api/v1/verification/policy", d.getPolicy)
	r.With(admin).Put("/api/v1/verification/policy", d.putPolicy)

	r.With(read).Get("/api/v1/verification/credits", d.credits)
	r.With(read).Get("/api/v1/verification/cache", d.cacheSummary)
	r.With(write).Delete("/api/v1/verification/cache", d.invalidateCache)
}

func (d *Deps) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return "", false
	}
	return t.ID, true
}

// writeProviderError maps the package's typed errors onto status
// codes. Credit exhaustion in particular must not read as a 500: it is
// an actionable billing state, and paging an on-call engineer for it
// would be wrong.
func (d *Deps) writeProviderError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrProviderPartialOutcome):
		// An upstream call crossed the billable boundary, but its complete result
		// is unknown. This is a deterministic conflict, not a retryable gateway
		// failure: the shared idempotency middleware persists 4xx responses, so
		// the same key cannot invoke the provider a second time and double-charge.
		httperror.Write(w, http.StatusConflict, "verification_provider_outcome_ambiguous",
			"Some provider requests may have completed before the batch failed. The batch was not retried to avoid duplicate charges.")
	case errors.Is(err, ErrNoCredits):
		writeNoCreditsDenial(w)
	case errors.Is(err, ErrProviderAccountRejected):
		httperror.Write(w, http.StatusPreconditionFailed, "verification_provider_account_rejected",
			"The verification provider rejected the configured account. Check both the API key and available credits.")
	case errors.Is(err, ErrUnauthorized):
		// 412, not 502. The provider rejected the workspace's OWN configured key
		// — a customer-fixable configuration state, in the same class as
		// ErrNotConfigured below. 5xx is precisely what this file's comment above
		// argues must not happen for an actionable state: it pages an on-call
		// engineer for a credential only the tenant can rotate.
		httperror.Write(w, http.StatusPreconditionFailed, "verification_provider_unauthorized",
			"The verification provider rejected the configured API key. Update it in workspace settings.")
	case errors.Is(err, ErrNotConfigured):
		httperror.Write(w, http.StatusPreconditionFailed, "verification_not_configured",
			"No verification provider is configured for this workspace.")
	case errors.Is(err, ErrProviderUnavailable):
		httperror.Write(w, http.StatusBadGateway, "verification_provider_unavailable",
			"The verification provider could not be reached.")
	case errors.Is(err, ErrBatchTooLarge):
		httperror.WriteValidation(w, "batch_too_large",
			"Batch exceeds "+strconv.Itoa(MaxBatch)+" addresses; use an async job instead.")
	case errors.Is(err, ErrJobNotFound):
		httperror.Write(w, http.StatusNotFound, "job_not_found", "Verification job not found.")
	case errors.Is(err, ErrUsagePersistence):
		// Verification may already have spent a provider credit, while the daily
		// accounting write has an unknown outcome. A 409 is retained by the shared
		// idempotency ledger and prevents the exact request from executing again.
		httperror.Write(w, http.StatusConflict, "verification_usage_outcome_ambiguous",
			"Verification completed, but its usage record could not be confirmed. This request was not retried to avoid duplicate accounting or provider charges.")
	default:
		d.writeVerificationInternal(w, r, err)
	}
}

// --- address checks ---

type verifyOneRequest struct {
	Email string `json:"email"`
}

// requireBillableIdempotencyKey keeps every synchronous provider boundary on
// the shared 24-hour HTTP idempotency ledger mounted by main. The handler also
// validates the contract itself so alternate compositions cannot accidentally
// execute billable work without a replay key.
func requireBillableIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values("Idempotency-Key")
	if len(values) != 1 {
		httperror.WriteValidation(w, "idempotency_key_required",
			"Exactly one Idempotency-Key is required so retries cannot repeat billable verification work.")
		return false
	}
	if _, err := normalizeJobIdempotencyKey(values[0]); err != nil {
		httperror.WriteValidation(w, "invalid_idempotency_key",
			"Idempotency-Key must be one printable value of 1-255 UTF-8 bytes.")
		return false
	}
	return true
}

// verifyWithDispatchSafety remembers whether execution crossed the vendor
// boundary. Once it has, every error except an explicit pre-charge rejection
// is ambiguous: a timeout, malformed response, or connection reset can arrive
// after the provider accepted the request. Marking it partial makes the HTTP
// boundary return a replayable 409 rather than a retryable 5xx.
func verifyWithDispatchSafety(
	ctx context.Context,
	chain *Chain,
	emails []string,
) ([]Result, ChainStats, error) {
	// An explicit HTTP verification is a billable operation. Never replace a
	// post-dispatch provider error with a local unknown even when the tenant's
	// general interactive setting permits degradation: that would conceal both
	// the uncertain charge and the need to retain the replay key.
	strict := *chain
	strict.DegradeOnVendorFailure = false
	dispatched := false
	results, stats, err := strict.VerifyBatchWithDispatchHook(ctx, emails,
		func(context.Context, []string) error {
			dispatched = true
			return nil
		})
	if err == nil || !dispatched || errors.Is(err, ErrProviderPartialOutcome) {
		return results, stats, err
	}
	// These provider responses explicitly reject the work before charging it.
	// All other post-dispatch failures are conservatively indeterminate.
	if isExplicitUnbilledProviderRejection(err) {
		return results, stats, err
	}
	return nil, stats, errors.Join(ErrProviderPartialOutcome, err)
}

func (d *Deps) verifyOne(w http.ResponseWriter, r *http.Request) {
	// Verification responses now embed recipient health, including tenant-only
	// consent and engagement evidence. Apply the same cache boundary as the
	// dedicated health endpoints before any early return can write a response.
	noStoreHealth(w)
	r, cancel := withSynchronousVerificationTimeout(r)
	defer cancel()
	if !requireBillableIdempotencyKey(w, r) {
		return
	}
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var body verifyOneRequest
	if err := httpbody.DecodeJSONWith(w, r, 4<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if strings.TrimSpace(body.Email) == "" {
		httperror.WriteValidation(w, "email_required", "An email address is required.")
		return
	}
	if err := validateSynchronousVerifyEmails([]string{body.Email}); err != nil {
		httperror.WriteValidation(w, "invalid_email_input", err.Error())
		return
	}

	chain, err := d.Store.BuildChain(r.Context(), tenantID)
	if err != nil {
		d.writeProviderError(w, r, err)
		return
	}
	results, stats, err := verifyWithDispatchSafety(r.Context(), chain, []string{body.Email})
	if err != nil {
		d.Store.RecordProviderError(r.Context(), tenantID, chain.Name(), err)
		d.writeProviderError(w, r, err)
		return
	}
	if len(results) != 1 {
		d.writeProviderError(w, r, ErrProviderPartialOutcome)
		return
	}
	if err := d.recordUsage(r.Context(), tenantID, chain.Name(), stats); err != nil {
		d.observeUsagePersistenceFailure("sync", tenantID)
		d.writeProviderError(w, r, ErrUsagePersistence)
		return
	}
	result := results[0]
	result = d.attachHealth(r.Context(), tenantID, []Result{result})[0]
	writeJSON(w, http.StatusOK, result)
}

type verifyBatchRequest struct {
	Emails []string `json:"emails"`
}

func (d *Deps) verifyBatch(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	r, cancel := withSynchronousVerificationTimeout(r)
	defer cancel()
	if !requireBillableIdempotencyKey(w, r) {
		return
	}
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var body verifyBatchRequest
	if err := httpbody.DecodeJSONWith(w, r, 1<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if len(body.Emails) == 0 {
		httperror.WriteValidation(w, "emails_required", "At least one email address is required.")
		return
	}
	if len(body.Emails) > MaxSynchronousBatch {
		httperror.WriteValidation(w, "batch_too_large",
			"Synchronous verification accepts at most "+strconv.Itoa(MaxSynchronousBatch)+" addresses; create a durable async job instead.")
		return
	}
	if err := validateSynchronousVerifyEmails(body.Emails); err != nil {
		httperror.WriteValidation(w, "invalid_email_input", err.Error())
		return
	}

	chain, err := d.Store.BuildChain(r.Context(), tenantID)
	if err != nil {
		d.writeProviderError(w, r, err)
		return
	}
	results, stats, err := verifyWithDispatchSafety(r.Context(), chain, body.Emails)
	if err != nil {
		d.Store.RecordProviderError(r.Context(), tenantID, chain.Name(), err)
		d.writeProviderError(w, r, err)
		return
	}
	if err := d.recordUsage(r.Context(), tenantID, chain.Name(), stats); err != nil {
		d.observeUsagePersistenceFailure("sync", tenantID)
		d.writeProviderError(w, r, ErrUsagePersistence)
		return
	}
	results = d.attachHealth(r.Context(), tenantID, results)

	writeJSON(w, http.StatusOK, map[string]any{
		"results":        results,
		"summary":        summarize(results),
		"health_summary": summarizeResultHealth(results),
		"usage": map[string]any{
			"total":           stats.Total,
			"cache_hits":      stats.CacheHits,
			"local_filtered":  stats.LocalFiltered,
			"vendor_verified": stats.VendorVerified,
			"credits_spent":   stats.CreditsSpent,
			"duplicates":      stats.Duplicates,
			"credits_saved":   stats.SavedCredits(),
			"savings_ratio":   stats.SavingsRatio(),
		},
	})
}

func withSynchronousVerificationTimeout(r *http.Request) (*http.Request, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(r.Context(), SynchronousRequestTimeout)
	return r.WithContext(ctx), cancel
}

func (d *Deps) recordUsage(ctx context.Context, tenantID, provider string, stats ChainStats) error {
	if d.recordUsageOverride != nil {
		return d.recordUsageOverride(ctx, tenantID, provider, stats)
	}
	return d.Store.RecordUsage(ctx, tenantID, provider, stats)
}

func (d *Deps) observeUsagePersistenceFailure(surface, tenantID string) {
	observeVerificationUsagePersistenceFailure(surface)
	if d.Logger != nil {
		// Deliberately omit the raw storage error: driver/SQL failures can contain
		// addresses or tenant-scoped infrastructure detail.
		d.Logger.Error("verification: usage accounting persistence failed",
			"surface", surface, "tenant_id", tenantID)
	}
}

// validateSynchronousVerifyEmails rejects raw transport controls before the
// chain trims/canonicalizes addresses. Without this boundary, trailing VT/FF
// or C1 controls could disappear during normalization and turn malformed API
// input into a paid provider request. Syntax itself remains a verification
// verdict; this helper only enforces the bounded, single-line wire contract.
func validateSynchronousVerifyEmails(emails []string) error {
	for _, raw := range emails {
		if hasUnsafeControlText(raw) || len(strings.TrimSpace(raw)) > maxJobEmailBytes {
			return errors.New("Every email must be at most 320 characters with no control characters.")
		}
	}
	return nil
}

func (d *Deps) attachHealth(ctx context.Context, tenantID string, results []Result) []Result {
	if len(results) == 0 {
		return results
	}
	emails := make([]string, 0, len(results))
	for _, result := range results {
		emails = append(emails, result.Email)
	}
	health, err := d.healthReader().Resolve(ctx, tenantID, emails)
	if err == nil && len(health) == len(dedupeNormalized(emails)) {
		return AttachHealth(results, health)
	}
	if d.Logger != nil {
		d.Logger.Error("verification: recipient health evidence unavailable after verification",
			"tenant_id", tenantID, "result_count", len(results),
			"cause", safeHealthAttachmentFailureClass(err))
	}
	observeVerificationHealthUnavailable(len(results))
	now := time.Now().UTC()
	for i := range results {
		fallback := UnavailableEmailHealth(results[i].Email, results[i], now)
		results[i].Health = &fallback
	}
	return results
}

// Raw database and constraint errors can include the address or rejected row.
// Reduce the attachment failure to a closed diagnostic class before logging;
// the HTTP response already carries an explicit fail-closed U health result.
func safeHealthAttachmentFailureClass(err error) string {
	switch {
	case err == nil:
		return "incomplete_result"
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	default:
		return "evidence_read_failed"
	}
}

func summarizeResultHealth(results []Result) map[string]int {
	out := map[string]int{"A": 0, "B": 0, "C": 0, "D": 0, "F": 0, "U": 0}
	for _, result := range results {
		if result.Health != nil {
			out[string(result.Health.Grade)]++
		}
	}
	return out
}

// summarize counts a result slice by status, so the caller does not
// have to fold it client-side.
func summarize(results []Result) map[string]int {
	out := map[string]int{}
	for _, r := range results {
		out[string(r.Status)]++
	}
	return out
}

// --- jobs ---

type createJobRequest struct {
	Source    string   `json:"source"`
	SourceRef string   `json:"source_ref,omitempty"`
	Emails    []string `json:"emails,omitempty"`
}

const (
	maxJobSourceRefBytes = 512
	maxJobEmailBytes     = 320
)

func validateCreateJobInput(source string, body createJobRequest) (string, error) {
	if hasUnsafeControlText(body.SourceRef) {
		return "", errors.New("verification: source_ref must be a single line of at most 512 characters")
	}
	sourceRef := strings.TrimSpace(body.SourceRef)
	if len(sourceRef) > maxJobSourceRefBytes {
		return "", errors.New("verification: source_ref must be a single line of at most 512 characters")
	}
	if len(body.Emails) > MaxJobAddresses {
		return "", fmt.Errorf("verification: address count exceeds the %d per-job limit", MaxJobAddresses)
	}
	for _, raw := range body.Emails {
		if hasUnsafeControlText(raw) {
			return "", errors.New("verification: every address must be at most 320 characters with no control characters")
		}
		trimmed := strings.TrimSpace(raw)
		if len(trimmed) > maxJobEmailBytes {
			return "", errors.New("verification: every address must be at most 320 characters with no control characters")
		}
	}

	switch source {
	case JobSourceInline, JobSourceUpload:
		if len(body.Emails) == 0 {
			return "", errors.New("verification: this source requires at least one address")
		}
	case JobSourceTag:
		if sourceRef == "" {
			return "", errors.New("verification: a tag job requires source_ref")
		}
		if len(body.Emails) > 0 {
			return "", errors.New("verification: a tag job cannot also include inline addresses")
		}
	case JobSourceAllSubscribers:
		if sourceRef != "" || len(body.Emails) > 0 {
			return "", errors.New("verification: an all-subscribers job cannot include a source_ref or inline addresses")
		}
	}
	return sourceRef, nil
}

func normalizeCreateJobSource(raw string) (string, error) {
	if hasUnsafeControlText(raw) {
		return "", errors.New("verification: source must not contain control characters")
	}
	source := strings.TrimSpace(raw)
	if source == "" {
		source = JobSourceInline
	}
	if err := ValidateJobSource(source); err != nil {
		return "", err
	}
	return source, nil
}

func (d *Deps) createJob(w http.ResponseWriter, r *http.Request) {
	// This capability gate is deliberately first: disabled requests must not
	// read an attacker-controlled body, resolve tenant/provider state, seed a
	// database job, or create billable work. A composed Runner does not enable
	// the endpoint.
	if !d.BulkJobCreationEnabled {
		runtimecapability.WriteUnavailable(w, verificationBulkRuntime)
		return
	}
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	if !requireBillableIdempotencyKey(w, r) {
		return
	}
	idempotencyKey, _ := normalizeJobIdempotencyKey(r.Header.Values("Idempotency-Key")[0])
	var body createJobRequest
	if err := httpbody.DecodeJSONWith(w, r, 8<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	source, err := normalizeCreateJobSource(body.Source)
	if err != nil {
		httperror.WriteValidation(w, "unsupported_source", err.Error())
		return
	}
	sourceRef, err := validateCreateJobInput(source, body)
	if err != nil {
		httperror.WriteValidation(w, "invalid_job", err.Error())
		return
	}

	var createdBy *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u.ID != "" {
		id := u.ID
		createdBy = &id
	}

	job, err := d.Store.CreateJob(r.Context(), tenantID, JobSpec{
		Source:         source,
		SourceRef:      sourceRef,
		Emails:         body.Emails,
		CreatedBy:      createdBy,
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			d.writeProviderError(w, r, err)
			return
		}
		if errors.Is(err, ErrJobIdempotencyConflict) {
			httperror.Write(w, http.StatusUnprocessableEntity,
				"idempotency_key_request_mismatch",
				"This Idempotency-Key was already used with a different verification request. Use a fresh key.")
			return
		}
		// Address-resolution problems are the caller's input, not a
		// server fault.
		if strings.Contains(err.Error(), "resolved to no addresses") ||
			strings.Contains(err.Error(), "requires source_ref") ||
			strings.Contains(err.Error(), "per-job limit") ||
			strings.Contains(err.Error(), "unsupported job source") {
			httperror.WriteValidation(w, "invalid_job", err.Error())
			return
		}
		d.writeVerificationInternal(w, r, err)
		return
	}

	writeJSON(w, http.StatusAccepted, publicJob(*job))
}

func (d *Deps) listJobs(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	jobs, err := d.Store.ListJobs(r.Context(), tenantID, limit)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": publicJobs(jobs)})
}

func (d *Deps) getJob(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	jobID, valid := jobIDParam(w, r)
	if !valid {
		return
	}
	job, err := d.Store.GetJob(r.Context(), tenantID, jobID)
	if err != nil {
		d.writeProviderError(w, r, err)
		return
	}
	summary, err := d.Store.JobSummary(r.Context(), tenantID, jobID)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":           publicJob(*job),
		"summary":       summary,
		"credits_saved": job.SavedCredits(),
		"credits_spent": job.CreditsSpent,
		"is_terminal":   job.Status == JobStatusCompleted || job.Status == JobStatusFailed || job.Status == JobStatusCanceled,
	})
}

func (d *Deps) jobResults(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	jobID, valid := jobIDParam(w, r)
	if !valid {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	var statuses []string
	if raw := strings.TrimSpace(q.Get("status")); raw != "" {
		for _, s := range strings.Split(raw, ",") {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if !Status(s).Valid() {
				httperror.WriteValidation(w, "invalid_status", "Unknown status filter: "+truncate(s, 40))
				return
			}
			statuses = append(statuses, s)
		}
	}

	items, err := d.Store.JobResults(r.Context(), tenantID, jobID, JobResultFilter{
		Status: statuses, Limit: limit, Offset: offset,
	})
	if err != nil {
		d.writeProviderError(w, r, err)
		return
	}
	if len(items) > 0 {
		emails := make([]string, len(items))
		for i := range items {
			emails[i] = items[i].Email
		}
		health, healthErr := d.healthReader().Resolve(r.Context(), tenantID, emails)
		if healthErr != nil {
			d.writeVerificationInternal(w, r, healthErr)
			return
		}
		byEmail := make(map[string]EmailHealth, len(health))
		for _, item := range health {
			byEmail[NormalizeEmail(item.Email)] = item
		}
		for i := range items {
			if item, ok := byEmail[NormalizeEmail(items[i].Email)]; ok {
				value := item
				items[i].Health = &value
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": items})
}

func (d *Deps) cancelJob(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	jobID, valid := jobIDParam(w, r)
	if !valid {
		return
	}
	if err := d.Store.CancelJob(r.Context(), tenantID, jobID); err != nil {
		d.writeProviderError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- provider configuration ---

func (d *Deps) listProviders(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	configs, err := d.Store.ListProviders(r.Context(), tenantID)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": publicProviderConfigs(configs),
		// Advertise what CAN be configured so the settings UI does not
		// have to hardcode the list.
		"available": []string{ProviderZeroBounce, ProviderKickbox},
	})
}

type putProviderRequest struct {
	CredentialRef string            `json:"credential_ref"`
	Enabled       *bool             `json:"enabled,omitempty"`
	Settings      *ProviderSettings `json:"settings,omitempty"`
}

func (d *Deps) putProvider(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	if err := ValidateProviderName(provider); err != nil {
		httperror.WriteValidation(w, "unknown_provider", err.Error())
		return
	}

	var body putProviderRequest
	if err := httpbody.DecodeJSONWith(w, r, 16<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := ValidateCredentialRef(body.CredentialRef); err != nil {
		httperror.WriteValidation(w, "invalid_credential_ref", err.Error())
		return
	}

	cfg := ProviderConfig{
		Provider:      provider,
		CredentialRef: strings.TrimSpace(body.CredentialRef),
		Enabled:       true,
	}
	if body.Enabled != nil {
		cfg.Enabled = *body.Enabled
	}
	if body.Settings != nil {
		cfg.Settings = *body.Settings
		if err := validateProviderSettings(cfg.Settings); err != nil {
			httperror.WriteValidation(w, "invalid_provider_settings", err.Error())
			return
		}
	}

	// Resolve the tenant-bound credential and probe it before any provider row
	// changes. A bad proposed key must never deactivate or replace the current
	// working provider.
	saved, err := d.Store.ConfigureProvider(r.Context(), tenantID, cfg)
	if err != nil {
		d.writeProviderError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, publicProviderConfig(*saved))
}

func (d *Deps) deleteProvider(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	removed, err := d.Store.DeleteProvider(r.Context(), tenantID, provider)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	if !removed {
		httperror.Write(w, http.StatusNotFound, "provider_not_found", "No such verification provider is configured.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- enforcement policy ---
//
// Admin-scoped on both verbs, including the read. The policy states
// which signups the workspace is currently refusing, which is an
// access-control-shaped fact rather than list data.

func (d *Deps) getPolicy(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	policy, err := d.Store.Policy(r.Context(), tenantID)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"policy": policy,
		"modes":  []string{ModeOff, ModeLocal, ModeFull},
		// The statuses an operator may choose to refuse. Sent so the
		// settings UI does not hardcode a list that could drift from
		// the server's closed set.
		"rejectable_statuses": []Status{
			StatusInvalid, StatusSpamtrap, StatusAbuse, StatusDoNotMail,
			StatusCatchAll, StatusUnknown,
		},
	})
}

func (d *Deps) putPolicy(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var body Policy
	if err := httpbody.DecodeJSONWith(w, r, 16<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	saved, err := d.Store.SetPolicy(r.Context(), tenantID, body)
	if err != nil {
		// Mode/status validation failures are the caller's input.
		if strings.Contains(err.Error(), "unknown mode") ||
			strings.Contains(err.Error(), "is not a valid status") {
			httperror.WriteValidation(w, "invalid_policy", err.Error())
			return
		}
		d.writeVerificationInternal(w, r, err)
		return
	}

	// Surface the exact consequence of turning full mode on with no provider.
	// Public forms preserve availability by admitting non-locally-decisive
	// addresses as visibly degraded; confirmed imports fail closed before any
	// subscriber write. Conflating those behaviors with "local mode" would hide
	// a production misconfiguration.
	resp := map[string]any{"policy": saved}
	if saved.FormsMode == ModeFull || saved.ImportMode == ModeFull {
		cfg, cfgErr := d.Store.EnabledProvider(r.Context(), tenantID)
		if cfgErr == nil && cfg == nil {
			switch {
			case saved.FormsMode == ModeFull && saved.ImportMode == ModeFull:
				resp["warning"] = "Full verification has no configured provider. Forms will fail open as degraded after local checks, and confirmed imports will fail closed before subscriber writes."
			case saved.FormsMode == ModeFull:
				resp["warning"] = "Full form verification has no configured provider. Forms will fail open as degraded after local checks until a provider is configured."
			default:
				resp["warning"] = "Full import verification has no configured provider. Confirmed imports will fail closed before subscriber writes until a provider is configured."
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- credits + cache ---

func (d *Deps) credits(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	usage, err := d.Store.Usage(r.Context(), tenantID, days)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}

	resp := map[string]any{"usage": usage}

	// Totals across the window, so the caller does not have to fold.
	var verified, spent, filtered, hits int
	for _, p := range usage {
		verified += p.Verified
		spent += p.CreditsSpent
		filtered += p.LocalFiltered
		hits += p.CacheHits
	}
	resp["totals"] = map[string]any{
		"verified":       verified,
		"credits_spent":  spent,
		"local_filtered": filtered,
		"cache_hits":     hits,
		"credits_saved":  verified - spent,
	}

	cfg, err := d.Store.EnabledProvider(r.Context(), tenantID)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	if cfg == nil {
		// Not an error: the free tier works unconfigured, and saying
		// so is more useful than a 412 here.
		resp["provider"] = nil
		resp["balance"] = nil
		resp["note"] = "No verification provider configured; local (free) checks only."
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp["provider"] = cfg.Provider
	// This endpoint is the operator's explicit balance/status refresh. Probe the
	// configured provider now, persist a successful balance, and retain the last
	// known value plus a safe error on failure. Ordinary settings/list reads stay
	// cache-only and do not add vendor latency.
	chain, probeErr := d.Store.BuildChain(r.Context(), tenantID)
	if probeErr == nil && chain.Vendor != nil {
		var balance int
		balance, probeErr = chain.Credits(r.Context())
		if probeErr == nil && balance != CreditsUnmetered {
			if err := d.Store.RecordBalance(r.Context(), tenantID, cfg.Provider, balance); err != nil {
				d.writeVerificationInternal(w, r, err)
				return
			}
			cfg.LastBalance = &balance
			now := time.Now().UTC()
			cfg.LastBalanceAt = &now
			cfg.LastError = ""
		}
	}
	if probeErr != nil {
		d.Store.RecordProviderError(r.Context(), tenantID, cfg.Provider, probeErr)
		cfg.LastError = safeProviderHealthError
	}
	resp["balance"] = cfg.LastBalance
	resp["balance_checked_at"] = cfg.LastBalanceAt
	if cfg.LastError != "" {
		resp["last_error"] = safeProviderHealthError
	}
	writeJSON(w, http.StatusOK, resp)
}

func (d *Deps) cacheSummary(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	cache := &TenantCache{Store: d.Store, TenantID: tenantID, TTL: DefaultCacheTTL}
	summary, err := cache.Summary(r.Context())
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

type invalidateRequest struct {
	Emails []string `json:"emails"`
}

func (d *Deps) invalidateCache(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var body invalidateRequest
	if err := httpbody.DecodeJSONWith(w, r, 1<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if len(body.Emails) == 0 {
		httperror.WriteValidation(w, "emails_required",
			"List the addresses to invalidate. Clearing the whole cache is not supported, because every entry costs a credit to rebuild.")
		return
	}
	cache := &TenantCache{Store: d.Store, TenantID: tenantID, TTL: DefaultCacheTTL}
	n, err := cache.Invalidate(r.Context(), body.Emails)
	if err != nil {
		if errors.Is(err, ErrCacheInvalidationTooLarge) {
			httperror.WriteValidation(w, "batch_too_large",
				"Cache invalidation accepts at most "+strconv.Itoa(MaxCacheInvalidationAddresses)+" addresses per request.")
			return
		}
		if errors.Is(err, ErrCacheInvalidationInput) {
			httperror.WriteValidation(w, "invalid_email_input",
				"Every cache-invalidation address must be non-empty, at most 320 UTF-8 bytes, and contain no unsafe control characters.")
			return
		}
		d.writeVerificationInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invalidated": n})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeNoCreditsDenial emits the provider-credit refusal through the shared
// denial contract.
//
// Extracted from writeProviderError deliberately. That switch also maps
// ErrUnauthorized and ErrNotConfigured (both 412) — upstream failures, not
// entitlement denials, which correctly use httperror.Write. A guard that checks
// "this site uses the contract and does not hand-build a refusal beside it"
// cannot distinguish the two while they share a function body, so the denial
// gets its own.
//
// The remedy is deliberately NOT `upgrade_plan`: this is the workspace's
// verification PROVIDER account running dry, and no change to the Moosewave plan
// resolves it. Offering an upgrade would send someone to a billing page that
// cannot fix their problem.
func writeNoCreditsDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "email_verification",
		Reason:  entitlement.ReasonPlan,
		Code:    "verification_no_credits",
		Message: "The verification provider reported no remaining credits.",
		Remedy:  "add_provider_credits",
	})
}
