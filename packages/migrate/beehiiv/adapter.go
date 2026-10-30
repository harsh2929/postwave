// SPDX-License-Identifier: MIT

// Package beehiiv implements the Beehiiv API v2 migration source adapter.
package beehiiv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	defaultBase = "https://api.beehiiv.com/v2"

	// Beehiiv documents 180 requests/minute per organization. We keep a small
	// safety margin because provider and local clocks are not synchronized.
	requestsPerMinute      = 170
	requestBurst           = 5
	maxOffsetPages         = 100
	maxProviderCursorBytes = 16 << 10
	// Bound the aggregate number of segment→subscription evidence links held in
	// memory while subscriber pages stream. Individual segments are capped by
	// API offset pagination; this account-wide ceiling prevents many small,
	// overlapping segments from exhausting a migration worker.
	maxSegmentMembershipEvidence = 250000

	maxJSONResponseBodyBytes int64 = 32 << 20

	WorkspaceIDExtraKey        = "beehiiv_workspace_id"
	PublicationIDExtraKey      = "beehiiv_publication_id"
	AccountFingerprintExtraKey = "beehiiv_account_fingerprint"
	// ArchiveClassificationCutoffExtraKey binds campaign and source-archive
	// partitioning to one durable run timestamp so a post cannot fall between
	// the two stages during a long or resumed migration.
	ArchiveClassificationCutoffExtraKey = "beehiiv_archive_classification_cutoff"
	publicationNameExtraKey             = "beehiiv_publication_name"
	workspaceNameExtraKey               = "beehiiv_workspace_name"
)

var ErrPublicationSelectionRequired = errors.New("beehiiv publication selection required")

func init() {
	adapter.Register(canonical.SourceBeehiiv, func() adapter.Adapter { return New() })
}

type segmentSnapshot struct {
	Segment   bhSegment
	Available bool
	Warning   string
}

type audienceSnapshot struct {
	Segments         []segmentSnapshot
	NewsletterLists  []bhNewsletterList
	TagsBySubscriber map[string][]string
	Warnings         []string
}

// Adapter implements adapter.Adapter for a single authenticated Beehiiv
// workspace/publication session. Cache entries contain only provider IDs and
// metadata; credentials always remain in adapter.Session.
type Adapter struct {
	http    *http.Client
	BaseURL string // overridable by package tests

	cacheMu       sync.Mutex
	audienceCache map[string]*audienceSnapshot
	cutoffMu      sync.Mutex
	cutoffs       map[string]time.Time
}

func New() *Adapter {
	return &Adapter{
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				// Never forward a bearer credential across a redirect boundary.
				return http.ErrUseLastResponse
			},
		},
		BaseURL:       defaultBase,
		audienceCache: make(map[string]*audienceSnapshot),
		cutoffs:       make(map[string]time.Time),
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{
		Source:     canonical.SourceBeehiiv,
		AuthMethod: "api_key",
	}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true // exact cutover snapshots; rules remain rebuild-only
	caps.Supports.Groups = true   // newsletter lists become membership tags/tag-backed segments
	caps.Supports.Automations = true
	caps.Supports.AutomationMode = "rebuild_review"
	caps.Supports.CampaignArchive = true
	// Premium membership is preserved on subscribers and in the source
	// archive. Billing objects and continuity are deliberately unsupported.
	caps.Supports.PaidSubs = false
	caps.Supports.ConsentTimestamps = false
	caps.Supports.Templates = false
	caps.Supports.Campaigns = true
	caps.Supports.Reports = true
	return caps
}

func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	apiKey := strings.TrimSpace(creds.APIKey)
	if apiKey == "" {
		return adapter.Session{}, fmt.Errorf("beehiiv: missing api_key: %w", adapter.ErrAuth)
	}
	sess := adapter.Session{
		AccessToken: apiKey,
		Source:      canonical.SourceBeehiiv,
		Extra:       cloneMap(creds.Extra),
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}

	var identity struct {
		Data bhWorkspace `json:"data"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/workspaces/identify", nil, &identity); err != nil {
		return adapter.Session{}, fmt.Errorf("beehiiv identify workspace: %w", err)
	}
	if !validPrefixedID(identity.Data.ID, "work_") {
		return adapter.Session{}, fmt.Errorf("beehiiv identify workspace returned an invalid workspace id: %w", adapter.ErrSourceUnavailable)
	}
	// Bind the organization limiter as soon as the provider reveals the
	// workspace so publication discovery shares the documented organization
	// budget even when multiple keys authenticate concurrently.
	sess.Extra[WorkspaceIDExtraKey] = identity.Data.ID
	if err := beehiivRequestLimiters.chargeIdentifiedWorkspace(identity.Data.ID); err != nil {
		return adapter.Session{}, fmt.Errorf("beehiiv account for workspace identification in organization rate limit: %w", err)
	}

	publications, err := a.listPublications(ctx, sess)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("beehiiv list publications: %w", err)
	}
	if len(publications) == 0 {
		return adapter.Session{}, fmt.Errorf("beehiiv: no publications available to this credential: %w", adapter.ErrAuth)
	}
	desired := firstNonEmpty(creds.AccountID, sess.Extra["publication_id"], sess.Extra[PublicationIDExtraKey])
	var selected bhPublication
	if desired == "" {
		if len(publications) != 1 {
			return adapter.Session{}, fmt.Errorf("%w: this workspace exposes %d publications; provide account_id/publication_id explicitly", ErrPublicationSelectionRequired, len(publications))
		}
		selected = publications[0]
	} else {
		if !validPrefixedID(desired, "pub_") {
			return adapter.Session{}, fmt.Errorf("beehiiv publication_id is invalid")
		}
		for _, publication := range publications {
			if publication.ID == desired {
				selected = publication
				break
			}
		}
		if selected.ID == "" {
			return adapter.Session{}, fmt.Errorf("beehiiv publication %q is not available to this credential: %w", desired, adapter.ErrAuth)
		}
	}
	if !validPrefixedID(selected.ID, "pub_") {
		return adapter.Session{}, fmt.Errorf("beehiiv publication inventory returned an invalid publication id: %w", adapter.ErrSourceUnavailable)
	}

	sess.AccountID = selected.ID
	sess.Extra[PublicationIDExtraKey] = selected.ID
	sess.Extra["publication_id"] = selected.ID // compatibility with existing clients
	sess.Extra[AccountFingerprintExtraKey] = accountFingerprint(identity.Data.ID, selected.ID)
	putSessionExtra(sess.Extra, publicationNameExtraKey, selected.Name)
	putSessionExtra(sess.Extra, workspaceNameExtraKey, identity.Data.Name)
	return sess, nil
}

// AccountFingerprint returns the stable, opaque workspace/publication binding
// established during Authenticate.
func AccountFingerprint(sess adapter.Session) string {
	if len(sess.Extra) == 0 {
		return ""
	}
	return strings.TrimSpace(sess.Extra[AccountFingerprintExtraKey])
}

func WorkspaceID(sess adapter.Session) string {
	if len(sess.Extra) == 0 {
		return ""
	}
	return strings.TrimSpace(sess.Extra[WorkspaceIDExtraKey])
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	if err := validateSession(sess); err != nil {
		return adapter.DiscoveryReport{}, err
	}
	snapshot, err := a.ensureAudienceSnapshot(ctx, sess)
	if err != nil {
		return adapter.DiscoveryReport{}, fmt.Errorf("beehiiv discover audiences: %w", err)
	}

	var report adapter.DiscoveryReport
	totalSubscribers, err := a.subscriptionCount(ctx, sess, "all")
	if err != nil {
		return report, fmt.Errorf("beehiiv discover subscriptions: %w", err)
	}
	report.SubscribersTotal = totalSubscribers
	report.SegmentsTotal = len(snapshot.Segments) + len(snapshot.NewsletterLists)
	report.GroupsTotal = len(snapshot.NewsletterLists)
	report.SnapshotMembershipCounts = make(map[string]int, len(snapshot.Segments)+len(snapshot.NewsletterLists))
	for _, list := range snapshot.NewsletterLists {
		report.SnapshotMembershipCounts[newsletterMembershipTag(list.ID)] = list.SubscriberCount
	}
	for _, segment := range snapshot.Segments {
		if segment.Available {
			report.SnapshotMembershipCounts[segmentMembershipTag(segment.Segment.ID)] = segment.Segment.TotalResults
		}
	}

	automations, err := a.listAutomations(ctx, sess)
	if err != nil {
		return report, fmt.Errorf("beehiiv discover automations: %w", err)
	}
	report.AutomationsTotal = len(automations)

	sentPosts, err := a.countSentNewsletters(ctx, sess)
	if err != nil {
		return report, fmt.Errorf("beehiiv discover posts: %w", err)
	}
	report.ArchiveTotal = sentPosts
	report.CampaignsTotal = sentPosts
	report.ReportsTotal = sentPosts

	premium, err := a.subscriptionCount(ctx, sess, "premium")
	if err != nil {
		return report, fmt.Errorf("beehiiv discover premium memberships: %w", err)
	}
	report.PaidSubsTotal = premium

	fields, err := a.listCustomFields(ctx, sess)
	if err != nil {
		return report, fmt.Errorf("beehiiv discover custom fields: %w", err)
	}
	for _, field := range fields {
		if name := strings.TrimSpace(field.Display); name != "" {
			report.CustomFields = append(report.CustomFields, name)
		}
	}
	report.CustomFields = uniqueStrings(report.CustomFields)
	report.Warnings = append(report.Warnings, snapshot.Warnings...)
	return report, nil
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	if err := validateSession(sess); err != nil {
		return nil, "", err
	}
	snapshot, err := a.ensureAudienceSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	values := url.Values{}
	values.Set("limit", "100")
	values.Set("status", "all")
	values.Set("tier", "all")
	for _, expansion := range []string{"custom_fields", "stats", "newsletter_lists", "subscription_premium_tiers"} {
		values.Add("expand[]", expansion)
	}
	if cursor = strings.TrimSpace(cursor); len(cursor) > maxProviderCursorBytes {
		return nil, "", fmt.Errorf("beehiiv subscriptions cursor is too large: %w", adapter.ErrSourceUnavailable)
	} else if cursor != "" {
		values.Set("cursor", cursor)
	}
	path, err := publicationPath(sess.AccountID, "/subscriptions", values)
	if err != nil {
		return nil, "", err
	}
	var response cursorResponse[bhSubscription]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", err
	}
	if len(response.Data) > 100 {
		return nil, "", fmt.Errorf("beehiiv subscriptions returned more than the requested limit: %w", adapter.ErrSourceUnavailable)
	}
	hasMore, next, err := validateArchiveCursorMetadata("subscriptions", cursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}
	if !hasMore {
		next = ""
	}
	if len(next) > maxProviderCursorBytes {
		return nil, "", fmt.Errorf("beehiiv subscriptions next_cursor is too large: %w", adapter.ErrSourceUnavailable)
	}
	out := make([]canonical.Subscriber, 0, len(response.Data))
	seenIDs := map[string]struct{}{}
	for _, subscription := range response.Data {
		if !validPrefixedID(subscription.ID, "sub_") || strings.TrimSpace(subscription.Email) == "" {
			return nil, "", fmt.Errorf("beehiiv subscriptions returned an incomplete subscriber identity: %w", adapter.ErrSourceUnavailable)
		}
		status := strings.TrimSpace(subscription.Status)
		if status == "" || len(status) > 64 || containsArchiveControlCharacter(status) || subscription.Created <= 0 {
			return nil, "", fmt.Errorf("beehiiv subscription %q omitted required status or creation provenance: %w", subscription.ID, adapter.ErrSourceUnavailable)
		}
		if err := validateSubscriptionAuthoritativePayload(&subscription); err != nil {
			return nil, "", err
		}
		if err := validateSubscriptionPremiumMetadata(&subscription); err != nil {
			return nil, "", err
		}
		if _, duplicate := seenIDs[subscription.ID]; duplicate {
			return nil, "", fmt.Errorf("beehiiv subscriptions returned a duplicate subscriber identity: %w", adapter.ErrSourceUnavailable)
		}
		seenIDs[subscription.ID] = struct{}{}
		seenListIDs := make(map[string]struct{}, len(subscription.NewsletterListIDs))
		for _, listID := range subscription.NewsletterListIDs {
			if !validPrefixedID(listID, "nl_list_") {
				return nil, "", fmt.Errorf("beehiiv subscriptions returned an invalid newsletter-list identity: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenListIDs[listID]; duplicate {
				return nil, "", fmt.Errorf("beehiiv subscription %q returned a duplicate newsletter-list identity: %w", subscription.ID, adapter.ErrSourceUnavailable)
			}
			seenListIDs[listID] = struct{}{}
		}
		out = append(out, mapSubscriber(subscription, sess.AccountID, snapshot.TagsBySubscriber[subscription.ID]))
	}
	return out, next, nil
}

func validateSubscriptionAuthoritativePayload(subscription *bhSubscription) error {
	if subscription == nil {
		return fmt.Errorf("beehiiv subscription payload is missing: %w", adapter.ErrSourceUnavailable)
	}
	id := strings.TrimSpace(subscription.ID)
	if !subscription.CustomFieldsPresent || subscription.CustomFieldsNull ||
		!subscription.NewsletterListIDsPresent || subscription.NewsletterListIDsNull ||
		!subscription.TagsPresent || subscription.TagsNull {
		return fmt.Errorf("beehiiv subscription %q omitted or returned null authoritative custom_fields, newsletter_list_ids, or tags arrays: %w", id, adapter.ErrSourceUnavailable)
	}

	seenFields := make(map[string]struct{}, len(subscription.CustomFields))
	for index := range subscription.CustomFields {
		field := &subscription.CustomFields[index]
		field.Name = strings.TrimSpace(field.Name)
		field.Kind = strings.ToLower(strings.TrimSpace(field.Kind))
		if field.Name == "" || len(field.Name) > 512 || containsArchiveControlCharacter(field.Name) {
			return fmt.Errorf("beehiiv subscription %q returned an invalid custom-field name: %w", id, adapter.ErrSourceUnavailable)
		}
		switch field.Kind {
		case "string", "integer", "boolean", "date", "datetime", "list", "double":
		default:
			return fmt.Errorf("beehiiv subscription %q returned custom field %q with invalid kind: %w", id, field.Name, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenFields[field.Name]; duplicate {
			return fmt.Errorf("beehiiv subscription %q returned duplicate custom field %q: %w", id, field.Name, adapter.ErrSourceUnavailable)
		}
		if !field.ValuePresent {
			return fmt.Errorf("beehiiv subscription %q returned custom field %q without an explicit value: %w", id, field.Name, adapter.ErrSourceUnavailable)
		}
		if !field.ValueNull && !validSubscriptionCustomFieldValue(field.Kind, field.Value) {
			return fmt.Errorf("beehiiv subscription %q returned custom field %q with a value that does not match kind %q: %w", id, field.Name, field.Kind, adapter.ErrSourceUnavailable)
		}
		seenFields[field.Name] = struct{}{}
	}

	seenTags := make(map[string]struct{}, len(subscription.Tags))
	for index, raw := range subscription.Tags {
		tag := strings.TrimSpace(raw)
		if tag == "" || len(tag) > 512 || containsArchiveControlCharacter(tag) {
			return fmt.Errorf("beehiiv subscription %q returned an invalid source tag: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenTags[tag]; duplicate {
			return fmt.Errorf("beehiiv subscription %q returned duplicate source tag %q: %w", id, tag, adapter.ErrSourceUnavailable)
		}
		seenTags[tag] = struct{}{}
		subscription.Tags[index] = tag
	}
	return nil
}

func validSubscriptionCustomFieldValue(kind string, value interface{}) bool {
	switch kind {
	case "string", "date", "datetime":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "integer":
		return validSubscriptionCustomFieldInteger(value)
	case "double":
		return validSubscriptionCustomFieldNumber(value)
	case "list":
		switch values := value.(type) {
		case []string:
			return true
		case []interface{}:
			for _, item := range values {
				if _, ok := item.(string); !ok {
					return false
				}
			}
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func validSubscriptionCustomFieldInteger(value interface{}) bool {
	switch number := value.(type) {
	case float64:
		return !math.IsNaN(number) && !math.IsInf(number, 0) && math.Trunc(number) == number && math.Abs(number) <= 1<<53
	case float32:
		converted := float64(number)
		return !math.IsNaN(converted) && !math.IsInf(converted, 0) && math.Trunc(converted) == converted
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	case json.Number:
		_, err := number.Int64()
		return err == nil
	default:
		return false
	}
}

func validSubscriptionCustomFieldNumber(value interface{}) bool {
	switch number := value.(type) {
	case float64:
		return !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		converted := float64(number)
		return !math.IsNaN(converted) && !math.IsInf(converted, 0)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	case json.Number:
		converted, err := number.Float64()
		return err == nil && !math.IsNaN(converted) && !math.IsInf(converted, 0)
	default:
		return false
	}
}

func validateSubscriptionPremiumMetadata(subscription *bhSubscription) error {
	if subscription == nil {
		return fmt.Errorf("beehiiv subscription premium metadata is missing: %w", adapter.ErrSourceUnavailable)
	}
	id := strings.TrimSpace(subscription.ID)
	tier := strings.ToLower(strings.TrimSpace(subscription.SubscriptionTier))
	if !subscription.SubscriptionTierPresent || (tier != "free" && tier != "premium") {
		return fmt.Errorf("beehiiv subscription %q omitted or returned an invalid subscription tier: %w", id, adapter.ErrSourceUnavailable)
	}
	if !subscription.PremiumTierNamesPresent || subscription.PremiumTierNamesNull || !subscription.PremiumTiersPresent || subscription.PremiumTiersNull {
		return fmt.Errorf("beehiiv subscription %q omitted or returned null premium-tier metadata requested by expansion: %w", id, adapter.ErrSourceUnavailable)
	}

	seenNames := make(map[string]struct{}, len(subscription.PremiumTierNames))
	for index, rawName := range subscription.PremiumTierNames {
		name := strings.TrimSpace(rawName)
		if name == "" || len(name) > 512 || containsArchiveControlCharacter(name) {
			return fmt.Errorf("beehiiv subscription %q returned invalid premium-tier name metadata: %w", id, adapter.ErrSourceUnavailable)
		}
		key := strings.ToLower(name)
		if _, duplicate := seenNames[key]; duplicate {
			return fmt.Errorf("beehiiv subscription %q returned duplicate premium-tier name metadata: %w", id, adapter.ErrSourceUnavailable)
		}
		seenNames[key] = struct{}{}
		subscription.PremiumTierNames[index] = name
	}

	seenIDs := make(map[string]struct{}, len(subscription.PremiumTiers))
	for index := range subscription.PremiumTiers {
		premiumTier := &subscription.PremiumTiers[index]
		premiumTier.ID = strings.TrimSpace(premiumTier.ID)
		premiumTier.Name = strings.TrimSpace(premiumTier.Name)
		premiumTier.Status = strings.TrimSpace(premiumTier.Status)
		if !validBoundedArchiveID(premiumTier.ID, "tier_") || premiumTier.Name == "" || len(premiumTier.Name) > 512 || containsArchiveControlCharacter(premiumTier.Name) || premiumTier.Status == "" || len(premiumTier.Status) > 64 || containsArchiveControlCharacter(premiumTier.Status) {
			return fmt.Errorf("beehiiv subscription %q returned an invalid expanded premium-tier object: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenIDs[premiumTier.ID]; duplicate {
			return fmt.Errorf("beehiiv subscription %q returned duplicate expanded premium-tier metadata: %w", id, adapter.ErrSourceUnavailable)
		}
		seenIDs[premiumTier.ID] = struct{}{}
	}
	subscription.SubscriptionTier = tier
	return nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	snapshot, err := a.ensureAudienceSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Segment, 0, len(snapshot.Segments)+len(snapshot.NewsletterLists))
	for _, item := range snapshot.Segments {
		out = append(out, snapshotSegment(item.Segment, item.Available, item.Warning))
	}
	for _, list := range snapshot.NewsletterLists {
		out = append(out, newsletterSegment(list))
	}
	return out, nil
}

func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	items, err := a.listAutomations(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Automation, 0, len(items))
	for _, item := range items {
		out = append(out, rebuildAutomation(item))
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	cutoff, err := a.archiveClassificationCutoff(sess)
	if err != nil {
		return nil, "", err
	}
	page, err := parsePageCursor(cursor)
	if err != nil {
		return nil, "", fmt.Errorf("beehiiv posts cursor: %w", err)
	}
	values := postListValues(page)
	path, err := publicationPath(sess.AccountID, "/posts", values)
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[bhPost]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", err
	}
	more, err := validateArchivePageWithLimit("posts", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
	if err != nil {
		return nil, "", err
	}
	out := make([]canonical.CampaignArchive, 0, len(response.Data))
	for _, summary := range response.Data {
		if !postIsSentNewsletter(summary, cutoff) {
			continue
		}
		post, payload, detailErr := a.getPost(ctx, sess, summary.ID)
		if detailErr != nil {
			return nil, "", fmt.Errorf("load expanded Beehiiv post %q: %w", summary.ID, detailErr)
		}
		if !postIsSentNewsletter(post, cutoff) {
			return nil, "", fmt.Errorf("Beehiiv post %q changed classification while its archive page was being read: %w", summary.ID, adapter.ErrSourceUnavailable)
		}
		if err := validateExpandedSentPostStats(summary.ID, payload); err != nil {
			return nil, "", err
		}
		out = append(out, mapPost(post, payload))
	}
	next := ""
	if more {
		next = strconv.Itoa(page + 1)
	}
	return out, next, nil
}

func validateExpandedSentPostStats(postID string, payload map[string]interface{}) error {
	stats, ok := payload["stats"].(map[string]interface{})
	if !ok || stats == nil {
		return fmt.Errorf("Beehiiv sent post %q omitted or returned invalid requested stats: %w", postID, adapter.ErrSourceUnavailable)
	}
	email, ok := stats["email"].(map[string]interface{})
	if !ok || email == nil {
		return fmt.Errorf("Beehiiv sent post %q omitted or returned invalid email stats: %w", postID, adapter.ErrSourceUnavailable)
	}
	for _, field := range []string{
		"recipients",
		"delivered",
		"opens",
		"unique_opens",
		"clicks",
		"unique_clicks",
		"unsubscribes",
		"spam_reports",
	} {
		if err := validateArchiveNonnegativeInteger(email, "sent post "+postID+" email stats", field); err != nil {
			return err
		}
	}
	return nil
}

func validateExpandedPostContent(postID string, payload map[string]interface{}) error {
	content, ok := payload["content"].(map[string]interface{})
	if !ok || content == nil {
		return fmt.Errorf("Beehiiv post %q omitted or returned invalid requested content expansions: %w", postID, adapter.ErrSourceUnavailable)
	}
	for section, fields := range map[string][]string{
		"free":    {"email", "web", "rss"},
		"premium": {"email", "web"},
	} {
		values, ok := content[section].(map[string]interface{})
		if !ok || values == nil {
			return fmt.Errorf("Beehiiv post %q omitted or returned invalid %s content expansion: %w", postID, section, adapter.ErrSourceUnavailable)
		}
		for _, field := range fields {
			if value, present := values[field]; !present {
				return fmt.Errorf("Beehiiv post %q omitted requested %s_%s content expansion: %w", postID, section, field, adapter.ErrSourceUnavailable)
			} else if _, ok := value.(string); !ok {
				return fmt.Errorf("Beehiiv post %q returned invalid %s_%s content expansion: %w", postID, section, field, adapter.ErrSourceUnavailable)
			}
		}
	}
	return nil
}

func (a *Adapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, fmt.Errorf("Beehiiv billing objects are not imported; preserve premium membership metadata and plan billing continuity separately: %w", adapter.ErrUnsupported)
}

func (a *Adapter) ensureAudienceSnapshot(ctx context.Context, sess adapter.Session) (*audienceSnapshot, error) {
	if err := validateSession(sess); err != nil {
		return nil, err
	}
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	if cached := a.audienceCache[sess.AccountID]; cached != nil {
		return cached, nil
	}

	segments, err := a.listSegments(ctx, sess)
	if err != nil {
		return nil, err
	}
	lists, err := a.listNewsletterLists(ctx, sess)
	if err != nil {
		return nil, err
	}
	snapshot := &audienceSnapshot{
		NewsletterLists:  lists,
		TagsBySubscriber: make(map[string][]string),
	}
	membershipEvidence := 0
	for _, segment := range segments {
		item := segmentSnapshot{Segment: segment}
		switch {
		case segment.TotalResults < 0:
			return nil, fmt.Errorf("Beehiiv segment %q returned a negative member count: %w", segment.Name, adapter.ErrSourceUnavailable)
		case !strings.EqualFold(segment.Status, "completed"):
			item.Warning = fmt.Sprintf("Beehiiv segment %q is %s; membership was not snapshotted and requires manual rebuild.", segment.Name, firstNonEmpty(segment.Status, "not completed"))
		case segment.TotalResults > maxOffsetPages*100:
			item.Warning = fmt.Sprintf("Beehiiv segment %q has %d members, exceeding the API v2 offset-pagination limit; no partial membership was imported.", segment.Name, segment.TotalResults)
		case !segmentMembershipBudgetAllows(membershipEvidence, segment.TotalResults):
			item.Warning = fmt.Sprintf("Beehiiv segment %q would raise account-wide membership evidence above the %d-link worker safety limit; no partial membership was imported and the segment requires manual rebuild.", segment.Name, maxSegmentMembershipEvidence)
		default:
			members, memberErr := a.listSegmentMemberIDs(ctx, sess, segment)
			if memberErr != nil {
				return nil, memberErr
			}
			membershipEvidence += len(members)
			item.Available = true
			for _, subscriptionID := range members {
				snapshot.TagsBySubscriber[subscriptionID] = append(snapshot.TagsBySubscriber[subscriptionID], segmentMembershipTag(segment.ID))
			}
		}
		if item.Warning != "" {
			snapshot.Warnings = append(snapshot.Warnings, item.Warning)
		}
		snapshot.Segments = append(snapshot.Segments, item)
	}
	for id, tags := range snapshot.TagsBySubscriber {
		snapshot.TagsBySubscriber[id] = uniqueStrings(tags)
	}
	a.audienceCache[sess.AccountID] = snapshot
	return snapshot, nil
}

func segmentMembershipBudgetAllows(used, next int) bool {
	return used >= 0 && next >= 0 && used <= maxSegmentMembershipEvidence && next <= maxSegmentMembershipEvidence-used
}

func (a *Adapter) listPublications(ctx context.Context, sess adapter.Session) ([]bhPublication, error) {
	var out []bhPublication
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}}
		var response pageResponse[bhPublication]
		if err := a.do(ctx, sess, http.MethodGet, "/publications?"+values.Encode(), nil, &response); err != nil {
			return nil, err
		}
		more, pageErr := validateArchivePageWithLimit("publications", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, pageErr
		}
		for _, publication := range response.Data {
			id := strings.TrimSpace(publication.ID)
			if !validBoundedArchiveID(id, "pub_") {
				return nil, fmt.Errorf("Beehiiv publications returned invalid id %q: %w", id, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[id]; duplicate {
				return nil, fmt.Errorf("Beehiiv publications returned duplicate id %q across pages: %w", id, adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			out = append(out, publication)
		}
		if !more {
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv publication pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listSegments(ctx context.Context, sess adapter.Session) ([]bhSegment, error) {
	var out []bhSegment
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}, "expand[]": {"stats"}}
		path, err := publicationPath(sess.AccountID, "/segments", values)
		if err != nil {
			return nil, err
		}
		var response pageResponse[bhSegment]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		more, pageErr := validateArchivePageWithLimit("segments", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, pageErr
		}
		for _, segment := range response.Data {
			id := strings.TrimSpace(segment.ID)
			if !validBoundedArchiveID(id, "seg_") || strings.TrimSpace(segment.Name) == "" || !segment.TotalResultsPresent || segment.TotalResults < 0 {
				return nil, fmt.Errorf("Beehiiv segments returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[id]; duplicate {
				return nil, fmt.Errorf("Beehiiv segments returned duplicate id %q across pages: %w", id, adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			out = append(out, segment)
		}
		if !more {
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv segment pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listSegmentMemberIDs(ctx context.Context, sess adapter.Session, segment bhSegment) ([]string, error) {
	if segment.TotalResults == 0 {
		return []string{}, nil
	}
	var out []string
	seenIDs := make(map[string]struct{}, segment.TotalResults)
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}}
		path, err := publicationPath(sess.AccountID, "/segments/"+url.PathEscape(segment.ID)+"/results", values)
		if err != nil {
			return nil, err
		}
		var response pageResponse[string]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, fmt.Errorf("snapshot Beehiiv segment %q: %w", segment.Name, err)
		}
		more, pageErr := validateArchivePageWithLimit("segment membership", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, fmt.Errorf("snapshot Beehiiv segment %q: %w", segment.Name, pageErr)
		}
		if response.TotalResults != nil && *response.TotalResults != segment.TotalResults {
			return nil, fmt.Errorf("Beehiiv segment %q membership total changed from %d to %d during the snapshot: %w", segment.Name, segment.TotalResults, *response.TotalResults, adapter.ErrSourceUnavailable)
		}
		for _, subscriptionID := range response.Data {
			subscriptionID = strings.TrimSpace(subscriptionID)
			if !validBoundedArchiveID(subscriptionID, "sub_") {
				return nil, fmt.Errorf("Beehiiv segment %q returned invalid subscription id %q: %w", segment.Name, subscriptionID, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenIDs[subscriptionID]; duplicate {
				return nil, fmt.Errorf("Beehiiv segment %q returned duplicate subscription id %q: %w", segment.Name, subscriptionID, adapter.ErrSourceUnavailable)
			}
			seenIDs[subscriptionID] = struct{}{}
			out = append(out, subscriptionID)
		}
		if !more {
			if len(out) != segment.TotalResults {
				return nil, fmt.Errorf("Beehiiv segment %q membership snapshot returned %d of %d IDs: %w", segment.Name, len(out), segment.TotalResults, adapter.ErrSourceUnavailable)
			}
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv segment %q pagination exceeded %d pages: %w", segment.Name, maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listNewsletterLists(ctx context.Context, sess adapter.Session) ([]bhNewsletterList, error) {
	var out []bhNewsletterList
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}}
		path, err := publicationPath(sess.AccountID, "/newsletter_lists", values)
		if err != nil {
			return nil, err
		}
		var response pageResponse[bhNewsletterList]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		more, pageErr := validateArchivePageWithLimit("newsletter lists", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, pageErr
		}
		for _, list := range response.Data {
			id := strings.TrimSpace(list.ID)
			if !validBoundedArchiveID(id, "nl_list_") || strings.TrimSpace(list.Name) == "" || !list.SubscriberCountPresent || list.SubscriberCount < 0 {
				return nil, fmt.Errorf("Beehiiv newsletter lists returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[id]; duplicate {
				return nil, fmt.Errorf("Beehiiv newsletter lists returned duplicate id %q across pages: %w", id, adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			out = append(out, list)
		}
		if !more {
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv newsletter-list pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listAutomations(ctx context.Context, sess adapter.Session) ([]bhAutomation, error) {
	var out []bhAutomation
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}, "expand[]": {"stats"}}
		path, err := publicationPath(sess.AccountID, "/automations", values)
		if err != nil {
			return nil, err
		}
		var response pageResponse[bhAutomation]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		more, pageErr := validateArchivePageWithLimit("automations", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, pageErr
		}
		for i := range response.Data {
			id := strings.TrimSpace(response.Data[i].ID)
			if !validBoundedArchiveID(id, "aut_") || strings.TrimSpace(response.Data[i].Name) == "" {
				return nil, fmt.Errorf("Beehiiv automations returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
			}
			if err := validateAutomationStats(response.Data[i].Stats, "automation "+id); err != nil {
				return nil, err
			}
			if _, duplicate := seen[id]; duplicate {
				return nil, fmt.Errorf("Beehiiv automations returned duplicate id %q across pages: %w", id, adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			emails, emailErr := a.listAutomationEmails(ctx, sess, response.Data[i].ID)
			if emailErr != nil {
				return nil, fmt.Errorf("preserve Beehiiv automation %q emails: %w", response.Data[i].Name, emailErr)
			}
			response.Data[i].Emails = emails
		}
		out = append(out, response.Data...)
		if !more {
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv automation pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listAutomationEmails(ctx context.Context, sess adapter.Session, automationID string) ([]bhAutomationEmail, error) {
	var out []bhAutomationEmail
	cursor := ""
	seenCursors := map[string]struct{}{}
	seenIDs := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}}
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		path, err := publicationPath(sess.AccountID, "/automations/"+url.PathEscape(automationID)+"/emails", values)
		if err != nil {
			return nil, err
		}
		var response cursorResponse[bhAutomationEmail]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		if len(response.Data) > 100 {
			return nil, fmt.Errorf("Beehiiv automation emails returned more than the requested limit: %w", adapter.ErrSourceUnavailable)
		}
		for _, email := range response.Data {
			id := strings.TrimSpace(email.ID)
			if id == "" || strings.TrimSpace(email.AutomationStepID) == "" {
				return nil, fmt.Errorf("Beehiiv automation emails returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seenIDs[id]; duplicate {
				return nil, fmt.Errorf("Beehiiv automation emails returned a duplicate identity: %w", adapter.ErrSourceUnavailable)
			}
			if err := validateAutomationEmailStats(email.Stats, id); err != nil {
				return nil, err
			}
			seenIDs[id] = struct{}{}
		}
		out = append(out, response.Data...)
		hasMore, next, cursorErr := validateArchiveCursorMetadata("automation emails", cursor, response.HasMore, response.NextCursor, len(response.Data))
		if cursorErr != nil {
			return nil, cursorErr
		}
		if !hasMore {
			return out, nil
		}
		if page == maxOffsetPages {
			return nil, fmt.Errorf("Beehiiv automation %q email inventory exceeded %d cursor pages: %w", automationID, maxOffsetPages, adapter.ErrUnsupported)
		}
		if len(next) > maxProviderCursorBytes {
			return nil, fmt.Errorf("Beehiiv automation emails next_cursor is too large: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenCursors[next]; duplicate {
			return nil, fmt.Errorf("Beehiiv automation emails returned a repeated cursor: %w", adapter.ErrSourceUnavailable)
		}
		seenCursors[next] = struct{}{}
		cursor = next
	}
	return nil, fmt.Errorf("Beehiiv automation %q email inventory exceeded %d cursor pages: %w", automationID, maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) listCustomFields(ctx context.Context, sess adapter.Session) ([]bhCustomFieldDefinition, error) {
	var out []bhCustomFieldDefinition
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}}
		path, err := publicationPath(sess.AccountID, "/custom_fields", values)
		if err != nil {
			return nil, err
		}
		var response pageResponse[bhCustomFieldDefinition]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		more, pageErr := validateArchivePageWithLimit("custom fields", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return nil, pageErr
		}
		for _, field := range response.Data {
			if err := validateCustomFieldDefinition(field); err != nil {
				return nil, err
			}
			if _, duplicate := seen[field.ID]; duplicate {
				return nil, fmt.Errorf("Beehiiv custom fields returned duplicate id %q: %w", field.ID, adapter.ErrSourceUnavailable)
			}
			seen[field.ID] = struct{}{}
			out = append(out, field)
		}
		if !more {
			return out, nil
		}
	}
	return nil, fmt.Errorf("Beehiiv custom-field pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func validateCustomFieldDefinition(field bhCustomFieldDefinition) error {
	id := strings.TrimSpace(field.ID)
	display := strings.TrimSpace(field.Display)
	kind := strings.ToLower(strings.TrimSpace(field.Kind))
	if id == "" || len(id) > maxArchiveProviderIDBytes || containsArchiveControlCharacter(id) {
		return fmt.Errorf("Beehiiv custom field returned an invalid id: %w", adapter.ErrSourceUnavailable)
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return fmt.Errorf("Beehiiv custom field returned an invalid id: %w", adapter.ErrSourceUnavailable)
		}
	}
	if display == "" || len(display) > 512 || containsArchiveControlCharacter(display) {
		return fmt.Errorf("Beehiiv custom field %q returned an invalid display name: %w", id, adapter.ErrSourceUnavailable)
	}
	switch kind {
	case "string", "integer", "boolean", "date", "datetime", "list", "double":
	default:
		return fmt.Errorf("Beehiiv custom field %q returned unsupported kind %q: %w", id, field.Kind, adapter.ErrSourceUnavailable)
	}
	if field.Created == nil || *field.Created <= 0 {
		return fmt.Errorf("Beehiiv custom field %q returned an invalid created timestamp: %w", id, adapter.ErrSourceUnavailable)
	}
	if kind != "list" && len(field.Options) > 0 {
		return fmt.Errorf("Beehiiv custom field %q returned options for non-list kind %q: %w", id, kind, adapter.ErrSourceUnavailable)
	}
	seenOptions := map[string]struct{}{}
	for _, option := range field.Options {
		option = strings.TrimSpace(option)
		if option == "" || len(option) > 1024 || containsArchiveControlCharacter(option) {
			return fmt.Errorf("Beehiiv custom field %q returned an invalid list option: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenOptions[option]; duplicate {
			return fmt.Errorf("Beehiiv custom field %q returned a duplicate list option: %w", id, adapter.ErrSourceUnavailable)
		}
		seenOptions[option] = struct{}{}
	}
	return nil
}

func (a *Adapter) subscriptionCount(ctx context.Context, sess adapter.Session, tier string) (int, error) {
	values := url.Values{"limit": {"1"}, "page": {"1"}, "status": {"all"}, "tier": {tier}}
	path, err := publicationPath(sess.AccountID, "/subscriptions", values)
	if err != nil {
		return 0, err
	}
	var response pageResponse[bhSubscription]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return 0, err
	}
	if response.TotalResults == nil || *response.TotalResults < 0 {
		return 0, fmt.Errorf("Beehiiv subscription count omitted total_results: %w", adapter.ErrSourceUnavailable)
	}
	return *response.TotalResults, nil
}

func (a *Adapter) countSentNewsletters(ctx context.Context, sess adapter.Session) (int, error) {
	cutoff, err := a.archiveClassificationCutoff(sess)
	if err != nil {
		return 0, err
	}
	total := 0
	seen := map[string]struct{}{}
	for page := 1; page <= maxOffsetPages; page++ {
		path, err := publicationPath(sess.AccountID, "/posts", postListValues(page))
		if err != nil {
			return 0, err
		}
		var response pageResponse[bhPost]
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
			return 0, err
		}
		more, pageErr := validateArchivePageWithLimit("posts", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
		if pageErr != nil {
			return 0, pageErr
		}
		for _, post := range response.Data {
			id := strings.TrimSpace(post.ID)
			if !validBoundedArchiveID(id, "post_") {
				return 0, fmt.Errorf("Beehiiv posts returned invalid id %q: %w", id, adapter.ErrSourceUnavailable)
			}
			if _, duplicate := seen[id]; duplicate {
				return 0, fmt.Errorf("Beehiiv posts returned duplicate id %q across pages: %w", id, adapter.ErrSourceUnavailable)
			}
			seen[id] = struct{}{}
			if postIsSentNewsletter(post, cutoff) {
				total++
			}
		}
		if !more {
			return total, nil
		}
	}
	return 0, fmt.Errorf("Beehiiv post pagination exceeded %d pages: %w", maxOffsetPages, adapter.ErrUnsupported)
}

func (a *Adapter) getPost(ctx context.Context, sess adapter.Session, postID string) (bhPost, map[string]interface{}, error) {
	postID = strings.TrimSpace(postID)
	if !validBoundedArchiveID(postID, "post_") {
		return bhPost{}, nil, fmt.Errorf("Beehiiv post returned an invalid id %q: %w", postID, adapter.ErrSourceUnavailable)
	}
	path, err := publicationPath(sess.AccountID, "/posts/"+url.PathEscape(postID), postExpansionValues())
	if err != nil {
		return bhPost{}, nil, err
	}
	var response struct {
		Data json.RawMessage `json:"data"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return bhPost{}, nil, err
	}
	if len(response.Data) == 0 || string(response.Data) == "null" {
		return bhPost{}, nil, fmt.Errorf("Beehiiv post %q detail response omitted data: %w", postID, adapter.ErrSourceUnavailable)
	}
	var post bhPost
	if err := json.Unmarshal(response.Data, &post); err != nil {
		return bhPost{}, nil, fmt.Errorf("decode Beehiiv post %q detail: %w", postID, adapter.ErrSourceUnavailable)
	}
	if strings.TrimSpace(post.ID) != postID {
		return bhPost{}, nil, fmt.Errorf("Beehiiv post detail id %q does not match requested id %q: %w", post.ID, postID, adapter.ErrSourceUnavailable)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(response.Data, &payload); err != nil || payload == nil {
		return bhPost{}, nil, fmt.Errorf("preserve Beehiiv post %q detail payload: %w", postID, adapter.ErrSourceUnavailable)
	}
	if err := validateExpandedPostContent(postID, payload); err != nil {
		return bhPost{}, nil, err
	}
	return post, payload, nil
}

func (a *Adapter) archiveClassificationCutoff(sess adapter.Session) (time.Time, error) {
	key := AccountFingerprint(sess)
	if key == "" {
		key = strings.TrimSpace(sess.AccountID)
	}
	if key == "" {
		return time.Time{}, fmt.Errorf("Beehiiv archive classification requires a bound publication: %w", adapter.ErrAuth)
	}
	var supplied time.Time
	if raw := strings.TrimSpace(sess.Extra[ArchiveClassificationCutoffExtraKey]); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil || parsed.Unix() <= 0 {
			return time.Time{}, fmt.Errorf("Beehiiv archive classification cutoff is invalid: %w", adapter.ErrSourceUnavailable)
		}
		supplied = parsed.UTC().Truncate(time.Second)
	}

	a.cutoffMu.Lock()
	defer a.cutoffMu.Unlock()
	if existing := a.cutoffs[key]; !existing.IsZero() {
		if !supplied.IsZero() && !existing.Equal(supplied) {
			return time.Time{}, fmt.Errorf("Beehiiv archive classification cutoff changed during one adapter run: %w", adapter.ErrSourceUnavailable)
		}
		return existing, nil
	}
	if supplied.IsZero() {
		supplied = time.Now().UTC().Truncate(time.Second)
	}
	a.cutoffs[key] = supplied
	return supplied, nil
}

func postListValues(page int) url.Values {
	return url.Values{
		"limit":     {"100"},
		"page":      {strconv.Itoa(page)},
		"status":    {"all"},
		"order_by":  {"publish_date"},
		"direction": {"asc"},
	}
	// The index remains intentionally lightweight. Expanded rendered HTML can
	// make a 100-post response exceed the bounded HTTP body limit; sent/source
	// posts are expanded one at a time through getPost instead.
}

func postExpansionValues() url.Values {
	values := url.Values{}
	for _, expansion := range []string{"stats", "free_web_content", "free_email_content", "free_rss_content", "premium_web_content", "premium_email_content"} {
		// Beehiiv's posts index/show contract names this parameter `expand`
		// (without brackets), unlike segments and automations.
		values.Add("expand", expansion)
	}
	return values
}

type pageResponse[T any] struct {
	Data         []T  `json:"data"`
	Limit        *int `json:"limit"`
	Page         *int `json:"page"`
	TotalResults *int `json:"total_results"`
	TotalPages   *int `json:"total_pages"`
}

type cursorResponse[T any] struct {
	Data       []T     `json:"data"`
	Limit      *int    `json:"limit"`
	HasMore    *bool   `json:"has_more"`
	NextCursor *string `json:"next_cursor"`
}

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if a.usesProductionBase() {
		limiter := limiterForSession(sess)
		if err := limiter.Wait(ctx); err != nil {
			return err
		}
	}
	base := strings.TrimRight(strings.TrimSpace(a.BaseURL), "/")
	if base == "" {
		base = defaultBase
	}
	endpoint, err := adapter.BuildURL(base, path)
	if err != nil {
		return fmt.Errorf("build Beehiiv request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("build Beehiiv request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("Beehiiv API request failed: %w: %w", adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return &adapter.ErrRateLimited{RetryAfter: retryDelay(resp.Header, time.Now())}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("Beehiiv rejected the credential or required scope: %w", adapter.ErrAuth)
	}
	if resp.StatusCode >= 500 {
		return fmt.Errorf("Beehiiv API returned status %d: %w", resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("Beehiiv API redirect refused: %w", adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode >= 400 {
		// Do not include provider response bodies: they can contain addresses,
		// IDs, or other source-account data and surface through job errors.
		return fmt.Errorf("Beehiiv API returned status %d", resp.StatusCode)
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("Beehiiv response body: %w", err)
		}
		return nil
	}
	if err := adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out); err != nil {
		return fmt.Errorf("decode Beehiiv response: %w", err)
	}
	return nil
}

func limiterForSession(sess adapter.Session) *adapter.TokenBucket {
	return beehiivRequestLimiters.forSession(sess)
}

func (a *Adapter) usesProductionBase() bool {
	base := strings.TrimRight(strings.TrimSpace(a.BaseURL), "/")
	return base == "" || base == defaultBase
}

func retryDelay(headers http.Header, now time.Time) time.Duration {
	value := strings.TrimSpace(headers.Get("Retry-After"))
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil && when.After(now) {
		return when.Sub(now)
	}
	reset := strings.TrimSpace(headers.Get("RateLimit-Reset"))
	if epoch, err := strconv.ParseInt(reset, 10, 64); err == nil {
		when := time.Unix(epoch, 0)
		if when.After(now) {
			return when.Sub(now)
		}
	}
	return 5 * time.Second
}

func publicationPath(publicationID, suffix string, values url.Values) (string, error) {
	if !validPrefixedID(publicationID, "pub_") {
		return "", fmt.Errorf("invalid Beehiiv publication id")
	}
	if !strings.HasPrefix(suffix, "/") || strings.Contains(suffix, "?") || strings.Contains(suffix, "#") {
		return "", fmt.Errorf("invalid Beehiiv publication path")
	}
	path := "/publications/" + url.PathEscape(publicationID) + suffix
	if len(values) > 0 {
		path += "?" + values.Encode()
	}
	return path, nil
}

func validateSession(sess adapter.Session) error {
	if strings.TrimSpace(sess.AccessToken) == "" {
		return fmt.Errorf("Beehiiv session has no credential: %w", adapter.ErrAuth)
	}
	publicationID := strings.TrimSpace(sess.AccountID)
	boundPublicationID := strings.TrimSpace(sess.Extra[PublicationIDExtraKey])
	workspaceID := WorkspaceID(sess)
	fingerprint := AccountFingerprint(sess)
	if sess.Source != canonical.SourceBeehiiv || !validPrefixedID(publicationID, "pub_") ||
		!validPrefixedID(boundPublicationID, "pub_") || publicationID != boundPublicationID ||
		!validPrefixedID(workspaceID, "work_") || fingerprint != accountFingerprint(workspaceID, boundPublicationID) {
		return fmt.Errorf("Beehiiv session has an invalid workspace/publication binding: %w", adapter.ErrAuth)
	}
	return nil
}

func validPrefixedID(value, prefix string) bool {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, prefix) || len(value) <= len(prefix) {
		return false
	}
	for _, r := range value[len(prefix):] {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}
	return true
}

func accountFingerprint(workspaceID, publicationID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(publicationID)))
	return hex.EncodeToString(digest[:])
}

func parsePageCursor(cursor string) (int, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 1, nil
	}
	page, err := strconv.Atoi(cursor)
	if err != nil || page < 1 || page > maxOffsetPages {
		return 0, fmt.Errorf("invalid page %q", cursor)
	}
	return page, nil
}

func hasNextPage(requested, responsePage, totalPages, count int) bool {
	current := responsePage
	if current < requested {
		current = requested
	}
	if totalPages > 0 {
		return current < totalPages
	}
	return count == 100
}

func putSessionExtra(extra map[string]string, key, value string) {
	if value = strings.TrimSpace(value); value != "" {
		extra[key] = value
	}
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
