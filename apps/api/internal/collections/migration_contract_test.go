// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"os"
	"strings"
	"testing"
)

func TestReferenceCollectionsHardeningMigrationContract(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("../../../../infra/migrations/1783_reference_collections_contract.sql")
	if err != nil {
		t.Fatalf("read migration 1783: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"migration-execution: phased",
		"reference_collections_name_length_check",
		"reference_collection_name_is_safe",
		"value !~ '[[:cntrl:]]'",
		"reference_collections_data_shape_check",
		"reference_collection_compact_json_size",
		"reference_collection_compact_json_size_at_depth",
		"IF depth > 9 THEN",
		"jsonb_array_elements(value)",
		"jsonb_each(value)",
		`replace(string_value, U&'\2028', '')`,
		"reference_collection_field_name_is_safe",
		"reference_collection_value_node_count",
		"reference_collection_data_is_safe",
		"depth > 8",
		"member_count > 1000",
		"member_count > 100",
		"octet_length(string_value) > 65536",
		"abs(number_value) > 9007199254740991::numeric",
		"abs(number_value) < 1e-300::numeric",
		"abs(number_value) > 1e300::numeric",
		"total_nodes > 250000",
		"reference_collection_compact_json_size(row_value) > 262144",
		"public.reference_collection_compact_json_size(value) > 1048576",
		"CHECK (reference_collection_data_is_safe(data)) NOT VALID",
		"contains data outside the bounded row/value contract",
		"reference_collections_tenant_page_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_tenant_page_idx",
		"tenant_id, created_at DESC, id DESC",
		"reference_collections_tenant_type_page_idx",
		"tenant_id, collection_type, created_at DESC, id DESC",
		"reference_collections_name_trgm_idx",
		"lower(name) gin_trgm_ops",
		"reference_collections_tenant_name_uidx",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_tenant_name_uidx",
		"tenant_id, lower(name)",
		"reference_collections_set_updated_at",
		"duplicate tenant/name identities",
		"not the deployable discounts coupon_pools runtime",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("migration 1783 missing %q", required)
		}
	}
	if strings.Contains(source, "DROP TABLE") || strings.Contains(source, "DROP COLUMN") {
		t.Fatal("migration 1783 must remain additive")
	}
	if strings.Contains(source, "octet_length(data::text) <= 1048576") {
		t.Fatal("jsonb presentation whitespace must not define the compact API size ceiling")
	}
}
