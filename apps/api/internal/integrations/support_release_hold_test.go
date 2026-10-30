// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"strings"
	"testing"
)

func TestSupportProviderCatalogAndContractsExposeOnlyStaticReleaseHold(t *testing.T) {
	for _, slug := range []string{"zendesk", "intercom", "gorgias", "freshdesk", "zoho-desk"} {
		item, ok := CatalogItemBySlug(slug)
		if !ok {
			t.Fatalf("missing %s catalog item", slug)
		}
		if item.Badge != BadgePlanned || item.RuntimeStatus != RuntimePlanned || item.Native || item.SetupPath != "" || len(item.Capabilities) != 0 {
			t.Fatalf("%s leaked runnable catalog truth: %#v", slug, item)
		}
		if !strings.Contains(strings.ToLower(item.Summary), "release-held") {
			t.Fatalf("%s summary=%q", slug, item.Summary)
		}
		contract := ContractFor(item)
		if contract.NativeManaged || contract.NativeVerified || strings.Contains(strings.ToLower(contract.PublicClaim), "runtime complete") {
			t.Fatalf("%s leaked live contract claim: %#v", slug, contract)
		}
		if endpoint := delegatedEndpoint(item, "sync"); endpoint != "" {
			t.Fatalf("%s delegated endpoint=%q", slug, endpoint)
		}
		if _, _, ok := connectionIDQuery(item); ok {
			t.Fatalf("%s exposes support connection IDs through read:reports facade", slug)
		}
		if _, _, _, ok := nativeRunHistoryTables(item); ok {
			t.Fatalf("%s exposes support run history through read:reports facade", slug)
		}
		meta, ok := managedProviderMetadataForItem(item)
		if !ok || meta.RuntimeStatus != "held" || len(meta.RequiredFields) != 0 || len(meta.OptionalFields) != 0 || len(meta.ActionPaths) != 0 {
			t.Fatalf("%s provider metadata is not minimized: %#v", slug, meta)
		}
	}
}
