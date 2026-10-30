// SPDX-License-Identifier: AGPL-3.0-only

package inboxcapabilities

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestEmbeddedRegistryIsEvidenceQualifiedAndComplete(t *testing.T) {
	loaded, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("load embedded registry: %v", err)
	}
	if len(loaded.SHA256) != 64 {
		t.Fatalf("registry digest = %q", loaded.SHA256)
	}
	if loaded.Registry.LaunchDecision.Status != SelectionNotSelected || loaded.Registry.LaunchDecision.SelectedVendorID != "" {
		t.Fatalf("launch vendor must remain explicitly unselected: %+v", loaded.Registry.LaunchDecision)
	}

	providers := map[string]bool{}
	clients := map[string]bool{}
	for _, profile := range loaded.Registry.Profiles {
		providers[profile.Key.MailboxProvider] = true
		clients[profile.Key.ClientApp] = true
		if len(profile.Capabilities) != len(RequiredCapabilityIDs()) {
			t.Fatalf("profile %s capability count = %d", profile.ID, len(profile.Capabilities))
		}
		imap, ok := profile.Capability(CapabilitySummaryViaStandardIMAP)
		if !ok || imap.State != StateUnavailable || imap.EvidenceClass != EvidenceProtocolBoundary {
			t.Fatalf("profile %s overclaims IMAP summary access: %+v", profile.ID, imap)
		}
		markup, ok := profile.Capability(CapabilityStructuredMarkupSummary)
		if !ok || markup.State != StateUnknown {
			t.Fatalf("profile %s overclaims structured-markup summary effect: %+v", profile.ID, markup)
		}
		capture, ok := profile.Capability(CapabilityControlledSummaryCapture)
		if !ok || capture.State != StateUnavailable || capture.EvidenceClass == EvidenceControlledObservation {
			t.Fatalf("profile %s claims an uncertified controlled capture: %+v", profile.ID, capture)
		}
	}
	for _, provider := range []string{"gmail", "icloud_mail", "microsoft_365", "yahoo"} {
		if !providers[provider] {
			t.Errorf("provider %q missing", provider)
		}
	}
	for _, client := range []string{"gmail", "apple_mail", "outlook_web", "yahoo_mail_web"} {
		if !clients[client] {
			t.Errorf("client %q missing", client)
		}
	}
}

func TestProviderAndReadingClientAreIndependentExactKeyDimensions(t *testing.T) {
	loaded, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	profile, ok := loaded.Registry.ProfileByID("gmail-apple-mail-ios-inbox-list-summary")
	if !ok {
		t.Fatal("cross-provider/client profile missing")
	}
	if profile.Key.MailboxProvider != "gmail" || profile.Key.ClientApp != "apple_mail" {
		t.Fatalf("provider/client collapsed: %+v", profile.Key)
	}
	found, ok := loaded.Registry.FindExact(profile.Key)
	if !ok || found.ID != profile.ID {
		t.Fatalf("exact lookup failed: %+v, %v", found, ok)
	}

	profile.Key.Settings[0].Name = "mutated"
	again, _ := loaded.Registry.ProfileByID("gmail-apple-mail-ios-inbox-list-summary")
	if again.Key.Settings[0].Name == "mutated" {
		t.Fatal("profile lookup leaked mutable registry storage")
	}
	receipt, err := loaded.ReceiptForProfile(profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.RegistrySHA256 != loaded.SHA256 || receipt.ProfileID != profile.ID || len(receipt.ProfileSHA256) != 64 {
		t.Fatalf("invalid profile receipt: %+v", receipt)
	}
	repeat, err := loaded.ReceiptForProfile(profile.ID)
	if err != nil || repeat != receipt {
		t.Fatalf("profile receipt is not deterministic: %+v / %+v / %v", receipt, repeat, err)
	}
	tampered := loaded
	tampered.Registry.Profiles = append([]Profile(nil), loaded.Registry.Profiles...)
	tampered.Registry.Profiles[0].Revision++
	if _, err := tampered.ReceiptForProfile(tampered.Registry.Profiles[0].ID); err == nil {
		t.Fatal("tampered registry accepted its stale receipt hash")
	}
}

func TestKnownSurfaceClaimsRemainNarrow(t *testing.T) {
	loaded, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	wants := map[string]State{
		"gmail-gmail-android-opened-message-summary-card":  StateAvailable,
		"icloud-apple-mail-ios-inbox-list-summary":         StateAvailable,
		"microsoft365-outlook-web-selected-thread-summary": StateAvailable,
		"yahoo-yahoo-mail-web-summary-surface-unknown":     StateUnknown,
	}
	for id, want := range wants {
		profile, ok := loaded.Registry.ProfileByID(id)
		if !ok {
			t.Fatalf("profile %q missing", id)
		}
		statement, _ := profile.Capability(CapabilityDocumentedSummarySurface)
		if statement.State != want || (want == StateAvailable && statement.EvidenceClass != EvidencePublishedDocumentation) {
			t.Errorf("profile %s summary statement = %+v, want state %s", id, statement, want)
		}
	}
	gmail, _ := loaded.Registry.ProfileByID("gmail-gmail-android-opened-message-summary-card")
	api, _ := gmail.Capability(CapabilitySummaryViaGmailAPI)
	if api.State != StateUnavailable || !strings.Contains(api.Note, "does not expose") {
		t.Fatalf("Gmail API boundary is not explicit: %+v", api)
	}
}

func TestDecodeIsBoundedStrictAndRejectsTrailingJSON(t *testing.T) {
	raw, err := embeddedRegistry.ReadFile("registry.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	withUnknown := bytes.Replace(raw, []byte(`"schema_version":`), []byte(`"unexpected":true,"schema_version":`), 1)
	if _, err := Decode(bytes.NewReader(withUnknown)); err == nil {
		t.Fatal("unknown JSON field accepted")
	}
	if _, err := Decode(bytes.NewReader(append(append([]byte(nil), raw...), []byte(` {}`)...))); err == nil {
		t.Fatal("trailing JSON value accepted")
	}
	if _, err := Decode(bytes.NewReader(make([]byte, MaxRegistryBytes+1))); !errors.Is(err, ErrRegistryTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
}

func TestEvidenceModesCannotMasqueradeAsControlledObservation(t *testing.T) {
	sources := map[string]Source{
		"decision": {ID: "decision"},
	}
	base := Statement{
		Capability:    CapabilityControlledSummaryCapture,
		State:         StateAvailable,
		EvidenceClass: EvidenceControlledObservation,
		AssessedAt:    "2026-08-09T12:00:00Z",
		Note:          "Synthetic controlled observation for schema validation only.",
	}
	if err := validateStatement(base, sources); err == nil {
		t.Fatal("controlled observation without capture receipt accepted")
	}
	base.ObservedAt = "2026-08-09T11:59:00Z"
	base.CaptureMethod = "synthetic_harness.v1"
	base.EvidenceObjectSHA256 = strings.Repeat("a", 64)
	if err := validateStatement(base, sources); err != nil {
		t.Fatalf("complete controlled observation rejected: %v", err)
	}

	predicted := base
	predicted.Capability = CapabilityDocumentedSummarySurface
	predicted.State = StateUnknown
	predicted.EvidenceClass = EvidenceModeledPrediction
	predicted.ObservedAt = ""
	predicted.CaptureMethod = ""
	predicted.EvidenceObjectSHA256 = ""
	predicted.ModelReceipt = &ModelReceipt{
		ModelSnapshot: "synthetic-model.v1",
		PromptVersion: "synthetic-prompt.v1",
		ConfigSHA256:  strings.Repeat("b", 64),
	}
	if err := validateStatement(predicted, sources); err != nil {
		t.Fatalf("versioned prediction rejected: %v", err)
	}
	predicted.ObservedAt = "2026-08-09T11:59:00Z"
	if err := validateStatement(predicted, sources); err == nil {
		t.Fatal("modeled prediction accepted controlled-observation fields")
	}

	gap := Statement{
		Capability:    CapabilityRawMIME,
		State:         StateUnavailable,
		EvidenceClass: EvidenceResearchGap,
		AssessedAt:    "2026-08-09T12:00:00Z",
		Note:          "Not assessed.",
	}
	if err := validateStatement(gap, sources); err == nil {
		t.Fatal("research gap accepted a definitive unavailable state")
	}
}

func FuzzDecodeRegistry(f *testing.F) {
	raw, err := embeddedRegistry.ReadFile("registry.v1.json")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(raw)
	f.Add([]byte(`{"schema_version":"bad"}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = Decode(bytes.NewReader(input))
	})
}
