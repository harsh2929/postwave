// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
)

func TestNormalizeCampaignContentSemanticV2(t *testing.T) {
	t.Parallel()
	var blocks []map[string]any
	if err := json.Unmarshal([]byte(`[{"id":" title ","type":" HEADING ","role":" HEADING ","version":2,"content":{"heading":{"level":1,"text":{"runs":[{"kind":"text","text":"Hello"}]}}},"provenance":{"source":" USER "}}]`), &blocks); err != nil {
		t.Fatal(err)
	}
	normalized, raw, err := normalizeCampaignContent(campaignartifact.SourceModeSemantic, semanticContentSchemaVersion, blocks)
	if err != nil {
		t.Fatal(err)
	}
	if len(normalized) != 1 || normalized[0]["id"] != "title" || normalized[0]["type"] != "heading" {
		t.Fatalf("normalized blocks = %#v", normalized)
	}
	var roundTrip []map[string]any
	if err := json.Unmarshal(raw, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if len(roundTrip) != 1 || roundTrip[0]["id"] != "title" {
		t.Fatalf("raw semantic tree = %s", raw)
	}
}

func TestNormalizeCampaignContentEnforcesSourceSchemaPairs(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		mode   string
		schema int
	}{
		{mode: campaignartifact.SourceModeLegacyHTML, schema: 2},
		{mode: campaignartifact.SourceModeSemantic, schema: 1},
		{mode: "model_magic", schema: 2},
	} {
		if _, _, err := normalizeCampaignContent(test.mode, test.schema, nil); !errors.Is(err, campaignartifact.ErrInvalidInput) {
			t.Errorf("normalizeCampaignContent(%q, %d) error = %v", test.mode, test.schema, err)
		}
	}
}

func TestNormalizeCampaignContentRejectsUnknownSemanticFields(t *testing.T) {
	t.Parallel()
	var blocks []map[string]any
	if err := json.Unmarshal([]byte(`[{"id":"title","type":"heading","role":"heading","version":2,"content":{"heading":{"level":1,"text":{"runs":[{"kind":"text","text":"Hello"}]}}},"provenance":{"source":"user"},"unknown":true}]`), &blocks); err != nil {
		t.Fatal(err)
	}
	if _, _, err := normalizeCampaignContent(campaignartifact.SourceModeSemantic, semanticContentSchemaVersion, blocks); !errors.Is(err, campaignartifact.ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
}
