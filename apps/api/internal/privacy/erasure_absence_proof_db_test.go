// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	cryptorand "crypto/rand"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The "PostgreSQL absence proof" named in erasureHistoryCoverageComplete's
// comment. The inventory says which tables are in scope; this proves the
// address is actually gone from the ones erasure claims to reach.
//
// It scans EVERY text-shaped column of the covered tables rather than checking
// the columns erasure writes. Checking the written columns only proves the
// UPDATE ran; the failure worth catching is the address surviving somewhere
// nobody thought about — a denormalised copy, a metadata blob, an audit note.

// scanForAddress counts occurrences of value across every text-ish column of
// the given tables, including inside jsonb.
func scanForAddress(ctx context.Context, t *testing.T, tx pgx.Tx, tenantID, value string, tables []string) map[string]int {
	t.Helper()
	hits := map[string]int{}
	for _, table := range tables {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			continue
		}
		rows, err := tx.Query(ctx, `
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name=$1
   AND (data_type IN ('text','character varying','jsonb','json')
        OR udt_name IN ('citext','text'))`, table)
		if err != nil {
			t.Fatal(err)
		}
		var columns []string
		for rows.Next() {
			var column string
			if err := rows.Scan(&column); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			columns = append(columns, column)
		}
		rows.Close()
		if len(columns) == 0 {
			continue
		}
		predicates := make([]string, 0, len(columns))
		for _, column := range columns {
			predicates = append(predicates,
				fmt.Sprintf(`COALESCE(%q::text,'') ILIKE '%%' || $1 || '%%'`, column))
		}
		query := fmt.Sprintf(`SELECT count(*)::int FROM %q WHERE %s`,
			table, strings.Join(predicates, " OR "))
		var count int
		if err := tx.QueryRow(ctx, query, value).Scan(&count); err != nil {
			// A table the restricted role cannot read is reported rather than
			// silently counted as clean — "I could not look" and "nothing is
			// there" must not share a result.
			t.Fatalf("scan %s: %v", table, err)
		}
		if count > 0 {
			hits[table] = count
		}
	}
	return hits
}

func TestErasureLeavesNoTraceOfTheSubjectInCoveredTables_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)
	requireRestrictedRole(ctx, t, pool)

	tenantID := uuid.NewString()
	// Distinctive enough that a hit cannot be a coincidence from fixture data.
	address := "absence-proof-" + strings.ReplaceAll(uuid.NewString(), "-", "") + "@example.test"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'absence-proof', 'absence-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'import')`, tenantID, address); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_replies (
    tenant_id, recipient_email, subject, body_snippet, body_stripped,
    raw_message_id, source, classification, classified_at, received_at, metadata)
VALUES ($1::uuid, $2::citext, 'Re: launch', 'hello', 'hello',
        '<absence-proof@example.test>', 'postmark', 'human_reply', now(), now(),
        '{"classification_receipt":{"version":"reply-header-v1"}}'::jsonb)`,
		tenantID, address); err != nil {
		t.Fatalf("seed reply: %v", err)
	}

	// Non-vacuity. Without this the scan could be silently broken — matching
	// nothing anywhere — and the absence assertion would pass on an empty
	// search rather than on a successful erasure.
	before := scanForAddress(ctx, t, tx, tenantID, address, erasureCoveredTables)
	if len(before) == 0 {
		t.Fatal("the scanner found the address nowhere BEFORE erasure, so it " +
			"proves nothing after")
	}
	if before["subscribers"] == 0 || before["campaign_replies"] == 0 {
		t.Fatalf("seeded rows were not found by the scanner: %v", before)
	}

	if _, err := eraseSubscriberDataWithEntropy(ctx, tx, tenantID, address, cryptorand.Reader); err != nil {
		t.Fatalf("eraseSubscriberDataWithEntropy: %v", err)
	}

	after := scanForAddress(ctx, t, tx, tenantID, address, erasureCoveredTables)
	if len(after) != 0 {
		t.Fatalf("the subject's address survived erasure in %v", after)
	}
}

// The scanner must look inside jsonb, not only at plain text columns. An
// address copied into a metadata blob is exactly the kind of survival a
// column-by-column review misses.
func TestAbsenceScannerSeesInsideJSONBColumns_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)
	requireRestrictedRole(ctx, t, pool)

	tenantID := uuid.NewString()
	address := "jsonb-probe-" + strings.ReplaceAll(uuid.NewString(), "-", "") + "@example.test"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'jsonb-probe', 'jsonb-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatal(err)
	}
	// The address appears ONLY inside metadata, never in recipient_email.
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_replies (
    tenant_id, recipient_email, subject, raw_message_id, source,
    classification, classified_at, received_at, metadata)
VALUES ($1::uuid, 'someone.else@example.test', 'Re: launch',
        '<jsonb-probe@example.test>', 'postmark', 'human_reply', now(), now(),
        jsonb_build_object('forwarded_from', $2::text))`, tenantID, address); err != nil {
		t.Fatal(err)
	}
	hits := scanForAddress(ctx, t, tx, tenantID, address, []string{"campaign_replies"})
	if hits["campaign_replies"] == 0 {
		t.Fatal("the scanner did not see an address hidden in a jsonb column, " +
			"so the absence proof would miss exactly the case it exists for")
	}
}
