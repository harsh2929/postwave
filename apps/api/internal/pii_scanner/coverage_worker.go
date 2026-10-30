// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const coverageBookkeepingTimeout = 20 * time.Second

// CoverageAlertSink is the operator-notification seam. Implementations must
// not include subscriber values; the contract exposes UUIDs and closed outcome
// codes only. Production always logs even when no external alert sink is wired.
type CoverageAlertSink interface {
	NotifyPIICoverage(ctx context.Context, alert CoverageAlert) error
}

type CoverageAlert struct {
	TenantID     string
	SubscriberID string
	Kind         string
	ErrorCode    string
	Attempts     int
}

// CoverageMetrics is a cardinality-safe metrics seam. Implementations should
// aggregate by outcome/status and must never label by tenant/subscriber id.
type CoverageMetrics interface {
	IntentClaimed(count int)
	IntentFinished(outcome string, elapsed time.Duration)
	SnapshotLoaded(fields int, bytes int, truncated bool)
	ReconciliationFinished(status string, elapsed time.Duration)
	QueueUnavailable()
}

type noopCoverageMetrics struct{}

func (noopCoverageMetrics) IntentClaimed(int)                            {}
func (noopCoverageMetrics) IntentFinished(string, time.Duration)         {}
func (noopCoverageMetrics) SnapshotLoaded(int, int, bool)                {}
func (noopCoverageMetrics) ReconciliationFinished(string, time.Duration) {}
func (noopCoverageMetrics) QueueUnavailable()                            {}

// CoverageWorker drains revision-only intents and runs bounded reconciliation.
// Multiple API replicas may run it: SKIP LOCKED claims, expiring leases, owner
// checks, and idempotent findings make processing safely at-least-once.
type CoverageWorker struct {
	Repo     *Repo
	Detector *Detector
	Deps     *Deps
	Logger   *slog.Logger
	Alerts   CoverageAlertSink
	Metrics  CoverageMetrics
	OwnerID  string

	PollInterval          time.Duration
	LeaseTTL              time.Duration
	HandlerTimeout        time.Duration
	ReconciliationTimeout time.Duration
	ClaimBatch            int
	ScanConcurrency       int
	ReconcileBatch        int
	ReconcileTenants      int
	ReconcileConcurrency  int
	Now                   func() time.Time
	RandomUint64          func() (uint64, error)
	// runtimeHeartbeatInterval is a deterministic test seam. Production uses
	// scannerAvailabilityHeartbeat so the public API's grace-window view stays
	// truthful even while a scan/reconciliation tick is busy for much longer.
	runtimeHeartbeatInterval time.Duration
	contractFenceReported    bool
}

func NewCoverageWorker(repo *Repo, detector *Detector) *CoverageWorker {
	owner := ""
	if generated, err := uuid.NewRandom(); err == nil {
		owner = generated.String()
	}
	return &CoverageWorker{
		Repo:                     repo,
		Detector:                 detector,
		OwnerID:                  owner,
		PollInterval:             2 * time.Second,
		LeaseTTL:                 2 * time.Minute,
		HandlerTimeout:           90 * time.Second,
		ReconciliationTimeout:    60 * time.Second,
		ClaimBatch:               25,
		ScanConcurrency:          4,
		ReconcileBatch:           200,
		ReconcileTenants:         4,
		ReconcileConcurrency:     1,
		Now:                      time.Now,
		RandomUint64:             cryptoRandomUint64,
		Metrics:                  prometheusCoverageMetrics{},
		runtimeHeartbeatInterval: scannerAvailabilityHeartbeat,
	}
}

func cryptoRandomUint64() (uint64, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint64(buf[:]), nil
}

func (w *CoverageWorker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *CoverageWorker) metrics() CoverageMetrics {
	if w != nil && w.Metrics != nil {
		return w.Metrics
	}
	return noopCoverageMetrics{}
}

func (w *CoverageWorker) validate() error {
	if w == nil || w.Repo == nil || w.Repo.Pool == nil {
		return errors.New("pii_scanner: coverage worker requires a repository")
	}
	if _, err := uuid.Parse(w.OwnerID); err != nil {
		return errors.New("pii_scanner: coverage worker requires a cryptographically random UUID owner")
	}
	if w.PollInterval <= 0 || w.LeaseTTL <= 0 || w.HandlerTimeout <= 0 || w.ReconciliationTimeout <= 0 ||
		w.runtimeHeartbeatInterval <= 0 {
		return errors.New("pii_scanner: coverage worker durations must be positive")
	}
	if w.HandlerTimeout >= w.LeaseTTL || w.ReconciliationTimeout >= w.LeaseTTL {
		// Heartbeats permit long work, but keeping the initial timeout below the
		// lease makes a stopped heartbeat fail safe without overlapping workers.
		return errors.New("pii_scanner: handler timeout must be shorter than lease TTL")
	}
	if w.ScanConcurrency < 1 || w.ScanConcurrency > 16 ||
		w.ReconcileConcurrency < 1 || w.ReconcileConcurrency > 4 {
		return errors.New("pii_scanner: worker concurrency is outside the bounded range")
	}
	return nil
}

// Run blocks until cancellation. An immediate tick handles enable transitions
// without waiting for the idle interval; busy ticks loop immediately.
func (w *CoverageWorker) Run(ctx context.Context) error {
	if err := w.validate(); err != nil {
		return err
	}
	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	heartbeatDone := make(chan struct{})
	go w.runtimeAvailabilityHeartbeat(heartbeatCtx, heartbeatDone)
	defer func() {
		stopHeartbeat()
		<-heartbeatDone
	}()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		work, err := w.Tick(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			w.log().Warn("shadow PII coverage tick failed", "error_code", scanFailureCode(err))
		}
		if work > 0 {
			continue
		}
		timer := time.NewTimer(w.PollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// runtimeAvailabilityHeartbeat is deliberately independent of Tick. A tick
// may spend up to the handler/reconciliation timeout processing bounded work;
// tying deployment liveness to tick completion would let the persisted
// "available" state become stale and make public config responses lie. The
// exact contract CAS also keeps old rolling-deploy replicas fenced.
func (w *CoverageWorker) runtimeAvailabilityHeartbeat(ctx context.Context, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(w.runtimeHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			timeout := w.runtimeHeartbeatInterval
			if timeout < time.Second {
				timeout = time.Second
			}
			if timeout > coverageBookkeepingTimeout {
				timeout = coverageBookkeepingTimeout
			}
			heartbeatCtx, cancel := context.WithTimeout(ctx, timeout)
			scanContract, available := currentCoverageScanContract(w.Detector)
			_, err := w.Repo.activateScannerContract(heartbeatCtx, available, scanContract)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				w.log().Warn("shadow PII runtime heartbeat failed", "error_code", scanFailureCode(err))
			}
		}
	}
}

// Tick is exported for deterministic operational and crash-reclaim tests.
func (w *CoverageWorker) Tick(ctx context.Context) (int, error) {
	if err := w.validate(); err != nil {
		return 0, err
	}
	scanContract, available := currentCoverageScanContract(w.Detector)
	contractAccepted, err := w.Repo.activateScannerContract(ctx, available, scanContract)
	if err != nil {
		return 0, err
	}
	if !available {
		w.metrics().QueueUnavailable()
		return 0, nil
	}
	if !contractAccepted {
		// Another (newer) already-observed contract is active. This replica must
		// remain read-only for the queue so rolling deploys cannot oscillate
		// generations or scan new work with stale provenance.
		w.metrics().QueueUnavailable()
		if !w.contractFenceReported {
			w.log().Warn("shadow PII worker fenced by active scanner contract",
				"error_code", "scanner_contract_stale")
			w.contractFenceReported = true
		}
		return 0, nil
	}
	w.contractFenceReported = false

	work := 0
	reconcileClaimLimit := w.ReconcileTenants
	if reconcileClaimLimit < 1 {
		reconcileClaimLimit = 1
	}
	if reconcileClaimLimit > w.ReconcileConcurrency {
		reconcileClaimLimit = w.ReconcileConcurrency
	}
	reconciliations, err := w.Repo.ClaimReconciliations(
		ctx, w.OwnerID, w.LeaseTTL, reconcileClaimLimit, scanContract,
	)
	if err != nil {
		return 0, err
	}
	type reconciliationResult struct {
		lease    reconciliationLease
		snapshot *CoverageSnapshot
		err      error
		elapsed  time.Duration
	}
	reconcileResults := make(chan reconciliationResult, len(reconciliations))
	for _, lease := range reconciliations {
		lease := lease
		go func() {
			started := w.now()
			snapshot, reconcileErr := w.reconcileSafely(ctx, lease)
			reconcileResults <- reconciliationResult{
				lease: lease, snapshot: snapshot, err: reconcileErr,
				elapsed: w.now().Sub(started),
			}
		}()
	}
	for range reconciliations {
		result := <-reconcileResults
		status := "failed"
		if result.snapshot != nil {
			status = result.snapshot.Status
		}
		w.metrics().ReconciliationFinished(status, result.elapsed)
		if result.err != nil {
			w.log().Warn("shadow PII reconciliation failed",
				"tenant_id", result.lease.TenantID,
				"error_code", scanFailureCode(result.err))
			w.releaseReconciliationDetached(result.lease)
			continue
		}
		work++
		if result.snapshot != nil && result.snapshot.Status == "degraded" {
			w.alert(ctx, CoverageAlert{TenantID: result.lease.TenantID, Kind: "coverage_degraded"})
		}
	}

	claimLimit := w.ClaimBatch
	if claimLimit < 1 {
		claimLimit = 1
	}
	if claimLimit > w.ScanConcurrency {
		claimLimit = w.ScanConcurrency
	}
	intents, err := w.Repo.ClaimScanIntents(ctx, w.OwnerID, w.LeaseTTL, claimLimit, scanContract)
	if err != nil {
		return work, err
	}
	w.metrics().IntentClaimed(len(intents))
	var scanGroup sync.WaitGroup
	startedIntents := 0
	for _, intent := range intents {
		if err := ctx.Err(); err != nil {
			break
		}
		intent := intent
		scanGroup.Add(1)
		startedIntents++
		go func() {
			defer scanGroup.Done()
			w.processSafely(ctx, intent)
		}()
	}
	scanGroup.Wait()
	work += startedIntents
	if err := ctx.Err(); err != nil {
		return work, err
	}
	return work, nil
}

// currentCoverageScanContract binds a coverage generation to every executable
// input that changes the meaning or protected identity of a scan. The pepper is
// deliberately excluded; its non-secret version and one-way HMAC commitment
// are persisted so same-version/different-key replicas fail closed.
func currentCoverageScanContract(detector *Detector) (string, bool) {
	if detector == nil || len(detector.fingerprintKey) < MinFingerprintPepperBytes {
		return "", false
	}
	keyVersion := strings.TrimSpace(detector.FingerprintKeyVersion())
	if !fingerprintKeyVersionRE.MatchString(keyVersion) || keyVersion == LegacyFingerprintKeyVersion {
		return "", false
	}
	keyCommitment := detector.FingerprintKeyCommitment()
	if !isFullFingerprint(keyCommitment) {
		return "", false
	}
	contract := fmt.Sprintf(
		"scanner=%s@%s|detector=%s@%s|policy=%s@%s|fingerprint=%s@%s|key_commitment=%s:%s",
		ScannerName, ScannerVersion, DetectorName, DetectorVersion,
		PolicyName, PolicyVersion, FingerprintSchemeHMACSHA256V1, keyVersion,
		FingerprintSchemeHMACSHA256V1, keyCommitment,
	)
	if len(contract) > maxCoverageScanContractBytes {
		return "", false
	}
	return contract, true
}

func (w *CoverageWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *CoverageWorker) processSafely(parent context.Context, intent ScanIntent) {
	started := w.now()
	outcome := "failed"
	defer func() {
		if recovered := recover(); recovered != nil {
			w.log().Error("shadow PII poison row panic isolated",
				"tenant_id", intent.TenantID,
				"subscriber_id", intent.SubscriberID,
				"panic_type", fmt.Sprintf("%T", recovered),
				"stack", string(debug.Stack()))
			w.failDetached(intent, "internal_failure")
			outcome = "panic"
		}
		w.metrics().IntentFinished(outcome, w.now().Sub(started))
	}()

	ctx, cancel := context.WithTimeout(parent, w.HandlerTimeout)
	heartbeatDone := make(chan struct{})
	go w.heartbeat(ctx, cancel, intent, heartbeatDone)
	defer func() {
		cancel()
		<-heartbeatDone
	}()

	snapshot, err := w.Repo.LoadClaimedSubscriberSnapshot(ctx, intent)
	if errors.Is(err, ErrSubscriberGone) {
		// The composite FK cascades state/intent deletion with the subscriber.
		// There is no value to scan and no gap evidence to retain.
		outcome = "erased"
		return
	}
	if err != nil {
		w.failDetached(intent, scanFailureCode(err))
		return
	}
	w.metrics().SnapshotLoaded(snapshot.CandidateFields, snapshot.TransportBytes, snapshot.TransportTruncated)
	result := w.Detector.ScanFields(intent.TenantID, snapshot.Fields, snapshot.Declared)
	if err := applySnapshotCoverageLimits(snapshot, &result); err != nil {
		w.failDetached(intent, "invalid_subscriber_snapshot")
		return
	}
	inserted, needsMore, err := w.Repo.CompleteScan(
		ctx, intent, snapshot, result, w.Detector.FingerprintKeyVersion(),
	)
	if err != nil {
		w.failDetached(intent, scanFailureCode(err))
		return
	}
	if result.Truncated {
		outcome = "truncated"
		w.log().Error("shadow PII intent truncated and dead-lettered",
			"tenant_id", intent.TenantID,
			"subscriber_id", intent.SubscriberID,
			"fields_over_limit", result.FieldsOverLimit,
			"error_code", "scan_truncated")
		w.alert(parent, CoverageAlert{
			TenantID: intent.TenantID, SubscriberID: intent.SubscriberID,
			Kind: "scan_truncated", ErrorCode: "scan_truncated", Attempts: intent.Attempts,
		})
	} else if needsMore {
		outcome = "superseded"
	} else if len(result.Detections) > 0 {
		outcome = "findings"
	} else {
		// Storage/metric compatibility code: no finding in the bounded current
		// subscribers-row projection, not a claim about retained content stores.
		outcome = "clean"
	}
	if inserted > 0 && w.Deps != nil {
		w.Deps.emit(intent.TenantID, "subscriber.pii_detected", map[string]any{
			"subscriber_id":  intent.SubscriberID,
			"finding_count":  inserted,
			"total_detected": len(result.Detections),
			"truncated":      result.Truncated,
		})
	}
}

func (w *CoverageWorker) reconcileSafely(parent context.Context, lease reconciliationLease) (
	snapshot *CoverageSnapshot,
	err error,
) {
	ctx, cancel := context.WithTimeout(parent, w.ReconciliationTimeout)
	heartbeatDone := make(chan struct{})
	go w.reconciliationHeartbeat(ctx, cancel, lease, heartbeatDone)
	defer func() {
		cancel()
		<-heartbeatDone
		if recovered := recover(); recovered != nil {
			w.log().Error("shadow PII reconciliation panic isolated",
				"tenant_id", lease.TenantID,
				"panic_type", fmt.Sprintf("%T", recovered),
				"stack", string(debug.Stack()))
			snapshot = nil
			err = errors.New("pii_scanner: reconciliation panic")
		}
	}()
	return w.Repo.ReconcileTenant(ctx, lease, w.ReconcileBatch)
}

func (w *CoverageWorker) heartbeat(ctx context.Context, cancel context.CancelFunc, intent ScanIntent, done chan<- struct{}) {
	defer close(done)
	interval := w.LeaseTTL / 3
	if interval < 250*time.Millisecond {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hbCtx, hbCancel := context.WithTimeout(context.Background(), minDuration(interval, 10*time.Second))
			err := w.Repo.RenewScanLease(hbCtx, intent, w.LeaseTTL)
			hbCancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}

func (w *CoverageWorker) reconciliationHeartbeat(
	ctx context.Context,
	cancel context.CancelFunc,
	lease reconciliationLease,
	done chan<- struct{},
) {
	defer close(done)
	interval := w.LeaseTTL / 3
	if interval < 250*time.Millisecond {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hbCtx, hbCancel := context.WithTimeout(context.Background(), minDuration(interval, 10*time.Second))
			err := w.Repo.RenewReconciliationLease(hbCtx, lease, w.LeaseTTL)
			hbCancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func (w *CoverageWorker) failDetached(intent ScanIntent, code string) {
	if code == "lease_lost" {
		return
	}
	now := w.now()
	random := uint64(0)
	if w.RandomUint64 != nil {
		if value, err := w.RandomUint64(); err == nil {
			random = value
		}
	}
	retryAt := now.Add(retryDelay(intent.Attempts, random))
	ctx, cancel := context.WithTimeout(context.Background(), coverageBookkeepingTimeout)
	defer cancel()
	dead, err := w.Repo.FailScanIntent(ctx, intent, code, retryAt)
	if err != nil && !errors.Is(err, ErrLeaseLost) {
		w.log().Error("shadow PII failure bookkeeping failed",
			"tenant_id", intent.TenantID,
			"subscriber_id", intent.SubscriberID,
			"error_code", scanFailureCode(err))
		return
	}
	if dead {
		w.log().Error("shadow PII intent dead-lettered",
			"tenant_id", intent.TenantID,
			"subscriber_id", intent.SubscriberID,
			"attempts", intent.Attempts,
			"error_code", code)
		w.alert(ctx, CoverageAlert{
			TenantID: intent.TenantID, SubscriberID: intent.SubscriberID,
			Kind: "dead_letter", ErrorCode: code, Attempts: intent.Attempts,
		})
	}
}

func (w *CoverageWorker) releaseReconciliationDetached(lease reconciliationLease) {
	ctx, cancel := context.WithTimeout(context.Background(), coverageBookkeepingTimeout)
	defer cancel()
	if err := w.Repo.ReleaseReconciliationLease(ctx, lease); err != nil && !errors.Is(err, ErrLeaseLost) {
		w.log().Error("shadow PII reconciliation release failed",
			"tenant_id", lease.TenantID,
			"error_code", scanFailureCode(err))
	}
}

// retryDelay is exponential backoff (5s base, 1h cap) plus up to 25% jitter.
// A failed CSPRNG read simply supplies zero jitter; it never invents entropy.
func retryDelay(attempt int, random uint64) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 10 {
		shift = 10
	}
	base := 5 * time.Second * time.Duration(1<<shift)
	if base > time.Hour {
		base = time.Hour
	}
	jitterRange := uint64(base / 4)
	if jitterRange == 0 {
		return base
	}
	return base + time.Duration(random%(jitterRange+1))
}

func (w *CoverageWorker) alert(parent context.Context, alert CoverageAlert) {
	if w.Alerts == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
	defer cancel()
	if err := w.Alerts.NotifyPIICoverage(ctx, alert); err != nil {
		w.log().Warn("shadow PII coverage alert failed",
			"tenant_id", alert.TenantID,
			"subscriber_id", alert.SubscriberID,
			"kind", alert.Kind,
			"error_code", scanFailureCode(err))
	}
}
