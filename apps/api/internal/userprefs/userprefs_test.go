// SPDX-License-Identifier: AGPL-3.0-only
package userprefs

import (
	"reflect"
	"testing"
)

func TestSanitizeViewDropsUnknownColumns(t *testing.T) {
	in := SubscribersView{
		Columns: []string{"email", "drop_table", "engagement", "email"}, // dup + unknown
		Widths:  map[string]int{"email": 200, "garbage": 100, "engagement": -1, "tags": 9999},
		Sort:    "joined",
		Order:   "desc",
	}
	out := sanitizeView(in)
	wantCols := []string{"email", "engagement"}
	if !reflect.DeepEqual(out.Columns, wantCols) {
		t.Fatalf("columns = %v, want %v", out.Columns, wantCols)
	}
	if out.Widths["garbage"] != 0 {
		t.Fatalf("widths leaked unknown key: %v", out.Widths)
	}
	if out.Widths["engagement"] != 24 {
		t.Fatalf("negative width not clamped: %d", out.Widths["engagement"])
	}
	if out.Widths["tags"] != 1200 {
		t.Fatalf("oversize width not clamped: %d", out.Widths["tags"])
	}
	if out.Sort != "joined" || out.Order != "desc" {
		t.Fatalf("sort/order lost: %q/%q", out.Sort, out.Order)
	}
}

func TestSanitizeViewRejectsUnknownSortAndOrder(t *testing.T) {
	in := SubscribersView{
		Sort:  "ssn_desc; drop table",
		Order: "RANDOM()",
	}
	out := sanitizeView(in)
	if out.Sort != "" {
		t.Fatalf("unknown sort survived: %q", out.Sort)
	}
	if out.Order != "" {
		t.Fatalf("unknown order survived: %q", out.Order)
	}
}

func TestAllowedSortsMatchesRepoNormalizer(t *testing.T) {
	// Repo-side normalizeSort accepts these — keep allowedSorts in sync
	// so a column the operator chose can actually be applied next reload.
	// first_name/last_name added in SUB-075 (both server-sortable).
	wantedKeys := []string{"email", "status", "joined", "engagement", "updated", "first_name", "last_name"}
	for _, k := range wantedKeys {
		if !allowedSorts[k] {
			t.Fatalf("allowedSorts missing %q (drift vs. subscribers.normalizeSort)", k)
		}
	}
}

// TestSanitizeViewAcceptsSUB075Columns pins SUB-075: the six previously
// missing column keys (first/last/full/display name, archived_at, account) are
// now accepted + persisted in order, and their widths clamp like any other
// column. Before the allow-list expansion an operator who chose these lost the
// choice on reload because sanitizeView silently dropped them.
func TestSanitizeViewAcceptsSUB075Columns(t *testing.T) {
	cols := []string{"first_name", "last_name", "full_name", "display_name", "archived_at", "account"}
	in := SubscribersView{
		Columns: cols,
		Widths: map[string]int{
			"first_name":   150,
			"last_name":    9999, // clamps to 1200
			"full_name":    10,   // clamps up to 24
			"display_name": 180,
			"archived_at":  120,
			"account":      200,
		},
	}
	out := sanitizeView(in)
	if !reflect.DeepEqual(out.Columns, cols) {
		t.Fatalf("columns = %v, want %v (SUB-075 keys must survive)", out.Columns, cols)
	}
	if out.Widths["first_name"] != 150 {
		t.Fatalf("first_name width = %d, want 150", out.Widths["first_name"])
	}
	if out.Widths["last_name"] != 1200 {
		t.Fatalf("oversize last_name width not clamped: %d", out.Widths["last_name"])
	}
	if out.Widths["full_name"] != 24 {
		t.Fatalf("undersize full_name width not clamped: %d", out.Widths["full_name"])
	}
	if out.Widths["account"] != 200 {
		t.Fatalf("account width = %d, want 200", out.Widths["account"])
	}
}

// TestSanitizeViewAcceptsSUB075Sorts pins SUB-075: first_name/last_name are now
// accepted as persisted sorts so the column-header sort the operator picked is
// re-applied on next load instead of being silently dropped.
func TestSanitizeViewAcceptsSUB075Sorts(t *testing.T) {
	for _, s := range []string{"first_name", "last_name"} {
		out := sanitizeView(SubscribersView{Sort: s, Order: "asc"})
		if out.Sort != s {
			t.Fatalf("sort %q dropped, want preserved", s)
		}
		if out.Order != "asc" {
			t.Fatalf("order lost for sort %q: %q", s, out.Order)
		}
	}
}
