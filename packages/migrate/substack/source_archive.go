// SPDX-License-Identifier: MIT

package substack

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

var substackParityGaps = []canonical.SourceArchiveItem{
	parityGap("substack:consent", "consent_exclusions", "Consent and exclusion evidence", "Signup/subscription dates are provenance, not portable opt-in proof. Reconcile consent, bounces, complaints, and every email-disabled address before enabling sends."),
	parityGap("substack:billing_handoff", "paid_billing_handoff", "Paid billing and entitlement handoff", "Paid/founding/gift/comp labels do not migrate billing. Stripe products must be publication-bound and Apple in-app purchases, refunds, disputes, taxes, trials, pledges, and entitlement state require a coordinated handoff with Substack and the payment provider."),
	parityGap("substack:non_email_posts", "non_email_posts", "Drafts, pages, and web-only posts", "The campaign archive imports only rows with email-send evidence. Drafts, pages, and web-only posts must be rebuilt or preserved separately so they are not mislabeled as sent campaigns."),
	parityGap("substack:audience_variants", "audience_variants", "Audience-specific and paywalled variants", "Free, paid, founding, and logged-out readers can receive different post blocks. A single exported HTML fragment does not prove every reader-specific rendering or paywall rule."),
	parityGap("substack:comments_reactions", "comments_reactions", "Comments and reactions", "Comment bodies, discussion threads, likes, moderation state, and reader reactions are not imported by the ZIP/CSV path."),
	parityGap("substack:notes_restacks", "notes_restacks", "Notes and restacks", "Notes, cross-posts, restacks, social graphs, and their engagement history require a separate export or an explicit retirement decision."),
	parityGap("substack:chat", "chat", "Chat", "Chat threads, participants, moderation state, and attachments are not represented in the publication export contract."),
	parityGap("substack:recommendations_referrals", "recommendations_referrals", "Recommendations and referrals", "Recommendation relationships, referral attribution, network growth, and promotion settings require manual inventory and rebuild."),
	parityGap("substack:welcome_automations", "welcome_automations", "Welcome emails and automations", "Welcome emails, onboarding behavior, scheduled direct emails, and any source-side automation must be inventoried and rebuilt; no executable workflow is inferred from a post export."),
	parityGap("substack:surveys", "surveys", "Surveys", "Survey definitions and responses use a separate export surface and are not part of the uploaded publication ZIP contract."),
	parityGap("substack:media", "podcast_video_live", "Podcasts, video, and live media", "Podcast feeds, private feed entitlements, audio/video files, transcripts, livestream settings, and distribution relationships require separate migration."),
	parityGap("substack:assets", "assets", "Images, thumbnails, and attachments", "Exported HTML can retain remote Substack CDN references, but image files, social thumbnails, downloads, and attachment ownership are not proven portable by this adapter."),
	parityGap("substack:publication_settings", "publication_settings", "Publication settings and web presence", "Theme, About/custom pages, navigation, custom domain, redirects, SEO/social metadata, embeds, and capture widgets must be recreated and tested."),
	parityGap("substack:engagement_history", "engagement_history", "Subscriber engagement and delivery history", "Aggregate delivery/open files can be counted without retaining recipient identities. Per-reader opens, views, clicks, activity scores, deliveries, and historical targeting are not replayed."),
	parityGap("substack:integrations", "integrations", "Integrations and operational dependencies", "Connected apps, analytics, pixels, webhooks, API clients, sender identities, DNS, reply routing, and operational credentials require explicit reauthorization or replacement."),
}

func (a *Adapter) ListSourceArchive(_ context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	if strings.TrimSpace(cursor) != "" {
		return nil, "", fmt.Errorf("substack: invalid source-archive cursor %q: %w", cursor, adapter.ErrSourceUnavailable)
	}
	inventory, err := exportInventoryItem(sess)
	if err != nil {
		return nil, "", err
	}
	items := make([]canonical.SourceArchiveItem, 0, 1+len(substackParityGaps))
	items = append(items, inventory)
	items = append(items, substackParityGaps...)
	return items, "", nil
}

func sourceArchiveItemCount(_ adapter.Session) int {
	return 1 + len(substackParityGaps)
}

func exportInventoryItem(sess adapter.Session) (canonical.SourceArchiveItem, error) {
	payload := map[string]interface{}{}
	if sess.Extra != nil {
		payload["export_fingerprint"] = sess.Extra["export_fingerprint"]
		payload["upload_name"] = sess.Extra["file_name"]
	}
	if manifestPath := firstNonEmpty(sess.Extra["bundle_manifest_path"]); manifestPath != "" {
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			return canonical.SourceArchiveItem{}, fmt.Errorf("substack: read export manifest: %w", err)
		}
		var manifest ExportManifest
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return canonical.SourceArchiveItem{}, fmt.Errorf("substack: decode export manifest: %w", err)
		}
		byExtension := map[string]int{}
		for _, entry := range manifest.Entries {
			byExtension[strings.ToLower(filepath.Ext(entry.Path))]++
		}
		payload["archive_sha256"] = manifest.ArchiveSHA256
		payload["entry_count"] = len(manifest.Entries)
		payload["entries_by_extension"] = byExtension
		payload["prepared_at"] = manifest.PreparedAt
	} else {
		subsPath, _ := pathsFromSession(sess)
		headers, err := csvHeaderFromPath(subsPath)
		if err != nil {
			return canonical.SourceArchiveItem{}, err
		}
		columns := make([]string, 0, len(headers))
		for column := range headers {
			columns = append(columns, column)
		}
		sort.Strings(columns)
		payload["subscriber_columns"] = columns
		payload["entry_count"] = 1
	}
	return canonical.SourceArchiveItem{
		SourceID:       "substack:export_inventory",
		ResourceType:   "substack_export_inventory",
		Name:           "Uploaded Substack export inventory",
		Status:         "preserved",
		Payload:        payload,
		SourcePlatform: canonical.SourceSubstack,
	}, nil
}

func parityGap(id, resourceType, name, detail string) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "parity_gap:" + resourceType,
		Name:           name,
		Status:         "manual_review",
		Payload:        map[string]interface{}{"detail": detail},
		SourcePlatform: canonical.SourceSubstack,
	}
}
