// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCreateDatabaseErrorsAreBoundedAndTyped(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		postgres  *pgconn.PgError
		want      error
		retryable bool
	}{
		{
			name: "active artifact profile",
			postgres: &pgconn.PgError{Code: "23505",
				ConstraintName: "campaign_assurance_runs_one_active_artifact_profile_uidx"},
			want: ErrRunInFlight,
		},
		{
			name: "idempotency identity",
			postgres: &pgconn.PgError{Code: "23505",
				ConstraintName: "campaign_assurance_runs_tenant_id_campaign_id_request_id_key"},
			want: ErrIdempotencyConflict,
		},
		{
			name:      "serialization",
			postgres:  &pgconn.PgError{Code: "40001"},
			want:      nil,
			retryable: true,
		},
		{
			name: "run number collision",
			postgres: &pgconn.PgError{Code: "23505",
				ConstraintName: "campaign_assurance_runs_tenant_id_campaign_id_run_no_key"},
			want:      nil,
			retryable: true,
		},
		{
			name:     "frozen parent changed",
			postgres: &pgconn.PgError{Code: "23503", ConstraintName: "parent_fk"},
			want:     ErrSnapshotIncomplete,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := retryableCreateError(test.postgres); got != test.retryable {
				t.Fatalf("retryable=%v, want %v", got, test.retryable)
			}
			if test.want != nil && !errors.Is(mapCreateError(test.postgres), test.want) {
				t.Fatalf("mapped error = %v, want %v", mapCreateError(test.postgres), test.want)
			}
		})
	}
}

func TestDatabaseInvariantErrorsDoNotLeakPostgresDetails(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		code string
		want error
	}{
		{code: "42501", want: ErrUnauthorized},
		{code: "55000", want: ErrInvalidReceipt},
		{code: "23514", want: ErrInvalidReceipt},
		{code: "23505", want: ErrIdempotencyConflict},
	} {
		err := mapInvariantError(&pgconn.PgError{
			Code: test.code, Message: "sensitive internal database detail",
		}, ErrInvalidReceipt)
		if !errors.Is(err, test.want) {
			t.Errorf("SQLSTATE %s mapped error = %v, want %v", test.code, err, test.want)
		}
		if strings.Contains(err.Error(), "sensitive internal database detail") {
			t.Errorf("SQLSTATE %s leaked PostgreSQL detail: %v", test.code, err)
		}
	}
}
