// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestAssetListSortSQLAlwaysHasDeterministicIDTieBreaker(t *testing.T) {
	for _, sortName := range []string{"newest", "oldest", "largest", "name", "most-used"} {
		orderBy, tuple, columns, direction := assetListSortSQL(sortName)
		if !strings.Contains(orderBy, "id ") || !strings.Contains(tuple, "id") || !strings.Contains(columns, "id") {
			t.Errorf("sort %q lacks id tie-breaker: order=%q tuple=%q columns=%q", sortName, orderBy, tuple, columns)
		}
		if direction != "<" && direction != ">" {
			t.Errorf("sort %q cursor direction=%q", sortName, direction)
		}
	}
}

func TestListWithCountsRejectsInvalidCursorBeforeDatabaseAccess(t *testing.T) {
	repo := &Repo{}
	_, _, err := repo.ListWithCounts(context.Background(), "tenant", ListParams{Before: "not-a-uuid"})
	if !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("error=%v, want ErrInvalidCursor", err)
	}
}
