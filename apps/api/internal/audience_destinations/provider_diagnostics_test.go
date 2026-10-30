package audience_destinations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeProviderDiagnosticsAdapter struct {
	provider    string
	status      string
	err         error
	callCount   int
	gotCfg      map[string]any
	gotEvidence ProviderRunEvidence
}

func (a *fakeProviderDiagnosticsAdapter) Provider() string { return a.provider }

func (a *fakeProviderDiagnosticsAdapter) Readiness(map[string]any) PlatformAdapterStatus {
	return PlatformAdapterStatus{Provider: a.provider, Ready: true, Status: "configured"}
}

func (a *fakeProviderDiagnosticsAdapter) Sync(context.Context, map[string]any, []MemberRow) (PlatformSyncResult, error) {
	return PlatformSyncResult{Provider: a.provider}, nil
}

func (a *fakeProviderDiagnosticsAdapter) RetrieveDiagnostics(_ context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error) {
	a.callCount++
	a.gotCfg = cfg
	a.gotEvidence = evidence
	if a.err != nil {
		return PlatformDiagnosticsResult{}, a.err
	}
	return PlatformDiagnosticsResult{
		Provider:           a.provider,
		ExternalJobID:      evidence.ExternalJobID,
		ExternalAudienceID: evidence.ExternalAudienceID,
		ProviderMessage:    evidence.ProviderMessage,
		ProviderStatus:     a.status,
	}, nil
}

func TestInitialProviderDiagnosticsScheduleOnlyForPollableProviders(t *testing.T) {
	evidence := ProviderRunEvidence{ExternalJobID: "req-123", ExternalAudienceID: "aud-123"}
	status, next := initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderGoogleAds),
		Config:   map[string]any{"customer_match_transport": "data_manager"},
	})
	if status != "PENDING" || next == nil {
		t.Fatalf("google data manager schedule = %q/%v, want PENDING with next check", status, next)
	}

	status, next = initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderTikTok),
		Config:   map[string]any{"advertiser_id": "adv"},
	})
	if status != "PENDING" || next == nil {
		t.Fatalf("TikTok schedule = %q/%v, want PENDING with next check", status, next)
	}

	status, next = initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderLinkedIn),
		Config:   map[string]any{"segment_id": "seg"},
	})
	if status != "PENDING" || next == nil {
		t.Fatalf("LinkedIn schedule = %q/%v, want PENDING with next check", status, next)
	}

	status, next = initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderSnap),
		Config:   map[string]any{"segment_id": "seg"},
	})
	if status != "PENDING" || next == nil {
		t.Fatalf("Snap schedule = %q/%v, want PENDING with next check", status, next)
	}

	status, next = initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderTikTok),
		Config:   map[string]any{},
	})
	if status != "" || next != nil {
		t.Fatalf("TikTok schedule without advertiser_id = %q/%v, want empty", status, next)
	}

	status, next = initialProviderDiagnosticsSchedule(evidence, providerDiagnosticsScheduleContext{
		Provider: string(ProviderGoogleAds),
		Config:   map[string]any{"customer_match_transport": "offline_user_data_job"},
	})
	if status != "" || next != nil {
		t.Fatalf("legacy Google Ads schedule = %q/%v, want empty", status, next)
	}
}

func TestProviderDiagnosticsPollTargetHydratesAndBacksOff(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderGoogleAds), status: "PROCESSING"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderGoogleAds): adapter},
		CredentialResolver: SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
			json: map[string]map[string]string{"vault://ads/google": {"access_token": "live-token"}},
		}},
		Now: func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Kind:               providerDiagnosticsKindRun,
		TenantID:           "00000000-0000-4000-8000-000000000001",
		LedgerID:           "00000000-0000-4000-8000-000000000002",
		Provider:           string(ProviderGoogleAds),
		ExternalJobID:      "req-123",
		ExternalAudienceID: "999",
		ProviderMessage:    "accepted",
		Config: map[string]any{
			"credential_ref":           "vault://ads/google",
			"customer_match_transport": "data_manager",
			"user_list_id":             "999",
		},
	})
	if err != nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if adapter.callCount != 1 {
		t.Fatalf("adapter calls = %d, want 1", adapter.callCount)
	}
	if configString(adapter.gotCfg, "access_token") != "live-token" {
		t.Fatalf("credential ref was not hydrated: %+v", adapter.gotCfg)
	}
	if adapter.gotEvidence.ExternalJobID != "req-123" || adapter.gotEvidence.ExternalAudienceID != "999" {
		t.Fatalf("evidence = %+v", adapter.gotEvidence)
	}
	if update.ProviderStatus != "PROCESSING" || update.ProviderPollAttempts != 1 {
		t.Fatalf("update = %+v", update)
	}
	if update.ProviderNextCheckAt == nil || !update.ProviderNextCheckAt.Equal(fixed.Add(providerDiagnosticsPollInterval)) {
		t.Fatalf("next check = %v, want %v", update.ProviderNextCheckAt, fixed.Add(providerDiagnosticsPollInterval))
	}
}

func TestProviderDiagnosticsPollTargetStopsOnTerminalStatus(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderGoogleAds), status: "SUCCESS"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderGoogleAds): adapter},
		Now:      func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Provider:      string(ProviderGoogleAds),
		ExternalJobID: "req-123",
		Config: map[string]any{
			"customer_match_transport": "data_manager",
		},
		PollAttempts: 2,
	})
	if err != nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if update.ProviderStatus != "SUCCESS" || update.ProviderPollAttempts != 3 {
		t.Fatalf("update = %+v", update)
	}
	if update.ProviderNextCheckAt != nil {
		t.Fatalf("terminal status should stop polling, next=%v", update.ProviderNextCheckAt)
	}
}

func TestProviderDiagnosticsPollTargetSupportsTikTok(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderTikTok), status: "SUCCESS"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderTikTok): adapter},
		CredentialResolver: SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
			json: map[string]map[string]string{"vault://ads/tiktok": {"access_token": "live-token"}},
		}},
		Now: func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Kind:               providerDiagnosticsKindJob,
		TenantID:           "00000000-0000-4000-8000-000000000001",
		LedgerID:           "00000000-0000-4000-8000-000000000002",
		Provider:           string(ProviderTikTok),
		ExternalJobID:      "update-req",
		ExternalAudienceID: "aud",
		ProviderMessage:    "accepted",
		Config: map[string]any{
			"credential_ref": "vault://ads/tiktok",
			"advertiser_id":  "adv",
		},
	})
	if err != nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if adapter.callCount != 1 {
		t.Fatalf("adapter calls = %d, want 1", adapter.callCount)
	}
	if configString(adapter.gotCfg, "access_token") != "live-token" || configString(adapter.gotCfg, "audience_id") != "aud" {
		t.Fatalf("config was not hydrated/enriched: %+v", adapter.gotCfg)
	}
	if adapter.gotEvidence.ExternalJobID != "update-req" || adapter.gotEvidence.ExternalAudienceID != "aud" {
		t.Fatalf("evidence = %+v", adapter.gotEvidence)
	}
	if update.ProviderStatus != "SUCCESS" || update.ProviderPollAttempts != 1 || update.ProviderNextCheckAt != nil {
		t.Fatalf("update = %+v", update)
	}
}

func TestProviderDiagnosticsPollTargetSupportsLinkedIn(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderLinkedIn), status: "PROCESSING"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderLinkedIn): adapter},
		CredentialResolver: SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
			json: map[string]map[string]string{"vault://ads/linkedin": {"access_token": "live-token"}},
		}},
		Now: func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Kind:               providerDiagnosticsKindJob,
		TenantID:           "00000000-0000-4000-8000-000000000001",
		LedgerID:           "00000000-0000-4000-8000-000000000002",
		Provider:           string(ProviderLinkedIn),
		ExternalAudienceID: "seg",
		ProviderMessage:    "accepted",
		Config: map[string]any{
			"credential_ref": "vault://ads/linkedin",
		},
	})
	if err != nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if adapter.callCount != 1 {
		t.Fatalf("adapter calls = %d, want 1", adapter.callCount)
	}
	if configString(adapter.gotCfg, "access_token") != "live-token" || configString(adapter.gotCfg, "segment_id") != "seg" {
		t.Fatalf("config was not hydrated/enriched: %+v", adapter.gotCfg)
	}
	if update.ProviderStatus != "PROCESSING" || update.ProviderNextCheckAt == nil || !update.ProviderNextCheckAt.Equal(fixed.Add(providerDiagnosticsPollInterval)) {
		t.Fatalf("update = %+v", update)
	}
}

func TestProviderDiagnosticsPollTargetSupportsSnap(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderSnap), status: "PROCESSING"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderSnap): adapter},
		CredentialResolver: SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
			json: map[string]map[string]string{"vault://ads/snap": {"access_token": "live-token"}},
		}},
		Now: func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Kind:               providerDiagnosticsKindJob,
		TenantID:           "00000000-0000-4000-8000-000000000001",
		LedgerID:           "00000000-0000-4000-8000-000000000002",
		Provider:           string(ProviderSnap),
		ExternalJobID:      "snap-req",
		ExternalAudienceID: "seg",
		ProviderMessage:    "accepted",
		Config: map[string]any{
			"credential_ref": "vault://ads/snap",
		},
	})
	if err != nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if adapter.callCount != 1 {
		t.Fatalf("adapter calls = %d, want 1", adapter.callCount)
	}
	if configString(adapter.gotCfg, "access_token") != "live-token" || configString(adapter.gotCfg, "segment_id") != "seg" {
		t.Fatalf("config was not hydrated/enriched: %+v", adapter.gotCfg)
	}
	if update.ProviderStatus != "PROCESSING" || update.ProviderNextCheckAt == nil || !update.ProviderNextCheckAt.Equal(fixed.Add(providerDiagnosticsPollInterval)) {
		t.Fatalf("update = %+v", update)
	}
}

func TestProviderDiagnosticsPollTargetSkipsUnsupportedRows(t *testing.T) {
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderGoogleAds), status: "SUCCESS"}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderGoogleAds): adapter},
	}
	cases := []providerDiagnosticsTarget{
		{Provider: string(ProviderGoogleAds), Config: map[string]any{"customer_match_transport": "data_manager"}},
		{Provider: string(ProviderGoogleAds), ExternalJobID: "req-123", Config: map[string]any{"customer_match_transport": "offline_user_data_job"}},
		{Provider: string(ProviderTikTok), ExternalJobID: "req-123", Config: map[string]any{}},
		{Provider: string(ProviderLinkedIn), ExternalJobID: "req-123", Config: map[string]any{}},
		{Provider: string(ProviderSnap), ExternalJobID: "req-123", Config: map[string]any{}},
	}
	for _, target := range cases {
		if update, ok, err := poller.pollTarget(context.Background(), target); ok || err != nil || update.ProviderStatus != "" {
			t.Fatalf("target %+v should skip, got update=%+v ok=%v err=%v", target, update, ok, err)
		}
	}
	if adapter.callCount != 0 {
		t.Fatalf("adapter should not be called for skipped rows, got %d", adapter.callCount)
	}
}

func TestProviderDiagnosticsPollTargetRecordsPollFailure(t *testing.T) {
	fixed := time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC)
	adapter := &fakeProviderDiagnosticsAdapter{provider: string(ProviderGoogleAds), err: errors.New("provider unavailable")}
	poller := &ProviderDiagnosticsPoller{
		Adapters: AdapterRegistry{string(ProviderGoogleAds): adapter},
		Now:      func() time.Time { return fixed },
	}
	update, ok, err := poller.pollTarget(context.Background(), providerDiagnosticsTarget{
		Provider:      string(ProviderGoogleAds),
		ExternalJobID: "req-123",
		Config: map[string]any{
			"customer_match_transport": "data_manager",
		},
	})
	if err == nil || !ok {
		t.Fatalf("pollTarget ok=%v err=%v", ok, err)
	}
	if update.ProviderStatus != "POLL_FAILED" || update.ProviderNextCheckAt == nil {
		t.Fatalf("update = %+v", update)
	}
}
