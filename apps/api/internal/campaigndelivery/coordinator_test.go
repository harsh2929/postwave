// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
)

const (
	deliveryTenantID    = "00000000-0000-4000-8000-000000000101"
	deliveryCampaignID  = "00000000-0000-4000-8000-000000000102"
	deliveryRecipientID = int64(103)
	deliveryPlanID      = "00000000-0000-4000-8000-000000000104"
	deliveryArtifactID  = "00000000-0000-4000-8000-000000000105"
	deliveryRunID       = "00000000-0000-4000-8000-000000000106"
)

type fakeTransport struct {
	mu      sync.Mutex
	calls   int
	receipt campaigntransport.Receipt
	err     error
}

func (f *fakeTransport) Capabilities() campaigntransport.Capabilities {
	return campaigntransport.Capabilities{ContractVersion: campaigntransport.ContractVersion, RawMIME: true, ProviderReceipt: true}
}

func (f *fakeTransport) Send(_ context.Context, request campaigntransport.SendRequest) (campaigntransport.Receipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.receipt.ContractVersion == "" {
		f.receipt = receiptFor(request.Message, request.IdempotencyKey)
	}
	return f.receipt, f.err
}

func (f *fakeTransport) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakeStore struct {
	mu                sync.Mutex
	attempt           Attempt
	terminalCommitErr error
	commitThenError   bool
	acquireCalls      int
}

func (f *fakeStore) Acquire(_ context.Context, input AttemptInput, owner string, lease time.Duration) (Acquisition, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acquireCalls++
	if f.attempt.ID != "" {
		return Acquisition{Attempt: f.attempt}, nil
	}
	input, requestHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		return Acquisition{}, err
	}
	expires := time.Now().Add(lease)
	f.attempt = Attempt{ID: input.DeliveryID, AttemptInput: input,
		AttemptNo: 1, RequestHash: requestHash, State: StatePrepared,
		ClaimToken: "00000000-0000-4000-8000-000000000108",
		LeaseOwner: owner, LeaseExpiresAt: &expires, CreatedAt: time.Now()}
	return Acquisition{Attempt: f.attempt, Acquired: true}, nil
}

func (f *fakeStore) MarkDispatching(_ context.Context, _, _, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if token != f.attempt.ClaimToken || f.attempt.State != StatePrepared {
		return ErrLeaseLost
	}
	now := time.Now()
	f.attempt.State, f.attempt.DispatchStartedAt = StateDispatching, &now
	return nil
}

func (f *fakeStore) MarkAccepted(_ context.Context, input TerminalInput) (Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if input.ClaimToken != f.attempt.ClaimToken || f.attempt.State != StateDispatching {
		return Attempt{}, ErrLeaseLost
	}
	now := time.Now()
	f.attempt.State, f.attempt.AcceptedAt = StateAccepted, &now
	f.attempt.ProviderMessageID = input.Receipt.ProviderMessageID
	f.attempt.IdempotencyMode = input.Receipt.IdempotencyMode
	f.attempt.ReceiptHash = strings.Repeat("e", 64)
	if f.terminalCommitErr != nil {
		err := f.terminalCommitErr
		if !f.commitThenError {
			f.attempt.State, f.attempt.AcceptedAt = StateDispatching, nil
			f.attempt.ProviderMessageID, f.attempt.IdempotencyMode, f.attempt.ReceiptHash = "", "", ""
		}
		return Attempt{}, err
	}
	return f.attempt, nil
}

func (f *fakeStore) MarkRejected(_ context.Context, input TerminalInput) (Attempt, error) {
	return f.markFailure(input, StateRejected, string(campaigntransport.FailureDefinitelyNotSent))
}

func (f *fakeStore) MarkIndeterminate(_ context.Context, input TerminalInput) (Attempt, error) {
	return f.markFailure(input, StateIndeterminate, string(campaigntransport.FailureIndeterminate))
}

func (f *fakeStore) markFailure(input TerminalInput, state, disposition string) (Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if input.ClaimToken != f.attempt.ClaimToken || f.attempt.State != StateDispatching {
		return Attempt{}, ErrLeaseLost
	}
	now := time.Now()
	f.attempt.State, f.attempt.FailureCode, f.attempt.FailureDisposition = state, input.FailureCode, disposition
	if state == StateRejected {
		f.attempt.RejectedAt = &now
	} else {
		f.attempt.IndeterminateAt = &now
	}
	return f.attempt, nil
}

func TestCoordinatorDispatchesOnceAndReplaysAcceptedReceipt(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{}
	coordinator := newCoordinator(store, transport)
	request := validDeliveryRequest()

	first, err := coordinator.Dispatch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := coordinator.Dispatch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Attempt.State != StateAccepted || !second.Replayed || second.Receipt.ProviderMessageID != "provider-accepted-1" {
		t.Fatalf("results = %+v / %+v", first, second)
	}
	if first.Attempt.ID != request.Attempt.DeliveryID || first.Attempt.ReplyTo != request.Attempt.ReplyTo ||
		first.Attempt.ReplyCorrelationTokenHash != request.Attempt.ReplyCorrelationTokenHash ||
		second.Attempt.ReplyCorrelationKeyID != request.Attempt.ReplyCorrelationKeyID {
		t.Fatalf("reply correlation drifted across accepted replay: %+v / %+v", first.Attempt, second.Attempt)
	}
	if transport.callCount() != 1 {
		t.Fatalf("provider calls = %d, want 1", transport.callCount())
	}
}

func TestCoordinatorPersistsDefiniteRejectionWithoutRetry(t *testing.T) {
	t.Parallel()
	transportErr := &campaigntransport.SendError{Disposition: campaigntransport.FailureDefinitelyNotSent, Err: errors.New("rejected")}
	store := &fakeStore{}
	transport := &fakeTransport{err: transportErr}
	coordinator := newCoordinator(store, transport)
	if _, err := coordinator.Dispatch(context.Background(), validDeliveryRequest()); !errors.Is(err, transportErr) {
		t.Fatalf("first error = %v", err)
	}
	if _, err := coordinator.Dispatch(context.Background(), validDeliveryRequest()); !errors.Is(err, ErrAttemptRejected) {
		t.Fatalf("replay error = %v", err)
	}
	if store.attempt.State != StateRejected || transport.callCount() != 1 {
		t.Fatalf("attempt/calls = %+v/%d", store.attempt, transport.callCount())
	}
}

func TestCoordinatorPersistsAmbiguousProviderFailureAndNeverRetries(t *testing.T) {
	t.Parallel()
	transportErr := &campaigntransport.SendError{Disposition: campaigntransport.FailureIndeterminate, Err: context.DeadlineExceeded}
	store := &fakeStore{}
	transport := &fakeTransport{err: transportErr}
	coordinator := newCoordinator(store, transport)
	if _, err := coordinator.Dispatch(context.Background(), validDeliveryRequest()); !errors.Is(err, ErrDeliveryIndeterminate) {
		t.Fatalf("first error = %v", err)
	}
	if _, err := coordinator.Dispatch(context.Background(), validDeliveryRequest()); !errors.Is(err, ErrDeliveryIndeterminate) {
		t.Fatalf("replay error = %v", err)
	}
	if store.attempt.State != StateIndeterminate || transport.callCount() != 1 {
		t.Fatalf("attempt/calls = %+v/%d", store.attempt, transport.callCount())
	}
}

func TestCoordinatorTreatsBadProviderReceiptAsIndeterminate(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{receipt: campaigntransport.Receipt{ContractVersion: "wrong"}}
	_, err := newCoordinator(store, transport).Dispatch(context.Background(), validDeliveryRequest())
	if !errors.Is(err, ErrIntegrityMismatch) || !errors.Is(err, ErrDeliveryIndeterminate) {
		t.Fatalf("error = %v", err)
	}
	if store.attempt.State != StateIndeterminate || transport.callCount() != 1 {
		t.Fatalf("attempt/calls = %+v/%d", store.attempt, transport.callCount())
	}
}

func TestCoordinatorLostAcceptedCommitResponseReplaysWithoutResend(t *testing.T) {
	t.Parallel()
	store := &fakeStore{terminalCommitErr: errors.New("response lost"), commitThenError: true}
	transport := &fakeTransport{}
	coordinator := newCoordinator(store, transport)
	if _, err := coordinator.Dispatch(context.Background(), validDeliveryRequest()); !errors.Is(err, ErrDeliveryIndeterminate) {
		t.Fatalf("first error = %v", err)
	}
	store.terminalCommitErr = nil
	result, err := coordinator.Dispatch(context.Background(), validDeliveryRequest())
	if err != nil || !result.Replayed || transport.callCount() != 1 {
		t.Fatalf("replay = %+v, err=%v, calls=%d", result, err, transport.callCount())
	}
}

func TestCoordinatorNeverReplaysAcceptedReceiptForDifferentRequest(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{}
	coordinator := newCoordinator(store, transport)
	request := validDeliveryRequest()
	if _, err := coordinator.Dispatch(context.Background(), request); err != nil {
		t.Fatal(err)
	}

	different := request
	different.Attempt.IdempotencyKey = "recipient-103-plan-104-different"
	different.Attempt.MessageID = "<different-message@example.test>"
	if _, err := coordinator.Dispatch(context.Background(), different); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("different-request replay error = %v, want ErrIntegrityMismatch", err)
	}
	if transport.callCount() != 1 {
		t.Fatalf("provider calls = %d, want 1", transport.callCount())
	}
}

func TestCoordinatorRejectsIdentityMismatchBeforeLedgerOrProvider(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{}
	request := validDeliveryRequest()
	request.Message.MIMEHash = strings.Repeat("f", 64)
	_, err := newCoordinator(store, transport).Dispatch(context.Background(), request)
	if !errors.Is(err, ErrIntegrityMismatch) || store.acquireCalls != 0 || transport.callCount() != 0 {
		t.Fatalf("error/acquires/calls = %v/%d/%d", err, store.acquireCalls, transport.callCount())
	}
}

func TestCoordinatorCanonicalizesUUIDVariantsBeforeProvider(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{}
	request := validDeliveryRequest()
	request.Attempt.TenantID = "{" + strings.ToUpper(request.Attempt.TenantID) + "}"
	request.Attempt.CampaignID = strings.ToUpper(request.Attempt.CampaignID)
	request.Attempt.SendPlanID = strings.ToUpper(request.Attempt.SendPlanID)
	request.Attempt.ArtifactID = strings.ToUpper(request.Attempt.ArtifactID)
	request.Attempt.AssuranceRunID = strings.ToUpper(request.Attempt.AssuranceRunID)
	request.Attempt.ScenarioID = "  " + request.Attempt.ScenarioID + "  "
	request.Attempt.IdempotencyKey = "  " + request.Attempt.IdempotencyKey + "  "
	request.Message.CampaignID = strings.ToUpper(request.Message.CampaignID)
	request.Message.ArtifactID = strings.ToUpper(request.Message.ArtifactID)
	request.Message.ScenarioID = "  " + request.Message.ScenarioID + "  "

	result, err := newCoordinator(store, transport).Dispatch(context.Background(), request)
	if err != nil || result.Attempt.State != StateAccepted || transport.callCount() != 1 {
		t.Fatalf("canonical variant dispatch = %+v err=%v calls=%d", result, err, transport.callCount())
	}
	if result.Attempt.TenantID != deliveryTenantID || result.Attempt.CampaignID != deliveryCampaignID ||
		result.Attempt.ArtifactID != deliveryArtifactID ||
		result.Attempt.IdempotencyKey != "recipient-103-plan-104" {
		t.Fatalf("non-canonical durable attempt: %+v", result.Attempt.AttemptInput)
	}
}

func TestCoordinatorCanonicalizesCompleteOverrideSetBeforeLedger(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	transport := &fakeTransport{}
	request := validDeliveryRequest()
	request.Attempt.GateDecision = GateOverridden
	request.Attempt.GateOverrideIDs = []string{
		"00000000-0000-4000-8000-000000000202",
		"{00000000-0000-4000-8000-000000000201}",
	}

	result, err := newCoordinator(store, transport).Dispatch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"00000000-0000-4000-8000-000000000201",
		"00000000-0000-4000-8000-000000000202",
	}
	if strings.Join(result.Attempt.GateOverrideIDs, ",") != strings.Join(want, ",") {
		t.Fatalf("canonical override set = %v, want %v", result.Attempt.GateOverrideIDs, want)
	}
}

func TestCoordinatorRejectsIncompleteOrDuplicateOverrideSet(t *testing.T) {
	t.Parallel()
	for name, overrideIDs := range map[string][]string{
		"missing":   nil,
		"duplicate": {"00000000-0000-4000-8000-000000000201", "{00000000-0000-4000-8000-000000000201}"},
		"invalid":   {"not-a-uuid"},
	} {
		t.Run(name, func(t *testing.T) {
			request := validDeliveryRequest()
			request.Attempt.GateDecision = GateOverridden
			request.Attempt.GateOverrideIDs = overrideIDs
			store := &fakeStore{}
			transport := &fakeTransport{}
			if _, err := newCoordinator(store, transport).Dispatch(context.Background(), request); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
			if store.acquireCalls != 0 || transport.callCount() != 0 {
				t.Fatalf("invalid override set reached ledger/provider: %d/%d", store.acquireCalls, transport.callCount())
			}
		})
	}
}

func newCoordinator(store Store, transport campaigntransport.Transport) *Coordinator {
	return &Coordinator{Store: store, Transport: transport, TransportName: "ses_raw_v2",
		LeaseOwner: "worker-1", LeaseDuration: time.Minute}
}

func validDeliveryRequest() Request {
	hash := strings.Repeat("a", 64)
	deliveryID, err := DeriveDeliveryID(deliveryTenantID, deliveryCampaignID, deliveryRecipientID, deliveryPlanID)
	if err != nil {
		panic(err)
	}
	expiresAt := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	message := campaigntransport.CompiledMessage{
		ArtifactID: deliveryArtifactID, ScenarioID: "scenario-a", CampaignID: deliveryCampaignID,
		MessageID: "<message@example.test>", ReplyTo: "reply+opaque@reply.example.test",
		EnvelopeFrom: "news@example.test", To: []string{"recipient@example.test"},
		RFC822: []byte("synthetic exact MIME bytes"), MIMEHash: hash,
	}
	return Request{Attempt: AttemptInput{
		DeliveryID: deliveryID, TenantID: deliveryTenantID, CampaignID: deliveryCampaignID, CampaignRecipientID: deliveryRecipientID,
		SendPlanID: deliveryPlanID, ArtifactID: deliveryArtifactID, AssuranceRunID: deliveryRunID,
		AssuranceAttemptCount: 1, ArtifactSetHash: hash, GateDecision: GatePass,
		ScenarioID: "scenario-a", SourceHash: hash, PlanHash: hash, CompilerVersion: "compiler-v1",
		OutboundMIMEHash: hash, MessageID: "<message@example.test>", ReplyTo: "reply+opaque@reply.example.test",
		ReplyCorrelationVersion: 1, ReplyCorrelationKeyID: "k1",
		ReplyCorrelationExpiresAt: &expiresAt, ReplyCorrelationTokenHash: strings.Repeat("b", 64),
		IdempotencyKey: "recipient-103-plan-104",
	}, Recipient: "recipient@example.test", Message: message}
}

func receiptFor(message campaigntransport.CompiledMessage, key string) campaigntransport.Receipt {
	return campaigntransport.Receipt{
		ContractVersion: campaigntransport.ContractVersion, ArtifactID: message.ArtifactID,
		ScenarioID: message.ScenarioID, CampaignID: message.CampaignID,
		OutboundMIMEHash: message.MIMEHash, ProviderMessageID: "provider-accepted-1",
		IdempotencyKey: key, IdempotencyMode: campaigntransport.LedgerIdempotencyMode,
	}
}
