package warehouse

import "testing"

func TestWarehousePublicProjectionsRemovePrivateOperationalDetail(t *testing.T) {
	connection := &Connection{
		ID: "connection", CredentialsRef: "vault://warehouse", LastCursor: "private-cursor",
		Error: "provider returned a raw error", Config: map[string]any{
			"account": "safe-account",
			"nested": map[string]any{
				"password": "raw-secret",
				"region":   "safe-region",
			},
			"provider_cleanup": map[string]any{"operator_notes": "private"},
		},
	}
	public := sanitizeConnection(connection)
	if public.CredentialsRef != "" || public.LastCursor != "" || public.Error != "" {
		t.Fatalf("private connection fields escaped: %+v", public)
	}
	if !public.CredentialRefPresent || !public.IssuePresent {
		t.Fatalf("safe presence flags missing: %+v", public)
	}
	nested, ok := public.Config["nested"].(map[string]any)
	if !ok || nested["region"] != "safe-region" {
		t.Fatalf("safe nested config was not retained: %+v", public.Config)
	}
	if _, exists := nested["password"]; exists {
		t.Fatalf("nested credential escaped: %+v", public.Config)
	}
	if _, exists := public.Config["provider_cleanup"]; exists {
		t.Fatalf("cleanup evidence escaped: %+v", public.Config)
	}

	run := sanitizeSyncRun(&SyncRun{
		InputURI: "private-input", OutputURI: "signed-output", CursorFrom: "private-from",
		CursorTo: "private-to", Metrics: map[string]any{"provider": "private"}, Error: "private failure",
	})
	if run.InputURI != "" || run.OutputURI != "" || run.CursorFrom != "" || run.CursorTo != "" || run.Metrics != nil || run.Error != "" {
		t.Fatalf("private run detail escaped: %+v", run)
	}
	if !run.IssuePresent {
		t.Fatal("run issue presence was not retained")
	}
}
