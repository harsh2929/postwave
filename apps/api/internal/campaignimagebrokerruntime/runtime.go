// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/db"
)

type Dependencies struct {
	Pool     *db.Pool
	Objects  VersionedS3API
	Resolver campaignimagebroker.DNSResolver
	Dialer   *net.Dialer
	Now      func() time.Time
}

type Runtime struct {
	enabled    bool
	inspector  campaignimagebroker.Inspector
	ocr        *UnixOCREngine
	scanner    *UnixContentScanner
	evidence   *S3EvidenceStore
	repository *Repository
}

// Build is intentionally fail-closed. Feature-off construction acquires no
// database, object-storage, network, or IPC capability. Feature-on
// construction returns only after the restricted schema, exact versioned
// bucket, OCR identity/sandbox, and scanner identity all pass readiness.
func Build(ctx context.Context, configuration Configuration, dependencies Dependencies) (*Runtime, error) {
	if !configuration.Enabled {
		return &Runtime{}, nil
	}
	if err := configuration.Validate(); err != nil {
		return nil, err
	}
	if dependencies.Pool == nil || dependencies.Objects == nil {
		return nil, fmt.Errorf("%w: database and versioned object store are required", ErrInvalidConfiguration)
	}
	repository, err := NewRepository(dependencies.Pool, configuration.CacheRetention)
	if err != nil {
		return nil, err
	}
	ocr, err := NewUnixOCREngine(configuration.OCR)
	if err != nil {
		return nil, err
	}
	scanner, err := NewUnixContentScanner(configuration.Scanner)
	if err != nil {
		return nil, err
	}
	evidence, err := NewS3EvidenceStore(configuration.Evidence, dependencies.Objects, repository)
	if err != nil {
		return nil, err
	}
	if dependencies.Now != nil {
		evidence.now = dependencies.Now
		configuration.Broker.Now = dependencies.Now
	}
	runtime := &Runtime{
		enabled: true, ocr: ocr, scanner: scanner,
		evidence: evidence, repository: repository,
	}
	if err := runtime.Ready(ctx); err != nil {
		return nil, err
	}
	broker, err := campaignimagebroker.New(configuration.Broker, campaignimagebroker.Dependencies{
		Resolver: dependencies.Resolver, Dialer: dependencies.Dialer,
		OCREngine: ocr, Scanner: scanner, Evidence: evidence, Cache: repository,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: compose campaign image broker: %v", ErrInvalidConfiguration, err)
	}
	runtime.inspector = broker
	return runtime, nil
}

func (r *Runtime) Enabled() bool { return r != nil && r.enabled }

func (r *Runtime) Inspector() campaignimagebroker.Inspector {
	if r == nil || !r.enabled {
		return nil
	}
	return r.inspector
}

func (r *Runtime) Ready(ctx context.Context) error {
	if r == nil {
		return ErrInvalidConfiguration
	}
	if !r.enabled {
		return nil
	}
	if r.repository == nil || r.ocr == nil || r.scanner == nil || r.evidence == nil {
		return ErrNotReady
	}
	checks := []struct {
		name string
		fn   func(context.Context) error
	}{
		{"repository", r.repository.Ready},
		{"evidence", r.evidence.Ready},
		{"ocr", r.ocr.Ready},
		{"scanner", r.scanner.Ready},
	}
	for _, check := range checks {
		if err := check.fn(ctx); err != nil {
			return fmt.Errorf("%w: %s readiness: %v", ErrNotReady, check.name, err)
		}
	}
	return nil
}

// InjectWorker is the sole production worker hook. A feature-on runtime can
// never inject a nil or pre-readiness inspector. A feature-off runtime clears
// the optional seam so deterministic assurance remains explicit.
func (r *Runtime) InjectWorker(worker *campaignassuranceworker.Worker) error {
	if r == nil || worker == nil {
		return ErrInvalidConfiguration
	}
	if !r.enabled {
		worker.ImageInspector = nil
		return nil
	}
	if r.inspector == nil || !r.ocr.IsReady() || !r.scanner.IsReady() {
		return ErrNotReady
	}
	worker.ImageInspector = r.inspector
	return nil
}

type RetentionResult struct {
	CacheEntriesDeleted int64
	EvidenceVersions    int
	Failures            int
}

const (
	RetentionSweepInterval = time.Hour
	RetentionSweepBatch    = 1000
)

// SweepRetention is bounded by limit for each storage class. Exact-version S3
// deletion happens before the immutable receipt is appended. Replays are safe:
// an already-missing exact version produces the same receipt identity.
func (r *Runtime) SweepRetention(ctx context.Context, limit int) (RetentionResult, error) {
	if r == nil || !r.enabled || r.repository == nil || r.evidence == nil || limit < 1 || limit > 1000 {
		return RetentionResult{}, ErrInvalidConfiguration
	}
	result := RetentionResult{}
	cacheDeleted, cacheErr := r.repository.SweepExpiredCache(ctx, limit)
	result.CacheEntriesDeleted = cacheDeleted
	records, evidenceListErr := r.repository.ListExpiredEvidence(ctx, limit)
	var failures []error
	if cacheErr != nil {
		failures = append(failures, cacheErr)
	}
	if evidenceListErr != nil {
		failures = append(failures, evidenceListErr)
	} else {
		for _, record := range records {
			if err := r.evidence.DeleteExact(ctx, record); err != nil {
				result.Failures++
				failures = append(failures, err)
				continue
			}
			result.EvidenceVersions++
		}
	}
	if len(failures) != 0 {
		return result, errors.Join(failures...)
	}
	return result, nil
}

// RunRetention supervises serialized bounded sweeps until cancellation. It
// runs once immediately so a restart does not postpone already-expired
// evidence, then on the fixed interval. A failed batch is observed and retried
// on the next interval; it never disables the deletion ledger or spins.
func (r *Runtime) RunRetention(
	ctx context.Context,
	observe func(RetentionResult, error),
) error {
	if r == nil || !r.enabled || observe == nil {
		return ErrInvalidConfiguration
	}
	return runRetentionSupervisor(ctx, RetentionSweepInterval, observe, func(sweepContext context.Context) (RetentionResult, error) {
		return r.SweepRetention(sweepContext, RetentionSweepBatch)
	})
}

func runRetentionSupervisor(
	ctx context.Context,
	interval time.Duration,
	observe func(RetentionResult, error),
	sweep func(context.Context) (RetentionResult, error),
) error {
	if ctx == nil || interval <= 0 || sweep == nil {
		return ErrInvalidConfiguration
	}
	run := func() {
		result, err := sweep(ctx)
		if observe != nil {
			observe(result, err)
		}
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			run()
		}
	}
}
