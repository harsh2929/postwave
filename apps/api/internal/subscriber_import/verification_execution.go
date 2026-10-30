// SPDX-License-Identifier: AGPL-3.0-only
//
// Durable verification contract for confirmed subscriber imports.
//
// This package intentionally owns only a small, provider-neutral vocabulary.
// The server composition layer adapts the verification subsystem to it, so
// subscriber_import never imports or reaches into internal/verification.

package subscriber_import

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrImportVerificationBinding marks a durable integrity conflict, not a
// transient provider/database outage. Retrying such a conflict automatically
// would spin forever or risk attaching an import to different billable work.
var ErrImportVerificationBinding = errors.New("subscriber import verification binding conflict")

// subscriberImportLogErrorClass reduces worker and preview failures to a
// closed, non-PII vocabulary. Provider, storage, and PostgreSQL errors may
// contain an address, source object key, rejected row detail, or upstream URL;
// none of those values belong in the process log. Durable/user-facing import
// state already records bounded public error codes separately.
func subscriberImportLogErrorClass(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, ErrImportVerificationBinding):
		return "verification_binding_conflict"
	case errors.Is(err, pgx.ErrNoRows):
		return "record_not_found"
	default:
		return "internal_or_dependency"
	}
}

const (
	ImportVerificationModeOff   = "off"
	ImportVerificationModeLocal = "local"
	ImportVerificationModeFull  = "full"

	ImportVerificationStateOff       = "off"
	ImportVerificationStatePending   = "pending"
	ImportVerificationStateRunning   = "running"
	ImportVerificationStateCompleted = "completed"
	ImportVerificationStateFailed    = "failed"
)

// ImportVerificationRun is the durable job state visible to the import
// worker. Decisions are populated only after State=completed.
type ImportVerificationRun struct {
	JobID       string
	State       string
	FailureCode string
	Decisions   map[string]ImportVerificationDecision
}

// ImportVerificationDecision is deliberately minimal. Enrichment and scores
// remain available on the verification job surface; the importer only needs
// the canonical status required to enforce its admission boundary.
type ImportVerificationDecision struct {
	Status string
}

// ImportExecutionVerifier is implemented by the server composition adapter.
// Ensure must be idempotent for (tenant, import, mode, normalized addresses),
// and Get must never re-run provider work.
type ImportExecutionVerifier interface {
	CurrentImportVerificationMode(ctx context.Context, tenantID string) (string, error)
	EnsureImportVerification(ctx context.Context, tenantID, importID, mode string, emails []string) (ImportVerificationRun, error)
	GetImportVerification(ctx context.Context, tenantID, importID, jobID, mode string) (ImportVerificationRun, error)
	ActivateImportVerification(ctx context.Context, tenantID, importID, jobID, mode string) error
	CancelImportVerification(ctx context.Context, tenantID, jobID string) error
}

func (d *Deps) currentImportVerificationMode(ctx context.Context, tenantID string) (string, error) {
	if d == nil || d.ExecutionVerification == nil {
		if d == nil || d.Pool == nil {
			return "", errors.New("subscriber import verification policy adapter is unavailable")
		}
		// Fail-safe composition fallback: read the provider-neutral policy
		// column directly so a missing adapter can never turn a configured
		// local/full workspace into an unverified import. Execution will later
		// fail closed unless the adapter is restored.
		tx, err := db.WithTenant(ctx, d.Pool, tenantID)
		if err != nil {
			return "", err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var mode string
		err = tx.QueryRow(ctx, `SELECT import_mode FROM verification_policy WHERE tenant_id=$1::uuid`, tenantID).Scan(&mode)
		if errors.Is(err, pgx.ErrNoRows) {
			return ImportVerificationModeOff, nil
		}
		if err != nil {
			return "", err
		}
		return normalizeImportVerificationMode(mode)
	}
	mode, err := d.ExecutionVerification.CurrentImportVerificationMode(ctx, tenantID)
	if err != nil {
		return "", err
	}
	return normalizeImportVerificationMode(mode)
}

func normalizeImportVerificationMode(mode string) (string, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = ImportVerificationModeOff
	}
	switch mode {
	case ImportVerificationModeOff, ImportVerificationModeLocal, ImportVerificationModeFull:
		return mode, nil
	default:
		return "", fmt.Errorf("unsupported import verification mode %q", mode)
	}
}

func verificationRejectsImport(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "invalid", "spamtrap", "abuse", "do_not_mail":
		return true
	default:
		return false
	}
}

func validateImportVerificationDecisions(emails []string, decisions map[string]ImportVerificationDecision) error {
	if len(emails) == 0 {
		return nil
	}
	if len(decisions) != len(emails) {
		return errors.New("completed verification job has an incomplete decision set")
	}
	for _, email := range emails {
		decision, ok := decisions[strings.ToLower(strings.TrimSpace(email))]
		if !ok || strings.TrimSpace(decision.Status) == "" {
			return errors.New("completed verification job is missing an address decision")
		}
		switch strings.ToLower(strings.TrimSpace(decision.Status)) {
		case "valid", "invalid", "catch_all", "spamtrap", "abuse", "do_not_mail", "unknown":
		default:
			return errors.New("completed verification job contains an unsupported address decision")
		}
	}
	return nil
}

// enforceImportVerification removes terminally unsafe rows before any
// subscriber or consent write is attempted. The row error contains no email
// or provider payload and is safe for the existing privacy-bounded ledger.
func enforceImportVerification(batch *preparedBatch, decisions map[string]ImportVerificationDecision) int64 {
	if batch == nil || len(batch.Accepted) == 0 {
		return 0
	}
	kept := batch.Accepted[:0]
	var rejected int64
	for _, candidate := range batch.Accepted {
		decision, ok := decisions[candidate.Email]
		if ok && verificationRejectsImport(decision.Status) {
			batch.Errors = append(batch.Errors, rowError{
				RowNumber: candidate.RowNumber,
				Code:      "email_verification_rejected",
				Message:   "Email was rejected by the confirmed verification policy",
			})
			rejected++
			continue
		}
		kept = append(kept, candidate)
	}
	batch.Accepted = kept
	return rejected
}
