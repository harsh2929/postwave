// SPDX-License-Identifier: MIT

package mailerlite

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// --- MailerLite wire types ---

type mlSubscriber struct {
	ID             string                 `json:"id"`
	Email          string                 `json:"email"`
	Status         string                 `json:"status"` // active | unsubscribed | bounced | junk | unconfirmed
	Source         string                 `json:"source"`
	SubscribedAt   string                 `json:"subscribed_at"`
	UnsubscribedAt string                 `json:"unsubscribed_at"`
	CreatedAt      string                 `json:"created_at"`
	UpdatedAt      string                 `json:"updated_at"`
	Fields         map[string]interface{} `json:"fields"`
	Groups         []mlGroupRef           `json:"groups"`
	OptInIP        string                 `json:"optin_ip"`
	OptInAt        string                 `json:"opted_in_at"`
}

type mlGroupRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type mlGroup struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ActiveCount int    `json:"active_count"`
	TotalCount  int    `json:"total_count"`
}

type mlField struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Key  string `json:"key"`
	Type string `json:"type"`
}

type mlSegment struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Total int    `json:"total"`
}

type mlAutomation struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Enabled  bool            `json:"enabled"`
	Steps    json.RawMessage `json:"steps"`
	Triggers json.RawMessage `json:"triggers"`
	Raw      json.RawMessage `json:"-"`
}

type mlCampaignEmail struct {
	ID         string                 `json:"id"`
	Subject    string                 `json:"subject"`
	From       string                 `json:"from"`
	FromName   string                 `json:"from_name"`
	ReplyTo    string                 `json:"reply_to"`
	PlainText  string                 `json:"plain_text"`
	PreviewURL string                 `json:"preview_url"`
	Content    json.RawMessage        `json:"content"`
	Stats      map[string]interface{} `json:"stats"`
}

type mlCampaign struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Subject    string                 `json:"subject"`
	Status     string                 `json:"status"`
	FinishedAt string                 `json:"finished_at"`
	Stats      map[string]interface{} `json:"stats"`
	Emails     []mlCampaignEmail      `json:"emails"`
}

// --- mappers ---

func mapSubscriber(s mlSubscriber) canonical.Subscriber {
	// Unknown status defaults to disabled rather than enabled to avoid
	// promoting an unrecognised state into an actively-mailed bucket.
	status := canonical.StatusDisabled
	switch strings.ToLower(s.Status) {
	case "active":
		status = canonical.StatusEnabled
	case "unsubscribed":
		status = canonical.StatusDisabled
	case "bounced", "junk":
		status = canonical.StatusBlocklisted
	case "unconfirmed":
		status = canonical.StatusUnconfirmed
	}

	custom := map[string]interface{}{}
	for k, v := range s.Fields {
		custom[k] = v
	}
	preserveMailerLiteSubscriberEvidence(custom, "source", s.Source)
	preserveMailerLiteSubscriberEvidence(custom, "subscribed_at", s.SubscribedAt)
	preserveMailerLiteSubscriberEvidence(custom, "unsubscribed_at", s.UnsubscribedAt)
	preserveMailerLiteSubscriberEvidence(custom, "created_at", s.CreatedAt)
	preserveMailerLiteSubscriberEvidence(custom, "updated_at", s.UpdatedAt)
	preserveMailerLiteSubscriberEvidence(custom, "opted_in_at", s.OptInAt)
	preserveMailerLiteSubscriberEvidence(custom, "optin_ip", s.OptInIP)

	tags := make([]string, 0, len(s.Groups))
	for _, g := range s.Groups {
		if g.Name != "" {
			tags = append(tags, g.Name)
		}
	}

	consent := parseMailerLiteTime(s.OptInAt)
	src := canonical.ConsentUnknown
	if consent != nil {
		// opted_in_at is the only portable opt-in timestamp in the subscriber
		// response. subscribed_at is account-ingestion time and must not be
		// promoted into legal consent evidence.
		src = canonical.ConsentDoubleOptIn
	} else {
		switch strings.ToLower(strings.TrimSpace(s.Source)) {
		case "api":
			src = canonical.ConsentAPI
		case "import":
			src = canonical.ConsentImport
		case "form", "popup", "embedded form", "landing page", "website":
			// Without opted_in_at, a form-origin active record is evidence of
			// a single-step signup, but the API supplies no portable timestamp.
			if status == canonical.StatusEnabled {
				src = canonical.ConsentSingleOptIn
			}
		}
	}
	if status == canonical.StatusUnconfirmed {
		// Unconfirmed records have not completed double opt-in.
		consent = nil
		src = canonical.ConsentUnknown
	}

	return canonical.Subscriber{
		Email:            s.Email,
		Status:           status,
		ConsentTimestamp: consent,
		ConsentSource:    src,
		CustomFields:     custom,
		Tags:             tags,
		SourceID:         s.ID,
		SourcePlatform:   canonical.SourceMailerLite,
	}
}

func preserveMailerLiteSubscriberEvidence(fields map[string]interface{}, name, value string) {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		fields["postwave_mailerlite_"+name] = trimmed
	}
}

func parseMailerLiteTime(raw string) *time.Time {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return &t
		}
	}
	return nil
}

// translateSegment preserves MailerLite's saved-segment metadata for rebuild.
// The documented API exposes names, counts, and memberships, but not the
// dynamic predicate definition; inventing an executable AST would silently
// change future audience membership.
func translateSegment(s mlSegment) canonical.Segment {
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "rebuild_review",
		"source_id":      "mailerlite:segment:" + s.ID,
		"source":         s,
		"limitation":     "MailerLite Connect API does not expose saved-segment predicate definitions.",
	})
	name := strings.TrimSpace(s.Name)
	if name == "" {
		name = "MailerLite segment " + s.ID
	}
	return canonical.Segment{
		Name:             name,
		Description:      "MailerLite saved segment could not be translated automatically; metadata is preserved for rebuild/review.",
		QueryAST:         canonical.SegmentNode{Op: "mailerlite_saved_segment_review"},
		SourceDefinition: string(raw),
	}
}

func translateGroupAsSegment(g mlGroup) canonical.Segment {
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "group_membership",
		"source_id":      "mailerlite:group:" + g.ID,
		"source":         g,
	})
	return canonical.Segment{
		Name:        "Group: " + g.Name,
		Description: "MailerLite group membership mapped to a Moosewave tag-backed segment.",
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      g.Name,
		},
		SourceDefinition: string(raw),
	}
}

// translateAutomation deliberately creates a rebuild-only record. MailerLite
// exposes useful step and trigger metadata, but its graph uses provider-specific
// parent/branch semantics and does not expose rendered message bodies. It is
// unsafe to activate a partial translation as a Moosewave runtime workflow.
func translateAutomation(au mlAutomation) canonical.Automation {
	source := au.Raw
	if len(source) == 0 {
		source, _ = json.Marshal(au)
	}
	raw, _ := json.Marshal(map[string]interface{}{
		"migration_mode": "rebuild_review",
		"source_id":      "mailerlite:automation:" + strings.TrimSpace(au.ID),
		"source":         json.RawMessage(source),
		"limitation":     "MailerLite workflow metadata is preserved, but provider-specific graph semantics and message bodies are not activated automatically.",
	})
	name := strings.TrimSpace(au.Name)
	if name == "" {
		name = "MailerLite automation " + au.ID
	}
	return canonical.Automation{
		Name:             name,
		Status:           "draft",
		SourceDefinition: string(raw),
	}
}

func mapCampaign(c mlCampaign) canonical.CampaignArchive {
	sentAt := time.Time{}
	if parsed := parseMailerLiteTime(c.FinishedAt); parsed != nil {
		sentAt = *parsed
	}

	subject := strings.TrimSpace(c.Subject)
	html, text, previewURL := "", "", ""
	if len(c.Emails) > 0 {
		email := c.Emails[0]
		if strings.TrimSpace(email.Subject) != "" {
			subject = strings.TrimSpace(email.Subject)
		}
		text = email.PlainText
		previewURL = email.PreviewURL
		html, text = decodeCampaignContent(email.Content, text)
	}
	if subject == "" {
		subject = strings.TrimSpace(c.Name)
	}
	sent, opens, clicks := campaignAggregateStats(c)

	warnings := []string{}
	if html == "" {
		warnings = append(warnings, "MailerLite's documented campaign read API does not expose rendered HTML; metadata, plain text, preview reference, and aggregate report totals were preserved.")
	}
	emailVariants := make([]map[string]interface{}, 0, len(c.Emails))
	for _, email := range c.Emails {
		emailVariants = append(emailVariants, map[string]interface{}{
			"id":          email.ID,
			"subject":     email.Subject,
			"from":        email.From,
			"from_name":   email.FromName,
			"reply_to":    email.ReplyTo,
			"plain_text":  email.PlainText,
			"preview_url": email.PreviewURL,
			"stats":       email.Stats,
		})
	}
	if len(c.Emails) > 1 {
		warnings = append(warnings, "This campaign contains multiple email variants. Every API-visible variant is preserved in the report; the first variant is used as the canonical archive subject and plain-text body.")
	}
	report := map[string]interface{}{
		"status":      c.Status,
		"name":        c.Name,
		"preview_url": previewURL,
		"emails":      emailVariants,
		"stats": map[string]int{
			"sent":         sent,
			"opens_count":  opens,
			"clicks_count": clicks,
		},
	}

	return canonical.CampaignArchive{
		SourceID:        c.ID,
		Subject:         subject,
		HTML:            html,
		Text:            text,
		SentAt:          sentAt,
		RecipientsCount: sent,
		Opens:           opens,
		Clicks:          clicks,
		Report:          report,
		Warnings:        warnings,
		SourcePlatform:  canonical.SourceMailerLite,
	}
}

func campaignAggregateStats(c mlCampaign) (sent, opens, clicks int) {
	rootSent, rootHasSent := campaignStat(c.Stats, "sent")
	rootOpens, rootHasOpens := campaignStat(c.Stats, "opens_count")
	rootClicks, rootHasClicks := campaignStat(c.Stats, "clicks_count")
	for _, email := range c.Emails {
		value, _ := campaignStat(email.Stats, "sent")
		sent += value
		value, _ = campaignStat(email.Stats, "opens_count")
		opens += value
		value, _ = campaignStat(email.Stats, "clicks_count")
		clicks += value
	}
	if rootHasSent {
		sent = rootSent
	}
	if rootHasOpens {
		opens = rootOpens
	}
	if rootHasClicks {
		clicks = rootClicks
	}
	return sent, opens, clicks
}

func campaignStat(stats map[string]interface{}, key string) (int, bool) {
	value, ok := stats[key]
	if !ok {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case float32:
		return int(typed), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return int(parsed), true
		}
	}
	return 0, true
}

func decodeCampaignContent(raw json.RawMessage, fallbackText string) (string, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", fallbackText
	}
	var html string
	if err := json.Unmarshal(raw, &html); err == nil {
		return html, fallbackText
	}
	var legacy struct {
		HTML string `json:"html"`
		Text string `json:"plain"`
	}
	if err := json.Unmarshal(raw, &legacy); err == nil {
		if legacy.Text == "" {
			legacy.Text = fallbackText
		}
		return legacy.HTML, legacy.Text
	}
	return "", fallbackText
}
