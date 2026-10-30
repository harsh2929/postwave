// SPDX-License-Identifier: MIT

package beehiiv

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// Wire types below intentionally mirror the public Beehiiv v2 schema. Keep
// source-only fields even when there is no executable Moosewave equivalent so
// they can be retained in canonical report/source-definition payloads.

type bhWorkspace struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	OwnerEmail string `json:"owner_email"`
}

type bhPublication struct {
	ID                     string                 `json:"id"`
	Name                   string                 `json:"name"`
	OrganizationName       string                 `json:"organization_name"`
	ReferralProgramEnabled bool                   `json:"referral_program_enabled"`
	Created                float64                `json:"created"`
	Stats                  map[string]interface{} `json:"stats,omitempty"`
}

type bhSubscription struct {
	ID                       string                 `json:"id"`
	Email                    string                 `json:"email"`
	Status                   string                 `json:"status"`
	Created                  int64                  `json:"created"`
	SubscriptionTier         string                 `json:"subscription_tier"`
	PremiumTierNames         []string               `json:"subscription_premium_tier_names"`
	PremiumTiers             []bhSubscriptionTier   `json:"subscription_premium_tiers"`
	UTMSource                string                 `json:"utm_source"`
	UTMMedium                string                 `json:"utm_medium"`
	UTMChannel               string                 `json:"utm_channel"`
	UTMCampaign              string                 `json:"utm_campaign"`
	UTMTerm                  string                 `json:"utm_term"`
	UTMContent               string                 `json:"utm_content"`
	ReferringSite            string                 `json:"referring_site"`
	ReferralCode             string                 `json:"referral_code"`
	CustomFields             []bhCustomField        `json:"custom_fields"`
	Tags                     []string               `json:"tags"`
	Stats                    map[string]interface{} `json:"stats,omitempty"`
	NewsletterListIDs        []string               `json:"newsletter_list_ids"`
	StripeCustomerID         string                 `json:"stripe_customer_id,omitempty"`
	LegacySubscribedAt       string                 `json:"subscribed_at,omitempty"`
	LegacySubscriptionPaid   bool                   `json:"subscription_paid,omitempty"`
	CustomFieldsPresent      bool                   `json:"-"`
	CustomFieldsNull         bool                   `json:"-"`
	NewsletterListIDsPresent bool                   `json:"-"`
	NewsletterListIDsNull    bool                   `json:"-"`
	TagsPresent              bool                   `json:"-"`
	TagsNull                 bool                   `json:"-"`
	SubscriptionTierPresent  bool                   `json:"-"`
	PremiumTierNamesPresent  bool                   `json:"-"`
	PremiumTierNamesNull     bool                   `json:"-"`
	PremiumTiersPresent      bool                   `json:"-"`
	PremiumTiersNull         bool                   `json:"-"`
}

func (s *bhSubscription) UnmarshalJSON(data []byte) error {
	type subscriptionAlias bhSubscription
	var decoded subscriptionAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*s = bhSubscription(decoded)
	if raw, ok := fields["custom_fields"]; ok {
		s.CustomFieldsPresent = true
		s.CustomFieldsNull = rawJSONNull(raw)
	}
	if raw, ok := fields["newsletter_list_ids"]; ok {
		s.NewsletterListIDsPresent = true
		s.NewsletterListIDsNull = rawJSONNull(raw)
	}
	if raw, ok := fields["tags"]; ok {
		s.TagsPresent = true
		s.TagsNull = rawJSONNull(raw)
	}
	_, s.SubscriptionTierPresent = fields["subscription_tier"]
	if raw, ok := fields["subscription_premium_tier_names"]; ok {
		s.PremiumTierNamesPresent = true
		s.PremiumTierNamesNull = rawJSONNull(raw)
	}
	if raw, ok := fields["subscription_premium_tiers"]; ok {
		s.PremiumTiersPresent = true
		s.PremiumTiersNull = rawJSONNull(raw)
	}
	return nil
}

func rawJSONNull(raw json.RawMessage) bool {
	return strings.EqualFold(strings.TrimSpace(string(raw)), "null")
}

type bhSubscriptionTier struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type bhCustomField struct {
	Name         string      `json:"name"`
	Kind         string      `json:"kind,omitempty"`
	Value        interface{} `json:"value,omitempty"`
	ValuePresent bool        `json:"-"`
	ValueNull    bool        `json:"-"`
}

func (f *bhCustomField) UnmarshalJSON(data []byte) error {
	type customFieldAlias bhCustomField
	var decoded customFieldAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*f = bhCustomField(decoded)
	if raw, ok := fields["value"]; ok {
		f.ValuePresent = true
		f.ValueNull = rawJSONNull(raw)
	}
	return nil
}

// bhCustomFieldDefinition is the wire shape returned by
// GET /publications/{publicationId}/custom_fields. It is deliberately kept
// separate from bhCustomField: expanded subscription values use
// name/kind/value, while schema definitions use id/kind/display/created/options.
// Conflating the two shapes silently erased every discovered field name.
type bhCustomFieldDefinition struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	Display string   `json:"display"`
	Created *int64   `json:"created"`
	Options []string `json:"options,omitempty"`
}

type bhSegment struct {
	ID                  string                 `json:"id"`
	Name                string                 `json:"name"`
	Type                string                 `json:"type"`
	LastCalculated      *int64                 `json:"last_calculated"`
	TotalResults        int                    `json:"total_results"`
	Status              string                 `json:"status"`
	Active              bool                   `json:"active"`
	Stats               map[string]interface{} `json:"stats,omitempty"`
	TotalResultsPresent bool                   `json:"-"`
}

func (s *bhSegment) UnmarshalJSON(data []byte) error {
	type segmentAlias bhSegment
	var decoded segmentAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*s = bhSegment(decoded)
	_, s.TotalResultsPresent = fields["total_results"]
	return nil
}

type bhNewsletterList struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Slug                   string `json:"slug"`
	Description            string `json:"description"`
	Status                 string `json:"status"`
	AutoSubscribe          bool   `json:"auto_subscribe"`
	SubscriberCount        int    `json:"subscriber_count"`
	CreatedAt              int64  `json:"created_at"`
	UpdatedAt              int64  `json:"updated_at"`
	SubscriberCountPresent bool   `json:"-"`
}

func (l *bhNewsletterList) UnmarshalJSON(data []byte) error {
	type newsletterListAlias bhNewsletterList
	var decoded newsletterListAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*l = bhNewsletterList(decoded)
	_, l.SubscriberCountPresent = fields["subscriber_count"]
	return nil
}

type bhAutomation struct {
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	Status        string                 `json:"status"`
	TriggerEvents []string               `json:"trigger_events"`
	Description   string                 `json:"description,omitempty"`
	Stats         map[string]interface{} `json:"stats,omitempty"`
	Emails        []bhAutomationEmail    `json:"automation_emails,omitempty"`
}

type bhAutomationEmail struct {
	ID               string                 `json:"id"`
	AutomationStepID string                 `json:"automation_step_id"`
	SubjectLine      string                 `json:"subject_line"`
	PreviewText      string                 `json:"preview_text"`
	Status           string                 `json:"status"`
	FirstSentAt      *int64                 `json:"first_sent_at"`
	LastSentAt       *int64                 `json:"last_sent_at"`
	CreatedAt        int64                  `json:"created_at"`
	Stats            map[string]interface{} `json:"stats,omitempty"`
}

type bhPost struct {
	ID                     string                 `json:"id"`
	Subtitle               string                 `json:"subtitle"`
	Title                  string                 `json:"title"`
	Authors                []string               `json:"authors"`
	Created                int64                  `json:"created"`
	Status                 string                 `json:"status"`
	PublishDate            *int64                 `json:"publish_date"`
	DisplayedDate          *int64                 `json:"displayed_date"`
	SplitTested            bool                   `json:"split_tested"`
	SubjectLine            string                 `json:"subject_line"`
	PreviewText            string                 `json:"preview_text"`
	Slug                   string                 `json:"slug"`
	ThumbnailURL           string                 `json:"thumbnail_url"`
	WebURL                 string                 `json:"web_url"`
	PreviewURL             string                 `json:"preview_url"`
	Audience               string                 `json:"audience"`
	Platform               string                 `json:"platform"`
	ContentTags            []string               `json:"content_tags"`
	MetaDefaultDescription string                 `json:"meta_default_description"`
	MetaDefaultTitle       string                 `json:"meta_default_title"`
	NewsletterListID       string                 `json:"newsletter_list_id"`
	HiddenFromFeed         bool                   `json:"hidden_from_feed"`
	EnforceGatedContent    bool                   `json:"enforce_gated_content"`
	EmailCapturePopup      bool                   `json:"email_capture_popup"`
	RecipientCount         *int                   `json:"recipient_count"`
	Recipients             map[string]interface{} `json:"recipients,omitempty"`
	Headers                map[string]string      `json:"headers,omitempty"`
	Content                bhPostContent          `json:"content"`
	Stats                  bhPostStats            `json:"stats"`
}

type bhPostContent struct {
	Free struct {
		Web   string `json:"web"`
		Email string `json:"email"`
		RSS   string `json:"rss"`
	} `json:"free"`
	Premium struct {
		Web   string `json:"web"`
		Email string `json:"email"`
	} `json:"premium"`
}

type bhPostStats struct {
	Email struct {
		Recipients           int     `json:"recipients"`
		Delivered            int     `json:"delivered"`
		Opens                int     `json:"opens"`
		UniqueOpens          int     `json:"unique_opens"`
		OpenRate             float64 `json:"open_rate"`
		Clicks               int     `json:"clicks"`
		UniqueClicks         int     `json:"unique_clicks"`
		VerifiedClicks       int     `json:"verified_clicks"`
		UniqueVerifiedClicks int     `json:"unique_verified_clicks"`
		ClickRate            float64 `json:"click_rate"`
		Unsubscribes         int     `json:"unsubscribes"`
		SpamReports          int     `json:"spam_reports"`
	} `json:"email"`
	Web      map[string]interface{}   `json:"web,omitempty"`
	Clicks   []map[string]interface{} `json:"clicks,omitempty"`
	Upgrades *int                     `json:"upgrades,omitempty"`
}

func mapSubscriber(s bhSubscription, publicationID string, snapshotTags []string) canonical.Subscriber {
	status := canonical.StatusUnconfirmed
	switch strings.ToLower(strings.TrimSpace(s.Status)) {
	case "active":
		status = canonical.StatusEnabled
	case "inactive", "paused":
		status = canonical.StatusDisabled
	case "invalid":
		status = canonical.StatusBlocklisted
	case "validating", "pending", "needs_attention":
		status = canonical.StatusUnconfirmed
	}

	custom := make(map[string]interface{}, len(s.CustomFields)+16)
	customFieldKinds := map[string]string{}
	nullCustomFields := []string{}
	providerKeyCollisions := map[string]interface{}{}
	for _, field := range s.CustomFields {
		sourceName := strings.TrimSpace(field.Name)
		if sourceName == "" {
			continue
		}
		name := beehiivCustomFieldDestinationKey(sourceName)
		if kind := strings.TrimSpace(field.Kind); kind != "" {
			customFieldKinds[name] = kind
		}
		if name != sourceName {
			// Reserved Moosewave/provider namespaces are control data in the
			// destination. Preserve an injectively escaped targeting key plus an
			// explicit original-to-destination ledger rather than reinterpreting or
			// dropping a legitimate Beehiiv field.
			providerKeyCollisions[sourceName] = map[string]interface{}{
				"destination_key": name,
				"kind":            strings.TrimSpace(field.Kind),
			}
		}
		if field.Value != nil {
			custom[name] = field.Value
		} else {
			nullCustomFields = append(nullCustomFields, name)
		}
	}
	provider := map[string]interface{}{
		"publication_id": publicationID,
		"status":         s.Status,
	}
	if s.Created > 0 {
		created := time.Unix(s.Created, 0).UTC()
		provider["subscription_created_at"] = created.Format(time.RFC3339)
	}
	provider["subscription_tier"] = strings.ToLower(strings.TrimSpace(s.SubscriptionTier))
	provider["subscription_premium_tier_names"] = append([]string{}, s.PremiumTierNames...)
	provider["subscription_premium_tiers"] = append([]bhSubscriptionTier{}, s.PremiumTiers...)
	putString(provider, "utm_source", s.UTMSource)
	putString(provider, "utm_medium", s.UTMMedium)
	putString(provider, "utm_channel", s.UTMChannel)
	putString(provider, "utm_campaign", s.UTMCampaign)
	putString(provider, "utm_term", s.UTMTerm)
	putString(provider, "utm_content", s.UTMContent)
	putString(provider, "referring_site", s.ReferringSite)
	putString(provider, "referral_code", s.ReferralCode)
	putString(provider, "stripe_customer_id", s.StripeCustomerID)
	putStrings(provider, "newsletter_list_ids", s.NewsletterListIDs)
	if len(s.Stats) > 0 {
		provider["stats"] = s.Stats
	}
	if len(customFieldKinds) > 0 {
		provider["custom_field_kinds"] = customFieldKinds
	}
	if len(nullCustomFields) > 0 {
		provider["null_custom_fields"] = uniqueStrings(nullCustomFields)
	}
	if len(providerKeyCollisions) > 0 {
		provider["custom_field_name_collisions"] = providerKeyCollisions
	}
	custom["beehiiv"] = provider

	tags := make([]string, 0, len(s.Tags)+len(s.NewsletterListIDs)+len(snapshotTags))
	tagCollisions := map[string]string{}
	for _, sourceTag := range s.Tags {
		sourceTag = strings.TrimSpace(sourceTag)
		if sourceTag == "" {
			continue
		}
		destinationTag := beehiivSourceTagDestination(sourceTag)
		if destinationTag != sourceTag {
			tagCollisions[sourceTag] = destinationTag
		}
		tags = append(tags, destinationTag)
	}
	if len(s.Tags) > 0 {
		provider["source_tags"] = uniqueStrings(s.Tags)
	}
	if len(tagCollisions) > 0 {
		provider["source_tag_namespace_collisions"] = tagCollisions
	}
	for _, listID := range s.NewsletterListIDs {
		if listID = strings.TrimSpace(listID); listID != "" {
			tags = append(tags, newsletterMembershipTag(listID))
		}
	}
	tags = append(tags, snapshotTags...)
	tags = uniqueStrings(tags)

	return canonical.Subscriber{
		Email:            strings.TrimSpace(s.Email),
		Status:           status,
		ConsentTimestamp: nil,
		ConsentSource:    canonical.ConsentUnknown,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         strings.TrimSpace(s.ID),
		SourcePlatform:   canonical.SourceBeehiiv,
	}
}

func snapshotSegment(segment bhSegment, available bool, warning string) canonical.Segment {
	definition := map[string]interface{}{
		"migration_mode": "static_membership_snapshot",
		"source_id":      segmentMembershipTag(segment.ID),
		"source":         segment,
		"warning":        strings.TrimSpace(warning),
	}
	raw, _ := json.Marshal(definition)
	query := canonical.SegmentNode{
		Op:         "condition",
		Field:      "tag",
		Comparator: "equals",
		Value:      segmentMembershipTag(segment.ID),
	}
	description := "Frozen membership snapshot from Beehiiv; the source API does not expose the segment rule definition, so dynamic behavior must be rebuilt."
	if !available {
		query = canonical.SegmentNode{Op: "unsupported"}
		description = "Beehiiv segment metadata preserved for manual rebuild; an exact membership snapshot was unavailable."
	}
	return canonical.Segment{
		Name:             segment.Name,
		Description:      description,
		QueryAST:         query,
		SourceDefinition: string(raw),
	}
}

func newsletterSegment(list bhNewsletterList) canonical.Segment {
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "newsletter_list_membership",
		"source_id":      newsletterMembershipTag(list.ID),
		"source":         list,
	})
	return canonical.Segment{
		Name:             list.Name,
		Description:      "Beehiiv newsletter-list membership mapped to a Moosewave tag-backed segment.",
		QueryAST:         canonical.SegmentNode{Op: "condition", Field: "tag", Comparator: "equals", Value: newsletterMembershipTag(list.ID)},
		SourceDefinition: string(raw),
	}
}

func rebuildAutomation(automation bhAutomation) canonical.Automation {
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "rebuild_review",
		"source_id":      "beehiiv:automation:" + strings.TrimSpace(automation.ID),
		"source":         automation,
		"limitation":     "Beehiiv API v2 exposes automation metadata, trigger-event labels, email metadata, and statistics, but not the executable step graph or message bodies.",
	})
	return canonical.Automation{
		Name:             automation.Name,
		Status:           "draft",
		Triggers:         nil,
		Nodes:            nil,
		Edges:            nil,
		SourceDefinition: string(raw),
	}
}

func mapPost(post bhPost, sourcePayload map[string]interface{}) canonical.CampaignArchive {
	subject := strings.TrimSpace(post.SubjectLine)
	if subject == "" {
		subject = strings.TrimSpace(post.Title)
	}
	html := firstNonEmpty(post.Content.Free.Email, post.Content.Free.Web, post.Content.Free.RSS, post.Content.Premium.Email, post.Content.Premium.Web)
	warnings := []string{"Beehiiv does not expose a plain-text rendering for posts; the archived text body is empty."}
	if post.Content.Free.Email == "" && post.Content.Free.Web == "" && (post.Content.Premium.Email != "" || post.Content.Premium.Web != "") {
		warnings = append(warnings, "Only premium-rendered HTML was available for this post.")
	}
	if html == "" {
		warnings = append(warnings, "No expanded post HTML was returned by Beehiiv.")
	}
	sentAt := time.Time{}
	if post.PublishDate != nil && *post.PublishDate > 0 {
		sentAt = time.Unix(*post.PublishDate, 0).UTC()
	}
	recipientsCount := post.Stats.Email.Recipients
	if recipientsCount <= 0 && post.RecipientCount != nil && *post.RecipientCount >= 0 {
		recipientsCount = *post.RecipientCount
	}
	report := map[string]interface{}{
		"title":                    post.Title,
		"subtitle":                 post.Subtitle,
		"authors":                  post.Authors,
		"status":                   post.Status,
		"created":                  post.Created,
		"publish_date":             post.PublishDate,
		"displayed_date":           post.DisplayedDate,
		"recipient_count":          post.RecipientCount,
		"audience":                 post.Audience,
		"platform":                 post.Platform,
		"split_tested":             post.SplitTested,
		"preview_text":             post.PreviewText,
		"slug":                     post.Slug,
		"web_url":                  post.WebURL,
		"preview_url":              post.PreviewURL,
		"thumbnail_url":            post.ThumbnailURL,
		"content_tags":             post.ContentTags,
		"newsletter_list_id":       post.NewsletterListID,
		"meta_default_title":       post.MetaDefaultTitle,
		"meta_default_description": post.MetaDefaultDescription,
		"hidden_from_feed":         post.HiddenFromFeed,
		"enforce_gated_content":    post.EnforceGatedContent,
		"email_capture_popup":      post.EmailCapturePopup,
		"recipients":               post.Recipients,
		"headers":                  post.Headers,
		"stats":                    sourcePayload["stats"],
		"content":                  sourcePayload["content"],
	}
	return canonical.CampaignArchive{
		SourceID:        post.ID,
		Subject:         subject,
		HTML:            html,
		Text:            "",
		SentAt:          sentAt,
		RecipientsCount: recipientsCount,
		Opens:           post.Stats.Email.Opens,
		Clicks:          post.Stats.Email.Clicks,
		Report:          report,
		Warnings:        warnings,
		SourcePlatform:  canonical.SourceBeehiiv,
	}
}

func postIsSentNewsletter(post bhPost, now time.Time) bool {
	status := strings.ToLower(strings.TrimSpace(post.Status))
	if status != "confirmed" && status != "archived" {
		return false
	}
	platform := strings.ToLower(strings.TrimSpace(post.Platform))
	if platform != "email" && platform != "both" {
		return false
	}
	return post.PublishDate != nil && *post.PublishDate > 0 && !time.Unix(*post.PublishDate, 0).After(now)
}

func segmentMembershipTag(id string) string {
	return "beehiiv:segment:" + strings.TrimSpace(id)
}

func newsletterMembershipTag(id string) string {
	return "beehiiv:newsletter-list:" + strings.TrimSpace(id)
}

const (
	beehiivEscapedCustomFieldPrefix = "beehiiv_custom_field__"
	beehiivEscapedSourceTagPrefix   = "beehiiv:source-tag:"
)

func beehiivCustomFieldDestinationKey(name string) string {
	name = strings.TrimSpace(name)
	lower := strings.ToLower(name)
	if lower == "beehiiv" || strings.HasPrefix(lower, "postwave_") || strings.HasPrefix(lower, beehiivEscapedCustomFieldPrefix) {
		return beehiivEscapedCustomFieldPrefix + hex.EncodeToString([]byte(name))
	}
	return name
}

func beehiivSourceTagDestination(tag string) string {
	tag = strings.TrimSpace(tag)
	lower := strings.ToLower(tag)
	if strings.HasPrefix(lower, "beehiiv:segment:") || strings.HasPrefix(lower, "beehiiv:newsletter-list:") || strings.HasPrefix(lower, beehiivEscapedSourceTagPrefix) {
		return beehiivEscapedSourceTagPrefix + hex.EncodeToString([]byte(tag))
	}
	return tag
}

func putString(dst map[string]interface{}, key, value string) {
	if value = strings.TrimSpace(value); value != "" {
		dst[key] = value
	}
}

func putStrings(dst map[string]interface{}, key string, values []string) {
	if values = uniqueStrings(values); len(values) > 0 {
		dst[key] = values
	}
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func rawPayload(value interface{}) map[string]interface{} {
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]interface{}{"preservation_error": fmt.Sprintf("marshal source payload: %v", err)}
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]interface{}{"preservation_error": fmt.Sprintf("decode source payload: %v", err)}
	}
	return out
}
