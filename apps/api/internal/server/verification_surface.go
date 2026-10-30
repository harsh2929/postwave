// SPDX-License-Identifier: AGPL-3.0-only
//
// verification_surface.go — composition for the email-verification
// connector layer (internal/verification).
//
// This is mounted as its own surface rather than folded into
// MountSubscriberProtectionUtilities because that function is pinned
// by a route-count-and-scope contract test against a legacy reference
// mount; adding routes there would break an assertion that exists to
// catch accidental drift, which is exactly the assertion we want to
// keep working.

package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/subscriber_import"
	"github.com/postwave/postwave/apps/api/internal/verification"
)

// VerificationSurfaceDeps wires the verification routes and worker.
type VerificationSurfaceDeps struct {
	Router chi.Router
	Pool   *db.Pool
	Logger *slog.Logger
	// BulkJobCreationEnabled is an explicit release/kill-switch value supplied
	// by composition. A constructed Store/Runner alone never enables writes.
	BulkJobCreationEnabled bool
	// Secrets resolves the tenant's BYO vendor API key from its
	// credential_ref. Optional: without it the free local tier still
	// works and any configured vendor fails loudly at chain-build
	// time rather than silently doing nothing.
	Secrets verification.SecretResolver
	// Store, when non-nil, is used instead of constructing a new one.
	// main.go builds the store early because the FORMS signup gate
	// needs it at forms.Deps construction time, long before the
	// authenticated router this surface mounts on exists. Sharing one
	// instance also shares its DNS cache across both call paths.
	Store *verification.Store
}

// NewVerificationStore builds the shared store. Exported so main.go can
// construct it before forms.Deps and hand the same instance to both.
func NewVerificationStore(pool *db.Pool, logger *slog.Logger, secrets verification.SecretResolver) *verification.Store {
	if pool == nil {
		return nil
	}
	return &verification.Store{
		Pool:    pool,
		Logger:  logger,
		Secrets: secrets,
		// One shared LocalVerifier across tenants: its only state is a
		// DNS answer cache, and DNS is not tenant-specific, so a
		// per-tenant instance would just repeat identical lookups.
		Local: &verification.LocalVerifier{},
	}
}

// VerificationSurface exposes the pieces main.go needs to start
// background work.
type VerificationSurface struct {
	Store  *verification.Store
	Runner *verification.Runner
}

// MountVerificationSurface registers the verification API and returns
// the job runner for the worker supervisor to start.
//
// Structurally incomplete dependencies mount nothing and return a zero
// surface, matching the convention the other Mount* helpers follow —
// a half-registered surface is worse than an absent one.
func MountVerificationSurface(deps VerificationSurfaceDeps) VerificationSurface {
	if deps.Router == nil || deps.Pool == nil {
		return VerificationSurface{}
	}

	store := deps.Store
	if store == nil {
		store = NewVerificationStore(deps.Pool, deps.Logger, deps.Secrets)
	}
	runner := &verification.Runner{
		Store:  store,
		Logger: deps.Logger,
		// Bounded per-invocation work so one enormous list cannot
		// starve every other tenant's job.
		MaxBatchesPerRun: 20,
	}

	verification.MountRoutes(deps.Router, &verification.Deps{
		Store:                  store,
		Logger:                 deps.Logger,
		Runner:                 runner,
		BulkJobCreationEnabled: deps.BulkJobCreationEnabled,
	})

	return VerificationSurface{Store: store, Runner: runner}
}

// --- forms signup-gate adapter ---

// FormsSignupGate adapts a *verification.Store to the narrow
// forms.SignupGate interface.
//
// The adapter exists so internal/forms never imports internal/verification.
// forms is public-facing and heavily edited; keeping the dependency
// one-way means a change to the verification package's types cannot
// ripple into the public submit path.
type FormsSignupGate struct {
	Store *verification.Store
}

// GateSignup implements forms.SignupGate.
func (g FormsSignupGate) GateSignup(
	ctx context.Context,
	tenantID, formID, email, submissionAttemptID string,
	requestFingerprint []byte,
	antiAbuseAuthorized bool,
) (forms.SignupDecision, error) {
	if g.Store == nil {
		return forms.SignupDecision{Allow: true}, nil
	}
	d, err := g.Store.GateSignupAuthorizedAttempt(
		ctx, tenantID, formID, email, submissionAttemptID, requestFingerprint,
		antiAbuseAuthorized,
	)
	if err != nil {
		return forms.SignupDecision{Allow: true}, err
	}
	return forms.SignupDecision{
		Allow:      d.Allow,
		Checked:    d.Checked,
		Degraded:   d.Degraded,
		Retryable:  d.Retryable,
		Reason:     d.Reason,
		DidYouMean: d.DidYouMean,
	}, nil
}

// NewFormsSignupGate returns a gate, or nil when there is no store to
// back it. Returning a typed nil would defeat forms' nil check, so the
// nil case is handled here.
func NewFormsSignupGate(store *verification.Store) forms.SignupGate {
	if store == nil {
		return nil
	}
	return FormsSignupGate{Store: store}
}

// --- import-preflight projector adapter ---

// ImportVerificationProjector adapts a *verification.Store to the
// narrow subscriber_import.ImportProjector interface, keeping the
// dependency one-way for the same reason as FormsSignupGate.
type ImportVerificationProjector struct {
	Store *verification.Store
}

// ProjectImportPreflight implements subscriber_import.ImportProjector.
func (p ImportVerificationProjector) ProjectImportPreflight(
	ctx context.Context, tenantID string, emails []string,
) (subscriber_import.VerificationProjection, error) {
	if p.Store == nil {
		return subscriber_import.VerificationProjection{}, nil
	}
	got, err := p.Store.ProjectImport(ctx, tenantID, emails)
	if err != nil {
		return subscriber_import.VerificationProjection{}, err
	}
	out := subscriber_import.VerificationProjection{
		Mode:              got.Mode,
		Total:             got.Total,
		Duplicates:        got.Duplicates,
		LocallyDecided:    got.LocallyDecided,
		CacheHits:         got.CacheHits,
		NeedsMailboxProbe: got.NeedsMailboxProbe,
		WouldCostCredits:  got.WouldCostCredits,
		ByStatus:          got.ByStatus,
		SuggestionsCapped: got.SuggestionsCapped,
	}
	for _, sg := range got.Suggestions {
		out.Suggestions = append(out.Suggestions, subscriber_import.TypoSuggestion{
			Email: sg.Email, DidYouMean: sg.DidYouMean,
		})
	}
	return out, nil
}

// NewImportVerificationProjector returns a projector, or nil when there
// is no store to back it.
func NewImportVerificationProjector(store *verification.Store) subscriber_import.ImportProjector {
	if store == nil {
		return nil
	}
	return ImportVerificationProjector{Store: store}
}

// ImportExecutionVerifier adapts durable verification jobs to the import
// worker's provider-neutral enforcement contract. The idempotency key is
// deterministic per import, while the verification job fingerprint also binds
// the immutable mode and normalized address set.
type ImportExecutionVerifier struct {
	Store *verification.Store
}

func (v ImportExecutionVerifier) CurrentImportVerificationMode(
	ctx context.Context, tenantID string,
) (string, error) {
	if v.Store == nil {
		return subscriber_import.ImportVerificationModeOff, nil
	}
	policy, err := v.Store.Policy(ctx, tenantID)
	if err != nil {
		return "", err
	}
	return policy.ImportMode, nil
}

func (v ImportExecutionVerifier) EnsureImportVerification(
	ctx context.Context, tenantID, importID, mode string, emails []string,
) (subscriber_import.ImportVerificationRun, error) {
	if v.Store == nil {
		return subscriber_import.ImportVerificationRun{}, verification.ErrNotConfigured
	}
	job, err := v.Store.CreateJob(ctx, tenantID, verification.JobSpec{
		Source:               verification.JobSourceUpload,
		SourceRef:            importID,
		Emails:               emails,
		ExecutionMode:        mode,
		IdempotencyKey:       verification.SubscriberImportJobIdempotencyKey(importID),
		SubscriberImportHeld: true,
	})
	if err != nil {
		if errors.Is(err, verification.ErrJobIdempotencyConflict) {
			return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: idempotency input changed", subscriber_import.ErrImportVerificationBinding)
		}
		if errors.Is(err, verification.ErrSubscriberImportJobBinding) {
			return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: import lifecycle changed", subscriber_import.ErrImportVerificationBinding)
		}
		return subscriber_import.ImportVerificationRun{}, err
	}
	return v.importVerificationRun(ctx, tenantID, importID, mode, job)
}

func (v ImportExecutionVerifier) GetImportVerification(
	ctx context.Context, tenantID, importID, jobID, mode string,
) (subscriber_import.ImportVerificationRun, error) {
	if v.Store == nil {
		return subscriber_import.ImportVerificationRun{}, verification.ErrNotConfigured
	}
	job, err := v.Store.GetJob(ctx, tenantID, jobID)
	if err != nil {
		if errors.Is(err, verification.ErrJobNotFound) {
			return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: linked job is missing", subscriber_import.ErrImportVerificationBinding)
		}
		return subscriber_import.ImportVerificationRun{}, err
	}
	return v.importVerificationRun(ctx, tenantID, importID, mode, job)
}

func (v ImportExecutionVerifier) CancelImportVerification(
	ctx context.Context, tenantID, jobID string,
) error {
	if v.Store == nil {
		return nil
	}
	return v.Store.CancelJob(ctx, tenantID, jobID)
}

func (v ImportExecutionVerifier) ActivateImportVerification(
	ctx context.Context, tenantID, importID, jobID, mode string,
) error {
	if v.Store == nil {
		return verification.ErrNotConfigured
	}
	job, err := v.Store.GetJob(ctx, tenantID, jobID)
	if err != nil {
		if errors.Is(err, verification.ErrJobNotFound) {
			return fmt.Errorf("%w: linked job is missing", subscriber_import.ErrImportVerificationBinding)
		}
		return err
	}
	if job.ExecutionClass != verification.JobExecutionClassSubscriberImport || job.Source != verification.JobSourceUpload ||
		job.SourceRef != importID || job.ExecutionMode != mode {
		return fmt.Errorf("%w: linked job metadata changed", subscriber_import.ErrImportVerificationBinding)
	}
	if job.Status == verification.JobStatusCompleted || job.Status == verification.JobStatusFailed ||
		job.Status == verification.JobStatusCanceled {
		return nil
	}
	if err := v.Store.ActivateSubscriberImportJob(ctx, tenantID, jobID, importID, mode); err != nil {
		return err
	}
	return nil
}

func (v ImportExecutionVerifier) importVerificationRun(
	ctx context.Context, tenantID, importID, mode string, job *verification.Job,
) (subscriber_import.ImportVerificationRun, error) {
	if job == nil || job.ExecutionClass != verification.JobExecutionClassSubscriberImport || job.Source != verification.JobSourceUpload ||
		job.SourceRef != importID || job.ExecutionMode != mode {
		return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: linked job metadata changed", subscriber_import.ErrImportVerificationBinding)
	}
	run := subscriber_import.ImportVerificationRun{JobID: job.ID, FailureCode: job.FailureCode}
	switch job.Status {
	case verification.JobStatusPending:
		run.State = subscriber_import.ImportVerificationStatePending
	case verification.JobStatusRunning:
		run.State = subscriber_import.ImportVerificationStateRunning
	case verification.JobStatusCompleted:
		run.State = subscriber_import.ImportVerificationStateCompleted
		run.Decisions = make(map[string]subscriber_import.ImportVerificationDecision, job.Total)
		for offset := 0; offset < job.Total; offset += 1000 {
			items, err := v.Store.JobResults(ctx, tenantID, job.ID, verification.JobResultFilter{
				Limit: 1000, Offset: offset,
			})
			if err != nil {
				return subscriber_import.ImportVerificationRun{}, err
			}
			for _, item := range items {
				if !item.Processed || item.AttemptState != "succeeded" {
					return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: completed job contains unsettled items", subscriber_import.ErrImportVerificationBinding)
				}
				run.Decisions[verification.NormalizeEmail(item.Email)] = subscriber_import.ImportVerificationDecision{
					Status: item.Status,
				}
			}
			if len(items) == 0 {
				break
			}
		}
		if len(run.Decisions) != job.Total {
			return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: completed job result count mismatch", subscriber_import.ErrImportVerificationBinding)
		}
	case verification.JobStatusFailed, verification.JobStatusCanceled:
		run.State = subscriber_import.ImportVerificationStateFailed
	default:
		return subscriber_import.ImportVerificationRun{}, fmt.Errorf("%w: unsupported job lifecycle", subscriber_import.ErrImportVerificationBinding)
	}
	return run, nil
}

func NewImportExecutionVerifier(store *verification.Store) subscriber_import.ImportExecutionVerifier {
	if store == nil {
		return nil
	}
	return ImportExecutionVerifier{Store: store}
}
