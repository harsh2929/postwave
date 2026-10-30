package views

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	testAssuranceRunID    = "71000000-0000-4000-8000-000000000001"
	testAssuranceTenantID = "71000000-0000-4000-8000-000000000002"
)

func TestCampaignAssuranceCursor_RoundTripsOnlyCanonicalBoundedValues(t *testing.T) {
	createdAt := time.Date(2026, 8, 10, 9, 8, 7, 654321000, time.FixedZone("offset", 19800))
	cursor := encodeCampaignAssuranceCursor(createdAt, testAssuranceRunID)
	decoded, ok := decodeCampaignAssuranceCursor(cursor)
	if !ok || decoded.RunID != testAssuranceRunID || !decoded.CreatedAt.Equal(createdAt) {
		t.Fatalf("cursor round trip = %+v ok=%v", decoded, ok)
	}
	for _, invalid := range []string{
		"",
		cursor + "=",
		cursor + "x",
		strings.Repeat("x", maxCampaignAssuranceCursorBytes+1),
		encodeCampaignAssuranceCursor(createdAt, "00000000-0000-0000-0000-000000000000"),
	} {
		if _, ok := decodeCampaignAssuranceCursor(invalid); ok {
			t.Errorf("accepted invalid cursor %q", invalid)
		}
	}
}

func TestCampaignAssuranceOpsWireTypesAreContentFree(t *testing.T) {
	types := []reflect.Type{
		reflect.TypeOf(CampaignAssuranceRunRow{}),
		reflect.TypeOf(CampaignAssuranceRunDetail{}),
		reflect.TypeOf(CampaignAssuranceTimelineEvent{}),
	}
	forbidden := []string{
		"subject", "body", "normalized_extraction", "raw_output",
		"object_ref", "prompt_text", "provider_payload", "recipient",
		"mailbox", "secret", "error_message", "event_metadata",
	}
	for _, typ := range types {
		keys := jsonFieldKeys(typ)
		for _, key := range keys {
			lower := strings.ToLower(key)
			for _, fragment := range forbidden {
				if strings.Contains(lower, fragment) {
					t.Errorf("%s exposes forbidden JSON field %q", typ.Name(), key)
				}
			}
		}
	}

	// The actual encoded detail contract is pinned too: embedding the summary
	// must not accidentally create a generic content or metadata envelope.
	raw, err := json.Marshal(CampaignAssuranceRunDetail{
		CampaignAssuranceRunRow: CampaignAssuranceRunRow{
			TenantID: testAssuranceTenantID, RunID: testAssuranceRunID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(string(raw))
	for _, fragment := range forbidden {
		if strings.Contains(encoded, `"`+fragment+`"`) {
			t.Errorf("encoded detail leaked forbidden key %q: %s", fragment, raw)
		}
	}
}

func jsonFieldKeys(typ reflect.Type) []string {
	keys := []string{}
	for index := 0; index < typ.NumField(); index++ {
		field := typ.Field(index)
		if field.Anonymous && field.Type.Kind() == reflect.Struct {
			keys = append(keys, jsonFieldKeys(field.Type)...)
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			keys = append(keys, name)
		}
	}
	return keys
}
