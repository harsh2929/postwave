// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestWriteCustomFieldsValidationErrorMapsMergeFieldConstraint(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	handled := writeCustomFieldsValidationError(recorder, &pgconn.PgError{
		Code:    "PW001",
		Message: "merge field AGE must be a finite number",
	})
	if !handled {
		t.Fatal("merge-field constraint error was not handled")
	}
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusUnprocessableEntity)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"code":"merge_field_validation_failed"`) ||
		!strings.Contains(body, "merge field AGE must be a finite number") {
		t.Fatalf("body = %s; want stable merge-field validation envelope", body)
	}
}

func TestWriteCustomFieldsValidationErrorDoesNotClaimUnknownDatabaseErrors(t *testing.T) {
	t.Parallel()
	if writeCustomFieldsValidationError(httptest.NewRecorder(), &pgconn.PgError{
		Code: "23505", Message: "internal uniqueness detail",
	}) {
		t.Fatal("unrelated database error was incorrectly exposed as validation")
	}
}
