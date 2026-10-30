// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func headingPatchTree(t *testing.T) json.RawMessage {
	t.Helper()
	raw := json.RawMessage(`[
        {"id":"title","type":"heading","role":"heading","version":2,
         "content":{"heading":{"level":1,"text":{"runs":[{"kind":"text","text":"Launch"}]}}},
         "conditions":[],"localizations":{},"provenance":{"source":"user"}},
        {"id":"details","type":"heading","role":"heading","version":2,
         "content":{"heading":{"level":3,"text":{"runs":[{"kind":"text","text":"Details"}]}}},
         "conditions":[],"localizations":{},"provenance":{"source":"user"}}
    ]`)
	normalized, _, err := NormalizeSemanticTreeV2(raw, semanticemail.SchemaVersionV2)
	if err != nil {
		t.Fatal(err)
	}
	return normalized
}

func TestApplyTypedPatchV1ChangesOnlyNamedHeadingLevel(t *testing.T) {
	t.Parallel()
	patched, err := applyTypedPatchV1(
		headingPatchTree(t), semanticemail.SchemaVersionV2,
		json.RawMessage(`{"value":"2","node_id":"details","operation":"set_semantic_field","field":"content.heading.level","schema_version":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	var nodes []semanticemail.Node
	if err := json.Unmarshal(patched, &nodes); err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || nodes[0].Content.Heading.Level != 1 ||
		nodes[1].Content.Heading.Level != 2 {
		t.Fatalf("patched nodes = %+v", nodes)
	}
	// Applying the exact receipt again is not silently treated as a change.
	if _, err := applyTypedPatchV1(patched, semanticemail.SchemaVersionV2,
		json.RawMessage(`{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"2"}`)); !errors.Is(err, ErrPatchNoop) {
		t.Fatalf("second apply error = %v, want ErrPatchNoop", err)
	}
}

func TestApplyTypedPatchV1FailsClosed(t *testing.T) {
	t.Parallel()
	tree := headingPatchTree(t)
	tests := []struct {
		name  string
		patch string
		want  error
	}{
		{"unknown operation", `{"schema_version":1,"operation":"remove_semantic_node","node_id":"details"}`, ErrPatchUnsupported},
		{"unknown field", `{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.text","value":"2"}`, ErrPatchUnsupported},
		{"unknown member", `{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"2","html":"<h2>"}`, ErrPatchUnsupported},
		{"noncanonical number", `{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"02"}`, ErrPatchUnsupported},
		{"out of range", `{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"7"}`, ErrPatchUnsupported},
		{"missing node", `{"schema_version":1,"operation":"set_semantic_field","node_id":"missing","field":"content.heading.level","value":"2"}`, ErrPatchUnsupported},
		{"wrong version", `{"schema_version":2,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"2"}`, ErrPatchUnsupported},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := applyTypedPatchV1(tree, semanticemail.SchemaVersionV2,
				json.RawMessage(test.patch)); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestPatchApplicationInputRequiresExactStrongCampaignETag(t *testing.T) {
	t.Parallel()
	input := ApplyAssuranceFindingInput{
		CampaignID: uuid.NewString(), RunID: uuid.NewString(),
		FindingID: uuid.NewString(), RequestID: uuid.NewString(),
		ActorID: uuid.NewString(), IfMatchToken: `"campaign-version"`,
	}
	normalized, hash, err := normalizePatchApplicationInput(input)
	if err != nil || normalized.CampaignID != input.CampaignID || !validHash(hash) {
		t.Fatalf("normalized=%+v hash=%q err=%v", normalized, hash, err)
	}
	for _, invalid := range []string{"", "*", `W/"weak"`, `"one", "two"`, "unquoted"} {
		candidate := input
		candidate.IfMatchToken = invalid
		if _, _, err := normalizePatchApplicationInput(candidate); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("If-Match %q error=%v, want ErrInvalidInput", invalid, err)
		}
	}
}
