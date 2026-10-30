// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

const (
	maxRawMIMEBytes        = 32 << 20
	staleProviderCallAfter = 2 * time.Minute
)

type Dispatcher struct {
	Seeds  SeedSource
	Store  ExecutionStore
	Sender RawSeedSender
	Clock  func() time.Time
}

func (d *Dispatcher) Execute(ctx context.Context, request inboxrealitycontract.DispatchRequest) (inboxrealitycontract.ExecutionReceipt, error) {
	if d == nil || d.Seeds == nil || d.Store == nil || d.Sender == nil {
		return inboxrealitycontract.ExecutionReceipt{}, ErrInvalidRequest
	}
	now := d.now()
	if err := validateDispatchRequest(request, now); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	if digest(request.RawMIME) != request.ArtifactMIMEHash {
		return inboxrealitycontract.ExecutionReceipt{}, ErrCommandConflict
	}
	dispatchedMIME, err := insertTestHeader(request.RawMIME, request.HeaderValue)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	dispatchedHash := digest(dispatchedMIME)
	snapshot, err := d.Seeds.CapabilitySnapshot(ctx)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	if err := validateCapabilitySnapshot(snapshot, request.RequestedCapabilities); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	seeds, err := d.Seeds.ActiveSeeds(ctx)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	if err := validateSeeds(seeds); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	if len(seeds) == 0 {
		return inboxrealitycontract.ExecutionReceipt{}, ErrNoActiveSeeds
	}
	prepared, err := d.Store.Prepare(ctx, request, seeds, snapshot, dispatchedHash)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	// Prepare freezes the first capability snapshot. A retried gateway lease
	// must report that original execution context rather than a later probe.
	if len(prepared) > 0 {
		var frozen inboxrealitycontract.CapabilitySnapshot
		if err := json.Unmarshal(prepared[0].CapabilitySnapshot, &frozen); err != nil {
			return inboxrealitycontract.ExecutionReceipt{}, ErrCommandConflict
		}
		for _, delivery := range prepared[1:] {
			if !bytes.Equal(delivery.CapabilitySnapshot, prepared[0].CapabilitySnapshot) {
				return inboxrealitycontract.ExecutionReceipt{}, ErrCommandConflict
			}
		}
		snapshot = frozen
	}
	if err := d.Store.MarkStaleDispatchesIndeterminate(ctx, request.CommandID,
		now.Add(-staleProviderCallAfter)); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}

	addresses := make(map[string]Seed, len(seeds))
	for _, seed := range seeds {
		addresses[seed.MailboxID] = seed
	}
	deliveries, err := d.Store.ListSeeds(ctx, request.CommandID)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	for _, delivery := range deliveries {
		if delivery.State != "prepared" && delivery.State != "retry_wait" {
			continue
		}
		if delivery.State == "retry_wait" && delivery.AvailableAt.After(now) {
			continue
		}
		claimed, err := d.Store.ClaimSeed(ctx, request.CommandID, delivery.MailboxID)
		if err != nil {
			if errors.Is(err, ErrExecutionLeaseLost) {
				continue
			}
			return inboxrealitycontract.ExecutionReceipt{}, err
		}
		seed, exists := addresses[claimed.MailboxID]
		if !exists || seed.Provider != claimed.Provider || strings.TrimSpace(seed.Address) == "" {
			if err := d.Store.RejectSeed(ctx, claimed, "SEED_ADDRESS_UNAVAILABLE"); err != nil {
				return inboxrealitycontract.ExecutionReceipt{}, err
			}
			continue
		}
		providerReceipt, sendErr := d.Sender.SendRaw(ctx, SendRequest{
			TenantID: request.TenantID, TestID: request.TestID, ArtifactID: request.ArtifactID,
			ScenarioID: request.ScenarioID, MailboxID: claimed.MailboxID,
			Provider: claimed.Provider, EnvelopeTo: seed.Address,
			RawMIME: append([]byte(nil), dispatchedMIME...), MIMEHash: dispatchedHash,
		})
		if sendErr == nil && strings.TrimSpace(providerReceipt.ProviderMessageID) == "" {
			sendErr = &SendError{Disposition: FailureIndeterminate,
				Code: "PROVIDER_RECEIPT_MISSING", Err: errors.New("provider message id missing")}
		}
		if sendErr == nil {
			if err := d.Store.AcceptSeed(ctx, claimed, providerReceipt.ProviderMessageID); err != nil {
				return inboxrealitycontract.ExecutionReceipt{}, err
			}
			continue
		}
		disposition, code := classifySendFailure(sendErr)
		switch disposition {
		case FailureRetryableDefinitelyNotSent:
			if err := d.Store.RetrySeed(ctx, claimed, now.Add(seedRetryBackoff(claimed.AttemptCount)), code); err != nil {
				return inboxrealitycontract.ExecutionReceipt{}, err
			}
		case FailurePermanentDefinitelyNotSent:
			if err := d.Store.RejectSeed(ctx, claimed, code); err != nil {
				return inboxrealitycontract.ExecutionReceipt{}, err
			}
		default:
			if err := d.Store.MarkSeedIndeterminate(ctx, claimed, code); err != nil {
				return inboxrealitycontract.ExecutionReceipt{}, err
			}
		}
	}
	final, err := d.Store.ListSeeds(ctx, request.CommandID)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	return buildExecutionReceipt(request, snapshot, dispatchedHash, final, d.now()), nil
}

func buildExecutionReceipt(
	request inboxrealitycontract.DispatchRequest,
	snapshot inboxrealitycontract.CapabilitySnapshot,
	dispatchedHash string,
	deliveries []SeedDelivery,
	now time.Time,
) inboxrealitycontract.ExecutionReceipt {
	sort.Slice(deliveries, func(i, j int) bool { return deliveries[i].MailboxID < deliveries[j].MailboxID })
	receipt := inboxrealitycontract.ExecutionReceipt{
		ContractVersion: inboxrealitycontract.Version, CommandID: request.CommandID,
		TestID: request.TestID, ArtifactID: request.ArtifactID, ScenarioID: request.ScenarioID,
		ArtifactMIMEHash: request.ArtifactMIMEHash, DispatchedMIMEHash: dispatchedHash,
		CapabilitySnapshot: snapshot, SeedCount: len(deliveries),
		Deliveries:  make([]inboxrealitycontract.SeedDispatchReceipt, 0, len(deliveries)),
		CompletedAt: now.UTC(),
	}
	for _, delivery := range deliveries {
		state := delivery.State
		switch state {
		case "accepted":
			receipt.AcceptedCount++
		case "rejected":
			receipt.RejectedCount++
		case "indeterminate":
			receipt.IndeterminateCount++
			state = "indeterminate"
		case "dispatching":
			// A concurrent replay observed a provider call still in flight. It
			// must tell the gateway to retry later, not convert that call into a
			// terminal unknown outcome while the first request may still obtain
			// an acceptance receipt.
			receipt.RetryWaitCount++
			state = "retry_wait"
		default:
			receipt.RetryWaitCount++
			state = "retry_wait"
		}
		receipt.Deliveries = append(receipt.Deliveries, inboxrealitycontract.SeedDispatchReceipt{
			MailboxID: delivery.MailboxID, Provider: delivery.Provider, State: state,
			AttemptCount: delivery.AttemptCount, DispatchedMIMEHash: delivery.DispatchedMIMEHash,
			FailureCode:        delivery.FailureCode,
			CapabilitySnapshot: append(json.RawMessage(nil), delivery.CapabilitySnapshot...),
		})
	}
	switch {
	case receipt.RetryWaitCount > 0:
		receipt.Status = "retry_wait"
	case receipt.AcceptedCount == receipt.SeedCount:
		receipt.Status = "accepted"
	case receipt.AcceptedCount > 0:
		receipt.Status = "partial"
	default:
		receipt.Status = "failed"
	}
	return receipt
}

func validateDispatchRequest(request inboxrealitycontract.DispatchRequest, now time.Time) error {
	if request.ContractVersion != inboxrealitycontract.Version ||
		!isUUID(request.CommandID) || !isUUID(request.TenantID) || !isUUID(request.TestID) ||
		!isUUID(request.LeaseToken) || !isUUID(request.CampaignID) ||
		!isUUID(request.ContentRevisionID) || !isUUID(request.SendPlanID) || !isUUID(request.ArtifactID) ||
		!isSHA256(request.RequestHash) || !isSHA256(request.ArtifactMIMEHash) ||
		!isSHA256(request.ArtifactStructureHash) || strings.TrimSpace(request.ScenarioID) == "" ||
		len(request.ScenarioID) > 200 || len(request.RawMIME) == 0 ||
		len(request.RawMIME) > maxRawMIMEBytes || request.ExpiresAt.IsZero() || !now.Before(request.ExpiresAt) {
		return ErrInvalidRequest
	}
	header := strings.TrimSpace(request.HeaderValue)
	if len(header) != 36 || !strings.HasPrefix(header, "irt_") || strings.ContainsAny(header, "\r\n") {
		return ErrInvalidRequest
	}
	for _, character := range strings.TrimPrefix(header, "irt_") {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return ErrInvalidRequest
		}
	}
	return nil
}

func validateCapabilitySnapshot(snapshot inboxrealitycontract.CapabilitySnapshot, requested inboxrealitycontract.CapabilityRequirements) error {
	if snapshot.Version == "" || snapshot.Connector == "" || snapshot.CapturedAt.IsZero() {
		return ErrCapabilityUnavailable
	}
	checks := []struct{ requirement, availability string }{
		{requested.Placement, snapshot.Placement}, {requested.Headers, snapshot.Headers},
		{requested.RawMIME, snapshot.RawMIME}, {requested.BodyParts, snapshot.BodyParts},
		{requested.ObservedSurface, snapshot.ObservedSurface},
	}
	for _, check := range checks {
		switch check.requirement {
		case "required":
			if check.availability != "available" {
				return ErrCapabilityUnavailable
			}
		case "optional", "disabled":
		default:
			return ErrInvalidRequest
		}
		if check.availability != "available" && check.availability != "unavailable" {
			return ErrCapabilityUnavailable
		}
	}
	return nil
}

func validateSeeds(seeds []Seed) error {
	seen := make(map[string]struct{}, len(seeds))
	for _, seed := range seeds {
		if strings.TrimSpace(seed.MailboxID) == "" || len(seed.MailboxID) > 200 ||
			!knownProvider(seed.Provider) || strings.ContainsAny(seed.MailboxID, "\x00\r\n") {
			return ErrInvalidRequest
		}
		if seed.RegistryVersionID != "" && !isUUID(seed.RegistryVersionID) {
			return ErrInvalidRequest
		}
		address, err := mail.ParseAddress(seed.Address)
		if err != nil || !strings.EqualFold(strings.TrimSpace(address.Address), strings.TrimSpace(seed.Address)) {
			return ErrInvalidRequest
		}
		if _, duplicate := seen[seed.MailboxID]; duplicate {
			return ErrInvalidRequest
		}
		seen[seed.MailboxID] = struct{}{}
	}
	return nil
}

func normalizedRFCMessageIDHash(rawMIME []byte) string {
	message, err := mail.ReadMessage(bytes.NewReader(rawMIME))
	if err != nil {
		return ""
	}
	messageID := strings.ToLower(strings.TrimSpace(message.Header.Get("Message-ID")))
	if len(messageID) >= 2 && strings.HasPrefix(messageID, "<") && strings.HasSuffix(messageID, ">") {
		messageID = strings.TrimSpace(messageID[1 : len(messageID)-1])
	}
	if messageID == "" {
		return ""
	}
	return digest([]byte(messageID))
}

func insertTestHeader(raw []byte, value string) ([]byte, error) {
	separator := []byte("\r\n\r\n")
	index := bytes.Index(raw, separator)
	if index <= 0 {
		return nil, ErrInvalidRequest
	}
	headerBlock := raw[:index]
	for _, line := range bytes.Split(headerBlock, []byte("\r\n")) {
		colon := bytes.IndexByte(line, ':')
		if colon > 0 && strings.EqualFold(strings.TrimSpace(string(line[:colon])), "X-Postwave-Test-ID") {
			return nil, ErrCommandConflict
		}
	}
	out := make([]byte, 0, len(raw)+len(value)+32)
	out = append(out, raw[:index]...)
	out = append(out, []byte("\r\nX-Postwave-Test-ID: "+value)...)
	out = append(out, raw[index:]...)
	return out, nil
}

func classifySendFailure(err error) (FailureDisposition, string) {
	var sendError *SendError
	if !errors.As(err, &sendError) || sendError == nil {
		return FailureIndeterminate, "PROVIDER_RESULT_INDETERMINATE"
	}
	code := normalizeCode(sendError.Code, "PROVIDER_SEND_FAILED")
	switch sendError.Disposition {
	case FailureRetryableDefinitelyNotSent, FailurePermanentDefinitelyNotSent, FailureIndeterminate:
		return sendError.Disposition, code
	default:
		return FailureIndeterminate, code
	}
}

func seedRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := time.Duration(1<<min(attempt, 8)) * time.Second
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

func (d *Dispatcher) now() time.Time {
	if d != nil && d.Clock != nil {
		return d.Clock().UTC()
	}
	return time.Now().UTC()
}

func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func isUUID(value string) bool   { _, err := uuid.Parse(strings.TrimSpace(value)); return err == nil }
func isSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
func knownProvider(value string) bool {
	switch value {
	case "gmail", "outlook_com", "o365", "icloud", "yahoo", "proton", "gmx", "mailru":
		return true
	}
	return false
}
func normalizeCode(value, fallback string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" || len(value) > 96 {
		return fallback
	}
	for i, c := range value {
		if i == 0 && (c < 'A' || c > 'Z') {
			return fallback
		}
		if i > 0 && !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return fallback
		}
	}
	return value
}
