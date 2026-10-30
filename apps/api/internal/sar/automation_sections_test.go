// SPDX-License-Identifier: AGPL-3.0-only

package sar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestAutomationSARSectionSourceContracts(t *testing.T) {
	required := map[string]bool{
		"automation_executions":            false,
		"automation_journey_executions":    false,
		"flow_runs":                        false,
		"external_warehouse_trigger_fires": false,
		"trigger_delay_preferences":        false,
		"omni_recipients":                  false,
		"channel_send_history":             false,
	}
	seen := make(map[string]struct{}, len(automationSARSections))
	for _, section := range automationSARSections {
		if _, duplicate := seen[section.name]; duplicate {
			t.Fatalf("duplicate automation SAR section %q", section.name)
		}
		seen[section.name] = struct{}{}
		if _, ok := required[section.name]; ok {
			required[section.name] = true
		}

		query := strings.ToLower(section.query)
		if section.rowLimit() <= 0 {
			t.Errorf("section %q has invalid limit %d", section.name, section.rowLimit())
		}
		for _, fragment := range []string{"$1::uuid", "$2", "order by ", "limit $3"} {
			if !strings.Contains(query, fragment) {
				t.Errorf("section %q lacks required bounded/tenant/subject fragment %q", section.name, fragment)
			}
		}
		for _, forbidden := range []string{
			"to_jsonb(",
			"'tenant_id'",
			"push_token",
			"rendered_prompt",
			"raw_response",
			"credentials_ref",
			"warehouse_connections",
			" from external_warehouse_triggers ",
			".query",
			".config",
			".signature",
			"'payload'",
			"'metadata'",
			"'trigger_payload'",
			"'value'",
			"'parsed_value'",
			"'breakdown'",
			"'message'",
			".payload",
			".metadata",
			".trigger_payload",
			".value",
			".parsed_value",
			".breakdown",
			".suppressed_reason",
			".rule_reason",
		} {
			if strings.Contains(query, forbidden) {
				t.Errorf("section %q exposes forbidden field/source %q", section.name, forbidden)
			}
		}
	}
	for name, present := range required {
		if !present {
			t.Errorf("required automation SAR section %q is missing", name)
		}
	}

	automationExecutionQuery := sectionQueryForTest(t, "automation_executions")
	if strings.Contains(automationExecutionQuery, "e.created_at") ||
		!strings.Contains(automationExecutionQuery, "order by e.last_at") {
		t.Fatal("automation_executions must order by the current-schema last_at column")
	}
	journeyExecutionQuery := sectionQueryForTest(t, "automation_journey_executions")
	if strings.Contains(journeyExecutionQuery, "j.created_at") ||
		!strings.Contains(journeyExecutionQuery, "order by j.last_at") {
		t.Fatal("automation_journey_executions must order by the current-schema last_at column")
	}
}

func TestTrimAutomationSARSectionReportsDeterministicTruncation(t *testing.T) {
	rows := []map[string]any{{"id": "first"}, {"id": "second"}, {"id": "look-ahead"}}
	trimmed, metadata := trimAutomationSARSection(rows, 2)
	if len(trimmed) != 2 || trimmed[0]["id"] != "first" || trimmed[1]["id"] != "second" {
		t.Fatalf("trimmed rows = %#v", trimmed)
	}
	if metadata.ReturnedCount != 2 || !metadata.Truncated || metadata.Limit != 2 {
		t.Fatalf("metadata = %#v, want returned_count=2 truncated=true limit=2", metadata)
	}

	exact, exactMetadata := trimAutomationSARSection(rows[:2], 2)
	if len(exact) != 2 || exactMetadata.ReturnedCount != 2 || exactMetadata.Truncated || exactMetadata.Limit != 2 {
		t.Fatalf("exact-cap metadata = %#v (rows=%#v)", exactMetadata, exact)
	}
}

func TestAutomationSARSectionMetadataIsAdditiveOnTheWire(t *testing.T) {
	bundle := map[string]any{
		"automation_executions": []map[string]any{{"id": "run-1"}},
		"automation_section_metadata": map[string]automationSARSectionMetadata{
			"automation_executions": {ReturnedCount: 1, Truncated: true, Limit: 1},
		},
	}
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, stillArray := decoded["automation_executions"].([]any); !stillArray {
		t.Fatalf("existing section changed wire shape: %T", decoded["automation_executions"])
	}
	metadata, ok := decoded["automation_section_metadata"].(map[string]any)
	if !ok {
		t.Fatalf("metadata wire shape = %T", decoded["automation_section_metadata"])
	}
	executionMetadata, ok := metadata["automation_executions"].(map[string]any)
	if !ok || executionMetadata["returned_count"] != float64(1) ||
		executionMetadata["truncated"] != true || executionMetadata["limit"] != float64(1) {
		t.Fatalf("metadata wire fields = %#v", executionMetadata)
	}
}

func TestSARBundleEnvelopeDoesNotExposeTenantID(t *testing.T) {
	bundle := newBundleEnvelope("subject@example.test")
	if _, leaked := bundle["tenant_id"]; leaked {
		t.Fatal("SAR bundle envelope exposes internal tenant_id")
	}
	if bundle["subscriber_email"] != "subject@example.test" {
		t.Fatalf("subscriber_email = %#v", bundle["subscriber_email"])
	}
}

func TestRecordOptionalSARSectionMarksMissingRelationWithoutFailingBundle(t *testing.T) {
	bundle := newBundleEnvelope("subject@example.test")
	var unavailable []string
	rows := []map[string]any{}
	missing := errors.Join(errOptionalSARRelationMissing, &pgconn.PgError{Code: "42P01"})

	if err := recordOptionalSARSection(bundle, &unavailable, "flow_runs", rows, missing); err != nil {
		t.Fatalf("missing optional relation must preserve bundle compatibility: %v", err)
	}
	if _, present := bundle["flow_runs"]; !present {
		t.Fatal("missing optional relation must still emit the section as an empty array")
	}
	if len(unavailable) != 1 || unavailable[0] != "flow_runs" {
		t.Fatalf("unavailable sections = %#v, want [flow_runs]", unavailable)
	}

	want := errors.New("current schema defect")
	if err := recordOptionalSARSection(bundle, &unavailable, "flow_runs", nil, want); !errors.Is(err, want) {
		t.Fatalf("non-compatibility error = %v, want wrapped source error", err)
	}
}

func sectionQueryForTest(t *testing.T, name string) string {
	t.Helper()
	for _, section := range automationSARSections {
		if section.name == name {
			return strings.ToLower(section.query)
		}
	}
	t.Fatalf("missing section %q", name)
	return ""
}

type optionalSectionTx struct {
	pgx.Tx
	rows      pgx.Rows
	queryErr  error
	execs     []string
	queryArgs []any
}

func (tx *optionalSectionTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.execs = append(tx.execs, sql)
	return pgconn.NewCommandTag(sql), nil
}

func (tx *optionalSectionTx) Query(_ context.Context, _ string, args ...any) (pgx.Rows, error) {
	tx.queryArgs = append([]any(nil), args...)
	return tx.rows, tx.queryErr
}

type optionalSectionRows struct {
	pgx.Rows
	documents [][]byte
	next      int
	err       error
	scanErr   error
	closed    bool
}

func (rows *optionalSectionRows) Close() { rows.closed = true }

func (rows *optionalSectionRows) Err() error { return rows.err }

func (rows *optionalSectionRows) Next() bool {
	if rows.next >= len(rows.documents) {
		rows.closed = true
		return false
	}
	rows.next++
	return true
}

func (rows *optionalSectionRows) Scan(dest ...any) error {
	if rows.scanErr != nil {
		return rows.scanErr
	}
	if rows.next == 0 || rows.next > len(rows.documents) || len(dest) != 1 {
		return errors.New("invalid fake row scan")
	}
	target, ok := dest[0].(*[]byte)
	if !ok {
		return fmt.Errorf("unexpected scan target %T", dest[0])
	}
	*target = append((*target)[:0], rows.documents[rows.next-1]...)
	return nil
}

func TestLoadOptionalEmailOnlySuppressesUndefinedTable(t *testing.T) {
	ctx := context.Background()

	t.Run("missing table remains backward compatible and observable", func(t *testing.T) {
		tx := &optionalSectionTx{queryErr: &pgconn.PgError{Code: "42P01", Message: "relation does not exist"}}
		got, err := loadOptionalEmail(ctx, tx, "SELECT 1", "tenant", "subject@example.test")
		if !errors.Is(err, errOptionalSARRelationMissing) {
			t.Fatalf("missing table error = %v, want unavailable sentinel", err)
		}
		if got == nil || len(got) != 0 {
			t.Fatalf("missing table result = %#v, want non-nil empty slice", got)
		}
		assertOptionalSectionSavepointCleanup(t, tx.execs)
	})

	t.Run("deferred missing table remains backward compatible and observable", func(t *testing.T) {
		tx := &optionalSectionTx{rows: &optionalSectionRows{err: &pgconn.PgError{Code: "42P01"}}}
		got, err := loadOptionalEmail(ctx, tx, "SELECT 1", "tenant", "subject@example.test")
		if !errors.Is(err, errOptionalSARRelationMissing) {
			t.Fatalf("deferred missing table error = %v, want unavailable sentinel", err)
		}
		if got == nil || len(got) != 0 {
			t.Fatalf("deferred missing table result = %#v, want non-nil empty slice", got)
		}
		assertOptionalSectionSavepointCleanup(t, tx.execs)
	})

	t.Run("undefined column is not translated to no data", func(t *testing.T) {
		want := &pgconn.PgError{Code: "42703", Message: "column does not exist"}
		tx := &optionalSectionTx{queryErr: want}
		got, err := loadOptionalEmail(ctx, tx, "SELECT 1", "tenant", "subject@example.test")
		if got != nil {
			t.Fatalf("undefined column result = %#v, want nil", got)
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != want.Code {
			t.Fatalf("undefined column error = %v, want SQLSTATE %s", err, want.Code)
		}
		assertOptionalSectionSavepointCleanup(t, tx.execs)
	})

	t.Run("invalid row JSON fails the disclosure", func(t *testing.T) {
		tx := &optionalSectionTx{rows: &optionalSectionRows{documents: [][]byte{[]byte("not-json")}}}
		got, err := loadOptionalEmail(ctx, tx, "SELECT 1", "tenant", "subject@example.test")
		if got != nil || err == nil || !strings.Contains(err.Error(), "decode optional-section row") {
			t.Fatalf("invalid JSON result/error = %#v / %v", got, err)
		}
		assertOptionalSectionSavepointCleanup(t, tx.execs)
	})

	t.Run("valid rows are returned and savepoint is released", func(t *testing.T) {
		tx := &optionalSectionTx{rows: &optionalSectionRows{documents: [][]byte{[]byte(`{"id":"run-1"}`)}}}
		got, err := loadOptionalEmail(ctx, tx, "SELECT 1", "tenant", "subject@example.test")
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0]["id"] != "run-1" {
			t.Fatalf("valid result = %#v", got)
		}
		wantExecs := []string{"SAVEPOINT sar_optional_section", "RELEASE SAVEPOINT sar_optional_section"}
		if strings.Join(tx.execs, "|") != strings.Join(wantExecs, "|") {
			t.Fatalf("execs = %#v, want %#v", tx.execs, wantExecs)
		}
	})
}

func TestLoadAutomationSARSectionFetchesOneLookAheadRow(t *testing.T) {
	tx := &optionalSectionTx{rows: &optionalSectionRows{documents: [][]byte{
		[]byte(`{"id":"returned"}`),
		[]byte(`{"id":"look-ahead"}`),
	}}}
	section := sarSectionQuery{name: "contract", query: "SELECT payload LIMIT $3", limit: 1}

	rows, metadata, err := loadAutomationSARSection(
		context.Background(), tx, section, "tenant", "subject@example.test",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["id"] != "returned" {
		t.Fatalf("rows = %#v", rows)
	}
	if metadata.ReturnedCount != 1 || !metadata.Truncated || metadata.Limit != 1 {
		t.Fatalf("metadata = %#v", metadata)
	}
	if len(tx.queryArgs) != 3 || tx.queryArgs[2] != 2 {
		t.Fatalf("query args = %#v, want cap+1 as third argument", tx.queryArgs)
	}
}

func assertOptionalSectionSavepointCleanup(t *testing.T, got []string) {
	t.Helper()
	want := []string{
		"SAVEPOINT sar_optional_section",
		"ROLLBACK TO SAVEPOINT sar_optional_section",
		"RELEASE SAVEPOINT sar_optional_section",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("savepoint execs = %#v, want %#v", got, want)
	}
}
