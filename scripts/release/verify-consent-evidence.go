// Command verify-consent-evidence is the bounded, read-only release gate for
// the consent evidence response contract introduced by migration 1979.
//
// The migration's CHECK constraints are intentionally NOT VALID so deploys do
// not take an unbounded validation lock. This command scans legacy rows under a
// deadline, reports only aggregate counts and non-PII row identifiers, and
// blocks the release until every existing row satisfies the strict read shape.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type evidenceCheck struct {
	name      string
	table     string
	idColumn  string
	predicate string
}

var consentEvidenceChecks = []evidenceCheck{
	{
		name: "consent_events", table: "public.consent_events", idColumn: "id::text",
		predicate: `
public.consent_evidence_uuid_is_safe(id) AND
(decision_id IS NULL OR public.consent_evidence_uuid_is_safe(decision_id)) AND
((subject_id IS NOT NULL AND subject_id <> '') OR subject_email IS NOT NULL) AND
public.consent_evidence_token_is_safe(subject_id, 512) AND
(subject_email IS NULL OR public.consent_evidence_email_is_safe(subject_email::text)) AND
source IS NOT NULL AND source <> '' AND
public.consent_evidence_token_is_safe(source, 512) AND
policy_version IS NOT NULL AND policy_version <> '' AND
public.consent_evidence_token_is_safe(policy_version, 256) AND
public.consent_evidence_narrative_is_safe(proof_text, 65536) AND
public.consent_evidence_token_is_safe(user_agent, 2048) AND
preferences IS NOT NULL AND
pg_catalog.jsonb_typeof(preferences) = 'object' AND
pg_catalog.octet_length(preferences::text) <= 65536 AND
public.consent_evidence_timestamp_is_safe(created_at) AND
public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, created_at))`,
	},
	{
		name: "consent_receipts", table: "public.consent_receipts", idColumn: "id::text",
		predicate: `
id IS NOT NULL AND id > 0 AND
subscriber_email IS NOT NULL AND
public.consent_evidence_email_is_safe(subscriber_email) AND
public.consent_evidence_token_is_safe(prev_state, 128) AND
source IS NOT NULL AND source <> '' AND
public.consent_evidence_token_is_safe(source, 512) AND
public.consent_evidence_narrative_is_safe(source_detail, 16384) AND
public.consent_evidence_token_is_safe(user_agent, 2048) AND
public.consent_evidence_token_is_safe(privacy_policy_version, 256) AND
public.consent_evidence_narrative_is_safe(captured_text, 65536) AND
public.consent_evidence_timestamp_is_safe(at) AND
public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, at))`,
	},
	{
		name: "consent_records", table: "public.consent_records", idColumn: "id::text",
		predicate: `
public.consent_evidence_uuid_is_safe(id) AND
email IS NOT NULL AND
public.consent_evidence_email_is_safe(email::text) AND
source IS NOT NULL AND source <> '' AND
public.consent_evidence_token_is_safe(source, 512) AND
public.consent_evidence_narrative_is_safe(source_url, 16384) AND
public.consent_evidence_token_is_safe(user_agent, 2048) AND
evidence IS NOT NULL AND
pg_catalog.octet_length(evidence::text) <= 65536 AND
public.consent_evidence_timestamp_is_safe(captured_at) AND
public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, created_at))`,
	},
}

const maxReportedEvidenceIDs = 20
const consentEvidenceDisableRLS = `SET LOCAL row_security = off`

func main() {
	if err := runConsentEvidenceVerification(); err != nil {
		fmt.Fprintf(os.Stderr, "consent evidence verification failed: %v\n", err)
		os.Exit(1)
	}
}

func runConsentEvidenceVerification() error {
	databaseURL := flag.String("database-url", "", "Postgres URL; defaults to DATABASE_URL")
	timeout := flag.Duration("timeout", 2*time.Minute, "maximum duration for the read-only legacy scan")
	flag.Parse()

	url := strings.TrimSpace(*databaseURL)
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		return errors.New("DATABASE_URL or --database-url is required")
	}
	if *timeout <= 0 || *timeout > 15*time.Minute {
		return errors.New("timeout must be greater than zero and no more than 15m")
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()

	results, err := verifyConsentEvidence(ctx, pool)
	if err != nil {
		return err
	}
	var violations []string
	for _, result := range results {
		fmt.Printf("consent evidence preflight: plane=%s invalid_rows=%d\n", result.name, result.count)
		if result.count > 0 {
			violations = append(violations, fmt.Sprintf(
				"%s has %d invalid legacy rows (sample non-PII ids: %s)",
				result.name, result.count, strings.Join(result.ids, ","),
			))
		}
	}
	if len(violations) > 0 {
		return errors.New(strings.Join(violations, "; "))
	}
	fmt.Println("consent evidence preflight passed: all three current source tables satisfy the v1 read bounds")
	return nil
}

type evidenceResult struct {
	name  string
	count int64
	ids   []string
}

type evidenceDB interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

func verifyConsentEvidence(ctx context.Context, database evidenceDB) ([]evidenceResult, error) {
	tx, err := database.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin read-only verification: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		return nil, fmt.Errorf("set lock timeout: %w", err)
	}
	// A release-wide legacy scan must never inherit tenant RLS and report an
	// empty, false-green result. On the privileged migrator connection this
	// exposes every source row; on an accidentally under-privileged connection
	// PostgreSQL fails the first protected-table query closed.
	if _, err := tx.Exec(ctx, consentEvidenceDisableRLS); err != nil {
		return nil, fmt.Errorf("disable row-security filtering for release verification: %w", err)
	}

	results := make([]evidenceResult, 0, len(consentEvidenceChecks))
	for _, check := range consentEvidenceChecks {
		where := evidenceViolationPredicate(check.predicate)
		var count int64
		if err := tx.QueryRow(ctx,
			"SELECT count(*) FROM "+check.table+" WHERE "+where,
		).Scan(&count); err != nil {
			return nil, fmt.Errorf("count %s violations: %w", check.name, err)
		}
		result := evidenceResult{name: check.name, count: count}
		if count > 0 {
			rows, err := tx.Query(ctx,
				"SELECT "+check.idColumn+" FROM "+check.table+" WHERE "+where+
					" ORDER BY "+check.idColumn+" LIMIT $1",
				maxReportedEvidenceIDs,
			)
			if err != nil {
				return nil, fmt.Errorf("sample %s violation identifiers: %w", check.name, err)
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return nil, fmt.Errorf("scan %s violation identifier: %w", check.name, err)
				}
				result.ids = append(result.ids, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, fmt.Errorf("iterate %s violation identifiers: %w", check.name, err)
			}
		}
		results = append(results, result)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit read-only verification: %w", err)
	}
	return results, nil
}

func evidenceViolationPredicate(predicate string) string {
	// SQL CHECK permits an UNKNOWN result, and historical rows can predate
	// current NOT NULL guarantees. Treat FALSE and UNKNOWN alike so the release
	// gate cannot miss a legacy NULL that the strict response decoder rejects.
	return "(" + predicate + ") IS NOT TRUE"
}
