// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
)

const maxCapabilitySnapshotBytes = 16 << 10

type Coordinator struct {
	Store         Store
	Transport     campaigntransport.Transport
	TransportName string
	LeaseOwner    string
	LeaseDuration time.Duration
	// AllowReceiptlessTransport is for local capture/testing only. Production
	// raw delivery needs a provider message ID for feedback/reply correlation.
	AllowReceiptlessTransport bool
}

// Dispatch first acquires a durable idempotency row, fences it as dispatching,
// and only then crosses the provider boundary. An accepted replay returns the
// original receipt without touching the provider. Ambiguous provider errors
// become terminal-indeterminate and are never automatically retried.
func (c *Coordinator) Dispatch(ctx context.Context, request Request) (Result, error) {
	var err error
	request.Message, err = normalizeCompiledIdentity(request.Message)
	if err != nil {
		return Result{}, err
	}
	input, err := c.prepare(request)
	if err != nil {
		return Result{}, err
	}
	input, requestHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		return Result{}, err
	}
	lease := c.LeaseDuration
	if lease <= 0 {
		lease = 30 * time.Second
	}
	acquired, err := c.Store.Acquire(ctx, input, strings.TrimSpace(c.LeaseOwner), lease)
	if err != nil {
		return Result{}, err
	}
	if !acquired.Acquired {
		// Acquire may return the non-retryable receipt already bound to this
		// campaign-recipient row even when the caller supplied a different
		// idempotency key. Never let that older receipt certify a materially
		// different plan, artifact, MIME hash, message ID, or transport request.
		if acquired.Attempt.RequestHash != requestHash {
			return Result{}, fmt.Errorf("%w: recipient is bound to a different delivery request", ErrIntegrityMismatch)
		}
		return replay(acquired.Attempt)
	}
	attempt := acquired.Attempt
	if attempt.ID != input.DeliveryID || attempt.State != StatePrepared || strings.TrimSpace(attempt.ClaimToken) == "" ||
		attempt.RequestHash != requestHash {
		return Result{}, fmt.Errorf("%w: acquired attempt is not prepared and fenced", ErrIntegrityMismatch)
	}
	if err := c.Store.MarkDispatching(ctx, input.TenantID, attempt.ID, attempt.ClaimToken); err != nil {
		return Result{}, err
	}

	receipt, sendErr := c.Transport.Send(ctx, campaigntransport.SendRequest{
		TenantID: input.TenantID, Recipient: strings.TrimSpace(request.Recipient),
		IdempotencyKey: input.IdempotencyKey, Messenger: strings.TrimSpace(request.Messenger),
		Message: request.Message,
	})
	if sendErr != nil {
		terminal := TerminalInput{
			TenantID: input.TenantID, AttemptID: attempt.ID, ClaimToken: attempt.ClaimToken,
		}
		if campaigntransport.FailureDispositionOf(sendErr) == campaigntransport.FailureDefinitelyNotSent {
			terminal.FailureCode = "TRANSPORT_DEFINITELY_NOT_SENT"
			if _, persistErr := c.Store.MarkRejected(context.WithoutCancel(ctx), terminal); persistErr != nil {
				return Result{}, errors.Join(sendErr, fmt.Errorf("persist rejected delivery: %w", persistErr))
			}
			return Result{}, sendErr
		}
		terminal.FailureCode = "PROVIDER_ACCEPTANCE_UNKNOWN"
		if _, persistErr := c.Store.MarkIndeterminate(context.WithoutCancel(ctx), terminal); persistErr != nil {
			return Result{}, errors.Join(ErrDeliveryIndeterminate, sendErr,
				fmt.Errorf("persist indeterminate delivery: %w", persistErr))
		}
		return Result{}, errors.Join(ErrDeliveryIndeterminate, sendErr)
	}
	if err := validateReceipt(input, receipt); err != nil {
		terminal := TerminalInput{
			TenantID: input.TenantID, AttemptID: attempt.ID, ClaimToken: attempt.ClaimToken,
			FailureCode: "PROVIDER_RECEIPT_INTEGRITY_UNKNOWN",
		}
		if _, persistErr := c.Store.MarkIndeterminate(context.WithoutCancel(ctx), terminal); persistErr != nil {
			return Result{}, errors.Join(err, ErrDeliveryIndeterminate,
				fmt.Errorf("persist receipt-integrity failure: %w", persistErr))
		}
		return Result{}, errors.Join(err, ErrDeliveryIndeterminate)
	}
	accepted, err := c.Store.MarkAccepted(context.WithoutCancel(ctx), TerminalInput{
		TenantID: input.TenantID, AttemptID: attempt.ID, ClaimToken: attempt.ClaimToken,
		Receipt: receipt,
	})
	if err != nil {
		// The provider has accepted the message. A database error here can be a
		// lost response after commit, so the caller must retry only by replaying
		// this idempotency key through Acquire; it must not call the provider.
		return Result{}, errors.Join(ErrDeliveryIndeterminate,
			fmt.Errorf("persist accepted delivery: %w", err))
	}
	return Result{Attempt: accepted, Receipt: receipt}, nil
}

func (c *Coordinator) prepare(request Request) (AttemptInput, error) {
	if c == nil || c.Store == nil || c.Transport == nil {
		return AttemptInput{}, fmt.Errorf("%w: store and transport are required", ErrInvalidInput)
	}
	input := request.Attempt
	input.TransportName = strings.TrimSpace(c.TransportName)
	if input.TransportName == "" || strings.TrimSpace(c.LeaseOwner) == "" {
		return AttemptInput{}, fmt.Errorf("%w: transport_name and lease_owner are required", ErrInvalidInput)
	}
	capabilities := c.Transport.Capabilities()
	if !capabilities.RawMIME {
		return AttemptInput{}, fmt.Errorf("%w: transport is not raw-MIME capable", ErrInvalidInput)
	}
	if !capabilities.ProviderReceipt && !c.AllowReceiptlessTransport {
		return AttemptInput{}, fmt.Errorf("%w: provider receipt capability is required", ErrInvalidInput)
	}
	if strings.TrimSpace(capabilities.ContractVersion) == "" {
		return AttemptInput{}, fmt.Errorf("%w: transport contract version is required", ErrInvalidInput)
	}
	capabilityJSON, err := json.Marshal(capabilities)
	if err != nil || len(capabilityJSON) > maxCapabilitySnapshotBytes {
		return AttemptInput{}, fmt.Errorf("%w: invalid capability snapshot", ErrInvalidInput)
	}
	input.TransportContract = capabilities.ContractVersion
	input.CapabilitySnapshot = capabilityJSON
	if err := validateAttemptInput(input); err != nil {
		return AttemptInput{}, err
	}
	input, _, err = normalizeDeliveryAttempt(input)
	if err != nil {
		return AttemptInput{}, err
	}
	if strings.TrimSpace(request.Recipient) == "" {
		return AttemptInput{}, fmt.Errorf("%w: recipient is required", ErrInvalidInput)
	}
	message := request.Message
	if message.ArtifactID != input.ArtifactID || message.CampaignID != input.CampaignID ||
		message.ScenarioID != input.ScenarioID || message.MIMEHash != input.OutboundMIMEHash ||
		message.MessageID != input.MessageID || message.ReplyTo != input.ReplyTo {
		return AttemptInput{}, fmt.Errorf("%w: compiled message does not match ledger identity", ErrIntegrityMismatch)
	}
	return input, nil
}

func normalizeCompiledIdentity(message campaigntransport.CompiledMessage) (campaigntransport.CompiledMessage, error) {
	for _, identity := range []*string{&message.ArtifactID, &message.CampaignID} {
		parsed, err := uuid.Parse(strings.TrimSpace(*identity))
		if err != nil {
			return campaigntransport.CompiledMessage{}, fmt.Errorf("%w: invalid compiled-message UUID identity", ErrInvalidInput)
		}
		*identity = parsed.String()
	}
	message.ScenarioID = strings.TrimSpace(message.ScenarioID)
	return message, nil
}

func validateAttemptInput(input AttemptInput) error {
	for _, field := range []struct{ name, value string }{
		{name: "delivery_id", value: input.DeliveryID},
		{name: "tenant_id", value: input.TenantID},
		{name: "campaign_id", value: input.CampaignID},
		{name: "send_plan_id", value: input.SendPlanID},
		{name: "artifact_id", value: input.ArtifactID},
		{name: "assurance_run_id", value: input.AssuranceRunID},
	} {
		if _, err := uuid.Parse(strings.TrimSpace(field.value)); err != nil {
			return fmt.Errorf("%w: invalid %s", ErrInvalidInput, field.name)
		}
	}
	if input.CampaignRecipientID <= 0 || input.AssuranceAttemptCount <= 0 {
		return fmt.Errorf("%w: campaign_recipient_id and assurance_attempt_count must be positive", ErrInvalidInput)
	}
	for _, field := range []struct{ name, value string }{
		{name: "artifact_set_hash", value: input.ArtifactSetHash},
		{name: "source_hash", value: input.SourceHash},
		{name: "plan_hash", value: input.PlanHash},
		{name: "outbound_mime_hash", value: input.OutboundMIMEHash},
	} {
		if !validSHA256(field.value) {
			return fmt.Errorf("%w: invalid %s", ErrInvalidInput, field.name)
		}
	}
	if input.TransportContract != campaigntransport.ContractVersion {
		return fmt.Errorf("%w: unsupported transport_contract_version", ErrInvalidInput)
	}
	replyTo := strings.ToLower(strings.TrimSpace(input.ReplyTo))
	parsedReplyTo, err := mail.ParseAddress(replyTo)
	if err != nil || parsedReplyTo == nil || parsedReplyTo.Address != replyTo {
		return fmt.Errorf("%w: invalid reply_to", ErrInvalidInput)
	}
	if input.ReplyCorrelationVersion != replycorrelation.Version ||
		input.ReplyCorrelationExpiresAt == nil || input.ReplyCorrelationExpiresAt.IsZero() ||
		!validReplyCorrelationKeyID(strings.TrimSpace(input.ReplyCorrelationKeyID)) ||
		!validSHA256(strings.TrimSpace(input.ReplyCorrelationTokenHash)) {
		return fmt.Errorf("%w: invalid reply correlation identity", ErrInvalidInput)
	}
	for _, field := range []struct{ name, value string }{
		{name: "scenario_id", value: input.ScenarioID},
		{name: "compiler_version", value: input.CompilerVersion},
		{name: "message_id", value: input.MessageID},
		{name: "idempotency_key", value: input.IdempotencyKey},
		{name: "transport_name", value: input.TransportName},
		{name: "transport_contract_version", value: input.TransportContract},
	} {
		value := strings.TrimSpace(field.value)
		if value == "" || len(value) > 255 || strings.ContainsAny(value, "\r\n\x00") {
			return fmt.Errorf("%w: invalid %s", ErrInvalidInput, field.name)
		}
	}
	switch input.GateDecision {
	case GatePass, GateWarn:
		if len(input.GateOverrideIDs) != 0 {
			return fmt.Errorf("%w: gate_override_ids require an overridden decision", ErrInvalidInput)
		}
	case GateOverridden:
		if len(input.GateOverrideIDs) == 0 || len(input.GateOverrideIDs) > 100 {
			return fmt.Errorf("%w: overridden delivery requires 1..100 gate_override_ids", ErrInvalidInput)
		}
		seen := make(map[string]struct{}, len(input.GateOverrideIDs))
		for _, value := range input.GateOverrideIDs {
			parsed, err := uuid.Parse(strings.TrimSpace(value))
			if err != nil {
				return fmt.Errorf("%w: overridden delivery requires valid gate_override_ids", ErrInvalidInput)
			}
			canonical := parsed.String()
			if _, duplicate := seen[canonical]; duplicate {
				return fmt.Errorf("%w: gate_override_ids must be unique", ErrInvalidInput)
			}
			seen[canonical] = struct{}{}
		}
	default:
		return fmt.Errorf("%w: gate_decision is not sendable", ErrInvalidInput)
	}
	if len(input.CapabilitySnapshot) == 0 || len(input.CapabilitySnapshot) > maxCapabilitySnapshotBytes ||
		!json.Valid(input.CapabilitySnapshot) {
		return fmt.Errorf("%w: capability_snapshot is invalid", ErrInvalidInput)
	}
	var object map[string]any
	if err := json.Unmarshal(input.CapabilitySnapshot, &object); err != nil || object == nil {
		return fmt.Errorf("%w: capability_snapshot must be an object", ErrInvalidInput)
	}
	return nil
}

func validReplyCorrelationKeyID(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for _, current := range value {
		if (current >= 'a' && current <= 'z') || (current >= '0' && current <= '9') || current == '_' || current == '-' {
			continue
		}
		return false
	}
	return true
}

func validateReceipt(input AttemptInput, receipt campaigntransport.Receipt) error {
	if receipt.ContractVersion != input.TransportContract || receipt.ArtifactID != input.ArtifactID ||
		receipt.ScenarioID != input.ScenarioID || receipt.CampaignID != input.CampaignID ||
		receipt.OutboundMIMEHash != input.OutboundMIMEHash || receipt.IdempotencyKey != input.IdempotencyKey ||
		strings.TrimSpace(receipt.IdempotencyMode) == "" {
		return ErrIntegrityMismatch
	}
	return nil
}

func replay(attempt Attempt) (Result, error) {
	switch attempt.State {
	case StateAccepted:
		receipt := campaigntransport.Receipt{
			ContractVersion: attempt.TransportContract, ArtifactID: attempt.ArtifactID,
			ScenarioID: attempt.ScenarioID, CampaignID: attempt.CampaignID,
			OutboundMIMEHash:  attempt.OutboundMIMEHash,
			ProviderMessageID: attempt.ProviderMessageID,
			IdempotencyKey:    attempt.IdempotencyKey, IdempotencyMode: attempt.IdempotencyMode,
		}
		if err := validateReceipt(attempt.AttemptInput, receipt); err != nil {
			return Result{}, err
		}
		return Result{Attempt: attempt, Receipt: receipt, Replayed: true}, nil
	case StateRejected:
		return Result{}, ErrAttemptRejected
	case StateDispatching, StateIndeterminate:
		return Result{}, ErrDeliveryIndeterminate
	case StatePrepared:
		return Result{}, ErrAttemptInFlight
	default:
		return Result{}, fmt.Errorf("%w: unknown attempt state %q", ErrIntegrityMismatch, attempt.State)
	}
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}
