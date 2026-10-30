// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const semanticContentSchemaVersion = semanticemail.SchemaVersionV2

// normalizeCampaignContent enforces the currently supported source/schema
// pairs and returns the exact content_blocks value suitable for persistence.
// Semantic input is strict-decoded and normalized; legacy blocks remain
// lossless because they belong to the historical editor model, not AST v2.
func normalizeCampaignContent(sourceMode string, schemaVersion int, blocks []map[string]any) ([]map[string]any, json.RawMessage, error) {
	sourceMode = strings.ToLower(strings.TrimSpace(sourceMode))
	raw, err := json.Marshal(nonNilSliceMap(blocks))
	if err != nil {
		return nil, nil, fmt.Errorf("encode campaign content: %w", err)
	}
	switch sourceMode {
	case campaignartifact.SourceModeLegacyHTML:
		if schemaVersion != 1 {
			return nil, nil, fmt.Errorf("%w: legacy_html source requires content_schema_version 1", campaignartifact.ErrInvalidInput)
		}
		return nonNilSliceMap(blocks), raw, nil
	case campaignartifact.SourceModeSemantic:
		if schemaVersion != semanticemail.SchemaVersionV2 {
			return nil, nil, fmt.Errorf("%w: semantic source requires content_schema_version %d", campaignartifact.ErrInvalidInput, semanticemail.SchemaVersionV2)
		}
		normalized, _, err := campaignartifact.NormalizeSemanticTreeV2(raw, schemaVersion)
		if err != nil {
			return nil, nil, err
		}
		var normalizedBlocks []map[string]any
		if err := json.Unmarshal(normalized, &normalizedBlocks); err != nil {
			return nil, nil, fmt.Errorf("decode normalized campaign content: %w", err)
		}
		return nonNilSliceMap(normalizedBlocks), normalized, nil
	default:
		return nil, nil, fmt.Errorf("%w: invalid source_mode", campaignartifact.ErrInvalidInput)
	}
}
