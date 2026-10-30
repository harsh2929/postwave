// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type listFanoutRow struct {
	values []any
	err    error
}

func (r listFanoutRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("unexpected scan destination count")
	}
	for index, value := range r.values {
		switch out := dest[index].(type) {
		case *bool:
			*out = value.(bool)
		case *int:
			*out = value.(int)
		default:
			return errors.New("unexpected scan destination type")
		}
	}
	return nil
}

type listFanoutTx struct {
	pgx.Tx
	execSQL      []string
	execArgs     [][]any
	queryRowSQL  []string
	queryRowArgs [][]any
	rows         []pgx.Row
	execErr      error
}

func (tx *listFanoutTx) Exec(
	_ context.Context,
	sql string,
	arguments ...any,
) (pgconn.CommandTag, error) {
	tx.execSQL = append(tx.execSQL, sql)
	tx.execArgs = append(tx.execArgs, arguments)
	return pgconn.CommandTag{}, tx.execErr
}

func (tx *listFanoutTx) QueryRow(
	_ context.Context,
	sql string,
	args ...any,
) pgx.Row {
	tx.queryRowSQL = append(tx.queryRowSQL, sql)
	tx.queryRowArgs = append(tx.queryRowArgs, args)
	if len(tx.rows) == 0 {
		return listFanoutRow{err: errors.New("unexpected QueryRow")}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}

func TestPrepareListSubscriberAddedEventUsesPersistedRevisionIdentity(t *testing.T) {
	event := ListSubscriberAddedEvent{
		SubscriberID: "subscriber-1",
		Email:        "person@example.com",
		ListID:       "list-1",
		Source:       "api",
		AddedAt:      time.Date(2026, 7, 23, 9, 10, 11, 123000000, time.UTC),
	}
	first, err := prepareListSubscriberAddedEvent("tenant-1", event)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	retry, err := prepareListSubscriberAddedEvent("tenant-1", event)
	if err != nil {
		t.Fatalf("prepare retry: %v", err)
	}
	if first.SourceEventID != retry.SourceEventID {
		t.Fatalf("retry identities differ: %q != %q", first.SourceEventID, retry.SourceEventID)
	}
	if _, err := uuid.Parse(first.SourceEventID); err != nil {
		t.Fatalf("source identity is not UUID-shaped: %v", err)
	}
	event.AddedAt = event.AddedAt.Add(time.Microsecond)
	nextRevision, err := prepareListSubscriberAddedEvent("tenant-1", event)
	if err != nil {
		t.Fatalf("prepare next revision: %v", err)
	}
	if first.SourceEventID == nextRevision.SourceEventID {
		t.Fatal("distinct persisted membership revisions shared one source identity")
	}

	var envelope struct {
		Event struct {
			ID         string         `json:"id"`
			Type       string         `json:"type"`
			OccurredAt string         `json:"occurred_at"`
			Data       map[string]any `json:"data"`
		} `json:"event"`
	}
	if err := json.Unmarshal(first.Envelope, &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if envelope.Event.ID != first.SourceEventID ||
		envelope.Event.Type != EventListSubscriberAdded ||
		envelope.Event.OccurredAt != first.OccurredAt.Format(time.RFC3339Nano) ||
		envelope.Event.Data["list_id"] != "list-1" {
		t.Fatalf("unexpected envelope: %#v", envelope)
	}
}

func TestTransactionalListFanoutIsSetBasedAndHonorsSubscriptionTime(t *testing.T) {
	tx := &listFanoutTx{rows: []pgx.Row{
		listFanoutRow{values: []any{false}},
		listFanoutRow{values: []any{7}},
	}}
	at := time.Date(2026, 7, 23, 9, 10, 11, 0, time.UTC)
	count, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		context.Background(), tx, "tenant-1",
		[]ListSubscriberAddedEvent{
			{SubscriberID: "subscriber-1", Email: "one@example.com", ListID: "list-1", Source: "api", AddedAt: at},
			{SubscriberID: "subscriber-2", Email: "two@example.com", ListID: "list-1", Source: "api", AddedAt: at},
		},
	)
	if err != nil {
		t.Fatalf("fanout: %v", err)
	}
	if count != 7 {
		t.Fatalf("delivery count = %d, want 7", count)
	}
	if len(tx.execSQL) != 1 {
		t.Fatalf("receipt INSERT calls = %d, want exactly 1", len(tx.execSQL))
	}
	if len(tx.queryRowSQL) != 2 {
		t.Fatalf("set-based query calls = %d, want collision + delivery", len(tx.queryRowSQL))
	}
	if !strings.Contains(tx.execSQL[0], "jsonb_to_recordset") ||
		!strings.Contains(tx.execSQL[0], "outbound_webhook_event_receipts") {
		t.Fatalf("receipt write is not set based: %s", tx.execSQL[0])
	}
	deliverySQL := tx.queryRowSQL[1]
	for _, contract := range []string{
		"jsonb_to_recordset",
		"w.created_at <= i.occurred_at",
		"w.list_id::text = i.list_id",
		"ON CONFLICT (tenant_id, webhook_id, source_event_id)",
	} {
		if !strings.Contains(deliverySQL, contract) {
			t.Errorf("delivery SQL missing %q", contract)
		}
	}
	var records []preparedListSubscriberAddedEvent
	if err := json.Unmarshal([]byte(tx.execArgs[0][1].(string)), &records); err != nil {
		t.Fatalf("decode receipt batch: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("batch records = %d, want 2", len(records))
	}
}

func TestTransactionalListFanoutFailsClosedOnReceiptCollision(t *testing.T) {
	tx := &listFanoutTx{rows: []pgx.Row{
		listFanoutRow{values: []any{true}},
	}}
	_, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		context.Background(), tx, "tenant-1",
		[]ListSubscriberAddedEvent{{
			SubscriberID: "subscriber-1",
			Email:        "person@example.com",
			ListID:       "list-1",
			Source:       "api",
			AddedAt:      time.Now().UTC(),
		}},
	)
	if err == nil || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("error = %v, want collision", err)
	}
	if len(tx.queryRowSQL) != 1 {
		t.Fatalf("delivery query ran after collision: calls=%d", len(tx.queryRowSQL))
	}
}

func TestTransactionalListFanoutRejectsIncompleteMembership(t *testing.T) {
	tx := &listFanoutTx{}
	_, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		context.Background(), tx, "tenant-1",
		[]ListSubscriberAddedEvent{{AddedAt: time.Now().UTC()}},
	)
	if err == nil {
		t.Fatal("incomplete membership event accepted")
	}
	if len(tx.execSQL) != 0 {
		t.Fatal("database touched before membership validation")
	}
}
