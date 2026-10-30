// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"testing"

	"github.com/google/uuid"
)

func TestDeriveDeliveryIDIsStableAndBoundToEveryIdentity(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	campaign := "22222222-2222-4222-8222-222222222222"
	plan := "33333333-3333-4333-8333-333333333333"
	baseline, err := DeriveDeliveryID(tenant, campaign, 42, plan)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := DeriveDeliveryID(tenant, campaign, 42, plan)
	if err != nil || replay != baseline {
		t.Fatalf("replay = %q, %v; baseline %q", replay, err, baseline)
	}
	parsed, err := uuid.Parse(baseline)
	if err != nil || parsed.Version() != 8 {
		t.Fatalf("derived ID = %q, version %v, error %v", baseline, parsed.Version(), err)
	}
	variants := []struct {
		tenant, campaign, plan string
		recipient              int64
	}{
		{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", campaign, plan, 42},
		{tenant, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", plan, 42},
		{tenant, campaign, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", 42},
		{tenant, campaign, plan, 43},
	}
	for _, variant := range variants {
		got, err := DeriveDeliveryID(variant.tenant, variant.campaign, variant.recipient, variant.plan)
		if err != nil {
			t.Fatal(err)
		}
		if got == baseline {
			t.Fatalf("changed identity retained delivery ID %q", baseline)
		}
	}
}
