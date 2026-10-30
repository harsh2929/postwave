// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type importedPreviewSource struct {
	variant     string
	url         string
	width       int
	height      int
	derivedFrom string
}

// enqueueImportedPreviews projects only provider-specific, public catalog
// metadata into asynchronous jobs. It never downloads pixels in the request
// path; the worker owns source validation, sanitization, and hosted storage.
func (d *Deps) enqueueImportedPreviews(
	ctx context.Context,
	templateID string,
	in CreateInput,
) error {
	provider := strings.ToLower(strings.TrimSpace(in.SourceProvider))
	if d == nil || d.Previews == nil ||
		(provider != PreviewProviderReallyGoodEmails && provider != PreviewProviderAuraBuild) {
		return nil
	}
	jobs, err := importedPreviewEnqueues(templateID, in)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if _, err := d.Previews.Enqueue(ctx, job); err != nil {
			return fmt.Errorf("enqueue %s preview: %w", job.Variant, err)
		}
	}
	return nil
}

func importedPreviewEnqueues(templateID string, in CreateInput) ([]PreviewAssetEnqueue, error) {
	provider := strings.ToLower(strings.TrimSpace(in.SourceProvider))
	if provider != PreviewProviderReallyGoodEmails && provider != PreviewProviderAuraBuild {
		return []PreviewAssetEnqueue{}, nil
	}

	var sources []importedPreviewSource
	switch provider {
	case PreviewProviderReallyGoodEmails:
		desktop := previewSourceFromMetadata("desktop", in.SourceMetadata["desktop_screenshot"])
		if desktop.url == "" {
			desktop = importedPreviewSource{
				variant: "desktop",
				url:     strings.TrimSpace(in.ThumbnailURL),
				width:   positiveMetadataInt(in.DesignMetadata["screenshot_width"]),
				height:  positiveMetadataInt(in.DesignMetadata["screenshot_height"]),
			}
		}
		mobile := previewSourceFromMetadata("mobile", in.SourceMetadata["mobile_screenshot"])
		card := previewSourceFromMetadata("card", in.SourceMetadata["card_screenshot"])
		if card.url == "" && desktop.url != "" {
			card = desktop
			card.variant = "card"
			card.derivedFrom = "desktop"
		}
		sources = []importedPreviewSource{desktop, mobile, card}
	case PreviewProviderAuraBuild:
		// Aura's public 320/800/1600 preview images are responsive image
		// sizes, not distinct mobile-layout captures. Seed only desktop and
		// its card projection from the catalog thumbnail.
		desktop := importedPreviewSource{
			variant: "desktop",
			url:     strings.TrimSpace(in.ThumbnailURL),
		}
		card := desktop
		card.variant = "card"
		card.derivedFrom = "desktop"
		sources = []importedPreviewSource{desktop, card}
	}

	jobs := make([]PreviewAssetEnqueue, 0, len(sources))
	for _, source := range sources {
		if source.url == "" {
			continue
		}
		if _, err := validatePreviewSourceStructure(provider, source.url); err != nil {
			return nil, fmt.Errorf("validate %s preview source: %w", source.variant, err)
		}
		provenance := map[string]any{
			"ingest":             "campaign_template_import",
			"source_external_id": strings.TrimSpace(in.SourceExternalID),
			"variant":            source.variant,
		}
		if source.width > 0 {
			provenance["declared_width"] = source.width
		}
		if source.height > 0 {
			provenance["declared_height"] = source.height
		}
		if source.derivedFrom != "" {
			provenance["derived_from"] = source.derivedFrom
		}
		raw, err := json.Marshal(provenance)
		if err != nil {
			return nil, fmt.Errorf("marshal %s preview provenance: %w", source.variant, err)
		}
		jobs = append(jobs, PreviewAssetEnqueue{
			TemplateID:       templateID,
			Variant:          source.variant,
			SourceProvider:   provider,
			SourceURL:        source.url,
			SourceProvenance: raw,
		})
	}
	return jobs, nil
}

func previewSourceFromMetadata(variant string, value any) importedPreviewSource {
	source := importedPreviewSource{variant: variant}
	switch typed := value.(type) {
	case string:
		source.url = strings.TrimSpace(typed)
	case map[string]any:
		if raw, ok := typed["url"].(string); ok {
			source.url = strings.TrimSpace(raw)
		}
		source.width = positiveMetadataInt(typed["width"])
		source.height = positiveMetadataInt(typed["height"])
	}
	return source
}

func positiveMetadataInt(value any) int {
	var parsed int64
	switch typed := value.(type) {
	case int:
		parsed = int64(typed)
	case int32:
		parsed = int64(typed)
	case int64:
		parsed = typed
	case uint:
		if uint64(typed) > math.MaxInt64 {
			return 0
		}
		parsed = int64(typed)
	case uint32:
		parsed = int64(typed)
	case uint64:
		if typed > math.MaxInt64 {
			return 0
		}
		parsed = int64(typed)
	case float32:
		if math.Trunc(float64(typed)) != float64(typed) {
			return 0
		}
		parsed = int64(typed)
	case float64:
		if math.Trunc(typed) != typed || typed > math.MaxInt64 {
			return 0
		}
		parsed = int64(typed)
	case json.Number:
		number, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil {
			return 0
		}
		parsed = number
	default:
		return 0
	}
	if parsed <= 0 || parsed > math.MaxInt {
		return 0
	}
	return int(parsed)
}
