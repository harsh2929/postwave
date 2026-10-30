// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"strings"
	"testing"
)

// The generated route manifest is one half of the gateway boundary. This
// contract pins the mount-site gate as well, preventing a future OpenAPI-only
// edit from advertising admin while the reverse proxy still accepts editors.
func TestVoiceProfileGovernanceMountsAreAdminOnly(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	required := []string{
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/sources", voiceProxy.ServeHTTP)`,
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/sources/{id}/ingest", voiceProxy.ServeHTTP)`,
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/voice/sources/{id}", voiceProxy.ServeHTTP)`,
		`r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/profile/build", voiceProxy.ServeHTTP)`,
	}
	for _, mount := range required {
		if !strings.Contains(source, mount) {
			t.Errorf("voice-profile governance mount is not admin-only: %s", mount)
		}
	}

	forbidden := []string{
		`r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/sources", voiceProxy.ServeHTTP)`,
		`r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/sources/{id}/ingest", voiceProxy.ServeHTTP)`,
		`r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete("/api/v1/voice/sources/{id}", voiceProxy.ServeHTTP)`,
		`r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/profile/build", voiceProxy.ServeHTTP)`,
	}
	for _, mount := range forbidden {
		if strings.Contains(root.all, mount) {
			t.Errorf("editor-level voice-profile governance mount survived: %s", mount)
		}
	}
}
