// SPDX-License-Identifier: AGPL-3.0-only

package link_checker

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const semanticSourceMode = "semantic"

// campaignContent is the saved message a campaign would send: the columns the
// editor writes and the send path reads.
//
// It deliberately does not read campaigns.body. That column is the public
// archive's copy, written only when a sent campaign is published, so it is
// NULL for every draft — the only time a pre-send check matters — and the
// sweep used to find "no links" in campaigns whose buttons were right there in
// body_html.
//
// Nor does it read campaigns.variants. That column is create/update
// passthrough that nothing in the send path reads; the A/B bodies recipients
// receive are campaign_variants rows, which sending.loadCampaignBodies joins
// (a variant with an empty body_html falls back to the campaign's). Checking
// the passthrough column would skip the links that are sent and flag links
// nobody receives.
type campaignContent struct {
	SourceMode    string
	BodyHTML      string
	PlainText     string
	ContentBlocks json.RawMessage
	// VariantBodies holds each A/B variant's own body_html. A variant with an
	// empty body sends the campaign's body_html, which is already scanned.
	VariantBodies []string
}

func loadCampaignContent(ctx context.Context, pool *db.Pool, tenantID, id string) (campaignContent, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return campaignContent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		content    campaignContent
		campaignID string
	)
	err = tx.QueryRow(ctx, `
SELECT id::text,
       COALESCE(source_mode, ''),
       COALESCE(body_html, ''),
       COALESCE(plain_text, ''),
       COALESCE(content_blocks, '[]'::jsonb)
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id::text = $2`, tenantID, id).Scan(
		&campaignID, &content.SourceMode, &content.BodyHTML, &content.PlainText,
		&content.ContentBlocks)
	if err != nil {
		return campaignContent{}, err
	}
	rows, err := tx.Query(ctx, `
SELECT body_html
  FROM campaign_variants
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND COALESCE(body_html, '') <> ''
 ORDER BY variant_label`, tenantID, campaignID)
	if err != nil {
		return campaignContent{}, err
	}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			rows.Close()
			return campaignContent{}, err
		}
		content.VariantBodies = append(content.VariantBodies, body)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return campaignContent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return campaignContent{}, err
	}
	return content, nil
}

// links gathers every destination the campaign would send, from the source
// that is authoritative for its mode.
//
//   - A semantic campaign's HTML is compiled from its node tree at send time;
//     body_html is not persisted for it, so the tree is walked directly and
//     every locale and conditional branch counts.
//   - Any other campaign sends body_html (the block editor renders its blocks
//     into it on every save) and plain_text; both are scanned.
//
// Each A/B variant that carries its own body sends that body, so it is
// scanned too, whatever the campaign's mode.
func (c campaignContent) links() []string {
	var links urlSet
	if strings.EqualFold(strings.TrimSpace(c.SourceMode), semanticSourceMode) {
		links.addAll(semanticLinks(c.ContentBlocks))
	} else {
		links.addAll(ExtractURLs(c.BodyHTML))
		links.addAll(extractTextURLs(c.PlainText))
	}
	for _, body := range c.VariantBodies {
		links.addAll(ExtractURLs(body))
	}
	return links.urls
}

// semanticLinks walks a stored semantic node tree. The tree was normalized and
// validated when it was saved; one that no longer decodes has no links this
// check can name, and the send path will refuse it on its own terms.
func semanticLinks(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var nodes []semanticemail.Node
	if err := json.Unmarshal(raw, &nodes); err != nil {
		return nil
	}
	return semanticemail.LinkURLs(nodes)
}
