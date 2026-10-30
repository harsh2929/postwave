package views

import (
	"context"
	"testing"
)

func TestBillingByTenant_CrossTenant(t *testing.T) {
	pool := readerDB(t)
	r := &Reader{Pool: pool}
	rows, err := r.BillingByTenant(context.Background(), 50)
	if err != nil {
		t.Fatalf("BillingByTenant: %v", err)
	}
	for _, row := range rows {
		if row.TenantID == "" {
			t.Fatal("every billing row must carry tenant_id")
		}
		if row.MonthlyCap <= 0 {
			t.Fatalf("cap must be positive (from tier): %+v", row)
		}
		if row.UsageFraction < 0 {
			t.Fatalf("usage fraction must be non-negative: %+v", row)
		}
	}
}
