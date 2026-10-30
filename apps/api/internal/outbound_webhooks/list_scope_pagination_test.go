package outbound_webhooks

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestListForListPageRejectsInvalidListIDBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()

	store := &Store{}
	_, _, err := store.ListForListPage(
		context.Background(),
		"00000000-0000-0000-0000-000000000001",
		"not-a-list-uuid",
		pagination.DefaultLimit,
		pagination.Cursor{},
	)
	if !errors.Is(err, ErrInvalidListID) {
		t.Fatalf("error = %v, want ErrInvalidListID", err)
	}
}

func TestListForListPageSourceIsBoundedAndDatabaseScoped(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Store) ListForListPage(")
	if start < 0 {
		t.Fatal("ListForListPage source start not found")
	}
	end := strings.Index(source[start:], "\n// Get fetches one webhook")
	if end < 0 {
		t.Fatal("ListForListPage source end not found")
	}
	method := source[start : start+end]
	for _, required := range []string{
		"WHERE tenant_id = $1::uuid",
		"AND list_id = $2::uuid",
		"AND deleted_at IS NULL",
		"LIMIT $",
		"limit+1",
		"pagination.HasMore",
		"pagination.Encode",
	} {
		if !strings.Contains(method, required) {
			t.Errorf("ListForListPage missing bounded scope contract %q", required)
		}
	}
}
