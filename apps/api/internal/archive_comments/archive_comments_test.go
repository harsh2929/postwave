package archive_comments

import (
	"testing"
	"time"
)

// TestBuildTree_Best — pinned floats first, then by score, then
// recency. Reflects the default "best" ordering Substack/Buttondown
// use. We assert both root ordering and child ordering so a regression
// that only sorts the top level is caught.
func TestBuildTree_Best(t *testing.T) {
	now := time.Now()
	rows := []Comment{
		{ID: "a", CampaignID: "c", Upvotes: 5, Downvotes: 2, CreatedAt: now.Add(-2 * time.Hour)},
		{ID: "b", CampaignID: "c", Upvotes: 10, Downvotes: 8, CreatedAt: now.Add(-1 * time.Hour)},
		{ID: "c", CampaignID: "c", Pinned: true, Upvotes: 0, CreatedAt: now.Add(-3 * time.Hour)},
		{ID: "a-1", CampaignID: "c", ParentID: "a", Upvotes: 1, CreatedAt: now.Add(-30 * time.Minute)},
		{ID: "a-2", CampaignID: "c", ParentID: "a", Upvotes: 3, CreatedAt: now.Add(-10 * time.Minute)},
	}
	tree := BuildTree(rows, "best")
	// Roots: pinned first, then a (score 3), then b (score 2).
	if len(tree) != 3 {
		t.Fatalf("expected 3 roots, got %d", len(tree))
	}
	if tree[0].ID != "c" {
		t.Errorf("pinned should be first; got %s", tree[0].ID)
	}
	if tree[1].ID != "a" || tree[2].ID != "b" {
		t.Errorf("expected a,b ordering after pinned; got %s,%s", tree[1].ID, tree[2].ID)
	}
	// Children of 'a': a-2 (score 3) before a-1 (score 1).
	if len(tree[1].Children) != 2 {
		t.Fatalf("expected 2 children of a, got %d", len(tree[1].Children))
	}
	if tree[1].Children[0].ID != "a-2" {
		t.Errorf("expected a-2 first child of a (higher score); got %s", tree[1].Children[0].ID)
	}
}

// TestBuildTree_New — chronological (newest first), but pinned still
// floats. Mirrors the "newest" sort tab.
func TestBuildTree_New(t *testing.T) {
	now := time.Now()
	rows := []Comment{
		{ID: "old", CampaignID: "c", CreatedAt: now.Add(-2 * time.Hour)},
		{ID: "new", CampaignID: "c", CreatedAt: now.Add(-10 * time.Minute)},
		{ID: "pin", CampaignID: "c", Pinned: true, CreatedAt: now.Add(-3 * time.Hour)},
	}
	tree := BuildTree(rows, "new")
	if tree[0].ID != "pin" {
		t.Errorf("pinned should still float in new sort; got %s", tree[0].ID)
	}
	if tree[1].ID != "new" || tree[2].ID != "old" {
		t.Errorf("expected new,old ordering after pinned; got %s,%s", tree[1].ID, tree[2].ID)
	}
}

// TestBuildTree_OrphanPromoted — when a reply's parent was moderated
// out of the result set, the orphan still appears as a root rather
// than vanishing. Mirrors the resilient-tree behaviour Ghost ships.
func TestBuildTree_OrphanPromoted(t *testing.T) {
	now := time.Now()
	rows := []Comment{
		{ID: "ghost-reply", CampaignID: "c", ParentID: "missing", CreatedAt: now},
	}
	tree := BuildTree(rows, "best")
	if len(tree) != 1 || tree[0].ID != "ghost-reply" {
		t.Fatalf("orphan reply should promote to root; got %#v", tree)
	}
}

// TestValidStatus — the moderation status whitelist is the same in
// the repo (CHECK constraint) and the handler (input validation).
func TestValidStatus(t *testing.T) {
	for _, ok := range []string{"visible", "pending", "hidden", "spam"} {
		if !validStatus(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "approved", "deleted", "VISIBLE"} {
		if validStatus(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

// TestStripControl — control bytes are stripped, common whitespace
// preserved. Defence against display-name CR/LF injection into the
// JSON-LD Comment payload.
func TestStripControl(t *testing.T) {
	in := "hello\x00\x01\tworld\n"
	got := stripControl(in)
	want := "hello\tworld"
	if got != want {
		t.Errorf("stripControl(%q) = %q, want %q", in, got, want)
	}
}
