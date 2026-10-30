// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestWriteStoreErrorMapsMergeFieldConstraint(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	writeStoreError(recorder, &pgconn.PgError{
		Code:    "PW001",
		Message: "merge field AGE must be a finite number",
	}, "member")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusBadRequest)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "merge field AGE must be a finite number") {
		t.Fatalf("body = %s; want controlled validation detail", body)
	}
}

func TestWriteStoreErrorMapsPopulatedMergeFieldConflict(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	writeStoreError(recorder, &pgconn.PgError{Code: "PW002"}, "merge field")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusConflict)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "stored subscriber values") {
		t.Fatalf("body = %s; want stable field-in-use detail", body)
	}
}
