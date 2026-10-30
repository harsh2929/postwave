// SPDX-License-Identifier: AGPL-3.0-only
package archive

import (
	"strings"
	"testing"
)

func TestFeedProjectionDefersRichContentUntilAfterCandidateFiltering(t *testing.T) {
	for _, expensive := range []string{"body_html", "archive_hero_image"} {
		if strings.Contains(feedIssuesQuery, expensive) {
			t.Fatalf("candidate query reads %q before tag/author filtering: %s", expensive, feedIssuesQuery)
		}
	}
	for _, required := range []string{
		"COALESCE(body, body_html, '')::text",
		"COALESCE(archive_hero_image, '')",
		"archive_public = true",
		"archive_slug = ANY($2::text[])",
	} {
		if !strings.Contains(hydrateFeedIssuesQuery, required) {
			t.Errorf("rich feed hydration query missing %q: %s", required, hydrateFeedIssuesQuery)
		}
	}
}

func TestIsPublicImageURLSharesArchivePublishSafetyContract(t *testing.T) {
	for _, accepted := range []string{
		"https://cdn.example.com/hero.png",
		"  http://8.8.8.8/image.jpg  ",
	} {
		if !IsPublicImageURL(accepted) {
			t.Errorf("expected public image URL to pass: %q", accepted)
		}
	}
	for _, rejected := range []string{
		"",
		"/relative.png",
		"javascript:alert(1)",
		"https://user:pass@cdn.example.com/private.png",
		"https://cdn.example.com:65536/private.png",
		"https://cdn..example.com/private.png",
		"https://cdn.example.com/image.png?name=%0aInjected",
		"http://127.0.0.1/private.png",
		"http://169.254.169.254/latest/meta-data/",
	} {
		if IsPublicImageURL(rejected) {
			t.Errorf("expected unsafe image URL to fail: %q", rejected)
		}
	}
}
