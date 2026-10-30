// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type receiptTimeTx struct {
	pgx.Tx
	storedType     string
	storedDigest   []byte
	storedOccurred time.Time
	deliveryArgs   []any
}

func (tx *receiptTimeTx) Exec(
	context.Context,
	string,
	...any,
) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (tx *receiptTimeTx) QueryRow(
	context.Context,
	string,
	...any,
) pgx.Row {
	return receiptTimeRow{tx: tx}
}

func (tx *receiptTimeTx) Query(
	_ context.Context,
	_ string,
	args ...any,
) (pgx.Rows, error) {
	tx.deliveryArgs = append([]any(nil), args...)
	return &receiptTimeRows{}, nil
}

type receiptTimeRow struct{ tx *receiptTimeTx }

func (row receiptTimeRow) Scan(dest ...any) error {
	*(dest[0].(*string)) = row.tx.storedType
	*(dest[1].(*[]byte)) = append([]byte(nil), row.tx.storedDigest...)
	*(dest[2].(*time.Time)) = row.tx.storedOccurred
	return nil
}

type receiptTimeRows struct{ pgx.Rows }

func (*receiptTimeRows) Close()                 {}
func (*receiptTimeRows) Err() error             { return nil }
func (*receiptTimeRows) Next() bool             { return false }
func (*receiptTimeRows) Scan(...any) error      { return nil }
func (*receiptTimeRows) Values() ([]any, error) { return nil, nil }

func TestTransactionalFanoutRetryUsesReceiptOccurrenceTime(t *testing.T) {
	t.Parallel()

	body := map[string]any{"campaign_id": "campaign-1"}
	bodyJSON, err := transactionalBodyJSON(body)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bodyJSON)
	firstOccurred := time.Date(2026, 7, 22, 10, 11, 12, 13, time.UTC)
	retryOccurred := firstOccurred.Add(24 * time.Hour)
	tx := &receiptTimeTx{
		storedType:     "campaign.sent",
		storedDigest:   digest[:],
		storedOccurred: firstOccurred,
	}

	if _, err := (&TransactionalFanout{}).Fire(
		context.Background(),
		tx,
		TransactionalEvent{
			TenantID:      "11111111-1111-4111-8111-111111111111",
			EventType:     "campaign.sent",
			SourceEventID: "campaign-sent:campaign-1",
			Body:          body,
			OccurredAt:    retryOccurred,
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(tx.deliveryArgs) != 6 {
		t.Fatalf("delivery query args = %d; want 6", len(tx.deliveryArgs))
	}
	if got := tx.deliveryArgs[5].(time.Time); !got.Equal(firstOccurred) {
		t.Fatalf("subscription cutoff = %s; want receipt time %s", got, firstOccurred)
	}

	var envelope struct {
		Event struct {
			OccurredAt string `json:"occurred_at"`
		} `json:"event"`
	}
	if err := json.Unmarshal([]byte(tx.deliveryArgs[3].(string)), &envelope); err != nil {
		t.Fatal(err)
	}
	if got, want := envelope.Event.OccurredAt, firstOccurred.Format(time.RFC3339Nano); got != want {
		t.Fatalf("envelope occurred_at = %q; want %q", got, want)
	}
}

func TestTransactionalFanoutRejectsUnsupportedProducerTopic(t *testing.T) {
	t.Parallel()

	_, err := (&TransactionalFanout{}).Fire(
		context.Background(),
		&receiptTimeTx{},
		TransactionalEvent{
			TenantID:      "11111111-1111-4111-8111-111111111111",
			EventType:     "subscriber.typo",
			SourceEventID: "source-1",
			Body:          map[string]any{},
		},
	)
	if err == nil {
		t.Fatal("unsupported transactional event silently succeeded")
	}
}
