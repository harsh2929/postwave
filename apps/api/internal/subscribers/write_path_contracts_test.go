// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/customfields"
)

func TestNormalizeCreatePreservesMergeFieldPresence(t *testing.T) {
	t.Parallel()

	omitted := CreateInput{
		Email:        "profile@example.test",
		CustomFields: map[string]any{"unrelated_trait": "keep-separate"},
	}
	if err := normalizeCreate(&omitted); err != nil {
		t.Fatalf("normalize omitted input: %v", err)
	}
	if omitted.MergeFields != nil {
		t.Fatalf("omitted merge_fields became %#v; want nil omission", omitted.MergeFields)
	}
	if _, copied := omitted.MergeFields["unrelated_trait"]; copied {
		t.Fatal("custom trait was copied into merge_fields")
	}

	explicitEmpty := CreateInput{
		Email:       "clear@example.test",
		MergeFields: map[string]any{},
	}
	if err := normalizeCreate(&explicitEmpty); err != nil {
		t.Fatalf("normalize explicit empty input: %v", err)
	}
	if explicitEmpty.MergeFields == nil || len(explicitEmpty.MergeFields) != 0 {
		t.Fatalf("explicit empty merge_fields = %#v; want non-nil empty map", explicitEmpty.MergeFields)
	}

	explicitUpdate := CreateInput{
		Email:       "update@example.test",
		MergeFields: map[string]any{"FNAME": "Ada"},
	}
	if err := normalizeCreate(&explicitUpdate); err != nil {
		t.Fatalf("normalize explicit update: %v", err)
	}
	if explicitUpdate.MergeFields["FNAME"] != "Ada" {
		t.Fatalf("explicit merge field update lost: %#v", explicitUpdate.MergeFields)
	}
}

func TestBatchRecordDistinguishesOmittedAndExplicitEmptyMergeFields(t *testing.T) {
	t.Parallel()

	var omitted BatchUpsertInput
	if err := json.Unmarshal([]byte(`{"subscribers":[{"email":"omit@example.test"}]}`), &omitted); err != nil {
		t.Fatalf("decode omitted record: %v", err)
	}
	if got := batchRecordToCreateInput(omitted.Subscribers[0]).MergeFields; got != nil {
		t.Fatalf("omitted merge_fields = %#v; want nil", got)
	}

	var clear BatchUpsertInput
	if err := json.Unmarshal([]byte(`{"subscribers":[{"email":"clear@example.test","merge_fields":{}}]}`), &clear); err != nil {
		t.Fatalf("decode explicit clear record: %v", err)
	}
	if got := batchRecordToCreateInput(clear.Subscribers[0]).MergeFields; got == nil || len(got) != 0 {
		t.Fatalf("explicit empty merge_fields = %#v; want non-nil empty map", got)
	}
}

func TestCSVAndBulkPasteEmailOnlyRowsOmitMergeFields(t *testing.T) {
	t.Parallel()

	csvInput, err := buildCreateInput(
		[]string{"csv@example.test"},
		indexHeader([]string{"email"}),
	)
	if err != nil {
		t.Fatalf("build CSV input: %v", err)
	}
	if csvInput.MergeFields != nil {
		t.Fatalf("CSV email-only merge_fields = %#v; want nil omission", csvInput.MergeFields)
	}

	pasteInput := CreateInput{Email: "paste@example.test", CustomFields: map[string]any{}}
	if err := normalizeCreate(&pasteInput); err != nil {
		t.Fatalf("normalize paste-shaped input: %v", err)
	}
	if pasteInput.MergeFields != nil {
		t.Fatalf("bulk-paste-shaped merge_fields = %#v; want nil omission", pasteInput.MergeFields)
	}
}

func TestPersistenceRowErrorRedactsDatabaseDiagnostics(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		code string
		msg  string
	}{
		{
			name: "merge validation",
			err:  fmt.Errorf("upsert: %w", &pgconn.PgError{Code: "PW001", Message: "merge field SECRET contains forbidden SQL value"}),
			code: "merge_field_validation_failed",
			msg:  "a merge field value is invalid",
		},
		{
			name: "merge in use",
			err:  &pgconn.PgError{Code: "PW002", Message: "merge field INTERNAL has stored values"},
			code: "merge_field_in_use",
			msg:  "a merge field has stored subscriber values",
		},
		{
			name: "unique",
			err:  &pgconn.PgError{Code: "23505", Message: "duplicate key violates subscribers_tenant_email_key", Detail: "Key (tenant_id,email)=(secret) already exists"},
			code: "subscriber_conflict",
			msg:  "subscriber conflicts with an existing record",
		},
		{
			name: "check",
			err:  &pgconn.PgError{Code: "23514", Message: "violates check constraint hidden_constraint"},
			code: "subscriber_data_invalid",
			msg:  "subscriber data violates a storage constraint",
		},
		{
			name: "unknown database",
			err:  &pgconn.PgError{Code: "XX000", Message: "internal executor state and SELECT secret"},
			code: "subscriber_write_failed",
			msg:  "subscriber could not be saved",
		},
		{
			name: "unknown non-database",
			err:  errors.New("dial postgres://user:password@db/private"),
			code: "subscriber_write_failed",
			msg:  "subscriber could not be saved",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := persistenceRowError(tc.err)
			if got.Code != tc.code || got.Message != tc.msg {
				t.Fatalf("got %#v; want code=%q message=%q", got, tc.code, tc.msg)
			}
			for _, secret := range []string{"SECRET", "hidden_constraint", "password", "SELECT"} {
				if strings.Contains(got.Message, secret) {
					t.Fatalf("public message leaked %q: %q", secret, got.Message)
				}
			}
		})
	}
}

func TestRowErrorsSanitizeTypedCustomFieldFailuresAndEngineFailures(t *testing.T) {
	t.Parallel()

	got := persistenceRowError(&customfields.ErrTypeMismatch{
		Key: "age", Declared: customfields.TypeNumber, GotValue: "private-value",
	})
	if got.Code != "custom_field_type_mismatch" || strings.Contains(got.Message, "private-value") {
		t.Fatalf("typed validation error was not stable/redacted: %#v", got)
	}
	engine := engineRowError(errors.New("upstream Authorization: Bearer secret"))
	if engine.Code != "engine_sync_failed" || strings.Contains(engine.Message, "secret") {
		t.Fatalf("engine error was not stable/redacted: %#v", engine)
	}
}
