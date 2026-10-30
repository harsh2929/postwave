// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
)

func TestNormalizeDeliveryAttemptCanonicalizesUUIDAndJSONIdentity(t *testing.T) {
	t.Parallel()
	input := validDeliveryRequest().Attempt
	input.TransportName = "ses_raw_v2"
	input.TransportContract = campaigntransport.ContractVersion
	input.CapabilitySnapshot = json.RawMessage(`{"raw_mime":true,"contract_version":"postwave.campaign-transport.v2"}`)
	first, firstHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		t.Fatal(err)
	}
	secondInput := input
	secondInput.TenantID = "{" + input.TenantID + "}"
	secondInput.CapabilitySnapshot = json.RawMessage(`{
        "contract_version":"postwave.campaign-transport.v2", "raw_mime":true
    }`)
	second, secondHash, err := normalizeDeliveryAttempt(secondInput)
	if err != nil {
		t.Fatal(err)
	}
	if firstHash != secondHash || first.TenantID != second.TenantID {
		t.Fatalf("canonical identities differ: %s/%s %s/%s", firstHash, secondHash, first.TenantID, second.TenantID)
	}
}

func TestNormalizeReceiptIdentityCanonicalizesDurableReceipt(t *testing.T) {
	t.Parallel()
	receipt, err := normalizeReceiptIdentity(campaigntransport.Receipt{
		ContractVersion: "  " + campaigntransport.ContractVersion + "  ",
		ArtifactID:      "{" + strings.ToUpper(deliveryArtifactID) + "}",
		ScenarioID:      "  scenario-a  ",
		CampaignID:      strings.ToUpper(deliveryCampaignID),
		IdempotencyKey:  "  recipient-103-plan-104  ",
		IdempotencyMode: "  " + campaigntransport.LedgerIdempotencyMode + "  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ArtifactID != deliveryArtifactID || receipt.CampaignID != deliveryCampaignID ||
		receipt.ScenarioID != "scenario-a" || receipt.IdempotencyKey != "recipient-103-plan-104" ||
		receipt.ContractVersion != campaigntransport.ContractVersion {
		t.Fatalf("non-canonical receipt: %+v", receipt)
	}
}

func TestNormalizeDeliveryAttemptChangesHashForMaterialIdentity(t *testing.T) {
	t.Parallel()
	input := validDeliveryRequest().Attempt
	input.TransportName = "ses_raw_v2"
	input.TransportContract = campaigntransport.ContractVersion
	input.CapabilitySnapshot = json.RawMessage(`{"raw_mime":true}`)
	_, firstHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		t.Fatal(err)
	}
	input.MessageID = "<different@example.test>"
	_, secondHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		t.Fatal(err)
	}
	if firstHash == secondHash {
		t.Fatal("message identity change did not change request hash")
	}
}

func TestRepoRejectsInvalidLeaseBeforeDatabase(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := &Repo{}
	_, err := repo.Acquire(ctx, AttemptInput{}, "worker", time.Minute)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("nil pool error = %v", err)
	}
	repo = &Repo{Pool: nil}
	_, err = repo.Acquire(ctx, AttemptInput{}, strings.Repeat("x", 201), time.Minute)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid lease error = %v", err)
	}
}
