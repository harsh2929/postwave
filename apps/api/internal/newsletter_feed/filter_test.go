// SPDX-License-Identifier: AGPL-3.0-only
package newsletter_feed

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/archive"
)

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Release Notes":    "release-notes",
		"Jane Doe":         "jane-doe",
		"  Foo / Bar!  ":   "foo-bar",
		"Product  Updates": "product-updates",
		"C++":              "c",
		"已经":               "", // non-ascii drops to empty
		"":                 "",
		"---":              "",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTagKeep(t *testing.T) {
	keep := tagKeep("release-notes")
	if !keep(archive.FeedIssue{Tags: []string{"Release Notes", "Changelog"}}) {
		t.Error("should match a tag that slugifies to release-notes")
	}
	if keep(archive.FeedIssue{Tags: []string{"Announcements"}}) {
		t.Error("should not match an unrelated tag")
	}
	if keep(archive.FeedIssue{}) {
		t.Error("no tags should not match")
	}
}

func TestAuthorKeep(t *testing.T) {
	keep := authorKeep("jane-doe")
	if !keep(archive.FeedIssue{AuthorName: "Jane Doe"}) {
		t.Error("should match author Jane Doe")
	}
	if keep(archive.FeedIssue{AuthorName: "John Smith"}) {
		t.Error("should not match a different author")
	}
	if keep(archive.FeedIssue{AuthorName: ""}) {
		t.Error("empty author should not match")
	}
}
