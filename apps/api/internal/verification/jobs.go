// SPDX-License-Identifier: AGPL-3.0-only
//
// jobs.go — asynchronous bulk verification.
//
// This is the "upload a list and come back later" surface. It exists
// because synchronous verification does not scale past a few hundred
// addresses: a vendor probe is a real SMTP conversation, so a
// 50,000-address list is measured in hours, not seconds, and no HTTP
// request should be held open for that.
//
// The durability model is deliberately conservative and crash-safe:
//
//   - Every address is written to verification_job_items UP FRONT with
//     processed = false.
//   - The worker durably leases exact rows and records the subset crossing
//     the metered-provider boundary before making the request.
//   - Progress is therefore in the database, not in worker memory.
//
// Credits are real money. If a worker loses a provider response, those exact
// rows become terminally ambiguous and are never retried automatically. That
// avoids turning a crash or timeout into duplicate vendor charges.

package verification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Job lifecycle states.
const (
	JobStatusPending   = "pending"
	JobStatusRunning   = "running"
	JobStatusCompleted = "completed"
	JobStatusFailed    = "failed"
	JobStatusCanceled  = "canceled"
)

// Subscriber-import jobs use private non-terminal states so workers from a
// pre-enforcement release cannot claim them during a rolling deploy. scanJob
// projects these back to the public pending/running vocabulary.
const (
	jobStatusImportPending = "import_pending"
	jobStatusImportRunning = "import_running"
)

// Job execution modes are frozen when billable work is created. They are
// deliberately narrower than policy modes: an "off" policy creates no job.
const (
	JobExecutionModeLocal = "local"
	JobExecutionModeFull  = "full"
)

const (
	jobExecutionClassBulk             = "bulk"
	jobExecutionClassSubscriberImport = "subscriber_import"
	// JobExecutionClassSubscriberImport is exposed only for narrow composition
	// adapters that validate a durable import binding.
	JobExecutionClassSubscriberImport = jobExecutionClassSubscriberImport
)

// Job address sources.
const (
	// JobSourceInline — addresses supplied in the request body.
	JobSourceInline = "inline"
	// JobSourceUpload — addresses parsed from an uploaded CSV. Same
	// worker path as inline; the distinction is only provenance.
	JobSourceUpload = "upload"
	// JobSourceTag — every subscriber carrying a tag.
	JobSourceTag = "tag"
	// JobSourceAllSubscribers — the tenant's whole subscriber pool.
	JobSourceAllSubscribers = "all_subscribers"
)

// MaxJobAddresses bounds one job. Beyond this the operator should
// split the work, so a single runaway job cannot consume an entire
// credit balance in one action.
const MaxJobAddresses = 250000

// DefaultJobBatchSize is how many addresses one claim/verify cycle
// handles. Matches the vendor batch ceilings.
const DefaultJobBatchSize = 100

// DefaultJobLeaseDuration is deliberately longer than the provider clients'
// request timeout. A second replica must not declare an in-flight request
// abandoned while the first can still receive and persist its response.
const DefaultJobLeaseDuration = 10 * time.Minute

// jobSeedChunk bounds how many addresses go into one seeding INSERT.
// Large enough that a 250k job is 50 statements rather than 250k,
// small enough that no single array parameter is unreasonable.
const jobSeedChunk = 5000

// Job is one verification_jobs row.
type Job struct {
	ID                 string     `json:"id"`
	TenantID           string     `json:"-"`
	Status             string     `json:"status"`
	Source             string     `json:"source"`
	SourceRef          string     `json:"source_ref,omitempty"`
	ExecutionMode      string     `json:"execution_mode"`
	ExecutionClass     string     `json:"-"`
	Provider           string     `json:"provider,omitempty"`
	Total              int        `json:"total"`
	Processed          int        `json:"processed"`
	CacheHits          int        `json:"cache_hits"`
	LocalFiltered      int        `json:"local_filtered"`
	VendorVerified     int        `json:"vendor_verified"`
	CreditsSpent       int        `json:"credits_spent"`
	Duplicates         int        `json:"duplicates"`
	Ambiguous          int        `json:"ambiguous"`
	FailureCode        string     `json:"failure_code,omitempty"`
	Error              string     `json:"error,omitempty"`
	IdempotencyKey     string     `json:"-"`
	RequestFingerprint string     `json:"-"`
	Attempts           int        `json:"attempts"`
	NextAttemptAt      time.Time  `json:"-"`
	LeaseOwner         string     `json:"-"`
	LeaseExpiresAt     *time.Time `json:"-"`
	ActivatedAt        *time.Time `json:"-"`
	CreatedBy          *string    `json:"created_by,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	StartedAt          *time.Time `json:"started_at,omitempty"`
	CompletedAt        *time.Time `json:"completed_at,omitempty"`
}

// SavedCredits is how many vendor calls the free tiers avoided on this
// job. Reported alongside the spend so the number is auditable rather
// than marketing.
func (j Job) SavedCredits() int {
	saved := j.Processed - j.CreditsSpent
	if saved < 0 {
		return 0
	}
	return saved
}

// JobItem is one verification_job_items row.
type JobItem struct {
	Email        string       `json:"email"`
	Processed    bool         `json:"processed"`
	Status       string       `json:"status"`
	SubStatus    string       `json:"sub_status,omitempty"`
	Score        *int         `json:"score,omitempty"`
	Provider     string       `json:"provider,omitempty"`
	Billable     bool         `json:"billable"`
	Cached       bool         `json:"cached"`
	DidYouMean   string       `json:"did_you_mean,omitempty"`
	CheckedAt    *time.Time   `json:"checked_at,omitempty"`
	AttemptState string       `json:"attempt_state"`
	Health       *EmailHealth `json:"health,omitempty"`
}

var errInvalidStoredJobResult = errors.New("verification: stored job result is outside the canonical contract")

type jobBatchClaim struct {
	TenantID     string
	JobID        string
	Owner        string
	AttemptToken string
	Emails       []string
}

// JobSpec describes a job to create.
type JobSpec struct {
	Source    string
	SourceRef string
	// Emails is used for the inline and upload sources.
	Emails []string
	// CreatedBy is the acting user, for the audit trail.
	CreatedBy *string
	// ExecutionMode selects the immutable verification tier for this job.
	// Empty defaults to full so public/API-created jobs preserve the product
	// promise of mailbox verification. Trusted import composition explicitly
	// sets local when the tenant confirmed a local-only policy.
	ExecutionMode string
	// SubscriberImportHeld creates a private, non-runnable import job. Only
	// trusted composition may set it; ActivateSubscriberImportJob releases the
	// job after the import row has durably stored its exact binding.
	SubscriberImportHeld bool
	// IdempotencyKey is required by the HTTP creation surface and optional for
	// trusted internal callers. Inline/upload keys bind the fully resolved,
	// normalized address set. Dynamic tag/all-subscriber keys bind the source,
	// source reference, and execution mode: their first resolution is frozen in
	// job items and an exact request retry must not drift with later membership.
	IdempotencyKey string
}

// JobResultFilter narrows a results page.
type JobResultFilter struct {
	Status []string
	Limit  int
	Offset int
}

var (
	// ErrJobIdempotencyConflict means a caller reused a creation key with a
	// different immutable request (or, for inline/upload, address set).
	ErrJobIdempotencyConflict = errors.New("verification: idempotency key reused with different job input")
	// ErrJobLeaseHeld means another healthy worker currently owns the job.
	ErrJobLeaseHeld = errors.New("verification: job is leased by another worker")
	// ErrJobLeaseLost means this worker's durable ownership expired or was
	// canceled before it could commit a result.
	ErrJobLeaseLost = errors.New("verification: job lease lost")
	// ErrJobOutcomeAmbiguous is terminal and intentionally non-retryable: a
	// provider request started but no result receipt was committed.
	ErrJobOutcomeAmbiguous = errors.New("verification: provider request outcome is ambiguous")
	// ErrSubscriberImportJobBinding means a trusted import job could not be
	// atomically attached to its live import row. Retrying provider work would
	// be unsafe until the import lifecycle conflict is resolved.
	ErrSubscriberImportJobBinding = errors.New("verification: subscriber-import job binding conflict")
)

const failureCodeOutcomeAmbiguous = "verification_outcome_ambiguous"

const subscriberImportJobIdempotencyPrefix = "subscriber-import:"

// SubscriberImportJobIdempotencyKey returns the server-owned namespace used
// by the trusted import adapter. The public bulk endpoint rejects this prefix.
func SubscriberImportJobIdempotencyKey(importID string) string {
	return subscriberImportJobIdempotencyPrefix + strings.TrimSpace(importID) + ":verification:v1"
}

func jobFailureCode(cause error) string {
	switch {
	case errors.Is(cause, ErrProviderAccountRejected):
		return "verification_provider_account_rejected"
	case errors.Is(cause, ErrNoCredits):
		return "verification_no_credits"
	case errors.Is(cause, ErrUnauthorized):
		return "verification_provider_unauthorized"
	case errors.Is(cause, ErrNotConfigured):
		return "provider_not_configured"
	case errors.Is(cause, ErrProviderUnavailable):
		return "verification_provider_unavailable"
	default:
		return "verification_job_failed"
	}
}

func safeStoredJobError(cause error) string {
	switch jobFailureCode(cause) {
	case "verification_provider_account_rejected":
		return "The verification provider rejected the configured account. Check its credential and available credits."
	case "verification_no_credits":
		return "The verification provider has no credits remaining."
	case "verification_provider_unauthorized":
		return "The verification provider rejected the configured credential."
	case "provider_not_configured":
		return "No verification provider is configured for this workspace."
	case "verification_provider_unavailable":
		return "The verification provider was unavailable before the job could complete."
	default:
		return "The verification job failed before it could complete."
	}
}

// safeJobLogErrorClass intentionally reduces every runner error to a closed,
// non-PII class. PostgreSQL constraint detail and provider payloads can contain
// an address, so a background worker must never attach the raw error to logs.
func safeJobLogErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, ErrJobOutcomeAmbiguous):
		return "outcome_ambiguous"
	case errors.Is(err, ErrJobLeaseHeld), errors.Is(err, ErrJobLeaseLost):
		return "lease_conflict"
	case errors.Is(err, ErrNoCredits):
		return "no_credits"
	case errors.Is(err, ErrUnauthorized):
		return "unauthorized"
	case errors.Is(err, ErrProviderAccountRejected):
		return "account_rejected"
	case errors.Is(err, ErrNotConfigured):
		return "not_configured"
	case errors.Is(err, ErrProviderUnavailable):
		return "provider_unavailable"
	case errors.Is(err, ErrCacheUnavailable):
		return "cache_unavailable"
	default:
		return "persistence_or_internal"
	}
}

func jobRequestFingerprint(source, sourceRef string, emails []string, requestedMode ...string) string {
	mode := JobExecutionModeFull
	if len(requestedMode) > 0 && strings.TrimSpace(requestedMode[0]) != "" {
		mode = strings.TrimSpace(requestedMode[0])
	}
	h := sha256.New()
	_, _ = h.Write([]byte(source))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(sourceRef))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(mode))
	for _, email := range emails {
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(email))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func isDynamicJobSource(source string) bool {
	return source == JobSourceTag || source == JobSourceAllSubscribers
}

func jobIdempotencyMatches(existing *Job, spec JobSpec, executionMode, fingerprint string) bool {
	if existing == nil {
		return false
	}
	if isDynamicJobSource(spec.Source) {
		// Dynamic membership is frozen into verification_job_items at the first
		// successful creation. Compare only the immutable request itself. The
		// column comparison also keeps retries compatible with jobs created before
		// dynamic fingerprints stopped embedding an arbitrary SELECT order.
		return existing.Source == spec.Source && existing.SourceRef == spec.SourceRef &&
			existing.ExecutionMode == executionMode
	}
	return existing.RequestFingerprint == fingerprint
}

func subscriberImportJobRequestFingerprint(source, sourceRef string, emails []string, mode string) string {
	base := jobRequestFingerprint(source, sourceRef, emails, mode)
	sum := sha256.Sum256([]byte(jobExecutionClassSubscriberImport + "\x00" + base))
	return hex.EncodeToString(sum[:])
}

func normalizeJobExecutionMode(mode string) (string, error) {
	mode = strings.TrimSpace(strings.ToLower(mode))
	if mode == "" {
		mode = JobExecutionModeFull
	}
	switch mode {
	case JobExecutionModeLocal, JobExecutionModeFull:
		return mode, nil
	default:
		return "", fmt.Errorf("verification: unsupported job execution mode %q", truncate(mode, 40))
	}
}

func normalizeJobIdempotencyKey(value string) (string, error) {
	if value == "" || len(value) > 255 || hasUnsafeControlText(value) ||
		strings.TrimSpace(value) != value {
		return "", errors.New("verification: idempotency key must be 1-255 valid UTF-8 bytes")
	}
	return value, nil
}

// ValidateJobSource rejects sources the worker cannot resolve, so the
// API never accepts a job that is guaranteed to fail later.
func ValidateJobSource(source string) error {
	switch source {
	case JobSourceInline, JobSourceUpload, JobSourceTag, JobSourceAllSubscribers:
		return nil
	default:
		return fmt.Errorf("verification: unsupported job source %q", truncate(source, 40))
	}
}

// CreateJob records a job and seeds its address rows.
//
// Address resolution happens HERE, not in the worker, so `total` is
// truthful the moment the job is visible and the operator is never
// shown a progress bar against an unknown denominator.
func (s *Store) CreateJob(ctx context.Context, tenantID string, spec JobSpec) (*Job, error) {
	if err := ValidateJobSource(spec.Source); err != nil {
		return nil, err
	}
	if hasUnsafeControlText(spec.SourceRef) || len(strings.TrimSpace(spec.SourceRef)) > maxJobSourceRefBytes {
		return nil, errors.New("verification: source_ref must be a single line of at most 512 characters")
	}
	spec.SourceRef = strings.TrimSpace(spec.SourceRef)
	executionMode, err := normalizeJobExecutionMode(spec.ExecutionMode)
	if err != nil {
		return nil, err
	}
	idempotencyKey := ""
	if spec.IdempotencyKey != "" {
		var err error
		idempotencyKey, err = normalizeJobIdempotencyKey(spec.IdempotencyKey)
		if err != nil {
			return nil, err
		}
	}
	if s.Pool == nil {
		return nil, errors.New("verification: no database pool configured")
	}
	executionClass := jobExecutionClassBulk
	if spec.SubscriberImportHeld {
		if spec.Source != JobSourceUpload || spec.SourceRef == "" || idempotencyKey == "" {
			return nil, errors.New("verification: held subscriber-import jobs require upload provenance and idempotency")
		}
		executionClass = jobExecutionClassSubscriberImport
	}
	dynamicFingerprint := ""
	if isDynamicJobSource(spec.Source) {
		// The request is the selector, not the selector's mutable membership.
		// Resolved rows are durably frozen in verification_job_items below.
		dynamicFingerprint = jobRequestFingerprint(spec.Source, spec.SourceRef, nil, executionMode)
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if dynamicFingerprint != "" && idempotencyKey != "" {
		existing, lookupErr := scanJob(tx.QueryRow(ctx,
			`SELECT `+jobColumns+` FROM verification_jobs
			  WHERE tenant_id = $1::uuid AND execution_class = $2 AND idempotency_key = $3`,
			tenantID, executionClass, idempotencyKey))
		switch {
		case lookupErr == nil:
			if !jobIdempotencyMatches(existing, spec, executionMode, dynamicFingerprint) {
				return nil, ErrJobIdempotencyConflict
			}
			existing.TenantID = tenantID
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return existing, nil
		case !errors.Is(lookupErr, pgx.ErrNoRows):
			return nil, lookupErr
		}
	}

	emails, err := resolveJobAddresses(ctx, tx, tenantID, spec)
	if err != nil {
		return nil, err
	}
	if len(emails) == 0 && !spec.SubscriberImportHeld {
		return nil, fmt.Errorf("verification: job source %q resolved to no addresses", spec.Source)
	}
	if len(emails) > MaxJobAddresses {
		return nil, fmt.Errorf("verification: %d addresses exceeds the %d per-job limit; split the run",
			len(emails), MaxJobAddresses)
	}
	initialStatus := JobStatusPending
	now := time.Now().UTC()
	var activatedAt any = now
	var completedAt any
	if spec.SubscriberImportHeld {
		initialStatus = jobStatusImportPending
		activatedAt = nil
		if len(emails) == 0 {
			// No address can cross a provider boundary. Complete immediately so a
			// full-mode empty import does not require provider configuration.
			initialStatus = JobStatusCompleted
			activatedAt = now
			completedAt = now
		}
	}
	fingerprint := dynamicFingerprint
	if fingerprint == "" {
		fingerprint = jobRequestFingerprint(spec.Source, spec.SourceRef, emails, executionMode)
	}
	if executionClass == jobExecutionClassSubscriberImport {
		fingerprint = subscriberImportJobRequestFingerprint(spec.Source, spec.SourceRef, emails, executionMode)
	}

	if idempotencyKey != "" {
		existing, lookupErr := scanJob(tx.QueryRow(ctx,
			`SELECT `+jobColumns+` FROM verification_jobs
			  WHERE tenant_id = $1::uuid AND execution_class = $2 AND idempotency_key = $3`,
			tenantID, executionClass, idempotencyKey))
		switch {
		case lookupErr == nil:
			if !jobIdempotencyMatches(existing, spec, executionMode, fingerprint) {
				return nil, ErrJobIdempotencyConflict
			}
			existing.TenantID = tenantID
			if err := bindSubscriberImportJobTx(ctx, tx, tenantID, spec, executionMode, existing.ID); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return existing, nil
		case !errors.Is(lookupErr, pgx.ErrNoRows):
			return nil, lookupErr
		}
	}

	var jobID string
	err = tx.QueryRow(ctx,
		`INSERT INTO verification_jobs
		     (tenant_id, status, source, source_ref, execution_mode, execution_class,
		      activated_at, completed_at, total, created_by, idempotency_key, request_fingerprint)
		 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12)
		 ON CONFLICT (tenant_id, execution_class, idempotency_key) WHERE idempotency_key <> ''
		 DO NOTHING
		 RETURNING id`,
		tenantID, initialStatus, spec.Source, spec.SourceRef, executionMode, executionClass,
		activatedAt, completedAt, len(emails), spec.CreatedBy, idempotencyKey, fingerprint).Scan(&jobID)
	if errors.Is(err, pgx.ErrNoRows) && idempotencyKey != "" {
		existing, lookupErr := scanJob(tx.QueryRow(ctx,
			`SELECT `+jobColumns+` FROM verification_jobs
			  WHERE tenant_id = $1::uuid AND execution_class = $2 AND idempotency_key = $3`,
			tenantID, executionClass, idempotencyKey))
		if lookupErr != nil {
			return nil, lookupErr
		}
		if !jobIdempotencyMatches(existing, spec, executionMode, fingerprint) {
			return nil, ErrJobIdempotencyConflict
		}
		existing.TenantID = tenantID
		if err := bindSubscriberImportJobTx(ctx, tx, tenantID, spec, executionMode, existing.ID); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return existing, nil
	}
	if err != nil {
		return nil, err
	}

	// Seed the work queue.
	//
	// This deliberately does NOT use pgx CopyFrom: Postgres rejects
	// COPY FROM against a table with row-level security enabled
	// (SQLSTATE 0A000), and every table here is RLS-forced. An
	// INSERT ... SELECT unnest(...) is the next best thing — one
	// statement per chunk instead of one per address — and it can
	// carry the ON CONFLICT clause that makes seeding idempotent if a
	// creation is retried.
	for start := 0; start < len(emails); start += jobSeedChunk {
		end := start + jobSeedChunk
		if end > len(emails) {
			end = len(emails)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO verification_job_items (job_id, tenant_id, email)
			 SELECT $1::uuid, $2::uuid, e FROM unnest($3::text[]) AS e
			 ON CONFLICT (job_id, email) DO NOTHING`,
			jobID, tenantID, emails[start:end]); err != nil {
			return nil, err
		}
	}
	if err := bindSubscriberImportJobTx(ctx, tx, tenantID, spec, executionMode, jobID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetJob(ctx, tenantID, jobID)
}

func bindSubscriberImportJobTx(
	ctx context.Context, tx pgx.Tx, tenantID string, spec JobSpec, executionMode, jobID string,
) error {
	if !spec.SubscriberImportHeld {
		return nil
	}
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET verification_job_id = $3::uuid
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status IN ('verification_queued', 'verification_running')
   AND verification_mode = $4 AND verification_state IN ('pending', 'running')
   AND cancel_requested = false
   AND (verification_job_id IS NULL OR verification_job_id = $3::uuid)`,
		tenantID, spec.SourceRef, jobID, executionMode)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSubscriberImportJobBinding
	}
	return nil
}

const (
	tagJobAddressesQuery = `SELECT email FROM subscribers
 WHERE tenant_id = $1::uuid AND tags @> ARRAY[$2]::text[]
 ORDER BY email ASC, id ASC
 LIMIT $3`
	allSubscriberJobAddressesQuery = `SELECT email FROM subscribers
 WHERE tenant_id = $1::uuid
 ORDER BY email ASC, id ASC
 LIMIT $2`
)

// resolveJobAddresses expands a JobSpec into a deduplicated, normalized
// address list. Database-backed selectors read at most one row beyond the cap,
// so an oversized tenant cannot make the API allocate its whole subscriber
// table merely to reject the request.
func resolveJobAddresses(ctx context.Context, tx pgx.Tx, tenantID string, spec JobSpec) ([]string, error) {
	return resolveJobAddressesWithLimit(ctx, tx, tenantID, spec, MaxJobAddresses)
}

func resolveJobAddressesWithLimit(
	ctx context.Context, tx pgx.Tx, tenantID string, spec JobSpec, maxAddresses int,
) ([]string, error) {
	if maxAddresses <= 0 {
		return nil, errors.New("verification: per-job address limit must be positive")
	}
	var emails []string
	var err error
	switch spec.Source {
	case JobSourceInline, JobSourceUpload:
		emails, err = dedupeNormalizedJobAddresses(spec.Emails)

	case JobSourceTag:
		tag := strings.TrimSpace(spec.SourceRef)
		if tag == "" {
			return nil, errors.New("verification: a tag job requires source_ref")
		}
		rows, queryErr := tx.Query(ctx, tagJobAddressesQuery, tenantID, tag, maxAddresses+1)
		err = queryErr
		if err != nil {
			return nil, err
		}
		emails, err = collectEmails(rows)

	case JobSourceAllSubscribers:
		rows, queryErr := tx.Query(ctx, allSubscriberJobAddressesQuery, tenantID, maxAddresses+1)
		err = queryErr
		if err != nil {
			return nil, err
		}
		emails, err = collectEmails(rows)

	default:
		return nil, fmt.Errorf("verification: unsupported job source %q", truncate(spec.Source, 40))
	}
	if err != nil {
		return nil, err
	}
	if len(emails) > maxAddresses {
		return nil, fmt.Errorf("verification: %d addresses exceeds the %d per-job limit; split the run",
			len(emails), maxAddresses)
	}
	return emails, nil
}

func collectEmails(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return dedupeNormalizedJobAddresses(out)
}

// dedupeNormalizedJobAddresses validates the raw durable-job boundary before
// normalization. In particular, controls at either edge must be rejected, not
// trimmed away: subscriber imports call Store.CreateJob directly and the
// health snapshot table enforces the corresponding POSIX-cntrl invariant.
func dedupeNormalizedJobAddresses(in []string) ([]string, error) {
	for _, raw := range in {
		if hasUnsafeControlText(raw) || len(NormalizeEmail(raw)) > maxJobEmailBytes {
			return nil, errors.New("verification: every address must be at most 320 characters with no control characters")
		}
	}
	return dedupeNormalized(in), nil
}

// dedupeNormalized lowercases, trims, drops blanks, and collapses
// repeats while preserving first-seen order.
func dedupeNormalized(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, e := range in {
		n := NormalizeEmail(e)
		if n == "" {
			continue
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out
}

const jobColumns = `id, status, source, source_ref, execution_mode, execution_class, provider, total, processed,
	cache_hits, local_filtered, vendor_verified, credits_spent, duplicates,
	ambiguous, failure_code, error, idempotency_key, request_fingerprint,
	attempts, next_attempt_at, COALESCE(lease_owner, ''), lease_expires_at,
	activated_at, created_by, created_at, started_at, completed_at`

var errInvalidStoredJob = errors.New("verification: stored job failed integrity validation")

const (
	maxStoredJobFailureCodeBytes = 128
	maxStoredJobErrorBytes       = 512
	maxStoredJobLeaseOwnerBytes  = 256
)

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.Status, &j.Source, &j.SourceRef, &j.ExecutionMode, &j.ExecutionClass, &j.Provider, &j.Total,
		&j.Processed, &j.CacheHits, &j.LocalFiltered, &j.VendorVerified, &j.CreditsSpent,
		&j.Duplicates, &j.Ambiguous, &j.FailureCode, &j.Error, &j.IdempotencyKey,
		&j.RequestFingerprint, &j.Attempts, &j.NextAttemptAt, &j.LeaseOwner,
		&j.LeaseExpiresAt, &j.ActivatedAt, &j.CreatedBy, &j.CreatedAt, &j.StartedAt, &j.CompletedAt)
	if err != nil {
		return nil, err
	}
	if err := validateStoredJobHeader(j); err != nil {
		return nil, err
	}
	switch j.Status {
	case jobStatusImportPending:
		j.Status = JobStatusPending
	case jobStatusImportRunning:
		j.Status = JobStatusRunning
	}
	return &j, nil
}

func validateStoredJobHeader(j Job) error {
	validText := func(value string, maxBytes int) bool {
		return len(value) <= maxBytes && !hasUnsafeControlText(value) &&
			strings.TrimSpace(value) == value
	}
	if !validText(j.SourceRef, maxJobSourceRefBytes) ||
		!validText(j.FailureCode, maxStoredJobFailureCodeBytes) ||
		!validText(j.Error, maxStoredJobErrorBytes) ||
		!validText(j.IdempotencyKey, 255) ||
		!validText(j.LeaseOwner, maxStoredJobLeaseOwnerBytes) {
		return errInvalidStoredJob
	}
	switch j.Source {
	case JobSourceInline, JobSourceUpload, JobSourceTag, JobSourceAllSubscribers:
	default:
		return errInvalidStoredJob
	}
	if j.ExecutionMode != JobExecutionModeLocal && j.ExecutionMode != JobExecutionModeFull {
		return errInvalidStoredJob
	}
	switch j.ExecutionClass {
	case jobExecutionClassBulk:
		if !oneOfString(j.Status, JobStatusPending, JobStatusRunning,
			JobStatusCompleted, JobStatusFailed, JobStatusCanceled) {
			return errInvalidStoredJob
		}
	case jobExecutionClassSubscriberImport:
		if j.Source != JobSourceUpload || j.SourceRef == "" || j.IdempotencyKey == "" ||
			!oneOfString(j.Status, jobStatusImportPending, jobStatusImportRunning,
				JobStatusCompleted, JobStatusFailed, JobStatusCanceled) {
			return errInvalidStoredJob
		}
	default:
		return errInvalidStoredJob
	}
	if !oneOfString(j.Provider, "", ProviderLocal, ProviderZeroBounce, ProviderKickbox) {
		return errInvalidStoredJob
	}
	if storedJobCountersInvalid(j) {
		return errInvalidStoredJob
	}
	if err := validateStoredJobFingerprint(j); err != nil {
		return err
	}
	if storedJobTimestampsInvalid(j) {
		return errInvalidStoredJob
	}
	if j.CreatedBy != nil {
		if parsed, err := uuid.Parse(*j.CreatedBy); err != nil || parsed.String() != *j.CreatedBy {
			return errInvalidStoredJob
		}
	}
	if storedJobLeaseInvalid(j) {
		return errInvalidStoredJob
	}
	if storedJobLifecycleInvalid(j) {
		return errInvalidStoredJob
	}
	return nil
}

// storedJobCountersInvalid reports whether the persisted counters break the
// accounting invariants: every counter non-negative, Total bounded, processed
// plus ambiguous never exceeding Total, the processed breakdown never
// exceeding Processed, and credits never exceeding vendor-verified rows.
func storedJobCountersInvalid(j Job) bool {
	return j.Total < 0 || j.Total > MaxJobAddresses || j.Processed < 0 ||
		j.CacheHits < 0 || j.LocalFiltered < 0 || j.VendorVerified < 0 ||
		j.CreditsSpent < 0 || j.Duplicates < 0 || j.Ambiguous < 0 || j.Attempts < 0 ||
		j.Processed+j.Ambiguous > j.Total ||
		j.CacheHits+j.LocalFiltered+j.VendorVerified > j.Processed ||
		j.CreditsSpent > j.VendorVerified
}

// validateStoredJobFingerprint requires a present request fingerprint to be
// exactly lowercase hex SHA-256.
func validateStoredJobFingerprint(j Job) error {
	if j.RequestFingerprint == "" {
		return nil
	}
	if len(j.RequestFingerprint) != sha256.Size*2 ||
		strings.ToLower(j.RequestFingerprint) != j.RequestFingerprint {
		return errInvalidStoredJob
	}
	if _, err := hex.DecodeString(j.RequestFingerprint); err != nil {
		return errInvalidStoredJob
	}
	return nil
}

// storedJobTimestampsInvalid reports whether any persisted timestamp is zero
// or precedes the job's creation.
func storedJobTimestampsInvalid(j Job) bool {
	return j.CreatedAt.IsZero() || j.NextAttemptAt.IsZero() ||
		(j.ActivatedAt != nil && j.ActivatedAt.IsZero()) ||
		(j.StartedAt != nil && (j.StartedAt.IsZero() || j.StartedAt.Before(j.CreatedAt))) ||
		(j.CompletedAt != nil && (j.CompletedAt.IsZero() || j.CompletedAt.Before(j.CreatedAt)))
}

// storedJobLeaseInvalid reports whether the lease owner and lease expiry
// disagree about whether a lease is held.
func storedJobLeaseInvalid(j Job) bool {
	return (j.LeaseOwner == "") != (j.LeaseExpiresAt == nil) ||
		(j.LeaseExpiresAt != nil && j.LeaseExpiresAt.IsZero())
}

// storedJobLifecycleInvalid reports whether the status disagrees with the
// lease, start/completion timestamps, or completion counters.
func storedJobLifecycleInvalid(j Job) bool {
	running := j.Status == JobStatusRunning || j.Status == jobStatusImportRunning
	pending := j.Status == JobStatusPending || j.Status == jobStatusImportPending
	terminal := oneOfString(j.Status, JobStatusCompleted, JobStatusFailed, JobStatusCanceled)
	return (j.LeaseOwner != "" && !running) ||
		(running && (j.StartedAt == nil || j.CompletedAt != nil)) ||
		(pending && (j.StartedAt != nil || j.CompletedAt != nil || j.LeaseOwner != "")) ||
		(terminal && (j.CompletedAt == nil || j.LeaseOwner != "")) ||
		(j.Status == JobStatusCompleted && (j.Processed != j.Total || j.Ambiguous != 0))
}

func oneOfString(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

// ErrJobNotFound is returned when the job does not exist for the
// tenant. RLS makes "another tenant's job" and "no such job"
// indistinguishable here, which is the correct behaviour: the
// difference would itself leak the job's existence.
var ErrJobNotFound = errors.New("verification: job not found")

// GetJob loads one job.
func (s *Store) GetJob(ctx context.Context, tenantID, jobID string) (*Job, error) {
	if s.Pool == nil {
		return nil, errors.New("verification: no database pool configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	job, err := scanJob(tx.QueryRow(ctx,
		`SELECT `+jobColumns+` FROM verification_jobs
		  WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrJobNotFound
	}
	if err != nil {
		return nil, err
	}
	job.TenantID = tenantID
	return job, nil
}

// ListJobs returns recent jobs, newest first.
func (s *Store) ListJobs(ctx context.Context, tenantID string, limit int) ([]Job, error) {
	if s.Pool == nil {
		return []Job{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT `+jobColumns+` FROM verification_jobs
		  WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		j.TenantID = tenantID
		out = append(out, *j)
	}
	return out, rows.Err()
}

// ActivateSubscriberImportJob releases a held import job only after the
// subscriber_import row has durably stored its exact job id. Before this call,
// neither current nor pre-1956 verification workers can claim the job.
func (s *Store) ActivateSubscriberImportJob(
	ctx context.Context, tenantID, jobID, importID, executionMode string,
) error {
	if s.Pool == nil {
		return errors.New("verification: no database pool configured")
	}
	mode, err := normalizeJobExecutionMode(executionMode)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET activated_at = COALESCE(activated_at, now()), next_attempt_at = LEAST(next_attempt_at, now())
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND execution_class = $3 AND source = $4 AND source_ref = $5
   AND execution_mode = $6 AND status IN ($7, $8)
   AND EXISTS (
       SELECT 1 FROM subscriber_imports AS import
        WHERE import.tenant_id = $1::uuid AND import.id = $5::uuid
          AND import.verification_job_id = $2::uuid
          AND import.verification_mode = $6
          AND import.status IN ('verification_queued', 'verification_running')
          AND import.verification_state IN ('pending', 'running')
   )`,
		tenantID, jobID, jobExecutionClassSubscriberImport, JobSourceUpload, importID,
		mode, jobStatusImportPending, jobStatusImportRunning)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("verification: subscriber-import job activation binding mismatch")
	}
	return tx.Commit(ctx)
}

// CancelJob marks a job canceled. Terminal jobs are left alone.
func (s *Store) CancelJob(ctx context.Context, tenantID, jobID string) error {
	if s.Pool == nil {
		return errors.New("verification: no database pool configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE verification_jobs
		    SET status = $3, completed_at = now(),
		        lease_owner = NULL, lease_expires_at = NULL
		  WHERE tenant_id = $1::uuid AND id = $2::uuid
		    AND status IN ($4, $5, $6, $7)`,
		tenantID, jobID, JobStatusCanceled, JobStatusPending, JobStatusRunning,
		jobStatusImportPending, jobStatusImportRunning)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Either the job does not exist or it already finished.
		// Distinguish so the caller can 404 rather than pretend.
		if _, err := s.GetJob(ctx, tenantID, jobID); err != nil {
			return err
		}
		return nil
	}
	// A cancellation can race an upstream request. Anything that had crossed
	// the durable request-start boundary is recorded as ambiguous and is never
	// returned to pending; locally leased work is safe to release.
	if _, err := tx.Exec(ctx,
		`UPDATE verification_job_items
		    SET attempt_state = 'ambiguous', status = $3, sub_status = $4,
		        lease_owner = NULL, lease_expires_at = NULL, completed_at = now()
		  WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		    AND attempt_state = 'leased' AND request_started_at IS NOT NULL`,
		tenantID, jobID, string(StatusUnknown), "provider_response_ambiguous"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE verification_job_items
		    SET attempt_state = 'pending', attempt_token = NULL,
		        lease_owner = NULL, lease_expires_at = NULL
		  WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		    AND attempt_state = 'leased' AND request_started_at IS NULL`,
		tenantID, jobID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE verification_jobs AS job
		    SET ambiguous = (
		        SELECT count(*) FROM verification_job_items AS item
		         WHERE item.tenant_id = job.tenant_id AND item.job_id = job.id
		           AND item.attempt_state = 'ambiguous'
		    )
		  WHERE job.tenant_id = $1::uuid AND job.id = $2::uuid`,
		tenantID, jobID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	observeVerificationJobTerminal(JobStatusCanceled, "")
	return nil
}

// JobResults returns a page of per-address results.
func (s *Store) JobResults(ctx context.Context, tenantID, jobID string, f JobResultFilter) ([]JobItem, error) {
	if s.Pool == nil {
		return []JobItem{}, nil
	}
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	if f.Offset < 0 {
		f.Offset = 0
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// A NULL/empty status filter means "all". Passing the slice as an
	// array parameter keeps this a single prepared statement rather
	// than string-built SQL.
	rows, err := tx.Query(ctx,
		`SELECT email, processed, status, sub_status, score, provider,
		        billable, cached, did_you_mean, checked_at, attempt_state
		   FROM verification_job_items
		  WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		    AND ($3::text[] IS NULL OR cardinality($3::text[]) = 0 OR status = ANY($3::text[]))
		  ORDER BY id
		  LIMIT $4 OFFSET $5`,
		tenantID, jobID, f.Status, f.Limit, f.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []JobItem{}
	for rows.Next() {
		var (
			it    JobItem
			score *int16
		)
		if err := rows.Scan(&it.Email, &it.Processed, &it.Status, &it.SubStatus, &score,
			&it.Provider, &it.Billable, &it.Cached, &it.DidYouMean, &it.CheckedAt,
			&it.AttemptState); err != nil {
			return nil, err
		}
		if score != nil {
			v := int(*score)
			it.Score = &v
		}
		if err := validateStoredJobItem(it); err != nil {
			// Do not echo any malformed persisted value. Job results feed both an
			// authenticated response and subscriber-import admission, so legacy
			// rows predating schema constraints must fail closed here.
			return nil, errInvalidStoredJobResult
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func validateStoredJobItem(item JobItem) error {
	if item.Email == "" || len(item.Email) > maxJobEmailBytes ||
		hasUnsafeControlText(item.Email) || NormalizeEmail(item.Email) != item.Email {
		return errInvalidStoredJobResult
	}
	switch item.AttemptState {
	case "pending", "leased":
		if item.Processed || item.Status != string(StatusUnknown) || item.SubStatus != "" ||
			item.Score != nil || item.Provider != "" || item.Billable || item.Cached ||
			item.DidYouMean != "" || item.CheckedAt != nil {
			return errInvalidStoredJobResult
		}
		return nil
	case "ambiguous":
		if item.Processed || item.Status != string(StatusUnknown) ||
			item.SubStatus != "provider_response_ambiguous" || item.Score != nil ||
			item.Provider != "" || item.Billable || item.Cached ||
			item.DidYouMean != "" || item.CheckedAt != nil {
			return errInvalidStoredJobResult
		}
		return nil
	case "succeeded":
		if !item.Processed || item.CheckedAt == nil || (item.Billable && item.Cached) {
			return errInvalidStoredJobResult
		}
		return validatePersistableResult(Result{
			Email:      item.Email,
			Status:     Status(item.Status),
			SubStatus:  SubStatus(item.SubStatus),
			Score:      item.Score,
			Provider:   item.Provider,
			Billable:   item.Billable,
			Cached:     item.Cached,
			DidYouMean: item.DidYouMean,
			CheckedAt:  *item.CheckedAt,
		})
	default:
		return errInvalidStoredJobResult
	}
}

// JobSummary counts processed items by status.
func (s *Store) JobSummary(ctx context.Context, tenantID, jobID string) (map[string]int, error) {
	out := map[string]int{}
	if s.Pool == nil {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT status, count(*) FROM verification_job_items
		  WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND processed
		  GROUP BY status`, tenantID, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			status string
			n      int
		)
		if err := rows.Scan(&status, &n); err != nil {
			return nil, err
		}
		out[status] = n
	}
	return out, rows.Err()
}
