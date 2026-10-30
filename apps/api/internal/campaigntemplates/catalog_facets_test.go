// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"fmt"
	"testing"
)

func TestCatalogTagFacetsStayBoundedAndRanked(t *testing.T) {
	out := CatalogFacets{Tags: []FacetValue{}}
	for index := 0; index < maxCatalogTagFacets+25; index++ {
		appendCatalogFacet(&out, "tags", FacetValue{
			Value: fmt.Sprintf("tag-%03d", index),
			Count: maxCatalogTagFacets + 25 - index,
		})
	}
	if got := len(out.Tags); got != maxCatalogTagFacets {
		t.Fatalf("tag facets=%d, want %d", got, maxCatalogTagFacets)
	}
	if out.Tags[0].Value != "tag-000" ||
		out.Tags[len(out.Tags)-1].Value != "tag-099" {
		t.Fatalf("ranked tag bounds = %q ... %q",
			out.Tags[0].Value, out.Tags[len(out.Tags)-1].Value)
	}
}

func TestAppendCatalogFacetIgnoresUnknownDimensions(t *testing.T) {
	out := CatalogFacets{}
	appendCatalogFacet(&out, "unknown", FacetValue{Value: "ignored", Count: 1})
	if len(out.Goals)+len(out.Categories)+len(out.Providers)+
		len(out.Industries)+len(out.Styles)+len(out.Layouts)+len(out.Tags) != 0 {
		t.Fatalf("unknown dimension mutated facets: %#v", out)
	}
}
