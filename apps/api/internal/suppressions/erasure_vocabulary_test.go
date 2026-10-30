// SPDX-License-Identifier: AGPL-3.0-only

package suppressions

import (
	"strings"
	"testing"
)

// ErasedAddresses keeps only suppression rows whose reason or source contains
// one of erasureVocabularyStems (or whose metadata carries a marker key)
// before IsIrreversibleTombstone sees them. Every term the classification
// accepts must therefore contain a stem, or a tombstone written with it would
// be filtered out in SQL and an erased address let back in.
func TestErasureCandidateFilterCoversTheVocabulary(t *testing.T) {
	var terms []string
	terms = append(terms, irreversibleReasons...)
	terms = append(terms, irreversibleSources...)
	terms = append(terms, irreversibleSourcePrefixes...)
	for _, term := range terms {
		covered := false
		for _, stem := range erasureVocabularyStems {
			if strings.Contains(term, stem) {
				covered = true
				break
			}
		}
		if !covered {
			t.Errorf("tombstone term %q contains none of the SQL candidate stems %v", term, erasureVocabularyStems)
		}
		if !IsIrreversibleTombstone(term+"_deletion", "", nil) && !IsIrreversibleTombstone("", term+"_deletion", nil) &&
			!IsIrreversibleTombstone(term, "", nil) && !IsIrreversibleTombstone("", term, nil) {
			t.Errorf("vocabulary term %q is not recognised by IsIrreversibleTombstone", term)
		}
	}
	for _, stem := range erasureVocabularyStems {
		if strings.ContainsAny(stem, "-_ ") || strings.ToLower(stem) != stem {
			t.Errorf("stem %q would not survive normalizePolicyMarker unchanged", stem)
		}
	}
	for _, key := range append(append([]string{}, irreversibleMetadataFlags...), erasureIdentityMarkers...) {
		if !strings.Contains(erasureMarkersSQL, "'"+key+"'") {
			t.Errorf("metadata marker %q is missing from the SQL candidate filter", key)
		}
	}
}
