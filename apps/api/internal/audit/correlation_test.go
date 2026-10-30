// SPDX-License-Identifier: AGPL-3.0-only

package audit

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// One request produces many audit rows, and nothing said they belonged together.
//
// A single campaign send writes rows across several of the 35 audit tables —
// the campaign mutation, an approval decision, an entitlement check, an outbox
// dispatch. Read individually they are 35 answers to 35 questions nobody asked.
// The question actually asked during an incident is "what happened when I
// clicked send", and without a shared id there was no way to assemble it.
//
// The request id already existed on every request (chi generates one and the
// logger prints it); it simply never reached an audit row.

func TestTheAuditPayloadCarriesTheRequestId(t *testing.T) {
	payload := buildPayloadWithCorrelation(nil, nil, nil, "req-abc123")
	ctxMap, ok := payload["context"].(map[string]any)
	if !ok {
		t.Fatalf("no context block on the payload: %#v", payload)
	}
	if ctxMap["correlation_id"] != "req-abc123" {
		t.Fatalf("correlation_id=%v, want the request id", ctxMap["correlation_id"])
	}
}

func TestCallerMetadataSurvivesTheCorrelationStamp(t *testing.T) {
	// The stamp must not eat what the caller was already recording — that
	// metadata is the reason most of these rows are readable at all.
	payload := buildPayloadWithCorrelation(nil, nil,
		map[string]any{"reason": "operator override"}, "req-1")
	ctxMap := payload["context"].(map[string]any)
	if ctxMap["reason"] != "operator override" {
		t.Fatalf("caller metadata lost: %#v", ctxMap)
	}
	if ctxMap["correlation_id"] != "req-1" {
		t.Fatalf("correlation_id missing beside it: %#v", ctxMap)
	}
}

func TestACallerKeyNamedCorrelationIdIsNotOverwritten(t *testing.T) {
	// If a caller already recorded its own correlation_id — an inbound webhook
	// echoing an upstream id, say — that is more specific than ours and losing
	// it would break the very chain this exists to build.
	payload := buildPayloadWithCorrelation(nil, nil,
		map[string]any{"correlation_id": "upstream-9"}, "req-1")
	ctxMap := payload["context"].(map[string]any)
	if ctxMap["correlation_id"] != "upstream-9" {
		t.Fatalf("the caller's own correlation_id was overwritten: %#v", ctxMap)
	}
}

func TestNoRequestIdMeansNoEmptyKey(t *testing.T) {
	// A worker with no request context must not write correlation_id:"" — an
	// empty string would group every unrelated background row into one chain.
	payload := buildPayloadWithCorrelation(nil, nil, nil, "")
	if _, present := payload["context"]; present {
		t.Fatalf("an empty request id produced a context block: %#v", payload)
	}
}

func TestTheRequestIdIsReadFromTheAuditMeta(t *testing.T) {
	ctx := middleware.WithAuditMeta(context.Background(), db.AuditMeta{
		TenantID:  "t1",
		RequestID: "req-xyz",
	})
	meta, ok := middleware.AuditMetaFromContext(ctx)
	if !ok || meta.RequestID != "req-xyz" {
		t.Fatalf("AuditMeta does not carry a request id: %+v", meta)
	}
}

// Emit itself, not just the payload builder.
//
// The first version of this file called buildPayloadWithCorrelation directly,
// so removing the stamp from Emit left every test green — it proved the builder
// worked and nothing about whether the one production caller passed the request
// id in.
func TestEmitStampsTheRequestIdFromContext(t *testing.T) {
	var captured map[string]any
	SetEmitHookForTest(func(_ context.Context, _ string, _ string, _ string, _ string, payload map[string]any) error {
		captured = payload
		return nil
	})
	t.Cleanup(func() { SetEmitHookForTest(nil) })

	ctx := middleware.WithAuditMeta(context.Background(), db.AuditMeta{
		TenantID:  "11111111-1111-1111-1111-111111111111",
		RequestID: "req-from-ctx",
	})
	if err := Emit(ctx, nil, "campaign.updated", "campaign", "c1", nil, nil, nil); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	ctxMap, ok := captured["context"].(map[string]any)
	if !ok {
		t.Fatalf("Emit wrote no context block: %#v", captured)
	}
	if ctxMap["correlation_id"] != "req-from-ctx" {
		t.Fatalf("correlation_id=%v — the audit row cannot be tied to the request "+
			"that produced it", ctxMap["correlation_id"])
	}
}

func TestEmitWithoutARequestIdWritesNoCorrelation(t *testing.T) {
	// Background work has no request. Writing correlation_id:"" would group
	// every unrelated worker row into one chain.
	var captured map[string]any
	SetEmitHookForTest(func(_ context.Context, _ string, _ string, _ string, _ string, payload map[string]any) error {
		captured = payload
		return nil
	})
	t.Cleanup(func() { SetEmitHookForTest(nil) })

	ctx := middleware.WithAuditMeta(context.Background(), db.AuditMeta{
		TenantID: "11111111-1111-1111-1111-111111111111",
	})
	if err := Emit(ctx, nil, "worker.pruned", "subscriber", "", nil, nil, nil); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if _, present := captured["context"]; present {
		t.Fatalf("a worker row carries a context block: %#v", captured)
	}
}
