// SPDX-License-Identifier: AGPL-3.0-only

package merge_fields

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestValidateTypedValue(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		typ     FieldType
		value   string
		wantErr bool
	}{
		{name: "empty", typ: TypeDate, value: ""},
		{name: "number", typ: TypeNumber, value: "12.75"},
		{name: "negative number", typ: TypeNumber, value: "-4"},
		{name: "not a number", typ: TypeNumber, value: "NaN", wantErr: true},
		{name: "infinity", typ: TypeNumber, value: "+Inf", wantErr: true},
		{name: "boolean", typ: TypeBoolean, value: "false"},
		{name: "ambiguous boolean", typ: TypeBoolean, value: "yes", wantErr: true},
		{name: "leap date", typ: TypeDate, value: "2024-02-29"},
		{name: "impossible date", typ: TypeDate, value: "2025-02-29", wantErr: true},
		{name: "timestamp is not a date", typ: TypeDate, value: "2026-07-18T10:00:00Z", wantErr: true},
		{name: "bounded text", typ: TypeText, value: strings.Repeat("a", MaxValueLength)},
		{name: "oversized text", typ: TypeText, value: strings.Repeat("a", MaxValueLength+1), wantErr: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateTypedValue(test.typ, test.value)
			if test.wantErr && !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("validateTypedValue(%q, %q) error = %v; want ErrInvalidInput", test.typ, test.value, err)
			}
			if !test.wantErr && err != nil {
				t.Fatalf("validateTypedValue(%q, %q) error = %v; want nil", test.typ, test.value, err)
			}
		})
	}
}

func TestWriteErrFieldInUseIsStableAndRedacted(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/merge-fields/schema/SECRET", nil)
	(&Deps{}).writeErr(
		recorder,
		request,
		fmt.Errorf("%w: internal subscriber count 1234", ErrFieldInUse),
	)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusConflict)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"code":"field_in_use"`) {
		t.Fatalf("body = %s; want field_in_use code", body)
	}
	if strings.Contains(body, "1234") || strings.Contains(body, "internal subscriber") {
		t.Fatalf("body leaked internal error detail: %s", body)
	}
}

func TestWriteErrSchemaLimitIsStable(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/merge-fields/schema", nil)
	(&Deps{}).writeErr(recorder, request, fmt.Errorf("%w: internal count 51", ErrSchemaLimit))

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusUnprocessableEntity)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"code":"schema_limit"`) || !strings.Contains(body, "50 audience-field limit") {
		t.Fatalf("body = %s; want stable schema-limit contract", body)
	}
	if strings.Contains(body, "internal count") || strings.Contains(body, "51") {
		t.Fatalf("body leaked internal error detail: %s", body)
	}
}

func TestNormalizeSubscriberValueRejectsCompositeJSON(t *testing.T) {
	t.Parallel()
	for name, value := range map[string]any{
		"object": map[string]any{"nested": true},
		"array":  []any{"one", "two"},
	} {
		name, value := name, value
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := normalizeSubscriberValue(value); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v; want ErrInvalidInput", err)
			}
		})
	}
	for _, value := range []any{"Ada", true, 42.5, nil} {
		if _, err := normalizeSubscriberValue(value); err != nil {
			t.Fatalf("scalar %#v error = %v; want nil", value, err)
		}
	}
}

func TestPositionBoundsFailBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	repo := &Repo{}
	if _, err := repo.CreateSchema(context.Background(), "tenant", SchemaInput{
		Key: "FNAME", Label: "First name", Type: "text", Position: MaxPosition + 1,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("create position error = %v; want ErrInvalidInput", err)
	}
	position := MinPosition - 1
	if _, err := repo.PatchSchema(context.Background(), "tenant", "FNAME", SchemaPatch{
		Position: &position,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("patch position error = %v; want ErrInvalidInput", err)
	}
}

func TestMapDatabaseErrorPreservesStableDomainErrors(t *testing.T) {
	t.Parallel()
	if err := mapDatabaseError(&pgconn.PgError{
		Code: "PW001", Message: "merge field AGE must be a finite number",
	}); !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "AGE") {
		t.Fatalf("validation mapping = %v; want ErrInvalidInput with controlled detail", err)
	}
	if err := mapDatabaseError(&pgconn.PgError{Code: "PW002"}); !errors.Is(err, ErrFieldInUse) {
		t.Fatalf("usage mapping = %v; want ErrFieldInUse", err)
	}
}
