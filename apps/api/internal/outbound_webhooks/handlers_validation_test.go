// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestWriteTestPreparationErrorProjectsActionableFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"deleted", ErrNotFound, http.StatusNotFound, "not_found"},
		{"cipher", ErrCipherUnconfigured, http.StatusServiceUnavailable, "cipher_unconfigured"},
		{"auth pending", ErrAuthConfigPending, http.StatusServiceUnavailable, "delivery_configuration_pending"},
		{"destination pending", ErrDestinationPending, http.StatusServiceUnavailable, "destination_unavailable"},
		{"destination invalid", ErrDestinationInvalid, http.StatusConflict, "destination_unavailable"},
		{"filter invalid", errors.Join(ErrInvalidFilter, errors.New("parse")), http.StatusConflict, "delivery_configuration_invalid"},
		{"transform invalid", ErrInvalidTransform, http.StatusConflict, "delivery_configuration_invalid"},
		{"auth invalid", ErrAuthConfigInvalid, http.StatusConflict, "delivery_configuration_invalid"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			if !writeTestPreparationError(rec, test.err) {
				t.Fatal("expected preparation error to be projected")
			}
			if rec.Code != test.status {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, test.status, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"`+test.code+`"`) {
				t.Fatalf("body %q missing code %q", rec.Body.String(), test.code)
			}
		})
	}

	rec := httptest.NewRecorder()
	if writeTestPreparationError(rec, errors.New("database unavailable")) {
		t.Fatal("unexpected internal error was projected as an expected setup failure")
	}
}

func TestRotateSecretRejectsMalformedGraceWindowBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	for _, query := range []string{
		"?grace_minutes=invalid",
		"?grace_minutes=0",
		"?grace_minutes=-1",
		"?grace_minutes=10081",
		"?grace_minutes=1.5",
		"?grace_minutes=",
		"?grace_minutes=60&grace_minutes=120",
	} {
		query := query
		t.Run(query, func(t *testing.T) {
			t.Parallel()
			ctx := middleware.WithTenant(
				context.Background(),
				&middleware.Tenant{
					ID: "00000000-0000-4000-8000-000000000001",
				},
			)
			req := httptest.NewRequestWithContext(
				ctx,
				http.MethodPost,
				"/api/v1/outbound-webhooks/example/rotate-secret"+query,
				nil,
			)
			rec := httptest.NewRecorder()
			(&Deps{Store: &Store{}}).RotateSecret(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf(
					"grace_minutes=%q status = %d, want 400; body=%s",
					query,
					rec.Code,
					rec.Body.String(),
				)
			}
			if !strings.Contains(rec.Body.String(), "invalid_grace_minutes") {
				t.Fatalf(
					"grace_minutes=%q body %q missing validation code",
					query,
					rec.Body.String(),
				)
			}
		})
	}
}

func TestDeleteRejectsAmbiguousSoftFlagBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	for _, query := range []string{"?soft=yes", "?soft=", "?soft=1&soft=0"} {
		query := query
		t.Run(query, func(t *testing.T) {
			t.Parallel()
			ctx := middleware.WithTenant(
				context.Background(),
				&middleware.Tenant{
					ID: "00000000-0000-4000-8000-000000000001",
				},
			)
			req := httptest.NewRequestWithContext(
				ctx,
				http.MethodDelete,
				"/api/v1/outbound-webhooks/example"+query,
				nil,
			)
			rec := httptest.NewRecorder()
			(&Deps{Store: &Store{}}).Delete(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "invalid_soft_delete") {
				t.Fatalf("body %q missing validation code", rec.Body.String())
			}
		})
	}
}
