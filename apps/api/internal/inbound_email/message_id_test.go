// SPDX-License-Identifier: AGPL-3.0-only

package inbound_email

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOutboundMessageIDCandidates(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{name: "empty", in: "   ", want: nil},
		{name: "bare", in: "message@example.test", want: []string{"message@example.test", "<message@example.test>"}},
		{name: "bracketed", in: " <message@example.test> ", want: []string{"<message@example.test>", "message@example.test"}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := outboundMessageIDCandidates(test.in)
			if err != nil {
				t.Fatalf("outboundMessageIDCandidates: %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("candidates = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestOutboundMessageIDCandidatesRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	for _, input := range []string{
		"<>", "<missing-end", "missing-start>", "<nested<id>>",
		"line\r\nbreak@example.test", strings.Repeat("a", 999),
	} {
		input := input
		t.Run(strings.ReplaceAll(input, "/", "_"), func(t *testing.T) {
			t.Parallel()
			if got, err := outboundMessageIDCandidates(input); err == nil {
				t.Fatalf("candidates = %#v; malformed input was accepted", got)
			}
		})
	}
}

func TestCampaignsByMessageIDIsTenantScopedAndAmbiguityVisible_DB(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Message-ID query proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL search_path = pg_temp, public`); err != nil {
		t.Fatalf("set search_path: %v", err)
	}
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE campaign_send_deliveries (
    tenant_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    message_id text NOT NULL
)`); err != nil {
		t.Fatalf("create shadow delivery ledger: %v", err)
	}
	tenantID, otherTenantID := uuid.NewString(), uuid.NewString()
	campaignID, otherCampaignID := uuid.NewString(), uuid.NewString()
	messageID := "thread-" + uuid.NewString() + "@example.test"
	if _, err := tx.Exec(ctx, `INSERT INTO campaign_send_deliveries VALUES
    ($1::uuid, $2::uuid, '<' || $5 || '>'),
    ($3::uuid, $4::uuid, '<' || $5 || '>')`,
		tenantID, campaignID, otherTenantID, otherCampaignID, messageID); err != nil {
		t.Fatalf("seed shadow ledger: %v", err)
	}
	candidates, err := outboundMessageIDCandidates(messageID)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := campaignsByMessageID(ctx, tx, tenantID, candidates)
	if err != nil {
		t.Fatalf("campaignsByMessageID: %v", err)
	}
	if !reflect.DeepEqual(ids, []string{campaignID}) {
		t.Fatalf("tenant-scoped campaigns = %#v, want %#v", ids, []string{campaignID})
	}

	// If the bare and bracketed forms have been issued for different campaigns
	// in one tenant, the repository sees both and fails closed.
	secondCampaignID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO campaign_send_deliveries VALUES
    ($1::uuid, $2::uuid, $3)`, tenantID, secondCampaignID, messageID); err != nil {
		t.Fatalf("seed ambiguity: %v", err)
	}
	ids, err = campaignsByMessageID(ctx, tx, tenantID, candidates)
	if err != nil {
		t.Fatalf("ambiguous campaignsByMessageID: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ambiguous campaigns = %#v, want two distinct campaigns", ids)
	}
}
