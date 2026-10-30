// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/config"
)

// An environment that does not run the sidecars (lean staging) says so with
// *_SERVICE_URL=disabled. Before, it could only point them at names that do
// not resolve, and every proxied route answered 502 "did not respond".
func TestUndeployedSidecarsAnswerNotDeployedThroughTheirProxies(t *testing.T) {
	for _, key := range []string{
		"MIGRATION_SERVICE_URL", "VOICE_SERVICE_URL", "AUTOMATION_SERVICE_URL", "DELIVERABILITY_SERVICE_URL",
	} {
		t.Setenv(key, "disabled")
	}
	cfg := config.Load()
	for name, url := range map[string]string{
		"migration": cfg.MigrationServiceURL, "voice": cfg.VoiceServiceURL,
		"automation": cfg.AutomationServiceURL, "deliverability": cfg.DeliverabilityServiceURL,
	} {
		if url != "" {
			t.Fatalf("%s service URL = %q, want none", name, url)
		}
	}

	migration, voice, automation, automationAdmin := buildServiceProxies(cfg, nil)
	for path, proxy := range map[string]http.Handler{
		"/api/v1/migrations":                  migration,
		"/api/v1/voice/brand-profile":         voice,
		"/api/v1/automations/7/activate":      automation,
		"/api/v1/admin/automation/recurrence": automationAdmin,
	} {
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		var body struct {
			Error struct {
				Code      string `json:"code"`
				Retryable *bool  `json:"retryable"`
			} `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusServiceUnavailable || body.Error.Code != "service_not_deployed" ||
			body.Error.Retryable == nil || *body.Error.Retryable {
			t.Fatalf("%s: status %d body %s, want 503 service_not_deployed retryable:false", path, rec.Code, rec.Body.String())
		}
	}
}

// The default stays the local development port: only the explicit value says
// "not deployed", so a missing variable cannot silently switch a service off.
func TestUnsetSidecarURLsKeepTheirLocalDefaults(t *testing.T) {
	t.Setenv("AUTOMATION_SERVICE_URL", "")
	t.Setenv("VOICE_SERVICE_URL", "http://voice.internal:8083")
	t.Setenv("MIGRATION_SERVICE_URL", " Disabled ")
	cfg := config.Load()
	if cfg.AutomationServiceURL != "http://localhost:8084" {
		t.Fatalf("automation = %q, want the local default", cfg.AutomationServiceURL)
	}
	if cfg.VoiceServiceURL != "http://voice.internal:8083" {
		t.Fatalf("voice = %q", cfg.VoiceServiceURL)
	}
	if cfg.MigrationServiceURL != "" {
		t.Fatalf("migration = %q, want none for %q", cfg.MigrationServiceURL, " Disabled ")
	}
}
