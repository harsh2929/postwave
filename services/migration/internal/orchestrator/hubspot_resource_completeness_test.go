package orchestrator

import (
	"strings"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestHubSpotResourceCompletenessKeepsUninventoriedSurfacesVisible(t *testing.T) {
	rows := ResourceCompletenessForSource(
		canonical.SourceHubSpot,
		adapter.DiscoveryReport{},
		canonical.VerificationReport{},
	)

	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}

	staticSurfaces := []string{
		"dynamic_list_predicates",
		"automations",
		"campaigns",
		"templates",
		"reports",
		"forms",
		"landing",
		"ecommerce",
		"sms",
		"custom_objects",
		"other_crm_objects",
	}
	for _, resource := range staticSurfaces {
		row, ok := byName[resource]
		if !ok {
			t.Fatalf("missing HubSpot scope-review row %q", resource)
		}
		if row.Status != "manual_rebuild_required" {
			t.Errorf("%s status = %q, want manual_rebuild_required", resource, row.Status)
		}
		if row.Supported {
			t.Errorf("%s supported = true, want false", resource)
		}
		if row.SourceTotal != hubSpotStaticScopeReviewCount || row.Imported != 0 {
			t.Errorf("%s counts = %d/%d, want static %d/0", resource, row.SourceTotal, row.Imported, hubSpotStaticScopeReviewCount)
		}
		notes := strings.Join(row.Notes, " ")
		if !strings.Contains(notes, "not a provider inventory count") || !strings.Contains(notes, "must never be interpreted as proof that the surface was absent") {
			t.Errorf("%s notes do not disclose the static non-inventory contract: %q", resource, notes)
		}
	}
	dynamicNotes := strings.Join(byName["dynamic_list_predicates"].Notes, " ")
	for _, contract := range []string{
		"allowlisted structural list envelope",
		"not requested or persisted",
		"sensitive property and integration-event literals",
		"inspect rules in HubSpot",
	} {
		if !strings.Contains(dynamicNotes, contract) {
			t.Errorf("dynamic-list notes missing %q: %q", contract, dynamicNotes)
		}
	}
}

func TestHubSpotSegmentCompletenessExplainsCombinedTargetingCountAndSnapshotAuthority(t *testing.T) {
	rows := ResourceCompletenessForSource(
		canonical.SourceHubSpot,
		adapter.DiscoveryReport{SegmentsTotal: 2},
		canonical.VerificationReport{SegmentsTranslated: 2},
	)
	for _, row := range rows {
		if row.Resource != "lists" {
			continue
		}
		notes := strings.Join(row.Notes, " ")
		for _, contract := range []string{
			"combines exact HubSpot list snapshots",
			"every active email subscription definition",
			"not a lists-only count",
			"hubspot:list:{id}",
			"hubspot:subscription:{businessUnitId}:{subscriptionId}",
			"final full snapshot is authoritative",
		} {
			if !strings.Contains(notes, contract) {
				t.Fatalf("HubSpot targeting-boundary notes missing %q: %q", contract, notes)
			}
		}
		if row.Label != "HubSpot list and subscription targeting boundaries" {
			t.Fatalf("HubSpot targeting-boundary label = %q", row.Label)
		}
		return
	}
	t.Fatal("missing HubSpot lists row")
}

func TestHubSpotResourceCompletenessSeparatesIdentityPreferencesAndPropertySchema(t *testing.T) {
	rows := ResourceCompletenessForSource(
		canonical.SourceHubSpot,
		adapter.DiscoveryReport{
			SubscribersTotal:               4,
			ProfilesWithoutEmailTotal:      2,
			AdditionalEmailIdentitiesTotal: 3,
			SubscriptionChannelsTotal:      2,
			GroupsTotal:                    9,
			CRMTotal:                       6,
			CustomFields:                   []string{"first_name", "company"},
		},
		canonical.VerificationReport{
			SubscribersImported: 4,
			CustomFieldsMapped: []canonical.CustomFieldMapping{{
				Source:    "first_name",
				Canonical: "first_name",
			}},
			CustomFieldsUnmapped: []string{"company"},
		},
	)
	byName := make(map[string]canonical.ResourceCompleteness, len(rows))
	for _, row := range rows {
		byName[row.Resource] = row
	}

	if row := byName["groups"]; row.SourceTotal != 2 || row.Imported != 2 || row.Status != "imported_runtime" {
		t.Fatalf("populated property row = %+v, want exact 2/2 runtime values", row)
	}
	if notes := strings.Join(byName["groups"].Notes, " "); !strings.Contains(notes, "does not claim that empty property definitions were imported") {
		t.Fatalf("populated property notes overclaim schema import: %q", notes)
	}
	if row := byName["contact_property_definitions"]; row.SourceTotal != 9 || row.Imported != 0 || row.Status != "manual_rebuild_required" {
		t.Fatalf("property definition row = %+v, want reviewed 9/0 inventory", row)
	}
	if notes := strings.Join(byName["contact_property_definitions"].Notes, " "); !strings.Contains(notes, "fingerprint evidence") || !strings.Contains(notes, "not materialized") {
		t.Fatalf("property definition notes = %q, want exact non-materialized boundary", notes)
	}
	if row := byName["non_email_profiles"]; row.SourceTotal != 2 || row.Imported != 0 || row.Status != "manual_rebuild_required" {
		t.Fatalf("non-email row = %+v, want excluded 2/0 evidence", row)
	}
	if row := byName["additional_email_identities"]; row.SourceTotal != 3 || row.Imported != 0 || row.Status != "manual_rebuild_required" {
		t.Fatalf("additional-email row = %+v, want non-sendable 3/0 evidence", row)
	}
	if notes := strings.Join(byName["additional_email_identities"].Notes, " "); !strings.Contains(notes, "fingerprint-only") || !strings.Contains(notes, "never promotes them silently") {
		t.Fatalf("additional-email notes = %q, want non-email alias boundary", notes)
	}
	if row := byName["communication_preferences"]; row.SourceTotal != 4 || row.Imported != 4 || row.Status != "imported_runtime" {
		t.Fatalf("preference row = %+v, want exact 4/4 projection", row)
	}
	preferenceNotes := strings.Join(byName["communication_preferences"].Notes, " ")
	for _, contract := range []string{
		"2 active email subscription definition(s)",
		"SUBSCRIBED to every active email definition",
		"scoped or global opt-out",
		"globally disabled",
		"NOT_SPECIFIED remains unconfirmed",
		"defensible legal-basis",
		"hubspot:subscription:",
	} {
		if !strings.Contains(preferenceNotes, contract) {
			t.Errorf("preference notes missing %q: %q", contract, preferenceNotes)
		}
	}
	if row := byName["email_eligibility"]; row.SourceTotal != 4 || row.Imported != 4 || row.Status != "imported_runtime" {
		t.Fatalf("email eligibility row = %+v, want exact 4/4 conservative projection", row)
	}
	eligibilityNotes := strings.Join(byName["email_eligibility"].Notes, " ")
	for _, contract := range []string{
		"hard-bounce reason",
		"quarantine",
		"invalid-address",
		"non-marketing or unknown marketing-contact state",
		"double opt-in",
		"legacy email opt-out",
		"current primary email",
		"not a claim of exact HubSpot sendability parity",
	} {
		if !strings.Contains(eligibilityNotes, contract) {
			t.Errorf("eligibility notes missing %q: %q", contract, eligibilityNotes)
		}
	}
	if row := byName["crm"]; row.SourceTotal != 6 || row.Imported != 4 || row.Status != "partial_runtime" {
		t.Fatalf("CRM row = %+v, want honest email-addressable 4/6 bridge", row)
	}
}
