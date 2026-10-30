// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

type lifecycleWorkerFake struct {
	LifecycleStore
	command   DispatchCommand
	completed json.RawMessage
	failed    string
	expired   int
}

func (f *lifecycleWorkerFake) ExpireDue(context.Context, int, time.Time) (int, error) {
	f.expired++
	return 0, nil
}
func (f *lifecycleWorkerFake) ClaimDispatch(context.Context, string, time.Duration) (DispatchCommand, error) {
	return f.command, nil
}
func (f *lifecycleWorkerFake) CompleteDispatch(_ context.Context, _ DispatchCommand, receipt json.RawMessage) error {
	f.completed = append(json.RawMessage(nil), receipt...)
	return nil
}
func (f *lifecycleWorkerFake) FailDispatch(_ context.Context, _ DispatchCommand, code string) error {
	f.failed = code
	return nil
}

type workerTestStore struct {
	Store
	test Test
}

func (s workerTestStore) GetTest(context.Context, string, string) (Test, error) { return s.test, nil }

type workerObjectReader struct {
	raw         []byte
	contentType string
}

func (r workerObjectReader) Get(context.Context, string, string) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(r.raw)), r.contentType, nil
}

type workerExecutorFake struct {
	request inboxrealitycontract.DispatchRequest
}

func (e *workerExecutorFake) Execute(_ context.Context, request inboxrealitycontract.DispatchRequest) (inboxrealitycontract.ExecutionReceipt, error) {
	e.request = request
	capabilitySnapshot := inboxrealitycontract.CapabilitySnapshot{
		Version: "v1", Connector: "imap", Placement: "available", Headers: "available",
		RawMIME: "available", BodyParts: "available", ObservedSurface: "unavailable", CapturedAt: time.Now().UTC(),
	}
	snapshot, _ := json.Marshal(capabilitySnapshot)
	return inboxrealitycontract.ExecutionReceipt{
		ContractVersion: inboxrealitycontract.Version, CommandID: request.CommandID,
		TestID: request.TestID, ArtifactID: request.ArtifactID, ScenarioID: request.ScenarioID,
		ArtifactMIMEHash: request.ArtifactMIMEHash, DispatchedMIMEHash: strings.Repeat("d", 64),
		CapabilitySnapshot: capabilitySnapshot,
		Status:             "accepted", SeedCount: 1, AcceptedCount: 1,
		Deliveries: []inboxrealitycontract.SeedDispatchReceipt{{
			MailboxID: "gmail-controlled-01", Provider: "gmail", State: "accepted",
			AttemptCount: 1, DispatchedMIMEHash: strings.Repeat("d", 64), CapabilitySnapshot: snapshot,
		}}, CompletedAt: time.Now().UTC(),
	}, nil
}

func TestDispatchWorkerLoadsExactArtifactAndCompletesFencedCommand(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	raw := []byte("From: sender@example.test\r\nSubject: Launch\r\n\r\nLaunch\r\n")
	command := DispatchCommand{
		ID:          "11111111-1111-4111-8111-111111111111",
		TenantID:    "22222222-2222-4222-8222-222222222222",
		TestID:      "33333333-3333-4333-8333-333333333333",
		RequestHash: strings.Repeat("a", 64), CampaignID: "44444444-4444-4444-8444-444444444444",
		ContentRevisionID: "55555555-5555-4555-8555-555555555555",
		SendPlanID:        "66666666-6666-4666-8666-666666666666",
		ArtifactID:        "77777777-7777-4777-8777-777777777777", ScenarioID: "base",
		ArtifactMIMEObjectRef: "postwave.tenant-object-ref.v1:campaign-assurance/raw.eml",
		ArtifactMIMEHash:      digestLifecycleBytes(raw), ArtifactStructureHash: strings.Repeat("b", 64),
		RequestedCapabilities: DefaultCapabilityRequirements(), State: DispatchLeased,
		LeaseOwner: "88888888-8888-4888-8888-888888888888",
		LeaseToken: "99999999-9999-4999-8999-999999999999", AttemptCount: 1, MaxAttempts: 8,
	}
	test := Test{
		ID: command.TestID, TenantID: command.TenantID,
		HeaderToken: "0123456789abcdef0123456789abcdef", Status: StatusAwaitingDelivery,
		ArtifactID: command.ArtifactID, ScenarioID: command.ScenarioID,
		OutboundMIMEHash: command.ArtifactMIMEHash, ExpiresAt: now.Add(10 * time.Minute),
	}
	lifecycle := &lifecycleWorkerFake{command: command}
	executor := &workerExecutorFake{}
	worker := &DispatchWorker{
		Lifecycle: lifecycle, Tests: workerTestStore{test: test},
		Objects: workerObjectReader{raw: raw, contentType: "message/rfc822"}, Executor: executor,
		OwnerID: command.LeaseOwner, Clock: func() time.Time { return now },
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lifecycle.expired != 1 || lifecycle.failed != "" || len(lifecycle.completed) == 0 {
		t.Fatalf("lifecycle expired=%d failed=%q completed=%t", lifecycle.expired, lifecycle.failed, len(lifecycle.completed) > 0)
	}
	if !bytes.Equal(executor.request.RawMIME, raw) || executor.request.ArtifactMIMEHash != command.ArtifactMIMEHash ||
		executor.request.HeaderValue != "irt_"+test.HeaderToken || executor.request.LeaseToken != command.LeaseToken {
		t.Fatal("dispatch request did not preserve the exact artifact/test/fence identity")
	}
}
