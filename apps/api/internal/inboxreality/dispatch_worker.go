// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

var (
	ErrDispatchRetryable = errors.New("inboxreality: deliverability dispatch is retryable")
	ErrDispatchPermanent = errors.New("inboxreality: deliverability dispatch is permanent")
)

type ArtifactObjectReader interface {
	Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error)
}

type DeliverabilityExecutor interface {
	Execute(ctx context.Context, request inboxrealitycontract.DispatchRequest) (inboxrealitycontract.ExecutionReceipt, error)
}

type DispatchWorker struct {
	Lifecycle    LifecycleStore
	Tests        Store
	Objects      ArtifactObjectReader
	Executor     DeliverabilityExecutor
	OwnerID      string
	LeaseTTL     time.Duration
	PollEvery    time.Duration
	RetryBackoff func(attempt int) time.Duration
	Clock        func() time.Time
	Logger       *slog.Logger
}

func (w *DispatchWorker) Run(ctx context.Context) error {
	if err := w.validate(); err != nil {
		return err
	}
	interval := w.PollEvery
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		err := w.RunOnce(ctx)
		if err != nil && !errors.Is(err, ErrNoDispatchCommand) && !errors.Is(err, context.Canceled) {
			w.log().Warn("Inbox Reality dispatch attempt did not complete", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *DispatchWorker) RunOnce(ctx context.Context) error {
	if err := w.validate(); err != nil {
		return err
	}
	if _, err := w.Lifecycle.ExpireDue(ctx, 100, w.now()); err != nil {
		return fmt.Errorf("expire Inbox Reality tests before dispatch: %w", err)
	}
	leaseTTL := w.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = 2 * time.Minute
	}
	command, err := w.Lifecycle.ClaimDispatch(ctx, w.OwnerID, leaseTTL)
	if err != nil {
		return err
	}
	test, err := w.Tests.GetTest(ctx, command.TenantID, command.TestID)
	if err != nil {
		return w.fail(ctx, command, "TEST_IDENTITY_UNAVAILABLE", err)
	}
	if test.Status == StatusCancelled || test.Status == StatusExpired || test.Status == StatusComplete ||
		test.ArtifactID != command.ArtifactID || test.ScenarioID != command.ScenarioID ||
		test.OutboundMIMEHash != command.ArtifactMIMEHash {
		return w.fail(ctx, command, "TEST_IDENTITY_INVALID", ErrDispatchPermanent)
	}
	now := w.now()
	if !now.Before(test.ExpiresAt) {
		return w.fail(ctx, command, "TEST_EXPIRED", ErrDispatchPermanent)
	}
	raw, err := loadArtifactMIME(ctx, w.Objects, command)
	if err != nil {
		return w.fail(ctx, command, "ARTIFACT_LOAD_FAILED", err)
	}
	request := inboxrealitycontract.DispatchRequest{
		ContractVersion: inboxrealitycontract.Version,
		CommandID:       command.ID, TenantID: command.TenantID, TestID: command.TestID,
		LeaseToken: command.LeaseToken, RequestHash: command.RequestHash,
		HeaderValue: FormatHeaderValue(test.HeaderToken), CampaignID: command.CampaignID,
		ContentRevisionID: command.ContentRevisionID, SendPlanID: command.SendPlanID,
		ArtifactID: command.ArtifactID, ScenarioID: command.ScenarioID,
		ArtifactMIMEHash:      command.ArtifactMIMEHash,
		ArtifactStructureHash: command.ArtifactStructureHash,
		RequestedCapabilities: toContractRequirements(command.RequestedCapabilities),
		RawMIME:               raw, ExpiresAt: test.ExpiresAt,
	}
	receipt, err := w.Executor.Execute(ctx, request)
	if err != nil {
		if errors.Is(err, ErrDispatchPermanent) {
			return w.fail(ctx, command, "DELIVERABILITY_REJECTED", err)
		}
		return w.retry(ctx, command, "DELIVERABILITY_UNAVAILABLE", err)
	}
	if err := validateExecutionReceipt(command, receipt); err != nil {
		return w.fail(ctx, command, "EXECUTION_RECEIPT_INVALID", err)
	}
	if receipt.RetryWaitCount > 0 {
		return w.retry(ctx, command, "SEED_DISPATCH_RETRY_WAIT", ErrDispatchRetryable)
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return w.fail(ctx, command, "EXECUTION_RECEIPT_INVALID", err)
	}
	if err := w.Lifecycle.CompleteDispatch(ctx, command, encoded); err != nil {
		return err
	}
	return nil
}

func (w *DispatchWorker) validate() error {
	if w == nil || w.Lifecycle == nil || w.Tests == nil || w.Objects == nil || w.Executor == nil ||
		!validUUID(w.OwnerID) {
		return ErrInvalidLifecycle
	}
	return nil
}

func (w *DispatchWorker) retry(ctx context.Context, command DispatchCommand, code string, cause error) error {
	backoff := time.Duration(1<<min(command.AttemptCount, 8)) * time.Second
	if w.RetryBackoff != nil {
		backoff = w.RetryBackoff(command.AttemptCount)
	}
	if backoff < time.Second {
		backoff = time.Second
	}
	if backoff > 15*time.Minute {
		backoff = 15 * time.Minute
	}
	if err := w.Lifecycle.RetryDispatch(ctx, command, w.now().Add(backoff), code); err != nil {
		return errors.Join(cause, err)
	}
	return fmt.Errorf("%w: %v", ErrDispatchRetryable, cause)
}

func (w *DispatchWorker) fail(ctx context.Context, command DispatchCommand, code string, cause error) error {
	if err := w.Lifecycle.FailDispatch(ctx, command, code); err != nil {
		return errors.Join(cause, err)
	}
	return fmt.Errorf("%w: %v", ErrDispatchPermanent, cause)
}

func (w *DispatchWorker) now() time.Time {
	if w != nil && w.Clock != nil {
		return w.Clock().UTC()
	}
	return time.Now().UTC()
}

func (w *DispatchWorker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func loadArtifactMIME(ctx context.Context, reader ArtifactObjectReader, command DispatchCommand) ([]byte, error) {
	rest, err := campaignmaterializer.ParseObjectReference(command.ArtifactMIMEObjectRef)
	if err != nil {
		return nil, ErrArtifactUnavailable
	}
	body, contentType, err := reader.Get(ctx, command.TenantID, rest)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	if media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])); media != "message/rfc822" {
		return nil, ErrArtifactUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(body, mimecomposer.MaxRawMessageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || len(raw) > mimecomposer.MaxRawMessageBytes || digestLifecycleBytes(raw) != command.ArtifactMIMEHash {
		return nil, ErrArtifactUnavailable
	}
	return raw, nil
}

func validateExecutionReceipt(command DispatchCommand, receipt inboxrealitycontract.ExecutionReceipt) error {
	if receipt.ContractVersion != inboxrealitycontract.Version || receipt.CommandID != command.ID ||
		receipt.TestID != command.TestID || receipt.ArtifactID != command.ArtifactID ||
		receipt.ScenarioID != command.ScenarioID || receipt.ArtifactMIMEHash != command.ArtifactMIMEHash ||
		!validLowerSHA256(receipt.DispatchedMIMEHash) || receipt.SeedCount <= 0 ||
		len(receipt.Deliveries) != receipt.SeedCount ||
		receipt.AcceptedCount+receipt.RejectedCount+receipt.IndeterminateCount+receipt.RetryWaitCount != receipt.SeedCount {
		return ErrDispatchPermanent
	}
	if receipt.CapabilitySnapshot.Version == "" || receipt.CapabilitySnapshot.Connector == "" ||
		receipt.CapabilitySnapshot.CapturedAt.IsZero() {
		return ErrDispatchPermanent
	}
	switch receipt.Status {
	case "accepted", "partial", "failed", "retry_wait":
	default:
		return ErrDispatchPermanent
	}
	seen := make(map[string]struct{}, receipt.SeedCount)
	accepted, rejected, indeterminate, retryWait := 0, 0, 0, 0
	for _, delivery := range receipt.Deliveries {
		if strings.TrimSpace(delivery.MailboxID) == "" || len(delivery.MailboxID) > 200 ||
			!Provider(delivery.Provider).IsKnown() || delivery.DispatchedMIMEHash != receipt.DispatchedMIMEHash ||
			delivery.AttemptCount < 0 || len(delivery.CapabilitySnapshot) == 0 {
			return ErrDispatchPermanent
		}
		var deliveryCapabilities inboxrealitycontract.CapabilitySnapshot
		if json.Unmarshal(delivery.CapabilitySnapshot, &deliveryCapabilities) != nil ||
			deliveryCapabilities != receipt.CapabilitySnapshot {
			return ErrDispatchPermanent
		}
		if _, duplicate := seen[delivery.MailboxID]; duplicate {
			return ErrDispatchPermanent
		}
		seen[delivery.MailboxID] = struct{}{}
		switch delivery.State {
		case "accepted":
			accepted++
		case "rejected":
			rejected++
		case "indeterminate":
			indeterminate++
		case "retry_wait":
			retryWait++
		default:
			return ErrDispatchPermanent
		}
	}
	if accepted != receipt.AcceptedCount || rejected != receipt.RejectedCount ||
		indeterminate != receipt.IndeterminateCount || retryWait != receipt.RetryWaitCount {
		return ErrDispatchPermanent
	}
	wantStatus := "failed"
	switch {
	case retryWait > 0:
		wantStatus = "retry_wait"
	case accepted == receipt.SeedCount:
		wantStatus = "accepted"
	case accepted > 0:
		wantStatus = "partial"
	}
	if receipt.Status != wantStatus {
		return ErrDispatchPermanent
	}
	return nil
}

func toContractRequirements(in CapabilityRequirements) inboxrealitycontract.CapabilityRequirements {
	return inboxrealitycontract.CapabilityRequirements{
		Placement: string(in.Placement), Headers: string(in.Headers), RawMIME: string(in.RawMIME),
		BodyParts: string(in.BodyParts), ObservedSurface: string(in.ObservedSurface),
	}
}

func digestLifecycleBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
