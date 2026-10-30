package segments

import "testing"

func TestBasePredicateDefinitionsExposeCompilerStatus(t *testing.T) {
	items := basePredicateDefinitions()
	byKey := map[string]PredicateDefinition{}
	for _, item := range items {
		byKey[item.Key] = item
	}
	if byKey["email"].CompilerStatus != "supported" {
		t.Fatalf("email predicate = %#v", byKey["email"])
	}
	if byKey["last_opened_at"].CompilerStatus != "supported" {
		t.Fatalf("last_opened_at predicate = %#v", byKey["last_opened_at"])
	}
	if byKey["custom.*"].Source != "custom_field" {
		t.Fatalf("custom wildcard predicate = %#v", byKey["custom.*"])
	}
	if byKey["predictive.total_clv_cents"].Source != "profile_predictions" || byKey["predictive.total_clv_cents"].CompilerStatus != "supported" {
		t.Fatalf("predictive total CLV predicate = %#v", byKey["predictive.total_clv_cents"])
	}
	if byKey["rfm.segment_key"].Source != "profile_rfm_scores" || byKey["rfm.segment_key"].CompilerStatus != "supported" {
		t.Fatalf("RFM segment predicate = %#v", byKey["rfm.segment_key"])
	}
}
