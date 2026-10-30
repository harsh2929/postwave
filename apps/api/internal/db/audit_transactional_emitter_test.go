// SPDX-License-Identifier: AGPL-3.0-only

package db

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type auditTxStub struct {
	pgx.Tx

	execCount int
	execSQL   string
	execArgs  []any
	execErr   error
}

func (s *auditTxStub) Exec(
	_ context.Context,
	sql string,
	arguments ...any,
) (pgconn.CommandTag, error) {
	s.execCount++
	s.execSQL = sql
	s.execArgs = append([]any(nil), arguments...)
	if s.execErr != nil {
		return pgconn.CommandTag{}, s.execErr
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func isolateAuditHooks(t *testing.T) {
	t.Helper()

	oldTransactional := auditTransactionalEmitter.Load()
	oldRealtime := auditEmitter.Load()
	oldRedactor := auditRedactor.Load()
	SetAuditTransactionalEmitter(nil)
	SetAuditEventEmitter(nil)
	SetAuditRedactor(nil)
	t.Cleanup(func() {
		auditTransactionalEmitter.Store(oldTransactional)
		auditEmitter.Store(oldRealtime)
		auditRedactor.Store(oldRedactor)
	})
}

func TestAuditTransactionalEmitterReceivesInsertedEventIdentity(t *testing.T) {
	isolateAuditHooks(t)

	type contextKey string
	const markerKey contextKey = "audit-transactional-emitter"
	ctx := context.WithValue(context.Background(), markerKey, "same-context")
	tx := &auditTxStub{}
	meta := AuditMeta{
		TenantID:   "tenant-123",
		ActorType:  "agent",
		ActorLabel: "integration-test",
	}

	var got struct {
		called       int
		contextValue any
		tx           pgx.Tx
		tenantID     string
		action       string
		resourceType string
		resourceID   string
		eventID      string
		occurredAt   time.Time
	}
	SetAuditTransactionalEmitter(func(
		hookCtx context.Context,
		hookTx pgx.Tx,
		tenantID string,
		action string,
		resourceType string,
		resourceID string,
		eventID string,
		occurredAt time.Time,
	) error {
		got.called++
		got.contextValue = hookCtx.Value(markerKey)
		got.tx = hookTx
		got.tenantID = tenantID
		got.action = action
		got.resourceType = resourceType
		got.resourceID = resourceID
		got.eventID = eventID
		got.occurredAt = occurredAt
		return nil
	})

	before := time.Now().UTC()
	err := Audit(
		ctx,
		tx,
		meta,
		"subscriber.create",
		"subscriber",
		"subscriber-456",
		map[string]any{"source": "test"},
	)
	after := time.Now().UTC()
	if err != nil {
		t.Fatalf("Audit() error = %v", err)
	}

	if tx.execCount != 1 || !strings.Contains(tx.execSQL, "INSERT INTO audit_log") {
		t.Fatalf("audit insert calls = %d, SQL = %q; want one audit_log INSERT", tx.execCount, tx.execSQL)
	}
	if got.called != 1 {
		t.Fatalf("transactional emitter calls = %d, want 1", got.called)
	}
	if got.contextValue != "same-context" {
		t.Errorf("callback context marker = %v, want same-context", got.contextValue)
	}
	if got.tx != tx {
		t.Errorf("callback tx = %p, want exact caller tx %p", got.tx, tx)
	}
	if got.tenantID != meta.TenantID ||
		got.action != "subscriber.create" ||
		got.resourceType != "subscriber" ||
		got.resourceID != "subscriber-456" {
		t.Errorf(
			"callback identity = (%q, %q, %q, %q), want (%q, %q, %q, %q)",
			got.tenantID,
			got.action,
			got.resourceType,
			got.resourceID,
			meta.TenantID,
			"subscriber.create",
			"subscriber",
			"subscriber-456",
		)
	}
	if got.occurredAt.Location() != time.UTC {
		t.Errorf("callback occurredAt location = %v, want UTC", got.occurredAt.Location())
	}
	if got.occurredAt.Before(before) || got.occurredAt.After(after) {
		t.Errorf("callback occurredAt = %s, want between %s and %s", got.occurredAt, before, after)
	}

	if _, err := uuid.Parse(got.eventID); err != nil {
		t.Errorf("callback eventID = %q, want UUID: %v", got.eventID, err)
	}
	if len(tx.execArgs) != 15 {
		t.Fatalf("audit INSERT args = %d, want 15", len(tx.execArgs))
	}
	insertedEventID, ok := tx.execArgs[10].(string)
	if !ok {
		t.Fatalf("inserted event_id type = %T, want string", tx.execArgs[10])
	}
	if insertedEventID != got.eventID {
		t.Errorf("inserted event_id = %q, callback event_id = %q", insertedEventID, got.eventID)
	}
}

func TestAuditMintsDistinctEventIdentityForRepeatedSameResourceActions(t *testing.T) {
	isolateAuditHooks(t)

	tx := &auditTxStub{}
	var eventIDs []string
	SetAuditTransactionalEmitter(func(
		_ context.Context,
		_ pgx.Tx,
		_, _, _, _, eventID string,
		_ time.Time,
	) error {
		eventIDs = append(eventIDs, eventID)
		return nil
	})
	meta := AuditMeta{
		TenantID:   "tenant-123",
		ActorType:  "agent",
		ActorLabel: "integration-test",
	}
	for range 2 {
		if err := Audit(
			context.Background(),
			tx,
			meta,
			"subscriber.update",
			"subscriber",
			"subscriber-456",
			map[string]any{"source": "test"},
		); err != nil {
			t.Fatalf("Audit() error = %v", err)
		}
	}
	if len(eventIDs) != 2 {
		t.Fatalf("transactional event IDs = %v, want two", eventIDs)
	}
	if eventIDs[0] == eventIDs[1] {
		t.Fatalf("repeated legitimate audit actions collapsed to event ID %q", eventIDs[0])
	}
	for _, eventID := range eventIDs {
		if _, err := uuid.Parse(eventID); err != nil {
			t.Fatalf("event ID %q is not a UUID: %v", eventID, err)
		}
	}
}

func TestAuditPersistsAuthoritativeRequestCorrelation(t *testing.T) {
	isolateAuditHooks(t)
	tx := &auditTxStub{}
	metadata := map[string]any{
		"context": map[string]any{"trace_id": "trace-1", "correlation_id": "caller-value"},
	}
	err := Audit(context.Background(), tx, AuditMeta{
		TenantID:  "tenant-123",
		RequestID: "server/request-42",
	}, "campaign.update", "campaign", "campaign-1", metadata)
	if err != nil {
		t.Fatalf("Audit() error = %v", err)
	}
	inserted, ok := tx.execArgs[5].(map[string]any)
	if !ok {
		t.Fatalf("inserted metadata type = %T, want map", tx.execArgs[5])
	}
	contextValue, ok := inserted["context"].(map[string]any)
	if !ok {
		t.Fatalf("inserted context = %#v, want map", inserted["context"])
	}
	if contextValue["correlation_id"] != "server/request-42" {
		t.Fatalf("correlation_id = %#v, want server request id", contextValue["correlation_id"])
	}
	if contextValue["trace_id"] != "trace-1" {
		t.Fatalf("sibling context lost: %#v", contextValue)
	}
}

func TestAuditFailsClosedWhenRedactionFails(t *testing.T) {
	isolateAuditHooks(t)
	tx := &auditTxStub{}
	redactionErr := errors.New("policy lookup unavailable")
	SetAuditRedactor(func(context.Context, string, map[string]any) (map[string]any, []byte, map[string]string, error) {
		return nil, nil, nil, redactionErr
	})

	err := Audit(context.Background(), tx, AuditMeta{TenantID: "tenant-123"},
		"subscriber.update", "subscriber", "subscriber-1", map[string]any{"email": "private@example.com"})
	if !errors.Is(err, redactionErr) {
		t.Fatalf("Audit() error = %v, want wrapped %v", err, redactionErr)
	}
	if tx.execCount != 0 {
		t.Fatalf("audit insert calls = %d, want zero after redaction failure", tx.execCount)
	}
}

func TestAuditTransactionalEmitterFailureIsFailClosed(t *testing.T) {
	isolateAuditHooks(t)

	tx := &auditTxStub{}
	fanoutErr := errors.New("canonical fanout unavailable")
	transactionalCalled := false
	realtimeCalled := false
	SetAuditTransactionalEmitter(func(
		context.Context,
		pgx.Tx,
		string,
		string,
		string,
		string,
		string,
		time.Time,
	) error {
		transactionalCalled = true
		return fanoutErr
	})
	SetAuditEventEmitter(func(string, string, string, string) {
		realtimeCalled = true
	})

	err := Audit(
		context.Background(),
		tx,
		AuditMeta{TenantID: "tenant-123"},
		"audit.exported",
		"audit_log",
		"audit-456",
		nil,
	)
	if !errors.Is(err, fanoutErr) {
		t.Fatalf("Audit() error = %v, want wrapped fanout error %v", err, fanoutErr)
	}
	if !transactionalCalled {
		t.Fatal("transactional emitter was not called after the audit INSERT")
	}
	if tx.execCount != 1 {
		t.Fatalf("audit insert calls = %d, want 1 before fanout failure", tx.execCount)
	}
	if realtimeCalled {
		t.Fatal("best-effort realtime emitter ran after transactional emitter failure")
	}
}

func TestAuditRecordOnlyWritesCanonicalRowWithoutEventEmission(t *testing.T) {
	isolateAuditHooks(t)

	tx := &auditTxStub{}
	transactionalCalls := 0
	realtimeCalls := 0
	redactorCalls := 0
	SetAuditTransactionalEmitter(func(
		context.Context,
		pgx.Tx,
		string,
		string,
		string,
		string,
		string,
		time.Time,
	) error {
		transactionalCalls++
		return errors.New("record-only audit must not invoke transactional fanout")
	})
	SetAuditEventEmitter(func(string, string, string, string) {
		realtimeCalls++
	})
	SetAuditRedactor(func(
		context.Context,
		string,
		map[string]any,
	) (map[string]any, []byte, map[string]string, error) {
		redactorCalls++
		return map[string]any{"safe": true}, nil, nil, nil
	})

	err := AuditRecordOnly(
		context.Background(),
		tx,
		AuditMeta{TenantID: "tenant-123"},
		"outbound_webhook.playground_fire",
		"outbound_webhook",
		"webhook-456",
		map[string]any{"secret": "must-be-redacted"},
	)
	if err != nil {
		t.Fatalf("AuditRecordOnly() error = %v", err)
	}
	if tx.execCount != 1 || !strings.Contains(tx.execSQL, "INSERT INTO audit_log") {
		t.Fatalf("audit insert calls = %d, SQL = %q; want one audit_log INSERT", tx.execCount, tx.execSQL)
	}
	if redactorCalls != 1 {
		t.Fatalf("redactor calls = %d, want 1", redactorCalls)
	}
	if transactionalCalls != 0 || realtimeCalls != 0 {
		t.Fatalf(
			"record-only emitter calls transactional=%d realtime=%d, want zero",
			transactionalCalls,
			realtimeCalls,
		)
	}
	inserted, ok := tx.execArgs[5].(map[string]any)
	if !ok || inserted["safe"] != true || inserted["secret"] != nil {
		t.Fatalf("inserted metadata = %#v, want only redacted representation", tx.execArgs[5])
	}
}

func TestAuditRecordOnlyPropagatesInsertFailure(t *testing.T) {
	isolateAuditHooks(t)

	insertErr := errors.New("audit storage unavailable")
	tx := &auditTxStub{execErr: insertErr}
	err := AuditRecordOnly(
		context.Background(),
		tx,
		AuditMeta{TenantID: "tenant-123"},
		"outbound_webhook.playground_fire",
		"outbound_webhook",
		"webhook-456",
		nil,
	)
	if !errors.Is(err, insertErr) {
		t.Fatalf("AuditRecordOnly() error = %v, want wrapped %v", err, insertErr)
	}
	if tx.execCount != 1 {
		t.Fatalf("audit insert calls = %d, want 1", tx.execCount)
	}
}
