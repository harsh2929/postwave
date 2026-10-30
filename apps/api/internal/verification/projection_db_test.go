// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the import-preflight projection.

package verification

import (
	"context"
	"testing"
)

func projectionStore(t *testing.T, hasMX bool) (*Store, string) {
	t.Helper()
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		if !hasMX {
			return false, "", nil
		}
		return true, "mx.example.com", nil
	}}
	return s, tenant
}

func TestDBProjectImportNeverSpendsCredits(t *testing.T) {
	// A dry run that costs money is not a dry run. Even with a paid
	// provider configured and mode=full, the projection must only
	// ESTIMATE the vendor cost, never incur it.
	s, tenant := projectionStore(t, true)
	ctx := context.Background()
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "zb-primary"): "key",
	}}
	s.Secrets = secrets
	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	if _, err := s.SetPolicy(ctx, tenant, Policy{ImportMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	p, err := s.ProjectImport(ctx, tenant, []string{"a@example.com", "b@example.com"})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.CreditsSpent != 0 {
		t.Fatalf("CreditsSpent = %d; a projection must never bill", p.CreditsSpent)
	}
	if len(secrets.asked) != 0 {
		t.Fatalf("resolved a vendor credential during a projection: %v", secrets.asked)
	}
	if p.WouldCostCredits != 2 {
		t.Fatalf("WouldCostCredits = %d, want 2 (both need a mailbox probe)", p.WouldCostCredits)
	}
}

func TestDBProjectImportCountsLocallyDecidedRowsAsFree(t *testing.T) {
	s, tenant := projectionStore(t, true)

	p, err := s.ProjectImport(context.Background(), tenant, []string{
		"junk@mailinator.com", // static corpus signal -> advisory, needs probe
		"nope@bad",            // syntax      -> free reject
		"sales@example.com",   // role        -> advisory, still needs mailbox probe
		"real@example.com",    // needs probe -> would cost
	})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.Total != 4 {
		t.Fatalf("Total = %d", p.Total)
	}
	if p.LocallyDecided != 1 {
		t.Fatalf("LocallyDecided = %d, want 1", p.LocallyDecided)
	}
	if p.NeedsMailboxProbe != 3 {
		t.Fatalf("NeedsMailboxProbe = %d, want 3", p.NeedsMailboxProbe)
	}
	if p.ByStatus[string(StatusDoNotMail)] != 0 || p.ByStatus[string(StatusUnknown)] != 3 {
		t.Fatalf("ByStatus = %v", p.ByStatus)
	}
}

func TestDBProjectImportDeduplicatesBeforeCosting(t *testing.T) {
	s, tenant := projectionStore(t, true)

	p, err := s.ProjectImport(context.Background(), tenant, []string{
		"dup@example.com", "DUP@Example.com", "other@example.com",
	})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.Total != 2 {
		t.Fatalf("Total = %d, want 2 after case-insensitive dedup", p.Total)
	}
	if p.Duplicates != 1 {
		t.Fatalf("Duplicates = %d, want 1", p.Duplicates)
	}
	if p.NeedsMailboxProbe != 2 {
		t.Fatalf("NeedsMailboxProbe = %d, want 2", p.NeedsMailboxProbe)
	}
}

func TestDBProjectImportCountsCachedVerdictsAsFree(t *testing.T) {
	// Re-importing a list already verified this month should be
	// projected as costing nothing.
	s, tenant := projectionStore(t, true)
	ctx := context.Background()
	cache := &TenantCache{Store: s, TenantID: tenant, TTL: DefaultCacheTTL}
	if err := cache.Put(ctx, []Result{
		{Email: "known@example.com", Status: StatusValid, Provider: ProviderZeroBounce},
	}); err != nil {
		t.Fatalf("cache Put: %v", err)
	}

	p, err := s.ProjectImport(ctx, tenant, []string{"known@example.com", "fresh@example.com"})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.CacheHits != 1 {
		t.Fatalf("CacheHits = %d, want 1", p.CacheHits)
	}
	if p.NeedsMailboxProbe != 1 {
		t.Fatalf("NeedsMailboxProbe = %d, want 1 (the cached one is free)", p.NeedsMailboxProbe)
	}
}

func TestDBProjectImportSurfacesRecoverableTypos(t *testing.T) {
	// The single most actionable thing a preflight can tell an
	// operator: these rows are salvageable before you import them.
	s, tenant := projectionStore(t, false)

	p, err := s.ProjectImport(context.Background(), tenant, []string{"someone@gmial.com"})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if len(p.Suggestions) != 1 {
		t.Fatalf("Suggestions = %v", p.Suggestions)
	}
	if p.Suggestions[0].DidYouMean != "someone@gmail.com" {
		t.Fatalf("suggestion = %+v", p.Suggestions[0])
	}
}

func TestDBProjectImportCapsSuggestionList(t *testing.T) {
	// A 250k-row import of garbage must not produce a 250k-entry
	// payload embedded in the dry-run JSON.
	s, tenant := projectionStore(t, false)
	in := make([]string, 0, maxProjectionSuggestions+25)
	for i := 0; i < maxProjectionSuggestions+25; i++ {
		in = append(in, "user"+string(rune('a'+i%26))+string(rune('a'+i/26))+"@gmial.com")
	}

	p, err := s.ProjectImport(context.Background(), tenant, in)
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if len(p.Suggestions) > maxProjectionSuggestions {
		t.Fatalf("Suggestions = %d, exceeds cap %d", len(p.Suggestions), maxProjectionSuggestions)
	}
	if !p.SuggestionsCapped {
		t.Fatal("SuggestionsCapped = false; silent truncation reads as 'that was all of them'")
	}
}

func TestDBProjectImportReportsTheModeItWouldRunUnder(t *testing.T) {
	s, tenant := projectionStore(t, true)
	ctx := context.Background()
	if _, err := s.SetPolicy(ctx, tenant, Policy{ImportMode: ModeLocal}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}

	p, err := s.ProjectImport(ctx, tenant, []string{"a@example.com"})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.Mode != ModeLocal {
		t.Fatalf("Mode = %q", p.Mode)
	}
	// In local mode the paid tier will never run, so the projected cost
	// must be zero rather than a hypothetical.
	if p.WouldCostCredits != 0 {
		t.Fatalf("WouldCostCredits = %d; local mode never reaches a vendor", p.WouldCostCredits)
	}
}

func TestDBProjectImportOnEmptyInputIsHarmless(t *testing.T) {
	s, tenant := projectionStore(t, true)
	p, err := s.ProjectImport(context.Background(), tenant, nil)
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.Total != 0 || p.WouldCostCredits != 0 {
		t.Fatalf("projection = %+v", p)
	}
}

func TestDBProjectImportSeparatesHypotheticalCostFromCurrentModeSpend(t *testing.T) {
	// An operator deciding whether to ENABLE full mode needs the
	// hypothetical; a UI showing the current bill needs the actual.
	// Conflating them would either hide the value or invent a charge.
	s, tenant := projectionStore(t, true)
	ctx := context.Background()

	p, err := s.ProjectImport(ctx, tenant, []string{"a@example.com", "b@example.com"})
	if err != nil {
		t.Fatalf("ProjectImport: %v", err)
	}
	if p.Mode != ModeOff {
		t.Fatalf("Mode = %q, want off", p.Mode)
	}
	if p.NeedsMailboxProbe != 2 {
		t.Fatalf("NeedsMailboxProbe = %d, want 2 (the hypothetical)", p.NeedsMailboxProbe)
	}
	if p.WouldCostCredits != 0 {
		t.Fatalf("WouldCostCredits = %d, want 0 (mode is off)", p.WouldCostCredits)
	}
}
