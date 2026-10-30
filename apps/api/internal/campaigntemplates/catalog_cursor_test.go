// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCatalogCursorIsOpaqueFilterBoundAndSortAware(t *testing.T) {
	featured := true
	filter, err := normalizeCatalogSearchFilter(SearchFilter{
		Query: "  Weekly AI ", Goal: "newsletter", Source: "platform",
		Tags: []string{"Data", "weekly", "data"}, Featured: &featured,
		Sort: "recommended", UserID: "11111111-1111-1111-1111-111111111111",
	})
	if err != nil {
		t.Fatalf("normalize filter: %v", err)
	}
	last := Template{
		ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Name: "Digest",
		IsFeatured: true, QualityScore: 0.97, UsageCount: 42,
		CreatedAt: time.Date(2026, 7, 29, 12, 0, 0, 123, time.UTC),
	}
	cursor := encodeCatalogCursor(last, filter, "tenant-a", 2)
	if cursor == "" || strings.Contains(cursor, "{") || cursor == "2" {
		t.Fatalf("cursor is not opaque: %q", cursor)
	}
	position, err := decodeCatalogCursor(cursor, filter, "tenant-a")
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if position.Page != 2 || position.ID != last.ID ||
		position.Quality != last.QualityScore || position.Usage != last.UsageCount {
		t.Fatalf("decoded position = %#v", position)
	}
	for name, mutate := range map[string]func(SearchFilter) SearchFilter{
		"query": func(value SearchFilter) SearchFilter { value.Query = "different"; return value },
		"sort":  func(value SearchFilter) SearchFilter { value.Sort = "name"; return value },
		"user": func(value SearchFilter) SearchFilter {
			value.UserID = "22222222-2222-2222-2222-222222222222"
			return value
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeCatalogCursor(cursor, mutate(filter), "tenant-a"); !errors.Is(err, ErrInvalidCatalogCursor) {
				t.Fatalf("error = %v, want invalid cursor", err)
			}
		})
	}
	if _, err := decodeCatalogCursor(cursor, filter, "tenant-b"); !errors.Is(err, ErrInvalidCatalogCursor) {
		t.Fatalf("cross-tenant error = %v, want invalid cursor", err)
	}
	if _, err := decodeCatalogCursor("2", filter, "tenant-a"); !errors.Is(err, ErrInvalidCatalogCursor) {
		t.Fatalf("numeric legacy cursor error = %v, want invalid cursor", err)
	}
}

func TestNormalizeCatalogSearchFilterCanonicalizesSortAndTags(t *testing.T) {
	filter, err := normalizeCatalogSearchFilter(SearchFilter{
		Source: "ReallyGoodEmails", Tags: []string{" Weekly ", "data", "weekly"},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if filter.Sort != "recommended" || filter.Provider != "reallygoodemails" ||
		len(filter.Tags) != 2 || filter.Tags[0] != "data" || filter.Tags[1] != "weekly" {
		t.Fatalf("normalized = %#v", filter)
	}
	if _, err := normalizeCatalogSearchFilter(SearchFilter{Sort: "random"}); !errors.Is(err, ErrInvalidCatalogSort) {
		t.Fatalf("invalid sort error = %v", err)
	}
}

func TestDiscoverySelectionValidationCoversDuplicatesLimitsAndNames(t *testing.T) {
	valid := []string{
		"11111111-1111-1111-1111-111111111111",
		"22222222-2222-2222-2222-222222222222",
	}
	if ids, err := validateCollectionTemplateIDs(valid); err != nil || len(ids) != 2 {
		t.Fatalf("valid collection ids = %v, %v", ids, err)
	}
	if _, err := validateCollectionTemplateIDs([]string{valid[0], valid[0]}); !errors.Is(err, ErrInvalidCollectionItems) {
		t.Fatalf("duplicate collection error = %v", err)
	}
	tooMany := make([]string, maxCollectionTemplates+1)
	for index := range tooMany {
		tooMany[index] = valid[0]
	}
	if _, err := validateCollectionTemplateIDs(tooMany); !errors.Is(err, ErrInvalidCollectionItems) {
		t.Fatalf("limit error = %v", err)
	}
	if _, err := normalizeCompareIdentifiers([]string{"one", "ONE"}); !errors.Is(err, ErrInvalidCompareSelection) {
		t.Fatalf("compare duplicate error = %v", err)
	}
	if _, err := normalizeCompareIdentifiers([]string{"one"}); !errors.Is(err, ErrInvalidCompareSelection) {
		t.Fatalf("compare minimum error = %v", err)
	}
	if _, err := validateDiscoveryName("   "); !errors.Is(err, ErrInvalidDiscoveryName) {
		t.Fatalf("blank name error = %v", err)
	}
}
