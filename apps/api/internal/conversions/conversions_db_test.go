// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed integrity tests for raw conversion ingestion and keyset
// pagination. They reuse the throwaway-tenant fixtures in
// attribution_db_test.go and skip when DATABASE_URL is unavailable.
package conversions

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestInsertRejectsInvalidStaleAndForeignCampaignHintsWithoutLosingFact(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	foreignTenantID := createAttributionTenant(t, pool, ctx)
	foreignCampaignID := createAttributionCampaign(t, pool, ctx, foreignTenantID, "Foreign")
	staleCampaignID := randUUID(t)

	repo := &Repo{Pool: pool}
	for index, hint := range []string{
		"not-a-uuid",
		staleCampaignID,
		foreignCampaignID,
	} {
		conversion, err := repo.Insert(ctx, tenantID, IngestInput{
			EventName:  fmt.Sprintf("campaign_hint_%d", index),
			CampaignID: hint,
		})
		if err != nil {
			t.Fatalf("Insert(campaign hint %q): %v", hint, err)
		}
		if conversion.CampaignID != "" {
			t.Errorf("Insert(campaign hint %q) campaign_id = %q, want unattributed", hint, conversion.CampaignID)
		}
		if conversion.AttributedVia != AttributedViaNone {
			t.Errorf(
				"Insert(campaign hint %q) attributed_via = %q, want %q",
				hint,
				conversion.AttributedVia,
				AttributedViaNone,
			)
		}
	}
}

func TestInsertPersistsNormalizedNegativeAdjustment(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	adjustment := int64(-2500)
	conversion, err := (&Repo{Pool: pool}).Insert(ctx, tenantID, IngestInput{
		EventName:   "  refund.processed  ",
		Email:       "  Buyer+Refund@example.com  ",
		AmountCents: &adjustment,
		Currency:    " usd ",
		Properties:  map[string]interface{}{"reason": "return"},
	})
	if err != nil {
		t.Fatalf("Insert(negative adjustment): %v", err)
	}
	if conversion.EventName != "refund.processed" {
		t.Errorf("event_name = %q, want refund.processed", conversion.EventName)
	}
	if conversion.SubscriberEmail != "buyer+refund@example.com" {
		t.Errorf("subscriber_email = %q, want normalized lowercase address", conversion.SubscriberEmail)
	}
	if conversion.AmountCents == nil || *conversion.AmountCents != adjustment {
		t.Errorf("amount_cents = %v, want %d", conversion.AmountCents, adjustment)
	}
	if conversion.Currency != "USD" {
		t.Errorf("currency = %q, want USD", conversion.Currency)
	}
	if conversion.Properties["reason"] != "return" {
		t.Errorf("properties = %#v, want reason=return", conversion.Properties)
	}
}

func TestListCompositeCursorDoesNotSkipOrDuplicateEqualTimestamps(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	occurredAt := time.Now().UTC().Truncate(time.Microsecond)
	for index := 0; index < 75; index++ {
		seedConversion(t, pool, ctx, tenantID, "", nil, "", occurredAt)
	}

	repo := &Repo{Pool: pool}
	first, err := repo.List(ctx, tenantID, time.Time{}, 0, 50)
	if err != nil {
		t.Fatalf("List(first): %v", err)
	}
	if len(first) != 50 {
		t.Fatalf("first page length = %d, want 50", len(first))
	}
	cursor := first[len(first)-1]
	second, err := repo.List(ctx, tenantID, cursor.OccurredAt, cursor.ID, 50)
	if err != nil {
		t.Fatalf("List(second): %v", err)
	}
	if len(second) != 25 {
		t.Fatalf("second page length = %d, want 25", len(second))
	}

	seen := make(map[int64]struct{}, 75)
	var previousID int64
	for index, conversion := range append(first, second...) {
		if _, duplicate := seen[conversion.ID]; duplicate {
			t.Fatalf("conversion id %d appeared on multiple pages", conversion.ID)
		}
		seen[conversion.ID] = struct{}{}
		if index > 0 && conversion.ID >= previousID {
			t.Fatalf("ids are not strictly descending at index %d: %d after %d", index, conversion.ID, previousID)
		}
		previousID = conversion.ID
	}
	if len(seen) != 75 {
		t.Fatalf("unique rows across pages = %d, want 75", len(seen))
	}
}
