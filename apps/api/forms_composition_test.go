// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/forms"
)

// Unset, FORMS_PUBLIC_HOST is http://localhost:3000, and every double opt-in
// email would carry a link nobody can open. A production API refuses to start
// with it, or with any origin a visitor cannot reach over https.
func TestAProductionAPIRefusesAFormsHostVisitorsCannotOpen(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	for _, host := range []string{
		"", "http://localhost:3000", "https://localhost", "https://forms.localhost", "https://127.0.0.1",
		"https://[::1]:8443", "https://0.0.0.0", "https://10.0.3.7", "http://forms.example.com",
		"forms.example.com", "https://user:pass@forms.example.com",
	} {
		if err := validateProductionFormsPublicHost(host); err == nil || !strings.Contains(err.Error(), "FORMS_PUBLIC_HOST") {
			t.Errorf("production FORMS_PUBLIC_HOST %q accepted (err %v)", host, err)
		}
	}
	for _, host := range []string{
		"https://forms.example.com/prefix",
		"https://forms.example.com?next=evil.example",
		"https://forms.example.com/#fragment",
		"https://user:pass@forms.example.com",
	} {
		if err := validateProductionFormsPublicHost(host); err == nil {
			t.Errorf("production FORMS_PUBLIC_HOST %q accepted despite not being an origin", host)
		}
	}
	for _, host := range []string{"https://forms.example.com", "https://example.com/", "https://forms.example.com:8443"} {
		if err := validateProductionFormsPublicHost(host); err != nil {
			t.Errorf("production FORMS_PUBLIC_HOST %q refused: %v", host, err)
		}
	}
}

func TestADevelopmentAPIKeepsTheLocalFormsHost(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "development")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	if err := validateProductionFormsPublicHost("http://localhost:3000"); err != nil {
		t.Fatalf("development refused the local forms host: %v", err)
	}
}

// The boot path runs the check: building the public forms' upload plane in
// production fails on the local default before anything is served.
func TestAProductionBootStopsOnTheLocalFormsHost(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	t.Setenv("POSTWAVE_FORM_UPLOAD_TENANT_QUOTA_BYTES", "")
	t.Setenv("POSTWAVE_FORM_UPLOAD_PENDING_LIMIT", "")
	t.Setenv("POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR", "clamav.invalid:3310")
	_, err := buildFormUploads(nil, nil, &forms.LocalUploadStore{BaseDir: t.TempDir()},
		slog.New(slog.NewTextHandler(io.Discard, nil)), config.Config{FormsPublicHost: "http://localhost:3000"}, nil, t.Context())
	if err == nil || !strings.Contains(err.Error(), "FORMS_PUBLIC_HOST") {
		t.Fatalf("production boot with the local forms host = %v, want a FORMS_PUBLIC_HOST refusal", err)
	}
}
