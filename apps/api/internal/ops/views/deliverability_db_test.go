package views

import (
	"context"
	"testing"
)

func TestDeliverabilityByTenant_CrossTenant(t *testing.T) {
	pool := readerDB(t)
	r := &Reader{Pool: pool}
	rows, err := r.DeliverabilityByTenant(context.Background(), 50)
	if err != nil {
		t.Fatalf("DeliverabilityByTenant: %v", err)
	}
	for _, row := range rows {
		if row.TenantID == "" {
			t.Fatal("every deliverability row must carry tenant_id")
		}
		if row.ComplaintRate < 0 || row.BounceRate < 0 {
			t.Fatalf("rates must be non-negative: %+v", row)
		}
		// A rate is a fraction in [0,1]; guard against a denominator bug.
		if row.ComplaintRate > 1 || row.BounceRate > 1 {
			t.Fatalf("rate exceeds 1.0 — denominator bug: %+v", row)
		}
	}
}
