// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

const testTenantID = "11111111-1111-4111-8111-111111111111"

func catalogEnv(key string) string {
	if key == "POSTWAVE_CATALOG_DATABASE_URL" {
		return "postgres://catalog-operator@example.test/postwave"
	}
	return ""
}

func baseOptionsArgs() []string {
	return []string{
		"--tenant", testTenantID,
		"--actor", "release/catalog-rge-2026-07",
		"--note", "Reviewed for adaptation-only personal inspiration; direct use remains disabled.",
		"--inventory-manifest", "/operator/inventory.json",
		"--expected-count", "3132",
	}
}

func TestParseOptionsRequiresExactAuditableOperatorIntent(t *testing.T) {
	args := append(baseOptionsArgs(), "--approve-adaptation", "--publish", "--reconcile-stale")
	opts, err := parseOptions(args, catalogEnv)
	if err != nil {
		t.Fatalf("parseOptions: %v", err)
	}
	if opts.expectedCount != 3132 || !opts.approveAdaptation || !opts.publish ||
		!opts.reconcileStale || opts.provider != "really_good_emails" ||
		opts.inventoryManifest != "/operator/inventory.json" {
		t.Fatalf("options = %#v", opts)
	}
}

func TestParseOptionsRejectsPartialOrUnauditedRuns(t *testing.T) {
	base := []string{
		"--tenant", testTenantID,
		"--actor", "operator",
		"--note", "reviewed",
		"--inventory-manifest", "/operator/inventory.json",
		"--expected-count", "2",
	}
	tests := [][]string{
		base,
		append(append([]string{}, base...), "--expected-count", "0", "--dry-run"),
		{"--tenant", "not-a-uuid", "--actor", "operator", "--note", "reviewed", "--dry-run"},
		{"--tenant", testTenantID, "--actor", "", "--note", "reviewed", "--dry-run"},
		{"--tenant", testTenantID, "--actor", "operator", "--note", "reviewed", "--expected-count", "2", "--dry-run"},
	}
	for index, args := range tests {
		if _, err := parseOptions(args, catalogEnv); err == nil {
			t.Errorf("case %d unexpectedly accepted: %s", index, strings.Join(args, " "))
		}
	}
}

func TestParseOptionsAllowsReconciliationOnlyMutation(t *testing.T) {
	opts, err := parseOptions(append(baseOptionsArgs(), "--reconcile-stale"), catalogEnv)
	if err != nil {
		t.Fatalf("parseOptions: %v", err)
	}
	if !opts.reconcileStale || opts.publish || opts.approveAdaptation || opts.dryRun {
		t.Fatalf("options = %#v", opts)
	}
}

func TestParseOptionsDoesNotFallBackToRuntimeDatabaseURL(t *testing.T) {
	env := func(key string) string {
		if key == "DATABASE_URL" {
			return "postgres://runtime-must-not-be-used"
		}
		return ""
	}
	_, err := parseOptions([]string{
		"--tenant", testTenantID,
		"--actor", "operator",
		"--note", "reviewed",
		"--inventory-manifest", "/operator/inventory.json",
		"--expected-count", "2",
		"--dry-run",
	}, env)
	if err == nil || !strings.Contains(err.Error(), "POSTWAVE_CATALOG_DATABASE_URL") {
		t.Fatalf("error = %v", err)
	}
}

func validManifest() map[string]any {
	return map[string]any{
		"schema_version": inventoryManifestSchema,
		"generated_at":   "2026-07-29T00:00:00Z",
		"artifact": map[string]any{
			"file":         "catalog.json.gz",
			"encoding":     "gzip",
			"bytes":        42,
			"content_hash": "sha256:test",
		},
		"source": map[string]any{
			"provider": "really_good_emails",
		},
		"harvest": map[string]any{
			"complete":                  true,
			"pagination_exhausted":      true,
			"template_count":            2,
			"source_total_at_capture":   2,
			"source_unique_summaries":   2,
			"quality_rejections":        []any{},
			"detail_failures":           []any{},
			"quality_warnings":          []any{},
			"summaries_fetched":         2,
			"duplicate_details_skipped": 0,
		},
		"templates": []any{
			map[string]any{
				"source_provider":    "really_good_emails",
				"source_external_id": "source-b",
				"name":               "B",
				"content_hash":       bodyHTMLHash("Template body source-b"),
			},
			map[string]any{
				"source_provider":    "really_good_emails",
				"source_external_id": "source-a",
				"name":               "A",
				"content_hash":       bodyHTMLHash("Template body source-a"),
			},
		},
	}
}

func writeManifest(t *testing.T, manifest any) string {
	t.Helper()
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "inventory.json")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadInventoryManifestAcceptsCompleteHTMLFreeExactInventory(t *testing.T) {
	manifest, err := loadInventoryManifest(
		writeManifest(t, validManifest()),
		"really_good_emails",
		2,
	)
	if err != nil {
		t.Fatalf("loadInventoryManifest: %v", err)
	}
	if got, want := manifest.identities, []string{"source-a", "source-b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("identities = %v, want %v", got, want)
	}
	if got, want := manifest.contentHashes["source-a"], bodyHTMLHash("Template body source-a"); got != want {
		t.Fatalf("source-a content hash = %q, want %q", got, want)
	}
}

func TestLoadInventoryManifestRejectsMalformedWrongProviderDuplicateAndCountMismatch(t *testing.T) {
	t.Run("malformed JSON", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "inventory.json")
		if err := os.WriteFile(path, []byte(`{"schema_version":`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadInventoryManifest(path, "really_good_emails", 2); err == nil ||
			!strings.Contains(err.Error(), "decode JSON") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("wrong provider", func(t *testing.T) {
		value := validManifest()
		value["source"].(map[string]any)["provider"] = "another_provider"
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "does not exactly match") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("duplicate identity", func(t *testing.T) {
		value := validManifest()
		templates := value["templates"].([]any)
		templates[1].(map[string]any)["source_external_id"] = "source-b"
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "duplicate source_external_id") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("count mismatch", func(t *testing.T) {
		value := validManifest()
		value["harvest"].(map[string]any)["source_total_at_capture"] = 3
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "inventory counts disagree") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("invalid content hash", func(t *testing.T) {
		value := validManifest()
		value["templates"].([]any)[0].(map[string]any)["content_hash"] = "sha256:not-a-digest"
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "lowercase sha256 digest") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestLoadInventoryManifestRejectsIncompleteOrContentBearingManifest(t *testing.T) {
	t.Run("incomplete harvest", func(t *testing.T) {
		value := validManifest()
		value["harvest"].(map[string]any)["pagination_exhausted"] = false
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "pagination_exhausted must be true") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("HTML field", func(t *testing.T) {
		value := validManifest()
		value["templates"].([]any)[0].(map[string]any)["body_html"] = "<html></html>"
		if _, err := loadInventoryManifest(
			writeManifest(t, value),
			"really_good_emails",
			2,
		); err == nil || !strings.Contains(err.Error(), "HTML-free") {
			t.Fatalf("error = %v", err)
		}
	})
}

type fakeRows struct {
	pgx.Rows
	values [][]any
	index  int
	err    error
}

func newFakeRows(values ...[]any) *fakeRows {
	return &fakeRows{values: values, index: -1}
}

func (rows *fakeRows) Next() bool {
	rows.index++
	return rows.index < len(rows.values)
}

func (rows *fakeRows) Scan(dest ...any) error {
	if rows.index < 0 || rows.index >= len(rows.values) {
		return errors.New("Scan called without current row")
	}
	return assignValues(dest, rows.values[rows.index])
}

func (rows *fakeRows) Close() {}
func (rows *fakeRows) Err() error {
	return rows.err
}

type fakeRow struct {
	values []any
	err    error
}

func (row fakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	return assignValues(dest, row.values)
}

func assignValues(dest []any, values []any) error {
	if len(dest) != len(values) {
		return fmt.Errorf("destinations=%d values=%d", len(dest), len(values))
	}
	for index, value := range values {
		switch target := dest[index].(type) {
		case *string:
			typed, ok := value.(string)
			if !ok {
				return fmt.Errorf("value %d is %T, want string", index, value)
			}
			*target = typed
		case *bool:
			typed, ok := value.(bool)
			if !ok {
				return fmt.Errorf("value %d is %T, want bool", index, value)
			}
			*target = typed
		default:
			return fmt.Errorf("unsupported destination %T", dest[index])
		}
	}
	return nil
}

type fakeCatalogDB struct {
	query    func(context.Context, string, ...any) (pgx.Rows, error)
	queryRow func(context.Context, string, ...any) pgx.Row
}

func (db fakeCatalogDB) Query(
	ctx context.Context,
	sql string,
	args ...any,
) (pgx.Rows, error) {
	if db.query == nil {
		return nil, errors.New("unexpected Query")
	}
	return db.query(ctx, sql, args...)
}

func (db fakeCatalogDB) QueryRow(
	ctx context.Context,
	sql string,
	args ...any,
) pgx.Row {
	if db.queryRow == nil {
		return fakeRow{err: errors.New("unexpected QueryRow")}
	}
	return db.queryRow(ctx, sql, args...)
}

func referenceRow(id, externalID string) []any {
	bodyHTML := "Template body " + externalID
	contentHash := bodyHTMLHash(bodyHTML)
	return []any{
		id,
		externalID,
		"Template " + externalID,
		contentHash,
		bodyHTML,
		"approved",
		true,
		false,
	}
}

func TestLoadReferencesFiltersByExactManifestSet(t *testing.T) {
	opts := options{
		tenantID:      testTenantID,
		provider:      "really_good_emails",
		expectedCount: 2,
	}
	identities := []string{"source-a", "source-b"}
	contentHashes := map[string]string{
		"source-a": bodyHTMLHash("Template body source-a"),
		"source-b": bodyHTMLHash("Template body source-b"),
	}
	db := fakeCatalogDB{query: func(
		_ context.Context,
		sql string,
		args ...any,
	) (pgx.Rows, error) {
		if !strings.Contains(sql, "source.source_external_id = ANY($3::text[])") {
			t.Fatalf("query does not bind exact manifest identity set:\n%s", sql)
		}
		for _, marker := range []string{
			"platform.goal IS DISTINCT FROM source.goal",
			"platform.category IS DISTINCT FROM source.category",
			"platform.source_metadata - 'published_from_tenant_template_id'",
			"platform.design_metadata IS DISTINCT FROM source.design_metadata",
		} {
			if !strings.Contains(sql, marker) {
				t.Fatalf("query does not detect publication drift for %q:\n%s", marker, sql)
			}
		}
		if len(args) != 3 || args[0] != testTenantID || args[1] != "really_good_emails" {
			t.Fatalf("args = %#v", args)
		}
		if got, ok := args[2].([]string); !ok || !reflect.DeepEqual(got, identities) {
			t.Fatalf("identity arg = %#v", args[2])
		}
		return newFakeRows(
			referenceRow("11111111-1111-4111-8111-000000000001", "source-a"),
			referenceRow("11111111-1111-4111-8111-000000000002", "source-b"),
		), nil
	}}
	references, err := loadReferences(
		context.Background(),
		db,
		opts,
		identities,
		contentHashes,
	)
	if err != nil {
		t.Fatalf("loadReferences: %v", err)
	}
	if len(references) != 2 {
		t.Fatalf("references = %#v", references)
	}
}

func TestValidateLoadedReferencesRejectsMissingDuplicateOrUnexpectedRows(t *testing.T) {
	identities := []string{"source-a", "source-b"}
	contentHashes := map[string]string{
		"source-a": bodyHTMLHash("Template body source-a"),
		"source-b": bodyHTMLHash("Template body source-b"),
	}
	tests := []struct {
		name       string
		references []sourceReference
		want       string
	}{
		{
			name:       "missing",
			references: []sourceReference{{ExternalID: "source-a"}},
			want:       "missing 1 manifest references",
		},
		{
			name: "duplicate",
			references: []sourceReference{
				{ExternalID: "source-a"},
				{ExternalID: "source-a"},
			},
			want: "duplicate source_external_id",
		},
		{
			name:       "unexpected",
			references: []sourceReference{{ExternalID: "source-c"}},
			want:       "absent from manifest",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateLoadedReferences(
				test.references,
				identities,
				contentHashes,
			)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestValidateLoadedReferencesRejectsManifestAndBodyHashDrift(t *testing.T) {
	identities := []string{"source-a"}
	bodyHash := bodyHTMLHash("Template body source-a")
	tests := []struct {
		name          string
		reference     sourceReference
		contentHashes map[string]string
		want          string
	}{
		{
			name: "database hash differs from manifest",
			reference: sourceReference{
				ExternalID:  "source-a",
				ContentHash: bodyHash,
				BodyHash:    bodyHash,
			},
			contentHashes: map[string]string{
				"source-a": bodyHTMLHash("different manifest body"),
			},
			want: "does not match manifest",
		},
		{
			name: "stored body differs from declared hash",
			reference: sourceReference{
				ExternalID:  "source-a",
				ContentHash: bodyHash,
				BodyHash:    bodyHTMLHash("different stored body"),
			},
			contentHashes: map[string]string{"source-a": bodyHash},
			want:          "body_html hash",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateLoadedReferences(
				[]sourceReference{test.reference},
				identities,
				test.contentHashes,
			)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestStalePublicationRequiresExplicitReconciliationButDryRunDoesNot(t *testing.T) {
	stale := []platformReference{{
		ID: "11111111-1111-4111-8111-000000000009", ExternalID: "stale-source",
	}}
	tests := []struct {
		name    string
		opts    options
		wantErr bool
	}{
		{name: "publishing refuses stale", opts: options{publish: true}, wantErr: true},
		{name: "publishing reconciles explicitly", opts: options{publish: true, reconcileStale: true}},
		{name: "dry-run only reports", opts: options{publish: true, dryRun: true}},
		{name: "review-only does not mutate shared rows", opts: options{approveAdaptation: true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateStaleMutation(test.opts, stale)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr=%v", err, test.wantErr)
			}
		})
	}
}

func TestReconcileStaleReferencesUsesAuditedUnpublishFunction(t *testing.T) {
	stale := []platformReference{
		{ID: "11111111-1111-4111-8111-000000000008", ExternalID: "stale-a"},
		{ID: "11111111-1111-4111-8111-000000000009", ExternalID: "stale-b"},
	}
	calls := 0
	db := fakeCatalogDB{queryRow: func(
		_ context.Context,
		sql string,
		args ...any,
	) pgx.Row {
		if !strings.Contains(sql, "campaign_template_unpublish_reference") {
			t.Fatalf("query = %s", sql)
		}
		if len(args) != 3 ||
			args[0] != stale[calls].ID ||
			args[1] != "operator" ||
			args[2] != "inventory refresh" {
			t.Fatalf("call %d args = %#v", calls, args)
		}
		calls++
		return fakeRow{values: []any{true}}
	}}
	if err := reconcileStaleReferences(
		context.Background(),
		db,
		stale,
		"operator",
		"inventory refresh",
	); err != nil {
		t.Fatalf("reconcileStaleReferences: %v", err)
	}
	if calls != len(stale) {
		t.Fatalf("calls = %d, want %d", calls, len(stale))
	}
}
