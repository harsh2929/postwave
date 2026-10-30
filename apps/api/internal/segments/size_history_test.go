// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsUndefinedTableOnlyMatchesPostgresUndefinedTable(t *testing.T) {
	undefined := &pgconn.PgError{Code: "42P01"}
	if !isUndefinedTable(undefined) {
		t.Fatal("expected PostgreSQL undefined-table error to allow rollout fallback")
	}
	if !isUndefinedTable(fmt.Errorf("query history: %w", undefined)) {
		t.Fatal("expected wrapped PostgreSQL undefined-table error to allow rollout fallback")
	}
	if isUndefinedTable(&pgconn.PgError{Code: "42501"}) {
		t.Fatal("permission errors must not be hidden behind the live-point fallback")
	}
	if isUndefinedTable(errors.New("connection reset")) {
		t.Fatal("generic database failures must not be hidden behind the live-point fallback")
	}
}
