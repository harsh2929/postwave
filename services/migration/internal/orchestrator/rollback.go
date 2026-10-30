// Package orchestrator — 7-day rollback engine.
//
// A migration that completes successfully sets MigrationJob.RollbackUntil to
// now+7d. Within that window, the user can click "Rollback this migration" in
// the admin UI and Rollback() reverses every write the orchestrator made:
// archive rows → automations → segments → subscribers (in that order, so we
// remove children before parents).
//
// Idempotency: re-invoking Rollback on a job already in MigRolledBack state
// is a no-op. This matters because the HTTP handler wires rollbacks up to a
// background goroutine and the user might double-click.
//
// Time policy: if RollbackUntil has already elapsed, Rollback refuses with
// ErrRollbackWindowExpired and does not touch any data. The 7-day cap is a
// product decision (plan.md Phase 3) — beyond that, deletions cascade through
// downstream automation runs and we can't safely reverse the side effects.
package orchestrator

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

// ErrRollbackWindowExpired is returned when the caller attempts to roll back a
// migration past its RollbackUntil deadline.
var ErrRollbackWindowExpired = errors.New("rollback window expired")

// ErrNotRollbackable is returned when the job is in a state that disallows
// rollback (e.g. still importing, never completed, or already failed).
var ErrNotRollbackable = errors.New("job is not in a rollback-able state")

// ErrRollbackDestinationUnavailable is returned when rollback would need a
// destination handle that is not configured. Returning this is safer than
// silently skipping tracked deletes and marking the job rolled back.
var ErrRollbackDestinationUnavailable = errors.New("rollback destination unavailable")

// ErrMigrationExecutionInProgress is returned when this process or another
// service instance already owns a shared job or source-account execution lock.
// Import, delta, discovery, monitoring, refresh, and rollback use the relevant
// lock identities in a consistent order.
var ErrMigrationExecutionInProgress = errors.New("migration execution already in progress")

// ErrMigrationExecutionLockUnavailable is returned when PostgreSQL cannot
// prove exclusive ownership. Credential-bearing and destination-mutating paths
// fail closed.
var ErrMigrationExecutionLockUnavailable = errors.New("migration execution lock unavailable")

// Backward-compatible rollback names remain aliases for callers/tests.
var ErrRollbackInProgress = ErrMigrationExecutionInProgress
var ErrRollbackLockUnavailable = ErrMigrationExecutionLockUnavailable

const rollbackLedgerBatchSize = 250

// AuditFn is the seam by which rollback events are written to the audit_log.
// In production this is wired to db.Audit; tests pass a recording stub.
type AuditFn func(ctx context.Context, event string, fields map[string]interface{})

// RollbackProgress is the live counter set rendered in the UI's progress bar.
type RollbackProgress struct {
	State              string `json:"state"` // pending | running | completed | failed
	ArchiveDeleted     int    `json:"archive_deleted"`
	ArchiveTotal       int    `json:"archive_total"`
	TemplatesDeleted   int    `json:"templates_deleted"`
	TemplatesTotal     int    `json:"templates_total"`
	AutomationsDeleted int    `json:"automations_deleted"`
	AutomationsTotal   int    `json:"automations_total"`
	SegmentsDeleted    int    `json:"segments_deleted"`
	SegmentsTotal      int    `json:"segments_total"`
	SubscribersDeleted int    `json:"subscribers_deleted"`
	SubscribersTotal   int    `json:"subscribers_total"`
	ListsDeleted       int    `json:"lists_deleted"`
	ListsTotal         int    `json:"lists_total"`
	PaidSubsDeleted    int    `json:"paid_subs_deleted"`
	PaidSubsTotal      int    `json:"paid_subs_total"`
	StartedAt          string `json:"started_at"`
	CompletedAt        string `json:"completed_at,omitempty"`
	Error              string `json:"error,omitempty"`
}

// RollbackEngine performs the actual deletions. Construct with the same
// listmonk Client + DB the orchestrator used so we hit the right surfaces.
type RollbackEngine struct {
	Listmonk *listmonkx.Client
	DB       *sql.DB
	TenantID string

	// Audit logs each delete; defaults to a no-op if nil.
	Audit AuditFn

	// Now is the clock; tests inject a fixed time.
	Now func() time.Time

	mu       sync.Mutex
	progress map[string]*RollbackProgress // job_id → live progress

	// These are dependency seams for the process-local and cluster-wide
	// rollback guards. Production uses the package-wide registry and the
	// PostgreSQL implementation; tests inject isolated registries to model
	// separate service processes deterministically.
	executionLocks       *rollbackExecutionRegistry
	acquireAdvisoryLease rollbackAdvisoryLeaseFunc
}

// NewRollbackEngine constructs an engine with sensible defaults.
func NewRollbackEngine(client *listmonkx.Client, db *sql.DB, tenantID string) *RollbackEngine {
	engine := &RollbackEngine{
		Listmonk:       client,
		DB:             db,
		TenantID:       tenantID,
		Audit:          func(_ context.Context, _ string, _ map[string]interface{}) {},
		Now:            time.Now,
		progress:       map[string]*RollbackProgress{},
		executionLocks: defaultRollbackExecutionRegistry,
	}
	if db != nil {
		engine.acquireAdvisoryLease = postgresRollbackAdvisoryLeaseFunc(db)
	}
	return engine
}

// Progress returns a snapshot of the current rollback progress, or nil if no
// rollback has been started for this job.
func (r *RollbackEngine) Progress(jobID string) *RollbackProgress {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.progress[jobID]
	if !ok {
		return nil
	}
	cp := *p
	return &cp
}

// Rollback reverses everything Run() committed for the given job. Safe to
// retry: completed-state idempotency, expired-window refusal, and per-call
// 404-tolerant deletions.
func (r *RollbackEngine) Rollback(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil {
		return fmt.Errorf("rollback: nil job")
	}
	releaseProcess, err := r.tryAcquireProcessExecution(job)
	if err != nil {
		return err
	}
	defer releaseProcess()

	// Idempotent: a finished rollback is a no-op.
	if job.Status == canonical.MigRolledBack {
		return nil
	}
	failedCommit := job.Status == canonical.MigFailed
	if job.Status != canonical.MigCompleted && job.Status != canonical.MigRollingBack && !failedCommit {
		return fmt.Errorf("%w: status=%s", ErrNotRollbackable, job.Status)
	}
	if job.RollbackUntil == nil || r.now().After(*job.RollbackUntil) {
		return ErrRollbackWindowExpired
	}
	releaseAdvisory, err := r.tryAcquireAdvisoryExecution(ctx, job)
	if err != nil {
		return err
	}
	defer releaseAdvisory()
	if err := r.reconcileExternalWriteIntents(ctx, job); err != nil {
		return fmt.Errorf("rollback external-intent reconciliation: %w", err)
	}

	totalsJob := job
	if failedCommit {
		probe := *job
		probe.Progress = canonical.MigrationProgress{}
		totalsJob = &probe
	}
	totals, err := r.rollbackTotals(ctx, totalsJob)
	if err != nil {
		return err
	}
	if failedCommit && (totals.CountSource != "imported_resource_ledger" || totals.total() == 0) {
		return fmt.Errorf("%w: failed commit has no tracked destination writes", ErrNotRollbackable)
	}
	if err := r.preflightRollbackDestinations(ctx, job, totals); err != nil {
		return fmt.Errorf("rollback preflight: %w", err)
	}

	prog := r.startProgress(job, totals)

	// Order matters: delete children before parents so the database doesn't
	// reject due to FK constraints, and so the user never sees a half-deleted
	// state where automations reference subscribers we already wiped.
	steps := []rollbackStep{
		{name: "paid subscriptions", run: r.deletePaidSubscriptions, total: &prog.PaidSubsTotal, done: &prog.PaidSubsDeleted},
		{name: "archive", run: r.deleteArchive, total: &prog.ArchiveTotal, done: &prog.ArchiveDeleted},
		{name: "automations", run: r.deleteAutomations, total: &prog.AutomationsTotal, done: &prog.AutomationsDeleted},
		{name: "templates", run: r.deleteTemplates, total: &prog.TemplatesTotal, done: &prog.TemplatesDeleted},
		{name: "segments", run: r.deleteSegments, total: &prog.SegmentsTotal, done: &prog.SegmentsDeleted},
		{name: "subscribers", run: r.deleteSubscribers, total: &prog.SubscribersTotal, done: &prog.SubscribersDeleted},
		{name: "lists", run: r.deleteLists, total: &prog.ListsTotal, done: &prog.ListsDeleted},
	}

	for _, step := range steps {
		if err := step.run(ctx, job, prog); err != nil {
			r.fail(prog, fmt.Errorf("%s: %w", step.name, err))
			return err
		}
	}
	// Subscriber registry cleanup is intentionally retried even when every
	// subscriber ledger row was already marked rolled back by a prior attempt.
	// This closes the crash window between the final row mark and the cleanup.
	if r.DB != nil && r.TenantID != "" {
		if err := listmonkx.CleanupSubscriberMigrationRegistriesForJob(ctx, r.DB, r.TenantID, job.ID); err != nil {
			cleanupErr := fmt.Errorf("subscriber registry cleanup: %w", err)
			r.fail(prog, cleanupErr)
			return cleanupErr
		}
	}

	r.mu.Lock()
	prog.State = "completed"
	prog.CompletedAt = r.now().UTC().Format(time.RFC3339)
	r.mu.Unlock()

	job.Status = canonical.MigRolledBack
	job.RollbackUntil = nil
	r.Audit(ctx, "migration.rolled_back", map[string]interface{}{
		"job_id":    job.ID,
		"tenant_id": job.TenantID,
		"source":    string(job.Source),
		"counts": map[string]int{
			"archive":     prog.ArchiveDeleted,
			"templates":   prog.TemplatesDeleted,
			"automations": prog.AutomationsDeleted,
			"segments":    prog.SegmentsDeleted,
			"subscribers": prog.SubscribersDeleted,
			"lists":       prog.ListsDeleted,
			"paid_subs":   prog.PaidSubsDeleted,
		},
	})
	return nil
}

// PreflightRollback performs the same whole-job destination conflict checks as
// Rollback without reconciling external intents, mutating destination state, or
// recording rollback progress. Callers must hold the tenant/job migration
// execution lease for the duration of this check so the observed ledger and
// destination state belong to one lifecycle epoch.
func (r *RollbackEngine) PreflightRollback(ctx context.Context, job *canonical.MigrationJob) error {
	if r == nil {
		return fmt.Errorf("%w: rollback engine is not configured", ErrRollbackDestinationUnavailable)
	}
	if job == nil {
		return fmt.Errorf("rollback preflight: nil job")
	}
	tenantID := strings.TrimSpace(r.TenantID)
	if tenantID == "" || tenantID != strings.TrimSpace(job.TenantID) || strings.TrimSpace(job.ID) == "" {
		return fmt.Errorf("%w: rollback preflight tenant/job binding is invalid", ErrRollbackDestinationUnavailable)
	}
	if job.Status != canonical.MigCompleted && job.Status != canonical.MigRollingBack && job.Status != canonical.MigFailed {
		return fmt.Errorf("%w: status=%s", ErrNotRollbackable, job.Status)
	}
	if job.RollbackUntil == nil || r.now().After(*job.RollbackUntil) {
		return ErrRollbackWindowExpired
	}
	if r.DB != nil {
		intentCount, err := listmonkx.CountExternalWriteIntents(ctx, r.DB, tenantID, job.ID)
		if err != nil {
			return fmt.Errorf("inspect unresolved destination writes: %w", err)
		}
		if intentCount > 0 {
			return fmt.Errorf("%w: %d unresolved destination write intent(s) require reconciliation before rollback preflight", ErrRollbackDestinationUnavailable, intentCount)
		}
	}
	totals, err := r.rollbackTotals(ctx, job)
	if err != nil {
		return err
	}
	return r.preflightRollbackDestinations(ctx, job, totals)
}

// HasTrackedWrites lets the HTTP layer offer cleanup for a failed commit only
// when the tenant/job ledger proves that destination mutations exist.
func (r *RollbackEngine) HasTrackedWrites(ctx context.Context, job *canonical.MigrationJob) (bool, error) {
	if r == nil || r.DB == nil || strings.TrimSpace(r.TenantID) == "" || job == nil {
		return false, nil
	}
	if err := r.reconcileExternalWriteIntents(ctx, job); err != nil {
		return false, err
	}
	probe := *job
	probe.Progress = canonical.MigrationProgress{}
	totals, err := r.rollbackTotals(ctx, &probe)
	if err != nil {
		return false, err
	}
	return totals.CountSource == "imported_resource_ledger" && totals.total() > 0, nil
}

func (r *RollbackEngine) reconcileExternalWriteIntents(ctx context.Context, job *canonical.MigrationJob) error {
	if r == nil || r.DB == nil || job == nil || strings.TrimSpace(r.TenantID) == "" {
		return nil
	}
	return listmonkx.ReconcileExternalWriteIntents(ctx, r.Listmonk, r.DB, r.TenantID, job.ID)
}

// MarkFailed records a rollback failure that happened outside the normal
// Rollback error path, for example a recovered panic in the HTTP worker.
func (r *RollbackEngine) MarkFailed(jobID string, err error) {
	if jobID == "" {
		return
	}
	if err == nil {
		err = errors.New("rollback failed")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.progress[jobID]
	if !ok {
		p = &RollbackProgress{
			State:       "failed",
			StartedAt:   now,
			CompletedAt: now,
		}
		r.progress[jobID] = p
	}
	p.State = "failed"
	p.Error = err.Error()
	p.CompletedAt = now
	if p.StartedAt == "" {
		p.StartedAt = now
	}
}

func (r *RollbackEngine) now() time.Time {
	if r != nil && r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *RollbackEngine) startProgress(job *canonical.MigrationJob, totals rollbackResourceTotals) *RollbackProgress {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.progress[job.ID]; ok && existing.State == "running" {
		return existing
	}
	p := &RollbackProgress{
		State:            "running",
		ArchiveTotal:     totals.Archive,
		TemplatesTotal:   totals.Templates,
		AutomationsTotal: totals.Automations,
		SegmentsTotal:    totals.Segments,
		SubscribersTotal: totals.Subscribers,
		ListsTotal:       totals.Lists,
		PaidSubsTotal:    totals.PaidSubs,
		StartedAt:        r.now().UTC().Format(time.RFC3339),
	}
	r.progress[job.ID] = p
	return p
}

type rollbackResourceTotals struct {
	CountSource string
	PaidSubs    int
	Templates   int
	Archive     int
	Automations int
	Segments    int
	Subscribers int
	Lists       int
}

func (t rollbackResourceTotals) total() int {
	return t.PaidSubs + t.Templates + t.Archive + t.Automations + t.Segments + t.Subscribers + t.Lists
}

func (r *RollbackEngine) rollbackTotals(ctx context.Context, job *canonical.MigrationJob) (rollbackResourceTotals, error) {
	if r != nil && r.DB != nil && r.TenantID != "" {
		totals := rollbackResourceTotals{CountSource: "imported_resource_ledger"}
		if err := r.addLedgerCount(ctx, job, &totals.PaidSubs, listmonkx.ResourcePaidSubscription); err != nil {
			return totals, err
		}
		if err := r.addLedgerCount(ctx, job, &totals.Templates, listmonkx.ResourceTemplate); err != nil {
			return totals, err
		}
		for _, resourceType := range []string{
			listmonkx.ResourceCampaignEvent,
			listmonkx.ResourceCampaign,
			listmonkx.ResourceAutomationJourney,
			listmonkx.ResourcePopupForm,
			listmonkx.ResourceLandingPage,
			listmonkx.ResourceCommerceIntegration,
			listmonkx.ResourceSourceArchive,
			listmonkx.ResourceCampaignArchive,
		} {
			if err := r.addLedgerCount(ctx, job, &totals.Archive, resourceType); err != nil {
				return totals, err
			}
		}
		if err := r.addLedgerCount(ctx, job, &totals.Automations, listmonkx.ResourceAutomation); err != nil {
			return totals, err
		}
		if err := r.addLedgerCount(ctx, job, &totals.Segments, listmonkx.ResourceSegment); err != nil {
			return totals, err
		}
		if err := r.addLedgerCount(ctx, job, &totals.Subscribers, listmonkx.ResourceSubscriber); err != nil {
			return totals, err
		}
		if err := r.addLedgerCount(ctx, job, &totals.Lists, listmonkx.ResourceList); err != nil {
			return totals, err
		}
		if totals.total() == 0 && rollbackProgressTotal(job) > 0 {
			historical, err := listmonkx.CountImportedResourceLedgerRows(ctx, r.DB, r.TenantID, job.ID)
			if err != nil {
				return totals, err
			}
			if historical == 0 {
				return totals, fmt.Errorf("%w: imported-resource ledger is empty but job progress records imported resources", ErrRollbackDestinationUnavailable)
			}
			totals.CountSource = "reconciled_imported_resource_ledger"
		}
		return totals, nil
	}
	return rollbackProgressTotals(job), nil
}

func (r *RollbackEngine) addLedgerCount(ctx context.Context, job *canonical.MigrationJob, dst *int, resourceType string) error {
	count, err := listmonkx.CountImportedResources(ctx, r.DB, r.TenantID, job.ID, resourceType)
	if err != nil {
		return fmt.Errorf("count rollback ledger resources %s: %w", resourceType, err)
	}
	*dst += count
	return nil
}

func rollbackProgressTotals(job *canonical.MigrationJob) rollbackResourceTotals {
	if job == nil {
		return rollbackResourceTotals{CountSource: "progress"}
	}
	return rollbackResourceTotals{
		CountSource: "progress",
		PaidSubs:    job.Progress.PaidSubsDone,
		Templates:   job.Progress.TemplatesDone,
		Archive:     job.Progress.ArchiveDone + job.Progress.SourceArchiveDone,
		Automations: job.Progress.AutomationsDone,
		Segments:    job.Progress.SegmentsDone,
		Subscribers: job.Progress.SubscribersDone,
	}
}

func rollbackProgressTotal(job *canonical.MigrationJob) int {
	return rollbackProgressTotals(job).total()
}

func (r *RollbackEngine) validateRollbackDestinations(totals rollbackResourceTotals) error {
	if totals.Subscribers > 0 && (r == nil || r.Listmonk == nil || r.DB == nil || r.TenantID == "") {
		return fmt.Errorf("%w: Listmonk client and Postgres ledger required to restore imported subscribers", ErrRollbackDestinationUnavailable)
	}
	if totals.Lists > 0 && (r == nil || r.Listmonk == nil || r.DB == nil || r.TenantID == "") {
		return fmt.Errorf("%w: Listmonk client and Postgres ledger required to delete imported lists", ErrRollbackDestinationUnavailable)
	}
	if totals.Templates > 0 {
		if r == nil || r.Listmonk == nil {
			return fmt.Errorf("%w: Listmonk client required to delete imported templates", ErrRollbackDestinationUnavailable)
		}
		if r.DB == nil || r.TenantID == "" {
			return fmt.Errorf("%w: Postgres imported-resource ledger required to delete imported templates", ErrRollbackDestinationUnavailable)
		}
	}
	if totals.PaidSubs+totals.Archive+totals.Automations+totals.Segments > 0 && (r == nil || r.DB == nil || r.TenantID == "") {
		return fmt.Errorf("%w: Postgres imported-resource ledger required to delete tracked migration resources", ErrRollbackDestinationUnavailable)
	}
	return nil
}

func (r *RollbackEngine) preflightRollbackDestinations(ctx context.Context, job *canonical.MigrationJob, totals rollbackResourceTotals) error {
	if err := r.validateRollbackDestinations(totals); err != nil {
		return err
	}
	if totals.Subscribers+totals.Lists+totals.Templates > 0 {
		if err := r.Listmonk.ValidateMigrationIsolation(r.TenantID); err != nil {
			return fmt.Errorf("%w: rollback tenant isolation: %v", ErrRollbackDestinationUnavailable, err)
		}
	}
	return r.preflightAllRollbackDestinations(ctx, job, totals)
}

func postgresRollbackResourceTypes() []string {
	return []string{
		listmonkx.ResourceCampaignEvent,
		listmonkx.ResourceCampaign,
		listmonkx.ResourceAutomationJourney,
		listmonkx.ResourcePopupForm,
		listmonkx.ResourceLandingPage,
		listmonkx.ResourceCommerceIntegration,
		listmonkx.ResourceSourceArchive,
		listmonkx.ResourceCampaignArchive,
		listmonkx.ResourcePaidSubscription,
		listmonkx.ResourceAutomation,
		listmonkx.ResourceSegment,
	}
}

// preflightAllRollbackDestinations validates the entire active ledger before
// the first deletion/restoration. Per-step code repeats the relevant checks
// immediately before mutation, but this whole-job pass prevents a conflict in
// a late dependency (for example, an edited subscriber) from being discovered
// only after archive and automation rows were already removed.
func (r *RollbackEngine) preflightAllRollbackDestinations(ctx context.Context, job *canonical.MigrationJob, totals rollbackResourceTotals) error {
	if r.DB != nil && r.TenantID != "" && totals.PaidSubs+totals.Archive+totals.Automations+totals.Segments > 0 {
		if err := listmonkx.ValidateTrackedPostgresResourcesUnchanged(ctx, r.DB, r.TenantID, job.ID, postgresRollbackResourceTypes()); err != nil {
			return err
		}
	}
	if totals.Templates > 0 {
		if err := r.preflightTemplates(ctx, job); err != nil {
			return err
		}
	}
	if totals.Subscribers > 0 {
		if err := r.preflightSubscribers(ctx, job); err != nil {
			return err
		}
	}
	if totals.Lists > 0 {
		if err := r.preflightLists(ctx, job); err != nil {
			return err
		}
	}
	return nil
}

func (r *RollbackEngine) preflightTemplates(ctx context.Context, job *canonical.MigrationJob) error {
	client := r.Listmonk.ForTenant(r.TenantID)
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceTemplate, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			return nil
		}
		for _, res := range tracked {
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("template rollback ledger %s lacks safe create marker", res.ID)
			}
			if _, err := client.TemplateRollbackNeedsDeletion(ctx, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
}

func (r *RollbackEngine) preflightSubscribers(ctx context.Context, job *canonical.MigrationJob) error {
	client := r.Listmonk.ForTenant(r.TenantID)
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceSubscriber, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			return nil
		}
		for _, res := range tracked {
			state, err := parseSubscriberRollbackLedger(res)
			if err != nil {
				return err
			}
			if _, err := client.SubscriberRollbackNeedsMutation(ctx, state.id, state.operation, state.before, state.after); err != nil {
				return err
			}
			if err := listmonkx.ValidateSubscriberMirrorUnchanged(ctx, r.DB, r.TenantID, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
}

func (r *RollbackEngine) preflightLists(ctx context.Context, job *canonical.MigrationJob) error {
	client := r.Listmonk.ForTenant(r.TenantID)
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceList, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			return nil
		}
		for _, res := range tracked {
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("list rollback ledger %s lacks safe create marker", res.ID)
			}
			if _, err := client.ListRollbackNeedsDeletion(ctx, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
}

func (r *RollbackEngine) fail(p *RollbackProgress, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p.State = "failed"
	p.Error = err.Error()
	p.CompletedAt = r.now().UTC().Format(time.RFC3339)
}

type rollbackStep struct {
	name  string
	run   func(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error
	total *int
	done  *int
}

// deletePaidSubscriptions removes mirrored paid-subscription rows for this job.
func (r *RollbackEngine) deletePaidSubscriptions(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	return r.deleteTrackedPostgres(ctx, job, p, listmonkx.ResourcePaidSubscription, "migration.rollback.paid_subscription_deleted", &p.PaidSubsDeleted)
}

func (r *RollbackEngine) deleteTemplates(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	if r.Listmonk == nil || r.DB == nil || r.TenantID == "" {
		return nil
	}
	client := r.Listmonk.ForTenant(r.TenantID)
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceTemplate, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			break
		}
		for _, res := range tracked {
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("template rollback ledger %s lacks safe create marker", res.ID)
			}
			if _, err := client.TemplateRollbackNeedsDeletion(ctx, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceTemplate, "", rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			return nil
		}
		for _, res := range tracked {
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("template rollback ledger %s lacks safe create marker", res.ID)
			}
			id, err := strconv.Atoi(res.DestinationID)
			if err != nil {
				return fmt.Errorf("template destination id %q: %w", res.DestinationID, err)
			}
			needsDeletion, err := client.TemplateRollbackNeedsDeletion(ctx, res)
			if err != nil {
				return err
			}
			if needsDeletion {
				if err := client.DeleteTemplate(ctx, id); err != nil {
					return err
				}
			}
			if err := listmonkx.MarkImportedResourceRolledBack(ctx, r.DB, r.TenantID, res.ID); err != nil {
				return err
			}
			r.mu.Lock()
			p.TemplatesDeleted++
			r.mu.Unlock()
			r.Audit(ctx, "migration.rollback.template_deleted", map[string]interface{}{
				"job_id":      job.ID,
				"resource_id": res.ID,
				"template_id": id,
			})
		}
	}
}

// deleteArchive removes campaign_archive rows previously persisted by the
// orchestrator and tracked for this job.
func (r *RollbackEngine) deleteArchive(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	for _, resource := range []string{
		listmonkx.ResourceCampaignEvent,
		listmonkx.ResourceCampaign,
		listmonkx.ResourceAutomationJourney,
		listmonkx.ResourcePopupForm,
		listmonkx.ResourceLandingPage,
		listmonkx.ResourceCommerceIntegration,
	} {
		if err := r.deleteTrackedPostgres(ctx, job, p, resource, "migration.rollback.materialized_source_deleted", &p.ArchiveDeleted); err != nil {
			return err
		}
	}
	if err := r.deleteTrackedPostgres(ctx, job, p, listmonkx.ResourceSourceArchive, "migration.rollback.source_archive_deleted", &p.ArchiveDeleted); err != nil {
		return err
	}
	return r.deleteTrackedPostgres(ctx, job, p, listmonkx.ResourceCampaignArchive, "migration.rollback.archive_deleted", &p.ArchiveDeleted)
}

// deleteAutomations removes automation rows tracked for this job.
func (r *RollbackEngine) deleteAutomations(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	return r.deleteTrackedPostgres(ctx, job, p, listmonkx.ResourceAutomation, "migration.rollback.automation_deleted", &p.AutomationsDeleted)
}

// deleteSegments removes saved segment rows tracked for this job.
func (r *RollbackEngine) deleteSegments(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	return r.deleteTrackedPostgres(ctx, job, p, listmonkx.ResourceSegment, "migration.rollback.segment_deleted", &p.SegmentsDeleted)
}

func (r *RollbackEngine) deleteTrackedPostgres(ctx context.Context, job *canonical.MigrationJob, _ *RollbackProgress, resourceType, event string, counter *int) error {
	if r.DB == nil || r.TenantID == "" {
		return nil
	}
	for {
		deleted, err := listmonkx.DeleteTrackedPostgresResourcesBatch(ctx, r.DB, r.TenantID, job.ID, resourceType, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(deleted) == 0 {
			return nil
		}
		for _, res := range deleted {
			r.mu.Lock()
			(*counter)++
			r.mu.Unlock()
			r.Audit(ctx, event, map[string]interface{}{
				"job_id":           job.ID,
				"resource_id":      res.ID,
				"source_id":        res.SourceID,
				"destination_type": res.DestinationType,
				"destination_id":   res.DestinationID,
			})
		}
	}
}

// deleteSubscribers removes subscribers we imported by walking Listmonk's
// subscriber search filtered on the postwave_source_platform attrib (which
// the translator stamps on every imported row). Listmonk paginates, so we
// loop until empty.
//
// We swallow per-row 404s so a partial-rollback retry doesn't fail because
// we already removed half of them.
type subscriberRollbackLedgerState struct {
	id        int
	operation listmonkx.UpsertOutcome
	before    listmonkx.SubscriberResponse
	after     listmonkx.SubscriberResponse
}

func parseSubscriberRollbackLedger(res listmonkx.ImportedResource) (subscriberRollbackLedgerState, error) {
	state := subscriberRollbackLedgerState{}
	id, err := strconv.Atoi(res.DestinationID)
	if err != nil {
		return state, fmt.Errorf("subscriber destination id %q: %w", res.DestinationID, err)
	}
	state.id = id
	operation, _ := res.DestinationMetadata["listmonk_operation"].(string)
	state.operation = listmonkx.UpsertOutcome(operation)
	if state.operation != listmonkx.UpsertCreated && state.operation != listmonkx.UpsertUpdated {
		return state, fmt.Errorf("subscriber rollback ledger %s lacks a safe Listmonk operation marker", res.ID)
	}
	raw, marshalErr := json.Marshal(res.DestinationMetadata["listmonk_after"])
	if marshalErr != nil || json.Unmarshal(raw, &state.after) != nil || state.after.ID != id {
		return state, fmt.Errorf("subscriber rollback ledger %s lacks valid Listmonk after-image", res.ID)
	}
	if state.operation == listmonkx.UpsertUpdated {
		raw, marshalErr = json.Marshal(res.DestinationMetadata["listmonk_before"])
		if marshalErr != nil || json.Unmarshal(raw, &state.before) != nil || state.before.ID != id {
			return state, fmt.Errorf("subscriber rollback ledger %s lacks valid Listmonk before-image", res.ID)
		}
	}
	return state, nil
}

func (r *RollbackEngine) deleteSubscribers(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) (err error) {
	if p == nil || p.SubscribersTotal == 0 {
		return nil
	}
	if r.Listmonk == nil || r.DB == nil || r.TenantID == "" {
		return fmt.Errorf("%w: subscriber rollback requires Listmonk and Postgres ledger", ErrRollbackDestinationUnavailable)
	}
	lease, err := listmonkx.AcquireSubscriberBatchLease(ctx, r.DB, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Release()) }()
	client := r.Listmonk.ForTenant(r.TenantID)
	// Validate every destination first. A conflict on a later row must not
	// leave an earlier subscriber already restored/deleted, and an overlapping
	// migration or UI edit must never be clobbered by snapshot rollback.
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceSubscriber, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			break
		}
		for _, res := range tracked {
			state, err := parseSubscriberRollbackLedger(res)
			if err != nil {
				return err
			}
			if _, err := client.SubscriberRollbackNeedsMutation(ctx, state.id, state.operation, state.before, state.after); err != nil {
				return err
			}
			if err := listmonkx.ValidateSubscriberMirrorUnchanged(ctx, r.DB, r.TenantID, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceSubscriber, "", rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			break
		}
		for _, res := range tracked {
			state, err := parseSubscriberRollbackLedger(res)
			if err != nil {
				return err
			}
			// Recheck immediately before the external mutation. This narrows the
			// unavoidable API race after the all-row preflight and recognizes an
			// intended terminal state left by a prior partial rollback attempt.
			needsMutation, err := client.SubscriberRollbackNeedsMutation(ctx, state.id, state.operation, state.before, state.after)
			if err != nil {
				return err
			}
			if needsMutation {
				switch state.operation {
				case listmonkx.UpsertCreated:
					if err := client.DeleteSubscriber(ctx, state.id); err != nil {
						return err
					}
				case listmonkx.UpsertUpdated:
					if err := client.RestoreSubscriber(ctx, state.before); err != nil {
						return err
					}
				default:
					return fmt.Errorf("subscriber rollback ledger %s lacks a safe Listmonk operation marker", res.ID)
				}
			}
			if err := listmonkx.RestoreSubscriberMirrorAndMark(ctx, r.DB, r.TenantID, res); err != nil {
				return err
			}
			r.mu.Lock()
			p.SubscribersDeleted++
			r.mu.Unlock()
			r.Audit(ctx, "migration.rollback.subscriber_restored", map[string]interface{}{
				"job_id":        job.ID,
				"resource_id":   res.ID,
				"subscriber_id": state.id,
				"operation":     string(state.operation),
			})
		}
	}
	return listmonkx.CleanupSubscriberMigrationRegistriesForJob(ctx, r.DB, r.TenantID, job.ID)
}

func (r *RollbackEngine) deleteLists(ctx context.Context, job *canonical.MigrationJob, p *RollbackProgress) error {
	if p == nil || p.ListsTotal == 0 {
		return nil
	}
	if r.Listmonk == nil || r.DB == nil || r.TenantID == "" {
		return nil
	}
	client := r.Listmonk.ForTenant(r.TenantID)
	afterID := ""
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceList, afterID, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			break
		}
		for _, res := range tracked {
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("list rollback ledger %s lacks safe create marker", res.ID)
			}
			if _, err := client.ListRollbackNeedsDeletion(ctx, res); err != nil {
				return err
			}
		}
		afterID = tracked[len(tracked)-1].ID
	}
	for {
		tracked, err := listmonkx.ListImportedResourcesPage(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceList, "", rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		if len(tracked) == 0 {
			return nil
		}
		for _, res := range tracked {
			id, err := strconv.Atoi(res.DestinationID)
			if err != nil {
				return fmt.Errorf("list destination id %q: %w", res.DestinationID, err)
			}
			if operation, _ := res.DestinationMetadata["operation"].(string); operation != "created" {
				return fmt.Errorf("list rollback ledger %s lacks safe create marker", res.ID)
			}
			needsDeletion, err := client.ListRollbackNeedsDeletion(ctx, res)
			if err != nil {
				return err
			}
			if needsDeletion {
				if err := client.DeleteList(ctx, id); err != nil {
					return err
				}
			}
		}
		deleted, err := listmonkx.DeleteTrackedPostgresResourcesBatch(ctx, r.DB, r.TenantID, job.ID, listmonkx.ResourceList, rollbackLedgerBatchSize)
		if err != nil {
			return err
		}
		for _, res := range deleted {
			r.mu.Lock()
			p.ListsDeleted++
			r.mu.Unlock()
			r.Audit(ctx, "migration.rollback.list_deleted", map[string]interface{}{
				"job_id":      job.ID,
				"resource_id": res.ID,
				"list_id":     res.DestinationID,
			})
		}
	}
}
