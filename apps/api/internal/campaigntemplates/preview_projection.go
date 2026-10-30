// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// TemplatePreviewAsset is a sanitized image already copied into Moosewave's
// content-addressed object store. Provider source URLs and worker state are
// deliberately not projected to clients.
type TemplatePreviewAsset struct {
	Variant   string `json:"variant"`
	URL       string `json:"url"`
	MIMEType  string `json:"mime_type"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	SizeBytes int64  `json:"size_bytes"`
	Status    string `json:"status"`
}

// attachHostedPreviewAssets enriches an already authorized template result.
// RLS independently constrains the asset rows, and only rows with a retained,
// sanitized hosted blob are visible. A refresh can be queued or retrying while
// the last-known-good blob remains usable, so every retained state except a
// confirmed upstream disappearance projects as ready.
func attachHostedPreviewAssets(ctx context.Context, tx pgx.Tx, templates []Template) error {
	if len(templates) == 0 {
		return nil
	}
	ids := make([]string, 0, len(templates))
	indexes := make(map[string][]int, len(templates))
	for index := range templates {
		templates[index].PreviewAssets = []TemplatePreviewAsset{}
		if templates[index].ID == "" {
			continue
		}
		ids = append(ids, templates[index].ID)
		indexes[templates[index].ID] = append(indexes[templates[index].ID], index)
	}
	if len(ids) == 0 {
		return nil
	}

	rows, err := tx.Query(ctx, `
SELECT asset.template_id::text,
       asset.variant,
       blob.public_url,
       blob.mime_type,
       blob.width,
       blob.height,
       blob.size_bytes,
       CASE
           WHEN asset.status = 'source_missing' THEN 'source_missing'
           ELSE 'ready'
       END AS public_status
  FROM campaign_template_preview_assets AS asset
  JOIN campaign_template_preview_blobs AS blob
    ON blob.id = asset.blob_id
 WHERE asset.template_id::text = ANY($1::text[])
   AND asset.blob_id IS NOT NULL
 ORDER BY asset.template_id,
          CASE asset.variant
              WHEN 'desktop' THEN 1
              WHEN 'mobile' THEN 2
              WHEN 'card' THEN 3
              ELSE 4
          END`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var templateID string
		var asset TemplatePreviewAsset
		if err := rows.Scan(
			&templateID,
			&asset.Variant,
			&asset.URL,
			&asset.MIMEType,
			&asset.Width,
			&asset.Height,
			&asset.SizeBytes,
			&asset.Status,
		); err != nil {
			return err
		}
		for _, index := range indexes[templateID] {
			templates[index].PreviewAssets = append(templates[index].PreviewAssets, asset)
		}
	}
	return rows.Err()
}

func attachHostedPreviewAsset(ctx context.Context, tx pgx.Tx, template *Template) error {
	if template == nil {
		return nil
	}
	templates := []Template{*template}
	if err := attachHostedPreviewAssets(ctx, tx, templates); err != nil {
		return err
	}
	*template = templates[0]
	return nil
}
