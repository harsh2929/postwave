// Package orchestrator wires migration adapters (read side) to the Listmonk
// translator (write side). It is intentionally durable-friendly: every public
// method takes a context, accepts a *canonical.MigrationJob (so cursors are
// observable), and reports progress through a callback so SSE / Inngest can
// be added later without changing the call sites.
package orchestrator

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

// ProgressFn is called after each batch with the updated counters. The closure
// is the SSE seam: today the handler ignores it; tomorrow it'll pump events.
type ProgressFn func(canonical.MigrationProgress)

type templateLister interface {
	ListTemplates(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.EmailTemplate, string, error)
}

// Orchestrator coordinates one migration job from end to end.
type Orchestrator struct {
	Listmonk *listmonkx.Client
	DB       *sql.DB // for automations + campaign_archive persistence
	TenantID string

	// DryRun, when true, performs reads and verification but skips all writes.
	DryRun bool

	// verifier accumulates per-resource observations during the run; populated
	// fresh per Run() invocation.
	verifier *VerifierInput

	audienceMappings                   map[string]listmonkx.AudienceMapping
	templateDestinationIDs             map[string]string
	automationTemplateReferencesLoaded bool
	dryRunPlannedNew                   int
	dryRunPlannedEmails                map[string]struct{}
	checkpointErr                      error
	mailchimpCustomFields              map[string]string
	beehiivFingerprint                 *beehiivFingerprintAccumulator
	hubSpotFingerprint                 *hubSpotFingerprintAccumulator
	klaviyoFingerprint                 *klaviyoFingerprintAccumulator
	customerIOFingerprint              *customerIOFingerprintAccumulator
}

const automationTemplateMapCursorKey = "__postwave_template_destination_ids"
const beehiivArchiveClassificationCutoffCursorKey = "__postwave_beehiiv_archive_classification_cutoff"
const maxSubscriberTraversalPageCalls = 1_000_000
const maxArchiveTrackedIdentities = 1_000_000

// maxArchiveTraversalPageCalls is the runaway-loop backstop for archive
// pagination: a source platform that never stops handing back a next-cursor
// would otherwise page forever. It sat inline as a bare 100000 at both
// traversal sites, with the same number repeated inside each error string —
// four copies that had to be edited in step to move one bound, next to two
// siblings on the identical concern that were already named.
const maxArchiveTraversalPageCalls = 100000

func bindBeehiivArchiveClassificationCutoff(job *canonical.MigrationJob, sess adapter.Session, now time.Time) (adapter.Session, error) {
	if job == nil {
		return sess, fmt.Errorf("Beehiiv archive classification requires a migration job")
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	var cutoff time.Time
	if raw, ok := cursorStringValue(job.Cursor, beehiivArchiveClassificationCutoffCursorKey); ok {
		parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
		if err != nil || parsed.Unix() <= 0 {
			return sess, fmt.Errorf("Beehiiv archive classification checkpoint is invalid")
		}
		cutoff = parsed.UTC().Truncate(time.Second)
	} else {
		if now.IsZero() {
			now = time.Now().UTC()
		}
		cutoff = now.UTC().Truncate(time.Second)
		raw := cutoff.Format(time.RFC3339Nano)
		job.Cursor[beehiivArchiveClassificationCutoffCursorKey] = &raw
	}
	if supplied := strings.TrimSpace(sess.Extra[beehiiv.ArchiveClassificationCutoffExtraKey]); supplied != "" {
		parsed, err := time.Parse(time.RFC3339Nano, supplied)
		if err != nil || !parsed.UTC().Truncate(time.Second).Equal(cutoff) {
			return sess, fmt.Errorf("Beehiiv archive classification session does not match the durable job checkpoint")
		}
	}
	extra := make(map[string]string, len(sess.Extra)+1)
	for key, value := range sess.Extra {
		extra[key] = value
	}
	extra[beehiiv.ArchiveClassificationCutoffExtraKey] = cutoff.Format(time.RFC3339Nano)
	sess.Extra = extra
	return sess, nil
}

func cursorStringValue(cursor map[string]*string, key string) (string, bool) {
	value, ok := cursor[key]
	if !ok || value == nil {
		return "", false
	}
	return *value, true
}

func (o *Orchestrator) restartBeehiivRunOnRecovery(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil || !beehiivExecutionStarted(job) {
		return nil
	}
	if o.DB != nil && strings.TrimSpace(o.TenantID) != "" {
		if err := ClearSubscriberVerifierObservations(ctx, o.DB, o.TenantID, job.ID); err != nil {
			return fmt.Errorf("restart Beehiiv snapshot after interrupted run: %w", err)
		}
	}
	cutoff, hasCutoff := cursorStringValue(job.Cursor, beehiivArchiveClassificationCutoffCursorKey)
	ResetExecutionState(job)
	if hasCutoff {
		job.Cursor[beehiivArchiveClassificationCutoffCursorKey] = &cutoff
	}
	job.Progress = canonical.MigrationProgress{}
	o.verifier = NewVerifierInput()
	if err := persistVerifierCheckpoint(job, o.verifier, o.DB != nil && strings.TrimSpace(o.TenantID) != ""); err != nil {
		return fmt.Errorf("restart Beehiiv verification checkpoint: %w", err)
	}
	return nil
}

func (o *Orchestrator) restartKlaviyoRunOnRecovery(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil || !exactSnapshotExecutionStarted(job) {
		return nil
	}
	if o.DB != nil && strings.TrimSpace(o.TenantID) != "" {
		if err := ClearSubscriberVerifierObservations(ctx, o.DB, o.TenantID, job.ID); err != nil {
			return fmt.Errorf("restart Klaviyo snapshot after interrupted run: %w", err)
		}
	}
	ResetExecutionState(job)
	job.Progress = canonical.MigrationProgress{}
	o.verifier = NewVerifierInput()
	if err := persistVerifierCheckpoint(job, o.verifier, o.DB != nil && strings.TrimSpace(o.TenantID) != ""); err != nil {
		return fmt.Errorf("restart Klaviyo verification checkpoint: %w", err)
	}
	return nil
}

func (o *Orchestrator) restartHubSpotRunOnRecovery(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil || !exactSnapshotExecutionStarted(job) {
		return nil
	}
	if o.DB != nil && strings.TrimSpace(o.TenantID) != "" {
		if err := ClearSubscriberVerifierObservations(ctx, o.DB, o.TenantID, job.ID); err != nil {
			return fmt.Errorf("restart HubSpot snapshot after interrupted run: %w", err)
		}
	}
	ResetExecutionState(job)
	job.Progress = canonical.MigrationProgress{}
	o.verifier = NewVerifierInput()
	if err := persistVerifierCheckpoint(job, o.verifier, o.DB != nil && strings.TrimSpace(o.TenantID) != ""); err != nil {
		return fmt.Errorf("restart HubSpot verification checkpoint: %w", err)
	}
	return nil
}

func (o *Orchestrator) restartCustomerIORunOnRecovery(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil || !exactSnapshotExecutionStarted(job) {
		return nil
	}
	if o.DB != nil && strings.TrimSpace(o.TenantID) != "" {
		if err := ClearSubscriberVerifierObservations(ctx, o.DB, o.TenantID, job.ID); err != nil {
			return fmt.Errorf("restart Customer.io snapshot after interrupted run: %w", err)
		}
	}
	ResetExecutionState(job)
	job.Progress = canonical.MigrationProgress{}
	o.verifier = NewVerifierInput()
	if err := persistVerifierCheckpoint(job, o.verifier, o.DB != nil && strings.TrimSpace(o.TenantID) != ""); err != nil {
		return fmt.Errorf("restart Customer.io verification checkpoint: %w", err)
	}
	return nil
}

func beehiivExecutionStarted(job *canonical.MigrationJob) bool {
	if job == nil {
		return false
	}
	if job.Progress != (canonical.MigrationProgress{}) {
		return true
	}
	for _, stage := range executionStages {
		if _, ok := job.Cursor[stage]; ok {
			return true
		}
		if _, ok := job.Cursor[stageDoneKey(stage)]; ok {
			return true
		}
	}
	return false
}

func exactSnapshotExecutionStarted(job *canonical.MigrationJob) bool {
	if job == nil {
		return false
	}
	if job.Progress != (canonical.MigrationProgress{}) {
		return true
	}
	for _, stage := range executionStages {
		if _, ok := job.Cursor[stage]; ok {
			return true
		}
		if _, ok := job.Cursor[stageDoneKey(stage)]; ok {
			return true
		}
	}
	return false
}

// Run executes the full pipeline (subscribers → segments → automations →
// archive → paid subs) using the supplied adapter and session. The job's
// Cursor map is updated in place so callers can persist incremental progress.
//
// At the end of the run (success or failure mid-pipeline), Run computes a
// canonical.VerificationReport and stores it on the job.
func (o *Orchestrator) Run(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	if progress == nil {
		progress = func(canonical.MigrationProgress) {}
	}
	externalProgress := progress
	o.verifier = loadVerifierCheckpoint(job)
	progress = func(current canonical.MigrationProgress) {
		if err := persistVerifierCheckpoint(job, o.verifier, o.DB != nil && o.TenantID != ""); err != nil {
			o.checkpointErr = err
			return
		}
		externalProgress(current)
	}
	// Reference maps are job-scoped. Reusing an Orchestrator across jobs must
	// never leak a template, audience, or plan-limit reservation from a prior
	// tenant/job into this run.
	o.audienceMappings = nil
	o.templateDestinationIDs = nil
	o.automationTemplateReferencesLoaded = false
	o.dryRunPlannedNew = 0
	o.dryRunPlannedEmails = map[string]struct{}{}
	o.checkpointErr = nil
	o.beehiivFingerprint = nil
	o.hubSpotFingerprint = nil
	o.klaviyoFingerprint = nil
	o.customerIOFingerprint = nil
	if o.DB != nil && o.TenantID != "" && job != nil {
		// Subscriber observations are DB-backed in this mode. Discard any
		// legacy inline copy before replaying the durable rows or a retry would
		// count the same page twice.
		clearSubscriberVerifierState(o.verifier)
		if err := o.loadSubscriberVerifierObservations(ctx, job); err != nil {
			return fmt.Errorf("load subscriber verification checkpoint: %w", err)
		}
	}
	caps := ad.Capabilities()
	_, hasSourceArchive := ad.(adapter.SourceArchiveAdapter)
	preflightErr := o.validateCommitPrereqs(caps, hasSourceArchive)
	source := caps.Source
	if job != nil && job.Source != "" {
		source = job.Source
	}
	if source == canonical.SourceMailchimp {
		// A recovery attempt resumes the partially accumulated dry-run plan.
		// Fresh dry-runs explicitly call ResetMailchimpCustomFieldPlan at the
		// handler boundary; resetting here would lose earlier pages after a
		// worker crash.
		o.mailchimpCustomFields = loadMailchimpCustomFieldPlan(job)
	}
	if source == canonical.SourceBeehiiv {
		if !o.DryRun {
			o.beehiivFingerprint = newBeehiivFingerprintAccumulator()
		}
		if restartErr := o.restartBeehiivRunOnRecovery(ctx, job); restartErr != nil {
			preflightErr = restartErr
		}
		var cutoffErr error
		sess, cutoffErr = bindBeehiivArchiveClassificationCutoff(job, sess, time.Now().UTC())
		if cutoffErr != nil {
			preflightErr = cutoffErr
		}
	}
	if source == canonical.SourceKlaviyo && !o.DryRun {
		o.klaviyoFingerprint = newKlaviyoFingerprintAccumulator()
		if restartErr := o.restartKlaviyoRunOnRecovery(ctx, job); restartErr != nil {
			preflightErr = restartErr
		}
	}
	if source == canonical.SourceHubSpot && !o.DryRun {
		o.hubSpotFingerprint = newHubSpotFingerprintAccumulator()
		if restartErr := o.restartHubSpotRunOnRecovery(ctx, job); restartErr != nil {
			preflightErr = restartErr
		}
	}
	if source == canonical.SourceCustomerIO && !o.DryRun {
		o.customerIOFingerprint = newCustomerIOFingerprintAccumulator()
		if restartErr := o.restartCustomerIORunOnRecovery(ctx, job); restartErr != nil {
			preflightErr = restartErr
		}
	}

	// Capture an upfront discovery snapshot so the report has source-side
	// totals to compare against. Most sources can fall back to orchestrator-side
	// counters, but ActiveCampaign cutover gates require a successful contact
	// discovery preflight so optional-surface totals and warnings cannot be
	// silently omitted from the verification report. HubSpot bridge cutovers
	// also require a complete upfront contact/property/list inventory so the
	// CRM bridge cannot certify with partial source scope.
	if preflightErr == nil {
		if disc, err := ad.Discover(ctx, sess); err == nil {
			o.verifier.Discovery = disc
			if source == canonical.SourceHubSpot && !o.DryRun {
				if fingerprintErr := observeHubSpotProviderFingerprintEvidence(ctx, ad, sess, disc, o.hubSpotFingerprint, "commit"); fingerprintErr != nil {
					preflightErr = fmt.Errorf("HubSpot final-delta source fingerprint preflight: %w", fingerprintErr)
				}
			}
			if source == canonical.SourceCustomerIO && !o.DryRun {
				if fingerprintErr := observeCustomerIONonEmailIdentityFingerprint(ctx, ad, sess, disc, o.customerIOFingerprint, "commit"); fingerprintErr != nil {
					preflightErr = fmt.Errorf("Customer.io final-delta source fingerprint preflight: %w", fingerprintErr)
				}
			}
			if o.DryRun && caps.Supports.Subscribers && (o.Listmonk == nil || o.Listmonk.ValidateMigrationIsolation(o.TenantID) != nil) {
				o.verifier.Discovery.Warnings = append(o.verifier.Discovery.Warnings,
					"Import requires a tenant-dedicated Listmonk destination bound to this workspace. This dry-run does not check destination credentials; destination access and isolation are checked before import writes begin.")
			}
			seedProgressTotals(job, disc)
			if source == canonical.SourceMailchimp && o.DB != nil && o.TenantID != "" {
				if limitErr := validateMigrationResourceLimits(ctx, o.DB, o.TenantID, job.ID, source, disc); limitErr != nil {
					if o.DryRun {
						o.verifier.Discovery.Warnings = append(o.verifier.Discovery.Warnings, "Commit resource-limit preflight: "+limitErr.Error())
					} else {
						preflightErr = fmt.Errorf("Mailchimp destination resource-limit preflight: %w", limitErr)
					}
				}
			}
		} else if sourceRequiresDiscoveryPreflight(source) {
			preflightErr = fmt.Errorf("source discovery preflight: %w", err)
		}
	}

	runErr := func() error {
		if preflightErr != nil {
			return preflightErr
		}
		if caps.Supports.Subscribers {
			if err := executeStage(job, stageSubscribers, progress, func() error { return o.runSubscribers(ctx, ad, sess, job, progress) }); err != nil {
				return fmt.Errorf("subscribers: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("subscribers: persist durable migration progress: %w", o.checkpointErr)
			}
			if exactSubscriberSnapshotSource(source) {
				if err := validateSnapshotSubscriberTraversalEvidence(o.verifier, source); err != nil {
					return fmt.Errorf("subscribers: %w", err)
				}
			}
		}
		if caps.Supports.Segments {
			if err := executeStage(job, stageSegments, progress, func() error { return o.runSegments(ctx, ad, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
				return fmt.Errorf("segments: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("segments: persist durable migration progress: %w", o.checkpointErr)
			}
		}
		if caps.Supports.Templates {
			if tl, ok := ad.(templateLister); ok {
				if err := executeStage(job, stageTemplates, progress, func() error { return o.runTemplates(ctx, tl, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
					return fmt.Errorf("templates: %w", err)
				}
				if o.checkpointErr != nil {
					return fmt.Errorf("templates: persist durable migration progress: %w", o.checkpointErr)
				}
			}
		}
		if caps.Supports.Automations {
			if err := executeStage(job, stageAutomations, progress, func() error { return o.runAutomations(ctx, ad, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
				return fmt.Errorf("automations: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("automations: persist durable migration progress: %w", o.checkpointErr)
			}
		}
		if caps.Supports.CampaignArchive {
			if err := executeStage(job, stageArchive, progress, func() error { return o.runArchive(ctx, ad, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
				return fmt.Errorf("archive: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("archive: persist durable migration progress: %w", o.checkpointErr)
			}
		}
		if sourceArchiver, ok := ad.(adapter.SourceArchiveAdapter); ok {
			if err := executeStage(job, stageSourceArchive, progress, func() error { return o.runSourceArchive(ctx, sourceArchiver, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
				return fmt.Errorf("source archive: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("source archive: persist durable migration progress: %w", o.checkpointErr)
			}
		}
		if caps.Supports.PaidSubs {
			if err := executeStage(job, stagePaidSubs, progress, func() error { return o.runPaidSubs(ctx, ad, sess, job, progress) }); err != nil && !errors.Is(err, adapter.ErrUnsupported) {
				return fmt.Errorf("paid subs: %w", err)
			}
			if o.checkpointErr != nil {
				return fmt.Errorf("paid subs: persist durable migration progress: %w", o.checkpointErr)
			}
		}
		return nil
	}()
	if runErr == nil && o.checkpointErr != nil {
		runErr = o.checkpointErr
	}
	if runErr == nil && source == canonical.SourceBeehiiv && !o.DryRun {
		fingerprint, fingerprintErr := o.beehiivFingerprint.fingerprint()
		if fingerprintErr == nil {
			fingerprintErr = persistBeehiivSourceFingerprint(job, fingerprint)
		}
		if fingerprintErr != nil {
			runErr = fmt.Errorf("persist Beehiiv final-delta source fingerprint: %w", fingerprintErr)
		}
	}
	if runErr == nil && source == canonical.SourceKlaviyo && !o.DryRun {
		fingerprint, fingerprintErr := o.klaviyoFingerprint.fingerprint()
		if fingerprintErr == nil {
			fingerprintErr = validateKlaviyoFingerprintAgainstDiscovery(fingerprint, o.verifier.Discovery)
		}
		if fingerprintErr == nil {
			fingerprintErr = persistKlaviyoSourceFingerprint(job, fingerprint)
		}
		if fingerprintErr != nil {
			runErr = fmt.Errorf("persist Klaviyo final-delta source fingerprint: %w", fingerprintErr)
		}
	}
	if runErr == nil && source == canonical.SourceHubSpot && !o.DryRun {
		fingerprint, fingerprintErr := o.hubSpotFingerprint.fingerprint()
		if fingerprintErr == nil {
			fingerprintErr = validateHubSpotFingerprintAgainstDiscovery(fingerprint, o.verifier.Discovery)
		}
		if fingerprintErr == nil {
			fingerprintErr = persistHubSpotSourceFingerprint(job, fingerprint)
		}
		if fingerprintErr != nil {
			runErr = fmt.Errorf("persist HubSpot final-delta source fingerprint: %w", fingerprintErr)
		}
	}
	if runErr == nil && source == canonical.SourceCustomerIO && !o.DryRun {
		fingerprint, fingerprintErr := o.customerIOFingerprint.fingerprint()
		if fingerprintErr == nil {
			fingerprintErr = validateCustomerIOFingerprintAgainstDiscovery(fingerprint, o.verifier.Discovery)
		}
		if fingerprintErr == nil {
			fingerprintErr = persistCustomerIOSourceFingerprint(job, fingerprint)
		}
		if fingerprintErr != nil {
			runErr = fmt.Errorf("persist Customer.io final-delta source fingerprint: %w", fingerprintErr)
		}
	}

	// Always materialise the verification report — even if the run failed
	// halfway, the partial report tells the user where things went wrong.
	report := BuildReport(o.verifier, job)
	job.VerificationReport = &report
	emitMigrationRunMetrics(job, caps, o.verifier, report, preflightErr, runErr, o.DryRun)

	// Fan out a terminal webhook event so tenant integrations (CRM
	// tagging, Slack ping, mobile push) can react. Best-effort: an
	// outbox-write failure must NOT change the run result; we surface
	// it via the returned error wrap only when the run otherwise
	// succeeded, so it doesn't mask a real migration failure.
	eventType := "migration.completed"
	var rateLimited *adapter.ErrRateLimited
	if runErr != nil {
		if errors.As(runErr, &rateLimited) {
			eventType = ""
		} else {
			eventType = "migration.failed"
		}
	}
	if o.DB != nil && o.TenantID != "" && eventType != "" {
		body := map[string]any{
			"job_id":              job.ID,
			"tenant_id":           o.TenantID,
			"source":              job.Source,
			"verification_report": job.VerificationReport,
		}
		if runErr != nil {
			body["error"] = runErr.Error()
		}
		_ = emitFanout(ctx, o.DB, o.TenantID, eventType, body)

		// Telemetry: hard signal — a migration just terminated.
		// Structured log only (no row data leaked); the logs →
		// PostHog forwarder picks up the "event:posthog:" prefix.
		// We track BOTH success and failure so funnel analysis sees
		// the full distribution.
		slog.Info("event:posthog:migration_completed",
			"event", "migration_completed",
			"tenant_id", o.TenantID,
			"job_id", job.ID,
			"source", job.Source,
			"ok", runErr == nil,
		)
	}

	return runErr
}

func validateBeehiivSubscriberTraversalEvidence(in *VerifierInput) error {
	return validateSnapshotSubscriberTraversalEvidence(in, canonical.SourceBeehiiv)
}

func validateSnapshotSubscriberTraversalEvidence(in *VerifierInput, source canonical.SourcePlatform) error {
	label := strings.TrimSpace(string(source))
	if label == "" {
		label = "source"
	}
	if in == nil {
		return fmt.Errorf("%s subscriber evidence is unavailable: %w", label, adapter.ErrSourceUnavailable)
	}
	discovery := in.Discovery
	if len(in.SubscriberSourceIDs) != discovery.SubscribersTotal {
		return fmt.Errorf("%s subscriber traversal observed %d unique source IDs, but discovery bound %d: %w", label, len(in.SubscriberSourceIDs), discovery.SubscribersTotal, adapter.ErrSourceUnavailable)
	}
	if (source == canonical.SourceBeehiiv || source == canonical.SourceSubstack) && in.PremiumMembershipsObserved != discovery.PaidSubsTotal {
		return fmt.Errorf("%s subscriber traversal observed %d premium memberships, but discovery bound %d: %w", sourceDisplayName(source), in.PremiumMembershipsObserved, discovery.PaidSubsTotal, adapter.ErrSourceUnavailable)
	}
	for tag, expected := range discovery.SnapshotMembershipCounts {
		if expected < 0 {
			return fmt.Errorf("%s discovery returned a negative membership count for %q: %w", label, tag, adapter.ErrSourceUnavailable)
		}
		if actual := in.SubscriberTagCounts[tag]; actual != expected {
			return fmt.Errorf("%s subscriber traversal applied %d of %d memberships for %q: %w", label, actual, expected, tag, adapter.ErrSourceUnavailable)
		}
	}
	for tag, actual := range in.SubscriberTagCounts {
		if !snapshotMembershipTagForSource(source, tag) {
			continue
		}
		if _, discovered := discovery.SnapshotMembershipCounts[tag]; !discovered {
			return fmt.Errorf("%s subscriber traversal returned %d memberships for undiscovered audience %q: %w", label, actual, tag, adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func snapshotMembershipTagForSource(source canonical.SourcePlatform, tag string) bool {
	switch source {
	case canonical.SourceBeehiiv:
		return strings.HasPrefix(tag, "beehiiv:segment:") || strings.HasPrefix(tag, "beehiiv:newsletter-list:")
	case canonical.SourceKlaviyo:
		return strings.HasPrefix(tag, "klaviyo:list:") || strings.HasPrefix(tag, "klaviyo:segment:")
	case canonical.SourceCustomerIO:
		return strings.HasPrefix(tag, "customerio:segment:") || strings.HasPrefix(tag, "customerio:topic:")
	case canonical.SourceHubSpot:
		return strings.HasPrefix(tag, "hubspot:list:") || strings.HasPrefix(tag, "hubspot:subscription:")
	default:
		return false
	}
}

func sourceRequiresDiscoveryPreflight(source canonical.SourcePlatform) bool {
	return source == canonical.SourceActiveCampaign || source == canonical.SourceHubSpot || source == canonical.SourceMailchimp || source == canonical.SourceBeehiiv || source == canonical.SourceKlaviyo || source == canonical.SourceCustomerIO
}

func executeStage(job *canonical.MigrationJob, stage string, progress ProgressFn, run func() error) error {
	if stageCompleted(job, stage) {
		return nil
	}
	err := run()
	if err == nil || errors.Is(err, adapter.ErrUnsupported) {
		markStageCompleted(job, stage)
		if progress != nil && job != nil {
			progress(job.Progress)
		}
	}
	return err
}

func (o *Orchestrator) reportProgress(progress ProgressFn, current canonical.MigrationProgress) error {
	if progress != nil {
		progress(current)
	}
	if o != nil && o.checkpointErr != nil {
		return fmt.Errorf("persist durable migration progress: %w", o.checkpointErr)
	}
	return nil
}

// RecordProgressPersistenceError lets the durable job-store callback stop the
// orchestrator at the same checkpoint boundary. Logging and continuing would
// allow later destination mutations to outrun the last durable cursor and be
// replayed after a worker crash.
func (o *Orchestrator) RecordProgressPersistenceError(err error) {
	if o == nil || err == nil || o.checkpointErr != nil {
		return
	}
	o.checkpointErr = err
}

func emitMigrationRunMetrics(job *canonical.MigrationJob, caps canonical.AdapterCapabilities, in *VerifierInput, report canonical.VerificationReport, preflightErr, runErr error, dryRun bool) {
	if job == nil {
		return
	}
	var preflightMsg string
	if preflightErr != nil {
		preflightMsg = preflightErr.Error()
	}
	var errMsg string
	if runErr != nil {
		errMsg = runErr.Error()
	}
	staticMemberships := 0
	tagsSeen := 0
	if in != nil {
		staticMemberships = in.StaticSegmentMemberships
		tagsSeen = in.SubscriberTagsSeen
	}
	slog.Info("event:posthog:migration_resource_metrics",
		"event", "migration_resource_metrics",
		"tenant_id", job.TenantID,
		"job_id", job.ID,
		"source", job.Source,
		"dry_run", dryRun,
		"ok", runErr == nil,
		"preflight_error", preflightMsg,
		"error", errMsg,
		"supports_templates", caps.Supports.Templates,
		"discovered_subscribers", job.Progress.SubscribersTotal,
		"imported_subscribers", report.SubscribersImported,
		"subscriber_tag_assignments", tagsSeen,
		"static_segment_memberships", staticMemberships,
		"duplicate_subscribers_merged", report.DuplicateSubscribersMerged,
		"segments_translated", report.SegmentsTranslated,
		"segments_with_warnings", len(report.SegmentsWithWarnings),
		"templates_imported", report.TemplatesImported,
		"template_warnings", len(report.TemplateWarnings),
		"archive_imported", report.ArchiveImported,
		"discovery_warnings", len(report.DiscoveryWarnings),
		"campaign_archive_warnings", len(report.CampaignArchiveWarnings),
		"source_archive_imported", report.SourceArchiveImported,
		"source_archive_warnings", len(report.SourceArchiveWarnings),
		"data_loss_estimate_pct", report.DataLossEstimatePct,
	)
}

func (o *Orchestrator) validateCommitPrereqs(caps canonical.AdapterCapabilities, hasSourceArchive bool) error {
	if o.DryRun {
		return nil
	}
	if (caps.Supports.Subscribers || caps.Supports.Templates) && o.Listmonk == nil {
		return fmt.Errorf("migration commit requires Listmonk writer credentials for subscribers/templates")
	}
	if caps.Source == canonical.SourceMailchimp {
		if err := o.Listmonk.ValidateMigrationIsolation(o.TenantID); err != nil {
			return fmt.Errorf("Mailchimp migration commit tenant isolation: %w", err)
		}
		if o.DB == nil || o.TenantID == "" {
			return fmt.Errorf("Mailchimp migration commit requires Moosewave DB and tenant scope before any destination mutation")
		}
	}
	if caps.Supports.Subscribers {
		if o.DB == nil || o.TenantID == "" {
			return fmt.Errorf("migration commit requires Moosewave DB and tenant scope for subscribers")
		}
		if err := o.Listmonk.ValidateMigrationIsolation(o.TenantID); err != nil {
			return fmt.Errorf("migration commit tenant isolation: %w", err)
		}
	}
	dbRequired := caps.Supports.Segments ||
		caps.Supports.Subscribers ||
		caps.Supports.Automations ||
		caps.Supports.CampaignArchive ||
		caps.Supports.PaidSubs ||
		hasSourceArchive
	if dbRequired && (o.DB == nil || o.TenantID == "") {
		return fmt.Errorf("migration commit requires Moosewave DB and tenant scope for persisted resources")
	}
	return nil
}

func seedProgressTotals(job *canonical.MigrationJob, disc adapter.DiscoveryReport) {
	if job == nil {
		return
	}
	job.Progress.SubscribersTotal = disc.SubscribersTotal
	job.Progress.SegmentsTotal = disc.SegmentsTotal
	job.Progress.AutomationsTotal = disc.AutomationsTotal
	job.Progress.PaidSubsTotal = disc.PaidSubsTotal
	job.Progress.ArchiveTotal = disc.ArchiveTotal
	job.Progress.TemplatesTotal = disc.TemplatesTotal
	job.Progress.SourceArchiveTotal = sourceArchiveExpectedTotal(job.Source, disc)
}

func (o *Orchestrator) runSubscribers(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	var snapshotCustomFields map[string]string
	if exactSubscriberSnapshotSource(job.Source) && !o.DryRun {
		label := sourceDisplayName(job.Source)
		emptyPageAllowance := 0
		if job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO || job.Source == canonical.SourceHubSpot {
			emptyPageAllowance = o.verifier.Discovery.ProfilesWithoutEmailTotal
		}
		plan, err := preflightSnapshotCommitCustomFields(ctx, ad, sess, job.Source, label, job.Progress.SubscribersTotal, emptyPageAllowance)
		if err != nil {
			return err
		}
		if err := listmonkx.ValidateImportedCustomFieldPlan(ctx, o.DB, o.TenantID, plan); err != nil {
			return fmt.Errorf("%s custom-field schema preflight: %w", label, err)
		}
		snapshotCustomFields = plan
	}
	if job.Source == canonical.SourceMailchimp && !o.DryRun {
		if !mailchimpCustomFieldPlanComplete(job) {
			return fmt.Errorf("Mailchimp commit requires a completed dry-run custom-field schema preflight before any destination mutation")
		}
		if err := listmonkx.ValidateImportedCustomFieldPlan(ctx, o.DB, o.TenantID, o.mailchimpCustomFields); err != nil {
			return fmt.Errorf("Mailchimp custom-field schema preflight: %w", err)
		}
		// Validate the complete live source traversal against the reviewed plan
		// before lists or subscribers are mutated. Per-page validation during
		// writes is too late: a new key on page N would otherwise be discovered
		// after pages 1..N-1 had already committed.
		if err := preflightMailchimpCommitSubscribers(ctx, ad, sess, o.mailchimpCustomFields, job.Progress.SubscribersTotal, len(o.verifier.Discovery.Audiences)); err != nil {
			return err
		}
	}
	if !o.DryRun && len(o.verifier.Discovery.Audiences) > 0 && len(o.audienceMappings) == 0 {
		mappings, err := listmonkx.EnsureAudienceLists(ctx, o.Listmonk, o.DB, o.TenantID, job.ID, job.Source, o.verifier.Discovery.Audiences)
		if err != nil {
			return fmt.Errorf("materialize audiences: %w", err)
		}
		o.audienceMappings = mappings
	}
	cursor := ""
	if c, ok := job.Cursor["subscribers"]; ok && c != nil {
		cursor = *c
	}
	seenCursors := newTraversalCursorSet()
	if cursor != "" {
		if err := recordTraversalCursor(seenCursors, "", cursor, "subscriber"); err != nil {
			return err
		}
	}
	pageCalls := 0
	emptyPageAllowance := 0
	if job.Source == canonical.SourceMailchimp {
		// Each selected Mailchimp audience is traversed independently. Empty
		// audiences legitimately produce an empty page that advances to the next
		// audience, so the discovery bound must include that finite allowance.
		emptyPageAllowance = len(o.verifier.Discovery.Audiences)
	} else if job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO || job.Source == canonical.SourceHubSpot {
		emptyPageAllowance = o.verifier.Discovery.ProfilesWithoutEmailTotal
	}
	maxPageCalls, err := subscriberTraversalPageLimit(job.Progress.SubscribersTotal, emptyPageAllowance)
	if err != nil {
		return err
	}
	for {
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return err
		}
		pageCalls++
		if pageCalls > maxPageCalls {
			return fmt.Errorf("subscriber traversal exceeded the discovery-bound page limit (%d calls for %d source subscribers): %w", maxPageCalls, job.Progress.SubscribersTotal, adapter.ErrSourceUnavailable)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "subscriber"); err != nil {
				return err
			}
		}
		if job.Source == canonical.SourceMailchimp {
			for _, subscriber := range batch {
				if o.DryRun {
					if err := mergeSubscriberCustomFieldPlan(o.mailchimpCustomFields, subscriber); err != nil {
						return err
					}
				} else if err := validateSubscriberAgainstCustomFieldPlan(o.mailchimpCustomFields, subscriber); err != nil {
					return err
				}
			}
			if o.DryRun {
				if err := persistMailchimpCustomFieldPlan(job, o.mailchimpCustomFields, false); err != nil {
					return err
				}
			}
		}
		if exactSubscriberSnapshotSource(job.Source) && !o.DryRun {
			label := sourceDisplayName(job.Source)
			for _, subscriber := range batch {
				if err := validateImportedSubscriberAgainstCustomFieldPlan(snapshotCustomFields, subscriber, label+" custom field"); err != nil {
					return fmt.Errorf("%s source schema drift before subscriber write: %w", label, err)
				}
			}
		}
		if o.DryRun && o.DB != nil && o.TenantID != "" {
			candidates := make([]canonical.Subscriber, 0, len(batch))
			for _, subscriber := range batch {
				email := strings.ToLower(strings.TrimSpace(subscriber.Email))
				if _, planned := o.dryRunPlannedEmails[email]; planned {
					continue
				}
				candidates = append(candidates, subscriber)
			}
			_, newRows, err := listmonkx.PrepareSubscriberBatchForWrite(ctx, o.DB, o.TenantID, candidates, o.dryRunPlannedNew)
			if err != nil {
				return fmt.Errorf("destination subscriber batch preflight: %w", err)
			}
			for i, subscriber := range candidates {
				if newRows[i] {
					email := strings.ToLower(strings.TrimSpace(subscriber.Email))
					o.dryRunPlannedNew++
					o.dryRunPlannedEmails[email] = struct{}{}
				}
			}
		}
		observations, err := o.recordSubscriberVerifierObservations(ctx, job, batch)
		if err != nil {
			return fmt.Errorf("persist subscriber verification checkpoint before destination writes: %w", err)
		}
		for _, subscriber := range observations {
			o.verifier.ObserveSubscriber(subscriber)
		}
		if o.beehiivFingerprint != nil {
			for _, subscriber := range batch {
				if err := o.beehiivFingerprint.observeSubscriber(subscriber); err != nil {
					return err
				}
			}
		}
		if o.klaviyoFingerprint != nil {
			for _, subscriber := range batch {
				if err := o.klaviyoFingerprint.observeSubscriber(subscriber); err != nil {
					return err
				}
			}
		}
		if o.hubSpotFingerprint != nil {
			for _, subscriber := range batch {
				if err := o.hubSpotFingerprint.observeSubscriber(subscriber); err != nil {
					return err
				}
			}
		}
		if o.customerIOFingerprint != nil {
			for _, subscriber := range batch {
				if err := o.customerIOFingerprint.observeSubscriber(subscriber); err != nil {
					return err
				}
			}
		}
		if !o.DryRun && o.Listmonk != nil && len(batch) > 0 {
			res := listmonkx.WriteSubscribers(ctx, o.Listmonk, batch, o.subscriberWriteOptions(job)...)
			job.Progress.SubscribersDone += res.Created + res.Updated
			o.verifier.SubscribersErrored += res.Failed
			if len(res.Errors) > 0 {
				return fmt.Errorf("subscriber destination writes failed: %w", errors.Join(res.Errors...))
			}
		} else {
			job.Progress.SubscribersDone += len(batch)
		}
		if o.DB == nil && next != "" {
			return fmt.Errorf("paginated subscriber verification requires tenant-scoped DB checkpoint storage before advancing cursor")
		}
		c := next
		job.Cursor["subscribers"] = &c
		if next == "" && job.Source == canonical.SourceMailchimp && o.DryRun {
			if o.DB != nil && o.TenantID != "" {
				if err := listmonkx.ValidateImportedCustomFieldPlan(ctx, o.DB, o.TenantID, o.mailchimpCustomFields); err != nil {
					return fmt.Errorf("Mailchimp custom-field schema preflight: %w", err)
				}
			}
			if err := persistMailchimpCustomFieldPlan(job, o.mailchimpCustomFields, true); err != nil {
				return err
			}
		}
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
		if next == "" {
			if err := o.reconcileFullSnapshotMissingSubscribers(ctx, job); err != nil {
				return err
			}
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.complete("subscribers"); err != nil {
					return err
				}
			}
			if o.hubSpotFingerprint != nil {
				if err := o.hubSpotFingerprint.complete("subscribers"); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.complete("subscribers"); err != nil {
					return err
				}
			}
			return nil
		}
		cursor = next
	}
}

// reconcileFullSnapshotMissingSubscribers closes the hard-delete and changed-
// email gaps for sources whose commit traversal is a complete, exact snapshot.
// Mutations remain restricted to ledger-proven identities owned by this job.
func (o *Orchestrator) reconcileFullSnapshotMissingSubscribers(ctx context.Context, job *canonical.MigrationJob) error {
	if o == nil || job == nil || !exactSubscriberSnapshotSource(job.Source) || o.DryRun || o.DB == nil || o.Listmonk == nil || strings.TrimSpace(o.TenantID) == "" {
		return nil
	}
	label := strings.TrimSpace(string(job.Source))
	current, err := snapshotCurrentSubscriberIdentities(o.verifier, label)
	if err != nil {
		return err
	}
	expected := o.verifier.Discovery.SubscribersTotal
	if err := validateSnapshotSubscriberInventory(current, expected, label); err != nil {
		return err
	}
	resources, err := listmonkx.ListImportedResources(ctx, o.DB, o.TenantID, job.ID, listmonkx.ResourceSubscriber)
	if err != nil {
		return fmt.Errorf("list %s subscriber ledger for deletion reconciliation: %w", label, err)
	}
	transfers, err := snapshotSubscriberOwnershipTransfers(resources, current, o.verifier, job.Source, label)
	if err != nil {
		return err
	}
	for _, transfer := range transfers {
		options := append([]listmonkx.WriteOption{}, o.subscriberWriteOptions(job)...)
		options = append(options, listmonkx.WithSourceIdentityTransferFrom(transfer.FromSourceID))
		result := listmonkx.WriteSubscribers(ctx, o.Listmonk, []canonical.Subscriber{transfer.Subscriber}, options...)
		if result.Failed > 0 || len(result.Errors) > 0 {
			return fmt.Errorf("transfer %s subscriber ownership from %q to %q after merged-identity churn: %w", label, transfer.FromSourceID, transfer.Subscriber.SourceID, errors.Join(result.Errors...))
		}
	}
	missing, err := snapshotMissingSubscriberDisables(resources, current, job.Source, label)
	if err != nil {
		return err
	}
	if len(missing) == 0 {
		return nil
	}
	result := listmonkx.WriteSourceSnapshotDeletionDisables(ctx, o.Listmonk, missing,
		listmonkx.WithMigrationJobID(job.ID),
		listmonkx.WithTenantPersistence(o.DB, o.TenantID),
	)
	if result.Failed > 0 || len(result.Errors) > 0 {
		return fmt.Errorf("disable %s subscribers missing from final source snapshot: %w", label, errors.Join(result.Errors...))
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	count := strconv.Itoa(len(missing))
	job.Cursor[label+"_source_deletions_reconciled"] = &count
	return nil
}

func (o *Orchestrator) reconcileBeehiivMissingSubscribers(ctx context.Context, job *canonical.MigrationJob) error {
	return o.reconcileFullSnapshotMissingSubscribers(ctx, job)
}

func validateBeehiivSubscriberInventory(current map[string]string, expected int) error {
	return validateSnapshotSubscriberInventory(current, expected, "Beehiiv")
}

func validateSnapshotSubscriberInventory(current map[string]string, expected int, label string) error {
	if expected < 0 || len(current) != expected {
		return fmt.Errorf("%s subscriber snapshot contains %d unique source identities, but discovery bound this run to %d; refusing destructive deletion reconciliation: %w", label, len(current), expected, adapter.ErrSourceUnavailable)
	}
	return nil
}

type beehiivSubscriberOwnershipTransfer struct {
	FromSourceID string
	Subscriber   canonical.Subscriber
}

func snapshotSubscriberOwnershipTransfers(resources []listmonkx.ImportedResource, current map[string]string, verifier *VerifierInput, source canonical.SourcePlatform, label string) ([]beehiivSubscriberOwnershipTransfer, error) {
	if verifier == nil {
		return nil, nil
	}
	transfers := make([]beehiivSubscriberOwnershipTransfer, 0)
	seenDestinations := map[string]struct{}{}
	for _, resource := range resources {
		if resource.SourcePlatform != source {
			continue
		}
		if owned, explicit := resource.DestinationMetadata["postwave_source_identity_owned"].(bool); explicit && !owned {
			continue
		}
		sourceIDs := beehiivLedgerSourceIDs(resource)
		if len(sourceIDs) == 0 {
			return nil, fmt.Errorf("%s subscriber ledger row %q has no source identity; refusing ownership reconciliation", label, resource.ID)
		}
		email, _ := resource.DestinationMetadata["email"].(string)
		email = strings.ToLower(strings.TrimSpace(email))
		if email == "" {
			return nil, fmt.Errorf("%s subscriber ledger has no destination email; refusing ownership reconciliation", label)
		}
		ownedSourceID := snapshotLedgerOwnedSourceID(resource, sourceIDs, source)
		if ownedSourceID == "" {
			return nil, fmt.Errorf("%s subscriber ledger does not prove the destination-owned source identity; refusing ownership reconciliation", label)
		}
		if currentEmail, present := current[ownedSourceID]; present && strings.EqualFold(currentEmail, email) {
			continue
		}
		hasTrackedSurvivor := false
		for _, sourceID := range sourceIDs {
			if currentEmail, present := current[sourceID]; present && strings.EqualFold(currentEmail, email) {
				hasTrackedSurvivor = true
				break
			}
		}
		if !hasTrackedSurvivor {
			continue
		}
		subscriber, ok := verifier.SubscriberFirstSeen[email]
		if !ok || !containsString(sourceIDs, subscriber.SourceID) {
			return nil, fmt.Errorf("%s merged subscriber %q retained a tracked source identity, but its canonical snapshot cannot prove a safe ownership successor", label, email)
		}
		if currentEmail, present := current[subscriber.SourceID]; !present || !strings.EqualFold(currentEmail, email) {
			return nil, fmt.Errorf("%s merged subscriber %q selected a non-current ownership successor", label, email)
		}
		destinationKey := firstNonEmptyString(resource.DestinationID, email)
		if _, duplicate := seenDestinations[destinationKey]; duplicate {
			continue
		}
		seenDestinations[destinationKey] = struct{}{}
		transfers = append(transfers, beehiivSubscriberOwnershipTransfer{
			FromSourceID: ownedSourceID,
			Subscriber:   subscriber,
		})
	}
	return transfers, nil
}

func beehiivSubscriberOwnershipTransfers(resources []listmonkx.ImportedResource, current map[string]string, verifier *VerifierInput) ([]beehiivSubscriberOwnershipTransfer, error) {
	return snapshotSubscriberOwnershipTransfers(resources, current, verifier, canonical.SourceBeehiiv, "Beehiiv")
}

func snapshotCurrentSubscriberIdentities(verifier *VerifierInput, label string) (map[string]string, error) {
	current := map[string]string{}
	if verifier == nil {
		return current, nil
	}
	put := func(sourceID, email string) error {
		sourceID = strings.TrimSpace(sourceID)
		email = strings.ToLower(strings.TrimSpace(email))
		if sourceID == "" || email == "" {
			return fmt.Errorf("%s subscriber snapshot contains an incomplete source identity; refusing deletion reconciliation", label)
		}
		if previous, exists := current[sourceID]; exists && previous != email {
			return fmt.Errorf("%s subscriber snapshot reused one source identity for multiple emails; refusing deletion reconciliation", label)
		}
		current[sourceID] = email
		return nil
	}
	for email, subscriber := range verifier.SubscriberFirstSeen {
		if err := put(subscriber.SourceID, firstNonEmptyString(subscriber.Email, email)); err != nil {
			return nil, err
		}
	}
	for email, conflict := range verifier.SubscriberMergeConflicts {
		contactEmail := firstNonEmptyString(conflict.Email, email)
		for _, sourceID := range conflict.SourceIDs {
			if err := put(sourceID, contactEmail); err != nil {
				return nil, err
			}
		}
	}
	return current, nil
}

func beehiivCurrentSubscriberIdentities(verifier *VerifierInput) (map[string]string, error) {
	return snapshotCurrentSubscriberIdentities(verifier, "Beehiiv")
}

func snapshotMissingSubscriberDisables(resources []listmonkx.ImportedResource, current map[string]string, source canonical.SourcePlatform, label string) ([]listmonkx.SourceSnapshotDeletionCandidate, error) {
	missing := make([]listmonkx.SourceSnapshotDeletionCandidate, 0)
	for _, resource := range resources {
		if resource.SourcePlatform != source {
			continue
		}
		sourceIDs := beehiivLedgerSourceIDs(resource)
		if len(sourceIDs) == 0 {
			return nil, fmt.Errorf("%s subscriber ledger row %q has no source identity; refusing deletion reconciliation", label, resource.ID)
		}
		email, _ := resource.DestinationMetadata["email"].(string)
		email = strings.TrimSpace(email)
		if email == "" {
			return nil, fmt.Errorf("%s subscriber ledger has no destination email; refusing deletion reconciliation", label)
		}
		keep := false
		for _, sourceID := range sourceIDs {
			if currentEmail, stillPresent := current[sourceID]; stillPresent && strings.EqualFold(email, currentEmail) {
				keep = true
				break
			}
		}
		if keep {
			continue
		}
		if owned, explicit := resource.DestinationMetadata["postwave_source_identity_owned"].(bool); explicit && !owned {
			// The Beehiiv records were merged into a local or different-source
			// subscriber. Their disappearance must not suppress that owner.
			continue
		}
		ownedSourceID := snapshotLedgerOwnedSourceID(resource, sourceIDs, source)
		if ownedSourceID == "" {
			return nil, fmt.Errorf("%s subscriber ledger does not prove the destination-owned source identity; refusing deletion reconciliation", label)
		}
		missing = append(missing, listmonkx.SourceSnapshotDeletionCandidate{
			Subscriber: canonical.Subscriber{
				Email:          email,
				Status:         canonical.StatusDisabled,
				ConsentSource:  canonical.ConsentUnknown,
				CustomFields:   map[string]interface{}{},
				SourceID:       ownedSourceID,
				SourcePlatform: source,
			},
			DestinationType: resource.DestinationType,
			DestinationID:   resource.DestinationID,
		})
	}
	return missing, nil
}

func beehiivMissingSubscriberDisables(resources []listmonkx.ImportedResource, current map[string]string) ([]listmonkx.SourceSnapshotDeletionCandidate, error) {
	return snapshotMissingSubscriberDisables(resources, current, canonical.SourceBeehiiv, "Beehiiv")
}

func beehiivLedgerSourceIDs(resource listmonkx.ImportedResource) []string {
	values := []string{resource.SourceID}
	switch sourceIDs := resource.DestinationMetadata["source_ids"].(type) {
	case []string:
		values = append(values, sourceIDs...)
	case []interface{}:
		for _, value := range sourceIDs {
			if sourceID, ok := value.(string); ok {
				values = append(values, sourceID)
			}
		}
	}
	return uniqueNonEmptyStrings(values)
}

func snapshotLedgerOwnedSourceID(resource listmonkx.ImportedResource, sourceIDs []string, source canonical.SourcePlatform) string {
	if after, ok := resource.DestinationMetadata["postwave_after"].(map[string]interface{}); ok {
		if subscriber, ok := after["subscriber"].(map[string]interface{}); ok {
			platform, _ := subscriber["source_platform"].(string)
			sourceID, _ := subscriber["source_id"].(string)
			if canonical.SourcePlatform(strings.TrimSpace(platform)) == source && containsString(sourceIDs, sourceID) {
				return strings.TrimSpace(sourceID)
			}
		}
	}
	if len(sourceIDs) == 1 {
		return sourceIDs[0]
	}
	return ""
}

func beehiivLedgerOwnedSourceID(resource listmonkx.ImportedResource, sourceIDs []string) string {
	return snapshotLedgerOwnedSourceID(resource, sourceIDs, canonical.SourceBeehiiv)
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func containsString(values []string, target string) bool {
	target = strings.TrimSpace(target)
	for _, value := range values {
		if strings.TrimSpace(value) == target {
			return true
		}
	}
	return false
}

func preflightMailchimpCommitSubscribers(ctx context.Context, ad adapter.Adapter, sess adapter.Session, plan map[string]string, expectedSubscribers, audienceCount int) error {
	cursor := ""
	seenCursors := map[[sha256.Size]byte]struct{}{}
	pageCalls := 0
	maxPageCalls, err := subscriberTraversalPageLimit(expectedSubscribers, audienceCount)
	if err != nil {
		return fmt.Errorf("Mailchimp commit source schema traversal: %w", err)
	}
	observed := 0
	for {
		if pageCalls >= maxPageCalls {
			return fmt.Errorf("Mailchimp commit source schema traversal exceeded the discovery-bound page limit (%d calls for %d source subscribers): %w", maxPageCalls, expectedSubscribers, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return fmt.Errorf("Mailchimp commit source schema traversal: %w", err)
		}
		pageCalls++
		observed += len(batch)
		if observed > expectedSubscribers {
			return fmt.Errorf("Mailchimp commit source schema traversal returned more subscribers than discovery (%d > %d): %w", observed, expectedSubscribers, adapter.ErrSourceUnavailable)
		}
		for _, subscriber := range batch {
			if err := validateSubscriberAgainstCustomFieldPlan(plan, subscriber); err != nil {
				return fmt.Errorf("Mailchimp commit source schema drift: %w", err)
			}
		}
		if next == "" {
			if observed != expectedSubscribers {
				return fmt.Errorf("Mailchimp commit source schema traversal returned %d subscribers, but discovery reported %d: %w", observed, expectedSubscribers, adapter.ErrSourceUnavailable)
			}
			return nil
		}
		duplicate, trackErr := addBoundedIdentity(seenCursors, "mailchimp_commit_schema_cursor", next, maxPageCalls)
		if trackErr != nil {
			return fmt.Errorf("Mailchimp commit source schema cursor bound: %w", trackErr)
		}
		if duplicate {
			return fmt.Errorf("Mailchimp commit source schema traversal returned repeated cursor %q", next)
		}
		cursor = next
	}
}

func preflightBeehiivCommitCustomFields(ctx context.Context, ad adapter.Adapter, sess adapter.Session, expectedSubscribers int) (map[string]string, error) {
	return preflightSnapshotCommitCustomFields(ctx, ad, sess, canonical.SourceBeehiiv, "Beehiiv", expectedSubscribers, 0)
}

func preflightSnapshotCommitCustomFields(ctx context.Context, ad adapter.Adapter, sess adapter.Session, source canonical.SourcePlatform, label string, expectedSubscribers, emptyPageAllowance int) (map[string]string, error) {
	plan := map[string]string{}
	cursor := ""
	seenCursors := map[[sha256.Size]byte]struct{}{}
	seenSourceIDs := map[[sha256.Size]byte]struct{}{}
	pageCalls := 0
	maxPageCalls, err := subscriberTraversalPageLimit(expectedSubscribers, emptyPageAllowance)
	if err != nil {
		return nil, fmt.Errorf("%s commit custom-field traversal: %w", label, err)
	}
	for {
		if pageCalls >= maxPageCalls {
			return nil, fmt.Errorf("%s commit custom-field traversal exceeded the discovery-bound page limit (%d calls for %d source subscribers): %w", label, maxPageCalls, expectedSubscribers, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return nil, fmt.Errorf("%s commit custom-field traversal: %w", label, err)
		}
		pageCalls++
		if len(batch) == 0 && next != "" && emptyPageAllowance == 0 {
			return nil, fmt.Errorf("%s commit custom-field traversal returned an empty non-terminal page: %w", label, adapter.ErrSourceUnavailable)
		}
		for _, subscriber := range batch {
			if subscriber.SourcePlatform != source {
				return nil, fmt.Errorf("%s commit custom-field traversal returned subscriber source %q: %w", label, subscriber.SourcePlatform, adapter.ErrSourceUnavailable)
			}
			sourceID := strings.TrimSpace(subscriber.SourceID)
			if sourceID == "" {
				return nil, fmt.Errorf("%s commit custom-field traversal returned a subscriber without a source identity: %w", label, adapter.ErrSourceUnavailable)
			}
			duplicate, trackErr := addBoundedIdentity(seenSourceIDs, string(source)+"_subscriber", sourceID, maxArchiveTrackedIdentities)
			if trackErr != nil {
				return nil, fmt.Errorf("%s commit custom-field traversal identity bound: %w", label, trackErr)
			}
			if duplicate {
				return nil, fmt.Errorf("%s commit custom-field traversal returned duplicate source identity %q across pages: %w", label, sourceID, adapter.ErrSourceUnavailable)
			}
			if len(seenSourceIDs) > expectedSubscribers {
				return nil, fmt.Errorf("%s commit custom-field traversal returned more unique subscribers than discovery (%d > %d): %w", label, len(seenSourceIDs), expectedSubscribers, adapter.ErrSourceUnavailable)
			}
			if err := mergeImportedCustomFieldPlan(plan, subscriber, label+" custom field", "cross-subscriber"); err != nil {
				return nil, fmt.Errorf("%s commit custom-field schema: %w", label, err)
			}
		}
		if next == "" {
			if len(seenSourceIDs) != expectedSubscribers {
				return nil, fmt.Errorf("%s commit custom-field traversal returned %d unique subscribers, but discovery reported %d: %w", label, len(seenSourceIDs), expectedSubscribers, adapter.ErrSourceUnavailable)
			}
			return plan, nil
		}
		if len(seenSourceIDs) >= expectedSubscribers && emptyPageAllowance == 0 {
			return nil, fmt.Errorf("%s commit custom-field traversal reported more pages after reaching the discovery total of %d subscribers: %w", label, expectedSubscribers, adapter.ErrSourceUnavailable)
		}
		duplicate, trackErr := addBoundedIdentity(seenCursors, string(source)+"_commit_schema_cursor", next, maxPageCalls)
		if trackErr != nil {
			return nil, fmt.Errorf("%s commit custom-field cursor bound: %w", label, trackErr)
		}
		if duplicate {
			return nil, fmt.Errorf("%s commit custom-field traversal returned repeated cursor: %w", label, adapter.ErrSourceUnavailable)
		}
		cursor = next
	}
}

func addBoundedIdentity(seen map[[sha256.Size]byte]struct{}, namespace, sourceID string, limit int) (bool, error) {
	digest := sha256.Sum256([]byte(strings.TrimSpace(namespace) + "\x00" + strings.TrimSpace(sourceID)))
	if _, duplicate := seen[digest]; duplicate {
		return true, nil
	}
	if limit < 0 || len(seen) >= limit {
		return false, fmt.Errorf("identity inventory exceeds the safe %d-row tracking limit: %w", limit, adapter.ErrUnsupported)
	}
	seen[digest] = struct{}{}
	return false, nil
}

func subscriberTraversalPageLimit(expectedSubscribers, emptyPageAllowance int) (int, error) {
	if expectedSubscribers < 0 || emptyPageAllowance < 0 {
		return 0, fmt.Errorf("subscriber discovery bounds are invalid (subscribers=%d empty_page_allowance=%d): %w", expectedSubscribers, emptyPageAllowance, adapter.ErrSourceUnavailable)
	}
	if expectedSubscribers >= maxSubscriberTraversalPageCalls ||
		emptyPageAllowance >= maxSubscriberTraversalPageCalls ||
		expectedSubscribers > maxSubscriberTraversalPageCalls-emptyPageAllowance-1 {
		return maxSubscriberTraversalPageCalls, nil
	}
	// Cursor pages must be non-empty while has_more=true. This deliberately
	// loose discovery bound permits short provider pages while the absolute cap
	// prevents a hostile total from keeping the workspace lease indefinitely.
	return expectedSubscribers + emptyPageAllowance + 1, nil
}

func exactSubscriberSnapshotSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceBeehiiv, canonical.SourceHubSpot, canonical.SourceKlaviyo, canonical.SourceCustomerIO, canonical.SourceMailerLite, canonical.SourceSubstack:
		return true
	default:
		return false
	}
}

func (o *Orchestrator) subscriberWriteOptions(job *canonical.MigrationJob) []listmonkx.WriteOption {
	if job == nil {
		return nil
	}
	opts := []listmonkx.WriteOption{
		listmonkx.WithMigrationJobID(job.ID),
		listmonkx.WithTenantPersistence(o.DB, o.TenantID),
		listmonkx.WithAudienceMappings(o.audienceMappings),
	}
	if subscriberStatusAuthoritativeSource(job.Source) {
		opts = append(opts, listmonkx.WithAuthoritativeStatus())
	}
	if subscriberFieldsAndTagsAuthoritativeSource(job.Source) {
		opts = append(opts, listmonkx.WithAuthoritativeTags())
		opts = append(opts, listmonkx.WithAuthoritativeFields())
	}
	return opts
}

func subscriberFieldsAndTagsAuthoritativeSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceBeehiiv, canonical.SourceHubSpot, canonical.SourceKlaviyo, canonical.SourceCustomerIO, canonical.SourceMailerLite, canonical.SourceSubstack:
		return true
	default:
		return false
	}
}

func subscriberStatusAuthoritativeSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceHubSpot, canonical.SourceBeehiiv, canonical.SourceKlaviyo, canonical.SourceCustomerIO, canonical.SourceMailerLite, canonical.SourceSubstack:
		return true
	default:
		return false
	}
}

func (o *Orchestrator) runSegments(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	segs, err := ad.ListSegments(ctx, sess)
	if err != nil {
		return err
	}
	var hubSpotSourceIDs map[string]struct{}
	if job.Source == canonical.SourceHubSpot {
		hubSpotSourceIDs, err = hubSpotSegmentSourceIDs(segs)
		if err != nil {
			return err
		}
	}
	job.Progress.SegmentsTotal = len(segs)
	start := executionCursorIndex(job, stageSegments)
	for i := start; i < len(segs); i++ {
		s := segs[i]
		var translateErr error
		// CompileSegment is run for every segment (even on dry-run) so the
		// verifier can flag SQL-translation failures without writing anything.
		_, _, err := listmonkx.CompileSegment(s.QueryAST)
		if err != nil {
			translateErr = err
		} else if !o.DryRun {
			// Listmonk-the-product has no segments table, so there is no
			// upstream API call. Moosewave persists segments to the local
			// `segments` table via PersistSegment, which also records an
			// imported-resource row for rollback. If the orchestrator was
			// constructed without DB/TenantID we treat the call as a soft
			// dry-run and surface the gap on the segment so callers can see
			// why the row never landed.
			if o.DB != nil && o.TenantID != "" {
				if err := listmonkx.ValidateSegmentQuery(ctx, o.DB, o.TenantID, s.QueryAST); err != nil {
					translateErr = err
				} else if _, err := listmonkx.PersistSegment(ctx, o.DB, o.TenantID, job.ID, s, job.Source); err != nil {
					translateErr = err
				}
			} else {
				translateErr = fmt.Errorf("orchestrator: segment %q skipped (DB/TenantID unset)", s.Name)
			}
		}
		// Translation/persistence failures are non-fatal — the verification
		// report surfaces them and the rest of the migration continues.
		o.verifier.ObserveSegment(s, translateErr)
		if o.beehiivFingerprint != nil {
			if err := o.beehiivFingerprint.observeSegment(s); err != nil {
				return err
			}
		}
		if o.klaviyoFingerprint != nil {
			if err := o.klaviyoFingerprint.observeSegment(s); err != nil {
				return err
			}
		}
		if o.hubSpotFingerprint != nil {
			if err := o.hubSpotFingerprint.observeSegment(s); err != nil {
				return err
			}
		}
		if o.customerIOFingerprint != nil {
			if err := o.customerIOFingerprint.observeSegment(s); err != nil {
				return err
			}
		}
		job.Progress.SegmentsDone++
		setExecutionCursorIndex(job, stageSegments, i+1)
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
	}
	if o.klaviyoFingerprint != nil {
		if err := o.klaviyoFingerprint.complete("segments"); err != nil {
			return err
		}
	}
	if o.hubSpotFingerprint != nil {
		if err := o.hubSpotFingerprint.complete("segments"); err != nil {
			return err
		}
	}
	if o.customerIOFingerprint != nil {
		if err := o.customerIOFingerprint.complete("segments"); err != nil {
			return err
		}
	}
	if job.Source == canonical.SourceHubSpot && !o.DryRun {
		if o.DB == nil || strings.TrimSpace(o.TenantID) == "" {
			return fmt.Errorf("orchestrator: HubSpot segment reconciliation requires DB and tenant ID")
		}
		if err := o.reconcileHubSpotSegments(ctx, job, hubSpotSourceIDs); err != nil {
			return err
		}
	}
	return nil
}

func hubSpotSegmentSourceIDs(segs []canonical.Segment) (map[string]struct{}, error) {
	sourceIDs := make(map[string]struct{}, len(segs))
	for _, seg := range segs {
		sourceID, err := listmonkx.SegmentSourceIdentity(seg, canonical.SourceHubSpot)
		if err != nil {
			return nil, fmt.Errorf("HubSpot segment snapshot identity: %w", err)
		}
		if !strings.HasPrefix(sourceID, "hubspot:list:") &&
			!strings.HasPrefix(sourceID, "hubspot:subscription:") {
			return nil, fmt.Errorf("HubSpot segment snapshot identity %q is not a stable HubSpot list or subscription identity", sourceID)
		}
		if _, duplicate := sourceIDs[sourceID]; duplicate {
			return nil, fmt.Errorf("HubSpot segment snapshot contains duplicate source identity %q", sourceID)
		}
		sourceIDs[sourceID] = struct{}{}
	}
	return sourceIDs, nil
}

func (o *Orchestrator) reconcileHubSpotSegments(ctx context.Context, job *canonical.MigrationJob, currentSourceIDs map[string]struct{}) error {
	afterID := ""
	for {
		resources, err := listmonkx.ListImportedResourcesPage(
			ctx, o.DB, o.TenantID, job.ID, listmonkx.ResourceSegment, afterID, 250,
		)
		if err != nil {
			return fmt.Errorf("list tracked HubSpot segments for reconciliation: %w", err)
		}
		if len(resources) == 0 {
			return nil
		}
		for _, resource := range resources {
			if resource.SourcePlatform != canonical.SourceHubSpot {
				return fmt.Errorf(
					"tracked segment %s belongs to source %q in HubSpot migration job %s",
					resource.ID, resource.SourcePlatform, job.ID,
				)
			}
			if _, present := currentSourceIDs[resource.SourceID]; present {
				continue
			}
			if _, err := listmonkx.DeleteTrackedPostgresResourceBySource(
				ctx,
				o.DB,
				o.TenantID,
				job.ID,
				listmonkx.ResourceSegment,
				canonical.SourceHubSpot,
				resource.SourceID,
			); err != nil {
				return fmt.Errorf("reconcile deleted HubSpot segment source %q: %w", resource.SourceID, err)
			}
		}
		afterID = resources[len(resources)-1].ID
	}
}

func (o *Orchestrator) runTemplates(ctx context.Context, ad templateLister, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	if o.templateDestinationIDs == nil {
		o.templateDestinationIDs = templateReferenceMapFromCursor(job)
	}
	if !o.DryRun && o.Listmonk != nil {
		// The client is process-lived, but reconciliation snapshots are not.
		// Refresh once per template-stage run and reuse it across all pages.
		o.Listmonk.RefreshTemplateReconciliationInventory()
	}
	cursor := ""
	if c, ok := job.Cursor["templates"]; ok && c != nil {
		cursor = *c
	}
	inferTotal := job.Progress.TemplatesTotal == 0 && job.Source != canonical.SourceKlaviyo && job.Source != canonical.SourceCustomerIO
	seenCursors := newTraversalCursorSet()
	if cursor != "" {
		if err := recordTraversalCursor(seenCursors, "", cursor, "template"); err != nil {
			return err
		}
	}
	seenSourceIDs := map[[sha256.Size]byte]struct{}{}
	pageCalls := 0
	maxPageCalls := 100000
	if job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO {
		emptyAllowance := 0
		if job.Source == canonical.SourceKlaviyo && o.verifier != nil {
			emptyAllowance = o.verifier.Discovery.SourceArchiveTotal
		}
		var err error
		maxPageCalls, err = subscriberTraversalPageLimit(job.Progress.TemplatesTotal, emptyAllowance)
		if err != nil {
			return fmt.Errorf("%s template traversal bound: %w", sourceDisplayName(job.Source), err)
		}
	}
	for {
		batch, next, err := ad.ListTemplates(ctx, sess, cursor)
		if err != nil {
			return err
		}
		pageCalls++
		if pageCalls > maxPageCalls {
			return fmt.Errorf("template traversal exceeded the discovery-bound page limit (%d): %w", maxPageCalls, adapter.ErrSourceUnavailable)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "template"); err != nil {
				return err
			}
		}
		for _, tpl := range batch {
			sourceID := strings.TrimSpace(tpl.SourceID)
			if sourceID == "" {
				return fmt.Errorf("template traversal returned an empty source identity: %w", adapter.ErrSourceUnavailable)
			}
			duplicate, trackErr := addBoundedIdentity(seenSourceIDs, "template", sourceID, maxArchiveTrackedIdentities)
			if trackErr != nil {
				return fmt.Errorf("template identity tracking: %w", trackErr)
			}
			if duplicate {
				return fmt.Errorf("template traversal returned duplicate source identity %q across pages: %w", sourceID, adapter.ErrSourceUnavailable)
			}
		}
		if inferTotal {
			job.Progress.TemplatesTotal += len(batch)
		}
		imported := len(batch)
		for _, tpl := range batch {
			o.verifier.ObserveTemplate(tpl)
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.observeTemplate(tpl); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.observeTemplate(tpl); err != nil {
					return err
				}
			}
			if tpl.SourceID != "" {
				if _, ok := o.templateDestinationIDs[tpl.SourceID]; !ok {
					o.templateDestinationIDs[tpl.SourceID] = ""
				}
			}
		}
		if !o.DryRun && o.Listmonk != nil && len(batch) > 0 {
			imported = 0
			for _, tpl := range batch {
				resp, _, err := listmonkx.CreateOrReuseTemplate(ctx, o.Listmonk, o.DB, o.TenantID, job.ID, tpl)
				if err != nil {
					return err
				}
				if resp != nil {
					imported++
					if tpl.SourceID != "" {
						o.templateDestinationIDs[tpl.SourceID] = fmt.Sprintf("%d", resp.ID)
					}
				}
			}
		}
		if err := persistTemplateReferenceMap(job, o.templateDestinationIDs); err != nil {
			return err
		}
		job.Progress.TemplatesDone += imported
		if (job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO) && job.Progress.TemplatesDone > job.Progress.TemplatesTotal {
			return fmt.Errorf("%s template traversal emitted more editable templates than discovery (%d > %d): %w", sourceDisplayName(job.Source), job.Progress.TemplatesDone, job.Progress.TemplatesTotal, adapter.ErrSourceUnavailable)
		}
		o.verifier.TemplatesImported += imported
		c := next
		job.Cursor["templates"] = &c
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
		if next == "" {
			if (job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO) && job.Progress.TemplatesDone != job.Progress.TemplatesTotal {
				return fmt.Errorf("%s template traversal emitted %d of the exact %d discovered editable templates: %w", sourceDisplayName(job.Source), job.Progress.TemplatesDone, job.Progress.TemplatesTotal, adapter.ErrSourceUnavailable)
			}
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.complete("editable_templates"); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.complete("editable_templates"); err != nil {
					return err
				}
			}
			return nil
		}
		cursor = next
	}
}

func (o *Orchestrator) runAutomations(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	autos, err := ad.ListAutomations(ctx, sess)
	if err != nil {
		return err
	}
	job.Progress.AutomationsTotal = len(autos)
	start := executionCursorIndex(job, stageAutomations)
	for i := start; i < len(autos); i++ {
		au := autos[i]
		if o.beehiivFingerprint != nil {
			// Fingerprint the provider-canonical object, before any destination
			// template remapping mutates it, so final-delta and shadow traversal
			// hash exactly the same Beehiiv source representation.
			if err := o.beehiivFingerprint.observeAutomation(au); err != nil {
				return err
			}
		}
		if o.klaviyoFingerprint != nil {
			if err := o.klaviyoFingerprint.observeAutomation(au); err != nil {
				return err
			}
		}
		var remapErr error
		au, remapErr = o.remapAutomationTemplates(ctx, job, au)
		unsupported := automationUnsupportedReason(au)
		if remapErr != nil {
			unsupported = remapErr.Error()
		}
		if unsupported == "" && !o.DryRun && o.DB != nil && o.TenantID != "" {
			if _, err := listmonkx.PersistAutomation(ctx, o.DB, o.TenantID, job.ID, au, job.Source); err != nil {
				unsupported = "Persistence failed: " + err.Error()
			}
		}
		o.verifier.ObserveAutomation(au, unsupported)
		// Progress tracks processed Classic Automation records. Runtime parity
		// remains split in the verifier; manual-review records must not leave an
		// otherwise completed job permanently below its discovered total.
		job.Progress.AutomationsDone++
		setExecutionCursorIndex(job, stageAutomations, i+1)
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
	}
	if o.klaviyoFingerprint != nil {
		if err := o.klaviyoFingerprint.complete("rebuild_flows"); err != nil {
			return err
		}
	}
	return nil
}

func (o *Orchestrator) remapAutomationTemplates(ctx context.Context, job *canonical.MigrationJob, au canonical.Automation) (canonical.Automation, error) {
	if err := o.loadAutomationReferenceMaps(ctx, job); err != nil {
		return au, err
	}

	if job.Source == canonical.SourceMailchimp {
		for i := range au.Triggers {
			if err := o.remapMailchimpListTrigger(&au.Triggers[i], au.Name); err != nil {
				return au, err
			}
		}
	}
	for i := range au.Nodes {
		node := &au.Nodes[i]
		if job.Source == canonical.SourceMailchimp {
			if node.WaitTrigger != nil {
				if err := o.remapMailchimpListTrigger(node.WaitTrigger, au.Name); err != nil {
					return au, err
				}
			}
			if node.Action != nil && strings.TrimSpace(node.Action.ListID) != "" {
				mapped, err := o.remapMailchimpListID(node.Action.ListID, au.Name)
				if err != nil {
					return au, err
				}
				node.Action.ListID = mapped
			}
		}
		if node.Type != "send_email" {
			continue
		}

		// TemplateID is a destination namespace. Capture all possible source
		// identities first, then clear it so a coincidentally equal numeric
		// source/Listmonk ID can never become executable without an exact remap.
		candidates := mailchimpTemplateSourceCandidates(*node)
		node.TemplateID = ""
		if len(candidates) == 0 {
			return au, fmt.Errorf("%s automation %q send-email node %q has no source template/content identity; manual review is required", sourceDisplayName(job.Source), au.Name, node.ID)
		}
		var sourceID, destinationID string
		for _, candidate := range candidates {
			if mapped, ok := o.templateDestinationIDs[candidate]; ok {
				sourceID, destinationID = candidate, mapped
				break
			}
		}
		if sourceID == "" {
			return au, fmt.Errorf("%s automation %q references source template/content %q with no tenant-verified imported destination template; manual review is required", sourceDisplayName(job.Source), au.Name, strings.Join(candidates, ", "))
		}
		if node.Metadata == nil {
			node.Metadata = map[string]interface{}{}
		}
		node.Metadata[listmonkx.MigrationSourceTemplateIDMetadataKey] = sourceID
		if o.DryRun {
			node.TemplateID = plannedReferenceID("template", sourceID)
		} else {
			if strings.TrimSpace(destinationID) == "" {
				return au, fmt.Errorf("%s automation %q source template/content %q has no destination template id; manual review is required", sourceDisplayName(job.Source), au.Name, sourceID)
			}
			node.TemplateID = destinationID
		}
	}
	return au, nil
}

func (o *Orchestrator) loadAutomationReferenceMaps(ctx context.Context, job *canonical.MigrationJob) error {
	if job == nil {
		return fmt.Errorf("automation template remap requires a migration job")
	}
	if !o.automationTemplateReferencesLoaded {
		if o.DryRun {
			if o.templateDestinationIDs == nil {
				o.templateDestinationIDs = templateReferenceMapFromCursor(job)
			}
		} else {
			if o.DB == nil || strings.TrimSpace(o.TenantID) == "" {
				return fmt.Errorf("automation template remap requires tenant-scoped migration state")
			}
			resources, err := listmonkx.ListImportedResources(ctx, o.DB, o.TenantID, job.ID, listmonkx.ResourceTemplate)
			if err != nil {
				return fmt.Errorf("load tenant-owned automation template references: %w", err)
			}
			o.templateDestinationIDs, err = verifiedTemplateReferenceMap(resources, o.TenantID, job.ID, job.Source)
			if err != nil {
				return err
			}
		}
		o.automationTemplateReferencesLoaded = true
	}
	if job.Source != canonical.SourceMailchimp || o.audienceMappings != nil {
		return nil
	}
	if o.DryRun {
		o.audienceMappings = make(map[string]listmonkx.AudienceMapping, len(o.verifier.Discovery.Audiences))
		for _, audience := range o.verifier.Discovery.Audiences {
			sourceID := strings.TrimSpace(audience.ID)
			if sourceID == "" {
				continue
			}
			o.audienceMappings[sourceID] = listmonkx.AudienceMapping{
				SourceID:   sourceID,
				Name:       audience.Name,
				PostwaveID: plannedReferenceID("list", sourceID),
			}
		}
		return nil
	}
	if o.DB == nil || o.TenantID == "" {
		return fmt.Errorf("Mailchimp automation audience remap requires tenant-scoped migration state")
	}
	mappings, err := listmonkx.LoadAudienceMappings(ctx, o.DB, o.TenantID, job.ID, job.Source)
	if err != nil {
		return err
	}
	o.audienceMappings = mappings
	return nil
}

func verifiedTemplateReferenceMap(resources []listmonkx.ImportedResource, tenantID, jobID string, source canonical.SourcePlatform) (map[string]string, error) {
	out := make(map[string]string, len(resources))
	for _, resource := range resources {
		sourceID := strings.TrimSpace(resource.SourceID)
		destinationID := strings.TrimSpace(resource.DestinationID)
		ownershipFingerprint := automationMetadataString(resource.DestinationMetadata, "ownership_fingerprint")
		if resource.TenantID != tenantID || resource.JobID != jobID || resource.ResourceType != listmonkx.ResourceTemplate ||
			resource.SourcePlatform != source || resource.DestinationType != listmonkx.DestinationListmonkTemplate ||
			sourceID == "" || destinationID == "" || ownershipFingerprint == "" {
			return nil, fmt.Errorf("template reference %q does not carry exact tenant/job/source destination ownership", sourceID)
		}
		destinationNumericID, err := strconv.ParseInt(destinationID, 10, 64)
		if err != nil || destinationNumericID <= 0 {
			return nil, fmt.Errorf("template reference %q has invalid Listmonk destination id %q", sourceID, destinationID)
		}
		if previous, duplicate := out[sourceID]; duplicate && previous != destinationID {
			return nil, fmt.Errorf("template reference %q is ambiguous across destinations %q and %q", sourceID, previous, destinationID)
		}
		out[sourceID] = destinationID
	}
	return out, nil
}

func (o *Orchestrator) remapMailchimpListTrigger(trigger *canonical.AutomationTrigger, automationName string) error {
	if trigger == nil || strings.TrimSpace(trigger.ListID) == "" {
		return nil
	}
	mapped, err := o.remapMailchimpListID(trigger.ListID, automationName)
	if err != nil {
		return err
	}
	if trigger.Metadata == nil {
		trigger.Metadata = map[string]interface{}{}
	}
	trigger.Metadata["source_list_id"] = trigger.ListID
	trigger.ListID = mapped
	if trigger.Type == "subscriber_added_to_list" || trigger.Type == "list_join" {
		trigger.Type = "list_joined"
	}
	return nil
}

func (o *Orchestrator) remapMailchimpListID(sourceID, automationName string) (string, error) {
	sourceID = strings.TrimSpace(sourceID)
	mapping, ok := o.audienceMappings[sourceID]
	if !ok {
		return "", fmt.Errorf("Mailchimp automation %q references audience %q with no imported destination list; manual review is required", automationName, sourceID)
	}
	if strings.TrimSpace(mapping.PostwaveID) == "" {
		return "", fmt.Errorf("Mailchimp automation %q audience %q has no destination Moosewave list id; manual review is required", automationName, sourceID)
	}
	return mapping.PostwaveID, nil
}

func mailchimpTemplateSourceCandidates(node canonical.AutomationNode) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, 3)
	for _, value := range []string{
		automationMetadataString(node.Metadata, "source_template_id"),
		automationMetadataString(node.Metadata, "source_content_id"),
		strings.TrimSpace(node.TemplateID),
	} {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func automationMetadataString(metadata map[string]interface{}, key string) string {
	if metadata == nil {
		return ""
	}
	switch value := metadata[key].(type) {
	case string:
		return strings.TrimSpace(value)
	case fmt.Stringer:
		return strings.TrimSpace(value.String())
	case float64:
		return fmt.Sprintf("%.0f", value)
	case int:
		return fmt.Sprintf("%d", value)
	case int64:
		return fmt.Sprintf("%d", value)
	default:
		return ""
	}
}

func plannedReferenceID(kind, sourceID string) string {
	return "planned:postwave-" + kind + ":" + strings.TrimSpace(sourceID)
}

func persistTemplateReferenceMap(job *canonical.MigrationJob, mappings map[string]string) error {
	if job == nil {
		return nil
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	keys := make([]string, 0, len(mappings))
	for key := range mappings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ordered := make(map[string]string, len(keys))
	for _, key := range keys {
		ordered[key] = mappings[key]
	}
	raw, err := json.Marshal(ordered)
	if err != nil {
		return fmt.Errorf("persist automation template reference map: %w", err)
	}
	value := string(raw)
	job.Cursor[automationTemplateMapCursorKey] = &value
	return nil
}

func templateReferenceMapFromCursor(job *canonical.MigrationJob) map[string]string {
	out := map[string]string{}
	if job == nil || job.Cursor == nil || job.Cursor[automationTemplateMapCursorKey] == nil {
		return out
	}
	_ = json.Unmarshal([]byte(*job.Cursor[automationTemplateMapCursorKey]), &out)
	return out
}

func (o *Orchestrator) runArchive(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	cursor := ""
	if c, ok := job.Cursor["archive"]; ok && c != nil {
		cursor = *c
	}
	seenCursors := newTraversalCursorSet()
	if cursor != "" {
		if err := recordTraversalCursor(seenCursors, "", cursor, "campaign-archive"); err != nil {
			return err
		}
	}
	seenSourceIDs := map[[sha256.Size]byte]struct{}{}
	pageCalls := 0
	maxPageCalls := 100000
	if job.Source == canonical.SourceKlaviyo {
		if o.verifier == nil || o.verifier.Discovery.CampaignsTotal < job.Progress.ArchiveTotal {
			return fmt.Errorf("Klaviyo campaign-archive discovery totals are inconsistent: %w", adapter.ErrSourceUnavailable)
		}
		emptyAllowance := o.verifier.Discovery.CampaignsTotal - job.Progress.ArchiveTotal + 3
		var boundErr error
		maxPageCalls, boundErr = subscriberTraversalPageLimit(job.Progress.ArchiveTotal, emptyAllowance)
		if boundErr != nil {
			return fmt.Errorf("Klaviyo campaign-archive traversal bound: %w", boundErr)
		}
	} else if job.Source == canonical.SourceCustomerIO {
		if o.verifier == nil || o.verifier.Discovery.ArchiveTotal != job.Progress.ArchiveTotal {
			return fmt.Errorf("Customer.io campaign-archive discovery totals are inconsistent: %w", adapter.ErrSourceUnavailable)
		}
		var boundErr error
		maxPageCalls, boundErr = subscriberTraversalPageLimit(job.Progress.ArchiveTotal, 3)
		if boundErr != nil {
			return fmt.Errorf("Customer.io campaign-archive traversal bound: %w", boundErr)
		}
	}
	for {
		batch, next, err := ad.ListCampaignArchive(ctx, sess, cursor)
		if err != nil {
			return err
		}
		pageCalls++
		if pageCalls > maxPageCalls {
			return fmt.Errorf("campaign-archive traversal exceeded %d page calls: %w", maxPageCalls, adapter.ErrSourceUnavailable)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "campaign-archive"); err != nil {
				return err
			}
		}
		for _, campaign := range batch {
			sourceID := strings.TrimSpace(campaign.SourceID)
			if sourceID == "" {
				return fmt.Errorf("campaign-archive traversal returned an empty source identity: %w", adapter.ErrSourceUnavailable)
			}
			duplicate, trackErr := addBoundedIdentity(seenSourceIDs, "campaign_archive", sourceID, maxArchiveTrackedIdentities)
			if trackErr != nil {
				return fmt.Errorf("campaign-archive identity tracking: %w", trackErr)
			}
			if duplicate {
				return fmt.Errorf("campaign-archive traversal returned duplicate source identity %q across pages: %w", sourceID, adapter.ErrSourceUnavailable)
			}
		}
		imported := len(batch)
		for _, c := range batch {
			o.verifier.ObserveCampaignArchive(c)
			if o.beehiivFingerprint != nil {
				if err := o.beehiivFingerprint.observeCampaign(c); err != nil {
					return err
				}
			}
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.observeCampaign(c); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.observeCampaign(c); err != nil {
					return err
				}
			}
		}
		if !o.DryRun && o.DB != nil && o.TenantID != "" {
			imported = 0
			for _, c := range batch {
				id, err := listmonkx.PersistCampaignArchive(ctx, o.DB, o.TenantID, job.ID, c)
				if err != nil {
					return err
				}
				if id != "" {
					imported++
				}
			}
		}
		job.Progress.ArchiveDone += len(batch)
		if (job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO) && job.Progress.ArchiveDone > job.Progress.ArchiveTotal {
			return fmt.Errorf("%s campaign-archive traversal emitted more sent campaigns than discovery (%d > %d): %w", sourceDisplayName(job.Source), job.Progress.ArchiveDone, job.Progress.ArchiveTotal, adapter.ErrSourceUnavailable)
		}
		o.verifier.ArchiveImported += imported
		c := next
		job.Cursor["archive"] = &c
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
		if next == "" {
			if (job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO) && job.Progress.ArchiveDone != job.Progress.ArchiveTotal {
				return fmt.Errorf("%s campaign-archive traversal emitted %d of the exact %d discovered sent campaigns: %w", sourceDisplayName(job.Source), job.Progress.ArchiveDone, job.Progress.ArchiveTotal, adapter.ErrSourceUnavailable)
			}
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.complete("sent_campaign_archive"); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.complete("sent_campaign_archive"); err != nil {
					return err
				}
			}
			return nil
		}
		cursor = next
	}
}

func (o *Orchestrator) runSourceArchive(ctx context.Context, ad adapter.SourceArchiveAdapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	cursor := ""
	if c, ok := job.Cursor["source_archive"]; ok && c != nil {
		cursor = *c
	}
	if job.Progress.SourceArchiveTotal == 0 && o.verifier != nil {
		job.Progress.SourceArchiveTotal = sourceArchiveExpectedTotal(job.Source, o.verifier.Discovery)
	}
	seenCursors := newTraversalCursorSet()
	if cursor != "" {
		if err := recordTraversalCursor(seenCursors, "", cursor, "source-archive"); err != nil {
			return err
		}
	}
	const maxSourceArchivePageCalls = 100000
	pageCalls := 0
	seenDefinitionIDs := map[[sha256.Size]byte]struct{}{}
	for {
		batch, next, err := ad.ListSourceArchive(ctx, sess, cursor)
		if err != nil {
			return err
		}
		pageCalls++
		if pageCalls > maxSourceArchivePageCalls {
			return fmt.Errorf("source-archive traversal exceeded %d page calls: %w", maxSourceArchivePageCalls, adapter.ErrSourceUnavailable)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "source-archive"); err != nil {
				return err
			}
		}
		for _, item := range batch {
			if sourceArchiveWarningOnly(item) || !sourceArchiveRequiresGlobalIdentityCheck(job.Source, item.ResourceType) {
				continue
			}
			resourceType := strings.TrimSpace(item.ResourceType)
			sourceID := strings.TrimSpace(item.SourceID)
			if sourceID == "" {
				return fmt.Errorf("source-archive traversal returned an empty source identity for %q: %w", item.ResourceType, adapter.ErrSourceUnavailable)
			}
			duplicate, trackErr := addBoundedIdentity(seenDefinitionIDs, resourceType, sourceID, maxArchiveTrackedIdentities)
			if trackErr != nil {
				return fmt.Errorf("source-archive identity tracking: %w", trackErr)
			}
			if duplicate {
				return fmt.Errorf("source-archive traversal returned duplicate %s identity %q across pages: %w", item.ResourceType, item.SourceID, adapter.ErrSourceUnavailable)
			}
		}
		if o.klaviyoFingerprint != nil {
			for _, item := range batch {
				if err := o.klaviyoFingerprint.observeSourceArchive(item); err != nil {
					return err
				}
			}
		}
		if o.customerIOFingerprint != nil {
			for _, item := range batch {
				if err := o.customerIOFingerprint.observeSourceArchive(item); err != nil {
					return err
				}
			}
		}
		processed := 0
		imported := 0
		if !o.DryRun && o.DB != nil && o.TenantID != "" {
			for _, item := range batch {
				if sourceArchiveWarningOnly(item) {
					o.verifier.ObserveSourceArchiveItem(item)
					if o.beehiivFingerprint != nil {
						if err := o.beehiivFingerprint.observeSourceArchive(item); err != nil {
							return err
						}
					}
					processed += sourceArchiveWarningProcessedUnits(job.Source, o.verifier.Discovery, item)
					continue
				}
				id, err := listmonkx.PersistSourceArchiveItem(ctx, o.DB, o.TenantID, job.ID, item)
				if err != nil {
					return err
				}
				processed++
				if id != "" {
					imported++
					o.verifier.ObserveSourceArchiveItem(item)
					if o.beehiivFingerprint != nil {
						if err := o.beehiivFingerprint.observeSourceArchive(item); err != nil {
							return err
						}
					}
				}
			}
		} else {
			for _, item := range batch {
				o.verifier.ObserveSourceArchiveItem(item)
				if o.beehiivFingerprint != nil {
					if err := o.beehiivFingerprint.observeSourceArchive(item); err != nil {
						return err
					}
				}
				if !sourceArchiveWarningOnly(item) {
					processed++
					imported++
				} else {
					processed += sourceArchiveWarningProcessedUnits(job.Source, o.verifier.Discovery, item)
				}
			}
		}
		job.Progress.SourceArchiveDone += processed
		if (job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO) && job.Progress.SourceArchiveDone > job.Progress.SourceArchiveTotal {
			return fmt.Errorf("%s source-archive traversal emitted more exact records than discovery (%d > %d): %w", sourceDisplayName(job.Source), job.Progress.SourceArchiveDone, job.Progress.SourceArchiveTotal, adapter.ErrSourceUnavailable)
		}
		if job.Progress.SourceArchiveDone > job.Progress.SourceArchiveTotal {
			job.Progress.SourceArchiveTotal = job.Progress.SourceArchiveDone
		}
		o.verifier.SourceArchiveImported += imported
		c := next
		job.Cursor["source_archive"] = &c
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
		if next == "" {
			if o.verifier.Discovery.SourceArchiveTotal > 0 && job.Progress.SourceArchiveDone != job.Progress.SourceArchiveTotal {
				return fmt.Errorf("source-archive traversal emitted %d of the exact %d discovered records: %w", job.Progress.SourceArchiveDone, job.Progress.SourceArchiveTotal, adapter.ErrSourceUnavailable)
			}
			// Account-wide APIs can collapse an unavailable multi-item surface
			// into one explicit manual-review record. Completeness retains the
			// detected source count; execution progress terminates at emitted work.
			if job.Progress.SourceArchiveDone < job.Progress.SourceArchiveTotal {
				job.Progress.SourceArchiveTotal = job.Progress.SourceArchiveDone
			}
			if o.klaviyoFingerprint != nil {
				if err := o.klaviyoFingerprint.complete("source_archive"); err != nil {
					return err
				}
			}
			if o.customerIOFingerprint != nil {
				if err := o.customerIOFingerprint.complete("source_archive"); err != nil {
					return err
				}
			}
			return nil
		}
		cursor = next
	}
}

func sourceArchiveRequiresGlobalIdentityCheck(source canonical.SourcePlatform, resourceType string) bool {
	if source == canonical.SourceCustomerIO {
		return strings.TrimSpace(resourceType) != ""
	}
	if source != canonical.SourceBeehiiv {
		return false
	}
	switch strings.TrimSpace(resourceType) {
	case "beehiiv_publication",
		"beehiiv_newsletter_list",
		"beehiiv_newsletter_list_subscription",
		"beehiiv_newsletter_list_history_manifest",
		"beehiiv_automation",
		"beehiiv_automation_email",
		"beehiiv_automation_email_inventory_manifest",
		"beehiiv_automation_journey",
		"beehiiv_automation_journey_inventory_manifest",
		"beehiiv_segment",
		"beehiiv_condition_set",
		"beehiiv_condition_set_inventory_manifest",
		"beehiiv_custom_field",
		"beehiiv_premium_tier",
		"beehiiv_referral_milestone",
		"beehiiv_poll",
		"beehiiv_poll_response",
		"beehiiv_post_template",
		"beehiiv_non_campaign_post":
		return true
	default:
		return false
	}
}

func sourceDisplayName(source canonical.SourcePlatform) string {
	switch source {
	case canonical.SourceCustomerIO:
		return "Customer.io"
	case canonical.SourceHubSpot:
		return "HubSpot"
	case canonical.SourceKlaviyo:
		return "Klaviyo"
	case canonical.SourceBeehiiv:
		return "Beehiiv"
	case canonical.SourceSubstack:
		return "Substack"
	default:
		return strings.TrimSpace(string(source))
	}
}

func sourceArchiveWarningOnly(item canonical.SourceArchiveItem) bool {
	if len(item.Warnings) == 0 {
		return false
	}
	if strings.TrimSpace(item.ResourceType) == "" {
		return true
	}
	return strings.HasPrefix(strings.TrimSpace(item.SourceID), "source_archive_warning:")
}

func sourceArchiveWarningProcessedUnits(source canonical.SourcePlatform, disc adapter.DiscoveryReport, item canonical.SourceArchiveItem) int {
	if source != canonical.SourceActiveCampaign {
		return 1
	}
	resourceType := sourceArchivePayloadString(item.Payload, "target_resource_type")
	switch resourceType {
	case "crm_deal":
		return maxInt(1, disc.DealsTotal)
	case "crm_pipeline":
		return maxInt(1, disc.PipelinesTotal)
	case "activecampaign_form":
		return maxInt(1, disc.FormsTotal)
	case "activecampaign_message":
		return maxInt(1, disc.TemplatesTotal)
	case "activecampaign_custom_field":
		return maxInt(1, len(disc.CustomFields))
	case "activecampaign_tag":
		return maxInt(1, disc.GroupsTotal)
	case "activecampaign_custom_object_schema":
		return maxInt(1, disc.CustomObjectsTotal)
	case "activecampaign_ecommerce_order":
		return maxInt(1, disc.EcommerceTotal)
	case "activecampaign_sms_message", "activecampaign_sms_broadcast":
		return maxInt(1, disc.SMSCampaignsTotal)
	default:
		return 1
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

type traversalCursorSet map[[sha256.Size]byte]struct{}

func newTraversalCursorSet() traversalCursorSet {
	return traversalCursorSet{}
}

func recordTraversalCursor(seen traversalCursorSet, current, next, resource string) error {
	if strings.TrimSpace(next) == "" {
		return nil
	}
	if next == current {
		return fmt.Errorf("%s traversal returned the current cursor again: %w", resource, adapter.ErrSourceUnavailable)
	}
	duplicate, err := addBoundedIdentity(seen, "traversal_cursor:"+resource, next, maxSubscriberTraversalPageCalls)
	if err != nil {
		return fmt.Errorf("%s traversal cursor tracking: %w", resource, err)
	}
	if duplicate {
		return fmt.Errorf("%s traversal entered a cursor cycle: %w", resource, adapter.ErrSourceUnavailable)
	}
	return nil
}

func sourceArchiveExpectedTotal(source canonical.SourcePlatform, disc adapter.DiscoveryReport) int {
	const mailchimpStaticSourceArchiveTasks = 10 // one Journey gap + nine guidance records
	if disc.SourceArchiveTotal > 0 {
		return disc.SourceArchiveTotal
	}
	if source == canonical.SourceMailchimp {
		// The adapter emits one audience-schema and one aggregate signup-form
		// record per selected audience, one item per landing page/store, one
		// explicit Customer Journey gap, and nine fixed guidance records.
		return 2*len(disc.Audiences) + disc.LandingPagesTotal + disc.EcommerceTotal + mailchimpStaticSourceArchiveTasks
	}
	if source == canonical.SourceActiveCampaign {
		return activeCampaignCRMTotal(disc) +
			len(disc.CustomFields) +
			disc.GroupsTotal +
			disc.FormsTotal +
			disc.TemplatesTotal +
			disc.CustomObjectsTotal +
			disc.EcommerceTotal +
			disc.SMSCampaignsTotal
	}
	total := disc.CRMTotal
	if total == 0 {
		total = disc.DealsTotal
	}
	total += disc.FormsTotal + disc.LandingPagesTotal + disc.EcommerceTotal
	return total
}

func migrationScopedTemplateName(name, jobID string) string {
	if jobID == "" {
		return name
	}
	short := jobID
	if len(short) > 8 {
		short = short[:8]
	}
	return fmt.Sprintf("%s (migration %s)", name, short)
}

func (o *Orchestrator) runPaidSubs(ctx context.Context, ad adapter.Adapter, sess adapter.Session, job *canonical.MigrationJob, progress ProgressFn) error {
	stripeAcct := ""
	if c, ok := job.Cursor["stripe_account_id"]; ok && c != nil {
		stripeAcct = *c
	}
	subs, err := ad.ListPaidSubs(ctx, sess, stripeAcct)
	if err != nil {
		return err
	}
	job.Progress.PaidSubsTotal = len(subs)
	start := executionCursorIndex(job, stagePaidSubs)
	for i := start; i < len(subs); i++ {
		ps := subs[i]
		if !o.DryRun && o.DB != nil && o.TenantID != "" {
			if _, err := listmonkx.PersistPaidSubscription(ctx, o.DB, o.TenantID, job.ID, ps); err != nil {
				return err
			}
		}
		job.Progress.PaidSubsDone++
		o.verifier.PaidSubsImported++
		setExecutionCursorIndex(job, stagePaidSubs, i+1)
		if err := o.reportProgress(progress, job.Progress); err != nil {
			return err
		}
	}
	return nil
}

func executionCursorIndex(job *canonical.MigrationJob, stage string) int {
	if job == nil || job.Cursor == nil || job.Cursor[stage] == nil {
		return 0
	}
	index, err := strconv.Atoi(strings.TrimSpace(*job.Cursor[stage]))
	if err != nil || index < 0 {
		return 0
	}
	return index
}

func setExecutionCursorIndex(job *canonical.MigrationJob, stage string, index int) {
	if job == nil {
		return
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := strconv.Itoa(index)
	job.Cursor[stage] = &value
}
