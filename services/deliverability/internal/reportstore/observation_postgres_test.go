package reportstore

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

func TestPrepareObservationBuildsPrivacySafeExactComparisonReceipt(t *testing.T) {
	clock := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	rawBytes := []byte("Content-Type: text/plain\r\n\r\nhello\r\n")
	structureHash := strings.Repeat("1", 64)
	textHash := strings.Repeat("2", 64)
	htmlHash := strings.Repeat("3", 64)
	store := &PostgresStore{Now: func() time.Time { return clock }}
	identity := observationIdentity{
		TenantID: uuid.NewString(), TestID: uuid.NewString(), CampaignID: uuid.NewString(),
		ContentRevisionID: uuid.NewString(), SendPlanID: uuid.NewString(), ArtifactID: uuid.NewString(),
		ScenarioID: "base", OutboundMIMEHash: strings.Repeat("4", 64),
		OutboundStructureHash: structureHash, OutboundTextHash: textHash, OutboundHTMLHash: htmlHash,
	}
	prepared, err := store.prepareObservation(seedlist.MessageObservation{
		TestHeaderValue: "irt_0123456789abcdef0123456789abcdef",
		Provider:        domain.ProviderGmail, MailboxID: "gmail-seed-01", RegistryVersionID: uuid.NewString(),
		Folder: "INBOX", Labels: []string{"category_promotions", "private-customer-label"},
		Placement: domain.PlacementPromotions,
		Headers:   map[string]string{"Message-ID": "<recipient-specific@example.test>"},
		Capabilities: seedlist.ConnectorCapabilities{
			Headers: seedlist.CapabilityAvailable, RawMIME: seedlist.CapabilityAvailable,
			BodyParts: seedlist.CapabilityAvailable, Placement: seedlist.CapabilityAvailable,
			ObservedSurface: seedlist.CapabilityUnavailable,
		},
		HealthState: seedlist.StatusActive,
		CheckedAt:   clock.Add(-time.Second), ReceivedAt: clock.Add(-2 * time.Second),
		RawMIME: &categorizers.RawMIMEAcquisition{
			Status: categorizers.RawMIMEComplete, Source: "imap_body_peek",
			SHA256: digestBytes(rawBytes), CapturedBytes: int64(len(rawBytes)),
			ReportedBytes: int64(len(rawBytes)), MaxBytes: 1024, UID: 9, UIDValidity: 10,
			Raw: rawBytes,
			Manifest: categorizers.MIMEManifest{
				Status: categorizers.MIMEParseParsed, StructureSHA256: structureHash,
				TextBodySHA256: textHash, HTMLBodySHA256: strings.Repeat("f", 64),
			},
		},
	}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.structureComparison != "match" || prepared.textComparison != "match" || prepared.htmlComparison != "mismatch" {
		t.Fatalf("comparisons = %s/%s/%s", prepared.structureComparison, prepared.textComparison, prepared.htmlComparison)
	}
	var labels []string
	if err := json.Unmarshal(prepared.labelsJSON, &labels); err != nil {
		t.Fatal(err)
	}
	if len(labels) != 1 || labels[0] != "CATEGORY_PROMOTIONS" {
		t.Fatalf("labels = %#v", labels)
	}
	if prepared.messageIDHash == "<recipient-specific@example.test>" || prepared.messageIDHash == nil {
		t.Fatalf("message id was not irreversibly reduced: %#v", prepared.messageIDHash)
	}
	if prepared.registryVersionID == nil {
		t.Fatal("registry version provenance was dropped")
	}
	if prepared.rawObject == nil || string(prepared.rawObject.Raw) != string(rawBytes) ||
		prepared.rawObject.ExpiresAt.Sub(clock) != seedObservationRetention {
		t.Fatalf("raw object = %#v", prepared.rawObject)
	}
	if prepared.testTokenHash == "irt_0123456789abcdef0123456789abcdef" {
		t.Fatal("bearer-like test token leaked into prepared metadata")
	}
}

func TestPrepareObservationRejectsInvalidRegistryVersion(t *testing.T) {
	store := &PostgresStore{Now: time.Now}
	_, err := store.prepareObservation(seedlist.MessageObservation{
		TestHeaderValue: "tenant:campaign", Provider: domain.ProviderGmail,
		MailboxID: "gmail-seed-01", RegistryVersionID: "not-a-uuid", Folder: "INBOX",
		Placement: domain.PlacementPrimary,
	}, observationIdentity{})
	if err == nil || !strings.Contains(err.Error(), "invalid registry version") {
		t.Fatalf("error=%v", err)
	}
}

func TestPrepareObservationRejectsInconsistentRawAcquisition(t *testing.T) {
	store := &PostgresStore{Now: time.Now}
	identity := observationIdentity{TenantID: uuid.NewString(), CampaignID: uuid.NewString()}
	_, err := store.prepareObservation(seedlist.MessageObservation{
		TestHeaderValue: identity.TenantID + ":" + identity.CampaignID,
		Provider:        domain.ProviderGmail, MailboxID: "gmail-seed-01", Folder: "INBOX",
		Placement: domain.PlacementPrimary,
		RawMIME: &categorizers.RawMIMEAcquisition{
			Status: categorizers.RawMIMEComplete, Source: "imap_body_peek",
			SHA256: strings.Repeat("0", 64), CapturedBytes: 5, Raw: []byte("hello"),
		},
	}, identity)
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("err = %v", err)
	}
}

func TestOpaqueInboxRealityTokenRecognitionIsStrict(t *testing.T) {
	want := "0123456789abcdef0123456789abcdef"
	if got, ok := opaqueInboxRealityToken("irt_" + want); !ok || got != want {
		t.Fatalf("got %q/%v", got, ok)
	}
	for _, value := range []string{"irt_short", strings.Repeat("g", 32), uuid.NewString(), "campaign-1"} {
		if _, ok := opaqueInboxRealityToken(value); ok {
			t.Fatalf("accepted invalid token %q", value)
		}
	}
}
