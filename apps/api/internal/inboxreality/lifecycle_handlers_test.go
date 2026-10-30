// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

type callbackLifecycle struct {
	LifecycleStore
	received *ObservationReceipt
}

func (s *callbackLifecycle) RecordObservation(_ context.Context, receipt ObservationReceipt) (Result, error) {
	copy := receipt
	s.received = &copy
	return Result{
		TestID: receipt.TestID, MailboxID: receipt.MailboxID,
		Provider: receipt.Provider, Placement: receipt.Placement,
	}, nil
}

func validObservationReceipt() ObservationReceipt {
	return ObservationReceipt{
		TenantID:   "11111111-1111-4111-8111-111111111111",
		TestID:     "22222222-2222-4222-8222-222222222222",
		ArtifactID: "33333333-3333-4333-8333-333333333333", ScenarioID: "base",
		ObservationKey: strings.Repeat("a", 64), MailboxID: "gmail-controlled-01",
		Provider: ProviderGmail, Placement: PlacementPrimary, Folder: "INBOX",
		CapabilitySnapshot: []byte(`{"raw_mime":"available"}`),
		RawMIMEStatus:      "complete", ReceivedMIMESHA256: strings.Repeat("b", 64),
		ReceivedStructureSHA256: strings.Repeat("c", 64), StructureComparison: "match",
		CapturedAt: time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC),
	}
}

func TestObservationCallbackVerifiesExactBodyAndConverges(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 1, 0, time.UTC)
	lifecycle := &callbackLifecycle{}
	deps := &Deps{
		Orchestrator:           &Orchestrator{Lifecycle: lifecycle},
		InternalSigningSecrets: "current-secret,previous-secret", Clock: func() time.Time { return now },
	}
	receipt := validObservationReceipt()
	body, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := internalsign.Sign("current-secret", http.MethodPost,
		inboxrealitycontract.ObservationPath, receipt.ObservationKey, body, now)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, inboxrealitycontract.ObservationPath, bytes.NewReader(body))
	internalsign.Apply(request.Header, signed)
	response := httptest.NewRecorder()
	deps.ObservationCallback(response, request)
	if response.Code != http.StatusOK || lifecycle.received == nil {
		t.Fatalf("status=%d body=%s received=%+v", response.Code, response.Body.String(), lifecycle.received)
	}
	if lifecycle.received.ObservationKey != receipt.ObservationKey || lifecycle.received.ArtifactID != receipt.ArtifactID {
		t.Fatalf("callback identity drifted: %+v", lifecycle.received)
	}
}

func TestObservationCallbackRejectsBodyChangedAfterSignature(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 1, 0, time.UTC)
	lifecycle := &callbackLifecycle{}
	deps := &Deps{
		Orchestrator:           &Orchestrator{Lifecycle: lifecycle},
		InternalSigningSecrets: "current-secret", Clock: func() time.Time { return now },
	}
	receipt := validObservationReceipt()
	body, _ := json.Marshal(receipt)
	signed, _ := internalsign.Sign("current-secret", http.MethodPost,
		inboxrealitycontract.ObservationPath, receipt.ObservationKey, body, now)
	tampered := bytes.Replace(body, []byte(`"INBOX"`), []byte(`"SPAM"`), 1)
	request := httptest.NewRequest(http.MethodPost, inboxrealitycontract.ObservationPath, bytes.NewReader(tampered))
	internalsign.Apply(request.Header, signed)
	response := httptest.NewRecorder()
	deps.ObservationCallback(response, request)
	if response.Code != http.StatusUnauthorized || lifecycle.received != nil {
		t.Fatalf("status=%d body=%s received=%+v", response.Code, response.Body.String(), lifecycle.received)
	}
}

func TestMountInternalUsesSharedObservationContractPath(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 1, 0, time.UTC)
	lifecycle := &callbackLifecycle{}
	deps := &Deps{
		Orchestrator:           &Orchestrator{Lifecycle: lifecycle},
		InternalSigningSecrets: "current-secret",
		Clock:                  func() time.Time { return now },
	}
	receipt := validObservationReceipt()
	body, _ := json.Marshal(receipt)
	signed, _ := internalsign.Sign("current-secret", http.MethodPost,
		inboxrealitycontract.ObservationPath, receipt.ObservationKey, body, now)
	request := httptest.NewRequest(http.MethodPost, inboxrealitycontract.ObservationPath, bytes.NewReader(body))
	internalsign.Apply(request.Header, signed)

	router := chi.NewRouter()
	deps.MountInternal(router)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || lifecycle.received == nil {
		t.Fatalf("shared observation route status=%d body=%s", response.Code, response.Body.String())
	}
}
