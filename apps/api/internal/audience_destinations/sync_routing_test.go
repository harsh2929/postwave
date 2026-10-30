// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the un-stubbed audience_destinations sync path (SUB-113):
//   - SyncRunner.SyncDestinationRow routes to the correct PlatformAdapter
//     by provider, and
//   - applies the consent-safe activation firewall (suppressed /
//     non-consented members are withheld before any row leaves).
//
// These run hermetically: the adapter is a fake that records what it
// received, and the firewall is a real *activation_firewall.Filter wired
// to an in-memory consent lookup (no Postgres).
package audience_destinations

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
)

// recordingAdapter is a PlatformAdapter test double that captures the
// config + members handed to Sync and returns a canned result.
type recordingAdapter struct {
	provider   string
	gotCfg     map[string]any
	gotMembers []MemberRow
	returnErr  error
	returnSent int
	externalID string
	jobID      string
	callCount  int
}

func (a *recordingAdapter) Provider() string { return a.provider }

func (a *recordingAdapter) Readiness(map[string]any) PlatformAdapterStatus {
	return PlatformAdapterStatus{Provider: a.provider, Ready: true, Status: "configured"}
}

func (a *recordingAdapter) Sync(_ context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	a.callCount++
	a.gotCfg = cfg
	a.gotMembers = members
	if a.returnErr != nil {
		return PlatformSyncResult{Provider: a.provider}, a.returnErr
	}
	sent := a.returnSent
	if sent == 0 {
		sent = len(members)
	}
	return PlatformSyncResult{
		Provider:           a.provider,
		MembersSent:        sent,
		ExternalAudienceID: a.externalID,
		ExternalJobID:      a.jobID,
		Message:            "provider accepted delivery",
	}, nil
}

func TestPlatformAdapterBatchesSent(t *testing.T) {
	if got := platformAdapterBatchesSent(PlatformSyncResult{MembersSent: 10001, BatchesSent: 2}); got != 2 {
		t.Fatalf("reported batches = %d, want 2", got)
	}
	if got := platformAdapterBatchesSent(PlatformSyncResult{MembersSent: 2}); got != 1 {
		t.Fatalf("legacy adapter batches = %d, want 1", got)
	}
	if got := platformAdapterBatchesSent(PlatformSyncResult{}); got != 0 {
		t.Fatalf("empty adapter batches = %d, want 0", got)
	}
}

// fakeConsent is an in-memory ConsentBatchLookup: emails present in the
// allowed set are consented; everything else is withheld (fail-deny on
// absence, matching the firewall contract). A non-nil err forces the
// fail-deny lookup-error path.
type fakeConsent struct {
	allowed map[string]bool
	err     error
}

func (f fakeConsent) AllowedBatch(_ context.Context, _ string, emails []string, _ string) (map[string]bool, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]bool{}
	for _, e := range emails {
		if f.allowed[strings.ToLower(strings.TrimSpace(e))] {
			out[strings.ToLower(strings.TrimSpace(e))] = true
		}
	}
	return out, nil
}

// TestSyncDestinationRowRoutesByProvider verifies the registry routes each
// provider's destination to its own adapter (and no other).
func TestSyncDestinationRowRoutesByProvider(t *testing.T) {
	for _, provider := range []string{
		string(ProviderMeta), string(ProviderGoogleAds), string(ProviderTikTok),
		string(ProviderLinkedIn), string(ProviderSnap),
	} {
		target := &recordingAdapter{provider: provider, externalID: "ext-" + provider, jobID: "job-" + provider}
		other := &recordingAdapter{provider: "other"}
		reg := AdapterRegistry{provider: target, "other": other}
		sr := &SyncRunner{Adapters: reg} // no firewall → all members pass

		members := []MemberRow{{Email: "a@example.com"}, {Email: "b@example.com"}}
		cfg := map[string]any{"audience_id": "aud-1"}
		out, err := sr.SyncDestinationRow(context.Background(), "t1",
			&Destination{ID: "00000000-0000-4000-8000-000000000001", Provider: Provider(provider)},
			members, cfg)
		if err != nil {
			t.Fatalf("%s: SyncDestinationRow: %v", provider, err)
		}
		if target.callCount != 1 {
			t.Errorf("%s: target adapter call count = %d, want 1", provider, target.callCount)
		}
		if other.callCount != 0 {
			t.Errorf("%s: wrong adapter invoked", provider)
		}
		if out.MembersSent != 2 {
			t.Errorf("%s: members sent = %d, want 2", provider, out.MembersSent)
		}
		if out.ExternalAudienceID != "ext-"+provider {
			t.Errorf("%s: external id = %q", provider, out.ExternalAudienceID)
		}
		if out.ExternalJobID != "job-"+provider || out.Message != "provider accepted delivery" {
			t.Errorf("%s: provider evidence = job %q message %q", provider, out.ExternalJobID, out.Message)
		}
		// gap #4: the destination Config must reach the adapter.
		if target.gotCfg["audience_id"] != "aud-1" {
			t.Errorf("%s: adapter did not receive config: %v", provider, target.gotCfg)
		}
	}
}

func TestSyncDestinationRowHydratesCredentialRef(t *testing.T) {
	target := &recordingAdapter{provider: string(ProviderMeta)}
	sr := &SyncRunner{
		Adapters: AdapterRegistry{string(ProviderMeta): target},
		CredentialResolver: SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
			json: map[string]map[string]string{"vault://ads/meta": {"access_token": "tok_live"}},
		}},
	}
	cfg := map[string]any{"credential_ref": "vault://ads/meta", "audience_id": "aud"}
	_, err := sr.SyncDestinationRow(context.Background(), "t1",
		&Destination{ID: "00000000-0000-4000-8000-000000000001", Provider: ProviderMeta},
		[]MemberRow{{Email: "a@example.com"}}, cfg)
	if err != nil {
		t.Fatalf("SyncDestinationRow: %v", err)
	}
	if target.gotCfg["access_token"] != "tok_live" {
		t.Fatalf("adapter did not receive resolved access token: %v", target.gotCfg)
	}
	if _, ok := cfg["access_token"]; ok {
		t.Fatalf("stored/raw config was mutated with resolved secret: %v", cfg)
	}
	if target.gotCfg["credential_ref"] != "vault://ads/meta" {
		t.Fatalf("credential ref lost during hydration: %v", target.gotCfg)
	}
}

// TestSyncDestinationRowNoAdapter fails clearly when the provider has no
// registered adapter (instead of silently doing nothing).
func TestSyncDestinationRowNoAdapter(t *testing.T) {
	sr := &SyncRunner{Adapters: AdapterRegistry{}}
	_, err := sr.SyncDestinationRow(context.Background(), "t1",
		&Destination{ID: "00000000-0000-4000-8000-000000000002", Provider: ProviderMeta},
		[]MemberRow{{Email: "a@example.com"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "no registered adapter") {
		t.Fatalf("want no-adapter error, got %v", err)
	}
}

// TestSyncDestinationRowConsentExclusion pins the consent-aware exclusion:
// only consented members reach the adapter; the rest are excluded and
// counted.
func TestSyncDestinationRowConsentExclusion(t *testing.T) {
	target := &recordingAdapter{provider: string(ProviderMeta)}
	// Real firewall, in-memory consent: only a@ and c@ have granted the
	// targeted_ads purpose (the purpose meta destinations map to). No
	// suppression dependency (defence-in-depth, optional).
	filter := activation_firewall.New(fakeConsent{allowed: map[string]bool{
		"a@example.com": true,
		"c@example.com": true,
	}}, nil)
	sr := &SyncRunner{
		Adapters: AdapterRegistry{string(ProviderMeta): target},
		Firewall: filter,
	}

	members := []MemberRow{
		{Email: "a@example.com"}, // consented → kept
		{Email: "b@example.com"}, // not consented → excluded
		{Email: "c@example.com"}, // consented → kept
		{Email: "d@example.com"}, // not consented → excluded
	}
	out, err := sr.SyncDestinationRow(context.Background(), "t1",
		&Destination{ID: "00000000-0000-4000-8000-000000000003", Provider: ProviderMeta},
		members, map[string]any{"audience_id": "aud"})
	if err != nil {
		t.Fatalf("SyncDestinationRow: %v", err)
	}
	if out.TotalMembers != 4 {
		t.Errorf("total = %d, want 4", out.TotalMembers)
	}
	if out.ExcludedCount != 2 {
		t.Errorf("excluded = %d, want 2", out.ExcludedCount)
	}
	if out.MembersSent != 2 {
		t.Errorf("members sent = %d, want 2", out.MembersSent)
	}
	// Only the two consented members must have reached the adapter.
	if len(target.gotMembers) != 2 {
		t.Fatalf("adapter received %d members, want 2", len(target.gotMembers))
	}
	got := map[string]bool{}
	for _, m := range target.gotMembers {
		got[m.Email] = true
	}
	if !got["a@example.com"] || !got["c@example.com"] {
		t.Errorf("kept members wrong: %v", target.gotMembers)
	}
	if got["b@example.com"] || got["d@example.com"] {
		t.Errorf("non-consented member leaked to adapter: %v", target.gotMembers)
	}
}

// TestSyncDestinationRowConsentFailDeny pins the fail-deny posture: a
// consent lookup error withholds EVERY member (nothing leaks), and the
// adapter still runs with zero members.
func TestSyncDestinationRowConsentFailDeny(t *testing.T) {
	target := &recordingAdapter{provider: string(ProviderGoogleAds)}
	filter := activation_firewall.New(fakeConsent{err: context.DeadlineExceeded}, nil)
	sr := &SyncRunner{
		Adapters: AdapterRegistry{string(ProviderGoogleAds): target},
		Firewall: filter,
	}
	members := []MemberRow{{Email: "a@example.com"}, {Email: "b@example.com"}}
	out, err := sr.SyncDestinationRow(context.Background(), "t1",
		&Destination{ID: "00000000-0000-4000-8000-000000000004", Provider: ProviderGoogleAds},
		members, nil)
	if err != nil {
		t.Fatalf("SyncDestinationRow: %v", err)
	}
	if out.ExcludedCount != 2 {
		t.Errorf("excluded = %d, want 2 (fail-deny)", out.ExcludedCount)
	}
	if len(target.gotMembers) != 0 {
		t.Errorf("fail-deny leaked %d members to adapter", len(target.gotMembers))
	}
}

// TestSyncDestinationRowSurfacesAdapterError pins that an adapter delivery
// error propagates (so the caller records a failed job).
func TestSyncDestinationRowSurfacesAdapterError(t *testing.T) {
	target := &recordingAdapter{provider: string(ProviderTikTok), returnErr: ErrAdapterNotConfigured}
	sr := &SyncRunner{Adapters: AdapterRegistry{string(ProviderTikTok): target}}
	_, err := sr.SyncDestinationRow(context.Background(), "t1",
		&Destination{ID: "00000000-0000-4000-8000-000000000005", Provider: ProviderTikTok},
		[]MemberRow{{Email: "a@example.com"}}, nil)
	if err == nil {
		t.Fatal("want adapter error to propagate, got nil")
	}
}

// TestSyncAdapterConfigUsesUnmaskedConfig pins that the audience_syncs runner
// path (execute) hands the unmasked credential-reference config to the adapter,
// not the masked wire Config.
func TestSyncAdapterConfigUsesRawConfig(t *testing.T) {
	s := &Sync{
		Destination: SyncDestination{
			Type:   DestinationTypeMeta,
			Config: map[string]any{"credentials_ref": "••••"}, // masked wire copy
		},
		rawConfig: map[string]any{"credentials_ref": "vault://ads/meta", "audience_id": "9"},
	}
	cfg := s.AdapterConfig()
	if cfg["credentials_ref"] != "vault://ads/meta" {
		t.Errorf("AdapterConfig returned masked config: %v", cfg)
	}
	// Falls back to wire Config when rawConfig is unset (in-memory Sync).
	s2 := &Sync{Destination: SyncDestination{Config: map[string]any{"audience_id": "x"}}}
	if s2.AdapterConfig()["audience_id"] != "x" {
		t.Errorf("AdapterConfig fallback wrong: %v", s2.AdapterConfig())
	}
}

func TestDestinationAdapterConfigUsesRawConfig(t *testing.T) {
	d := &Destination{
		Config:    jsonRaw(`{"credential_ref":"••••","audience_id":"masked"}`),
		rawConfig: map[string]any{"credential_ref": "vault://ads/meta", "audience_id": "raw"},
	}
	cfg := d.AdapterConfig()
	if cfg["credential_ref"] != "vault://ads/meta" || cfg["audience_id"] != "raw" {
		t.Fatalf("Destination.AdapterConfig returned masked config: %v", cfg)
	}
	fallback := (&Destination{Config: jsonRaw(`{"audience_id":"public"}`)}).AdapterConfig()
	if fallback["audience_id"] != "public" {
		t.Fatalf("Destination.AdapterConfig fallback wrong: %v", fallback)
	}
}

func jsonRaw(text string) []byte {
	return []byte(text)
}

// TestMaskDestinationConfig pins that credential-bearing keys are masked
// for the read API while plain ids pass through.
func TestMaskDestinationConfig(t *testing.T) {
	masked := maskDestinationConfig(map[string]any{
		"access_token":        "super-secret",
		"access_token_ref":    "vault://ads/meta",
		"api_secret":          "api-secret",
		"developer_token_ref": "vault://ads/google-dev",
		"password":            "pw",
		"private_key":         "key",
		"refresh_token":       "rt",
		"token":               "tok",
		"audience_id":         "123",
		"account_id":          "acc",
	})
	if masked["access_token"] != "••••" || masked["access_token_ref"] != "••••" ||
		masked["api_secret"] != "••••" || masked["developer_token_ref"] != "••••" ||
		masked["password"] != "••••" || masked["private_key"] != "••••" ||
		masked["refresh_token"] != "••••" || masked["token"] != "••••" {
		t.Errorf("secrets not masked: %v", masked)
	}
	if masked["audience_id"] != "123" || masked["account_id"] != "acc" {
		t.Errorf("non-secret ids altered: %v", masked)
	}
}

func TestEnrichAudienceDestinationConfigUsesExternalAudienceID(t *testing.T) {
	cases := []struct {
		provider string
		key      string
	}{
		{string(ProviderMeta), "audience_id"},
		{string(ProviderTikTok), "audience_id"},
		{string(ProviderGoogleAds), "user_list_id"},
		{string(ProviderLinkedIn), "segment_id"},
		{string(ProviderSnap), "segment_id"},
	}
	for _, tc := range cases {
		got := enrichAudienceDestinationConfig(tc.provider, map[string]any{}, "external-123")
		if got[tc.key] != "external-123" {
			t.Fatalf("%s enriched %s = %#v", tc.provider, tc.key, got)
		}
		got = enrichAudienceDestinationConfig(tc.provider, map[string]any{tc.key: "explicit"}, "external-123")
		if got[tc.key] != "explicit" {
			t.Fatalf("%s overwrote explicit %s: %#v", tc.provider, tc.key, got)
		}
	}
}
