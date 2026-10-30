package archive

import (
	"errors"
	"strings"
	"testing"
)

// TestValidateArchiveSlug exhaustively covers the kebab-case validator
// — it's the gatekeeper between an admin form and a column that backs
// public URL routing, so a typo here would mean every public archive
// URL 404s post-save. Cases mirror the regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`
// plus the 64-char length cap.
func TestValidateArchiveSlug(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		slug    string
		wantErr error
	}{
		// Empty string is the "clear the column" sentinel — must
		// validate clean so admins can revert to defaults.
		{"empty clears column", "", nil},

		// Happy-path: typical publication slugs.
		{"simple", "acme", nil},
		{"kebab", "acme-co", nil},
		{"multi-segment", "postwave-weekly", nil},
		{"digit suffix", "issue-42", nil},
		{"all digits", "1234", nil},
		{"single char", "a", nil},

		// Exactly at the cap.
		{"64-char boundary", strings.Repeat("a", 64), nil},
		{"65-char overflow", strings.Repeat("a", 65), errSlugTooLong},

		// Shape violations.
		{"uppercase", "Acme", errSlugShape},
		{"underscore", "acme_co", errSlugShape},
		{"trailing dash", "acme-", errSlugShape},
		{"leading dash", "-acme", errSlugShape},
		{"double dash", "acme--co", errSlugShape},
		{"space", "acme co", errSlugShape},
		{"dot", "acme.co", errSlugShape},
		{"unicode", "café", errSlugShape},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ValidateArchiveSlug(tc.slug)
			if !errors.Is(got, tc.wantErr) {
				t.Fatalf("ValidateArchiveSlug(%q) = %v, want %v", tc.slug, got, tc.wantErr)
			}
		})
	}
}
