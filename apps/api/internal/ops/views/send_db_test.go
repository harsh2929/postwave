package views

import (
	"context"
	"testing"
)

func TestQueueDepthByTenant_CrossTenant(t *testing.T) {
	pool := readerDB(t)
	r := &Reader{Pool: pool}
	rows, err := r.QueueDepthByTenant(context.Background(), 50)
	if err != nil {
		t.Fatalf("QueueDepthByTenant: %v", err)
	}
	for _, row := range rows {
		if row.TenantID == "" {
			t.Fatal("every queue-depth row must carry tenant_id")
		}
		if row.Pending < 0 || row.Failed < 0 {
			t.Fatalf("counts must be non-negative: %+v", row)
		}
	}
}

func TestListDeadLetters_CrossTenant(t *testing.T) {
	pool := readerDB(t)
	r := &Reader{Pool: pool}
	rows, err := r.ListDeadLetters(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListDeadLetters: %v", err)
	}
	for _, row := range rows {
		if row.TenantID == "" || row.Kind == "" {
			t.Fatalf("dead-letter row must carry tenant_id + kind: %+v", row)
		}
		if row.DeadCount <= 0 {
			t.Fatalf("a dead-letter group must have a positive count: %+v", row)
		}
	}
}
