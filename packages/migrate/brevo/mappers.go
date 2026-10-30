// SPDX-License-Identifier: MIT

package brevo

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

// --- Brevo wire types (subset; only fields we map) ---

// brevoAccount is the response from GET /v3/account.
type brevoAccount struct {
	OrganizationID string `json:"organization_id"`
	UserID         int64  `json:"user_id"`
	Email          string `json:"email"`
	FirstName      string `json:"firstName"`
	LastName       string `json:"lastName"`
	CompanyName    string `json:"companyName"`
}

// brevoContact is one row from GET /v3/contacts.
type brevoContact struct {
	Email               string                 `json:"email"`
	ID                  int64                  `json:"id"`
	EmailBlacklisted    *bool                  `json:"emailBlacklisted"`
	SmsBlacklisted      bool                   `json:"smsBlacklisted"`
	WhatsappBlacklisted *bool                  `json:"whatsappBlacklisted"`
	ListUnsubscribed    []int64                `json:"listUnsubscribed"`
	ConsentGroups       []brevoConsentGroup    `json:"consentGroups"`
	CreatedAt           string                 `json:"createdAt"`
	ModifiedAt          string                 `json:"modifiedAt"`
	Attributes          map[string]interface{} `json:"attributes"`
	ListIDs             []int64                `json:"listIds"`
}

type brevoConsentGroup struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// brevoList is one row from GET /v3/contacts/lists.
type brevoList struct {
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	TotalSubscribers  int    `json:"totalSubscribers"`
	TotalBlacklisted  int    `json:"totalBlacklisted"`
	UniqueSubscribers int    `json:"uniqueSubscribers"`
	FolderID          int64  `json:"folderId"`
}

// brevoSegment is one row from GET /v3/contacts/segments.
type brevoSegment struct {
	ID           int64  `json:"id"`
	Segment      string `json:"segment"`
	SegmentName  string `json:"segmentName"`
	CategoryName string `json:"categoryName"`
	CategoryID   int64  `json:"categoryId"`
}

// brevoCampaign is one row from GET /v3/emailCampaigns.
type brevoCampaign struct {
	ABTesting   bool               `json:"abTesting"`
	SubjectA    string             `json:"subjectA"`
	SubjectB    string             `json:"subjectB"`
	ID          int64              `json:"id"`
	Name        string             `json:"name"`
	Subject     string             `json:"subject"`
	Status      string             `json:"status"` // draft|sent|archive|queued|suspended|in_process
	Type        string             `json:"type"`
	HTMLContent string             `json:"htmlContent"`
	SentDate    string             `json:"sentDate"`
	CreatedAt   string             `json:"createdAt"`
	ModifiedAt  string             `json:"modifiedAt"`
	Statistics  brevoCampaignStats `json:"statistics"`
	Recipients  struct {
		Lists      []int64 `json:"lists"`
		Exclusions []int64 `json:"exclusionLists"`
	} `json:"recipients"`
}

type brevoCampaignStats struct {
	Raw         map[string]interface{} `json:"-"`
	GlobalStats struct {
		UniqueViews  *int `json:"uniqueViews"`
		Viewed       int  `json:"viewed"`
		UniqueClicks *int `json:"uniqueClicks"`
		Clickers     int  `json:"clickers"`
		Delivered    int  `json:"delivered"`
		Sent         *int `json:"sent"`
		Unsubscribed int  `json:"unsubscriptions"`
	} `json:"globalStats"`
}

func (s *brevoCampaignStats) UnmarshalJSON(data []byte) error {
	type wire brevoCampaignStats
	var parsed wire
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*s = brevoCampaignStats(parsed)
	s.Raw = raw
	return nil
}

// Legacy offline workflow fixture model. No public Brevo graph endpoint is
// advertised or called by this adapter.
type brevoWorkflow struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"` // active | paused | draft
	Trigger     struct {
		Type   string `json:"type"`
		ListID int64  `json:"listId"`
		Tag    string `json:"tag"`
		Event  string `json:"event"`
	} `json:"trigger"`
	Steps []brevoWorkflowStep `json:"steps"`
}

type brevoWorkflowStep struct {
	ID         string `json:"id"`
	Type       string `json:"type"` // delay | email | condition | action
	DelaySecs  int64  `json:"delaySeconds"`
	TemplateID int64  `json:"templateId"`
	NextID     string `json:"nextStepId"`
}

// --- mappers ---

// mapBrevoContactToCanonical converts a Brevo contact into the canonical
// Subscriber record. Email is normalized to lowercase and trimmed; missing
// fields fall through to canonical zero values.
func mapBrevoContactToCanonical(c brevoContact) canonical.Subscriber {
	status := deriveStatus(c.EmailBlacklisted)
	// Keep scoped opt-outs unsendable until destination consent-group and
	// list-level targeting can enforce every restriction independently.
	if len(c.ListUnsubscribed) > 0 {
		status = canonical.StatusDisabled
	}
	for _, group := range c.ConsentGroups {
		if group.Status != "subscribed" {
			status = canonical.StatusDisabled
		}
	}

	custom := map[string]interface{}{}
	for k, v := range normalizeAttributes(c.Attributes) {
		custom[k] = v
	}

	tags := mapListIDsToTags(c.ListIDs)

	// Contact creation is not an opt-in event. Keep source dates as provenance
	// without manufacturing permission evidence from them.
	custom["brevo_created_at"] = c.CreatedAt
	custom["brevo_modified_at"] = c.ModifiedAt
	custom["brevo_email_blacklisted"] = c.EmailBlacklisted
	custom["brevo_sms_blacklisted"] = c.SmsBlacklisted
	custom["brevo_whatsapp_blacklisted"] = c.WhatsappBlacklisted
	custom["brevo_list_unsubscribed"] = c.ListUnsubscribed
	custom["brevo_consent_groups"] = c.ConsentGroups

	return canonical.Subscriber{
		Email:          strings.ToLower(strings.TrimSpace(c.Email)),
		Status:         status,
		ConsentSource:  canonical.ConsentUnknown,
		CustomFields:   custom,
		Tags:           tags,
		SourceID:       strconv.FormatInt(c.ID, 10),
		SourcePlatform: canonical.SourceBrevo,
	}
}

// deriveStatus collapses Brevo's blacklist booleans into canonical statuses.
// Brevo only marks a contact unsubscribed via emailBlacklisted; SMS blacklist
// is orthogonal and does not block email migration, so we ignore it.
func deriveStatus(emailBlacklisted *bool) canonical.SubscriberStatus {
	if emailBlacklisted == nil {
		return canonical.StatusUnconfirmed
	}
	if *emailBlacklisted {
		return canonical.StatusDisabled
	}
	return canonical.StatusEnabled
}

// normalizeAttributes copies a Brevo attributes map, dropping nil values and
// unsupported types. Brevo can return numbers, strings, booleans, and date
// strings — we let JSON-friendly scalars through and stringify everything
// else so canonical CustomFields remains JSON-safe.
func normalizeAttributes(in map[string]interface{}) map[string]interface{} {
	if len(in) == 0 {
		return map[string]interface{}{}
	}
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		if v == nil {
			continue
		}
		switch tv := v.(type) {
		case string, bool, float64, int, int64, json.Number:
			out[k] = tv
		default:
			// Last-resort stringify to avoid losing data and to keep the map
			// JSON-safe for downstream serialization.
			b, err := json.Marshal(tv)
			if err == nil {
				out[k] = string(b)
			}
		}
	}
	return out
}

// mapListIDsToTags translates Brevo list IDs into canonical Tag strings of
// the form `list:<id>`. The orchestrator can later resolve list IDs to names
// via the lists endpoint when emitting verification reports.
func mapListIDsToTags(ids []int64) []string {
	if len(ids) == 0 {
		return nil
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, fmt.Sprintf("list:%d", id))
	}
	return out
}

// parseISO parses Brevo's typical timestamp formats (ISO8601 with offset, or
// the trailing-Z form). Returns nil on empty/unrecognized strings rather than
// surfacing parse errors.
func parseISO(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{
		time.RFC3339,
		"2006-01-02T15:04:05.000-07:00",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.Parse(layout, raw); err == nil && !t.IsZero() {
			return &t
		}
	}
	return nil
}

// mapBrevoListToSegment translates a Brevo list into a canonical Segment as
// a single-condition tag-equality node — mirrors the MailerLite/ConvertKit
// pattern for list-as-tag semantics.
func mapBrevoListToSegment(l brevoList) canonical.Segment {
	raw, _ := json.Marshal(l)
	return canonical.Segment{
		Name: "List: " + l.Name,
		QueryAST: canonical.SegmentNode{
			Op:         "condition",
			Field:      "tag",
			Comparator: "equals",
			Value:      fmt.Sprintf("list:%d", l.ID),
		},
		Description:      fmt.Sprintf("Brevo list #%d", l.ID),
		SourceDefinition: string(raw),
	}
}

// mapBrevoSegmentToCanonical translates a Brevo (saved) segment. Brevo does
// not expose a structured filter AST on the public API, so we surface the raw
// segment definition string and let the UI surface a "manual review" warning.
func mapBrevoSegmentToCanonical(s brevoSegment) canonical.Segment {
	raw, _ := json.Marshal(s)
	name := s.SegmentName
	if name == "" {
		name = s.Segment
	}
	return canonical.Segment{
		Name:             name,
		Description:      "Segment definition not exposed by Brevo API; manual review recommended.",
		QueryAST:         canonical.SegmentNode{Op: "and"},
		SourceDefinition: string(raw),
	}
}

// mapBrevoCampaignToCanonical converts a Brevo email campaign into the canonical
// CampaignArchive form. We only stamp records for sent campaigns; the adapter's
// list method already filters by status=sent before calling.
func mapBrevoCampaignToCanonical(c brevoCampaign) canonical.CampaignArchive {
	sentAt := time.Time{}
	if t := parseISO(c.SentDate); t != nil {
		sentAt = *t
	}
	subj := strings.TrimSpace(c.Subject)
	if subj == "" {
		subj = strings.TrimSpace(c.Name)
	}
	var warnings []string
	if c.ABTesting {
		warnings = append(warnings, "Brevo returned one campaign HTML body for an A/B test. Both subject variants are retained in the report; separate rendered variants require source review.")
	}
	return canonical.CampaignArchive{
		Report:          map[string]interface{}{"statistics": c.Statistics.Raw, "ab_testing": c.ABTesting, "subject_a": c.SubjectA, "subject_b": c.SubjectB},
		Warnings:        warnings,
		SourceID:        strconv.FormatInt(c.ID, 10),
		Subject:         subj,
		HTML:            c.HTMLContent,
		Text:            "", // Brevo's emailCampaigns endpoint does not expose plain-text alongside HTML.
		SentAt:          sentAt,
		RecipientsCount: *c.Statistics.GlobalStats.Sent,
		Opens:           *c.Statistics.GlobalStats.UniqueViews,
		Clicks:          *c.Statistics.GlobalStats.UniqueClicks,
		SourcePlatform:  canonical.SourceBrevo,
	}
}

// mapBrevoWorkflowToAutomation translates a Brevo workflow into a canonical
// Automation, walking the step list to emit wait/send/branch nodes plus edges.
func mapBrevoWorkflowToAutomation(w brevoWorkflow) canonical.Automation {
	out := canonical.Automation{
		Name: w.Name,
		// Imported workflows always enter Moosewave as review-only drafts. The
		// source status remains in SourceDefinition, but must never arm a
		// destination runtime as a side effect of migration.
		Status: "draft",
	}
	if w.Trigger.Type != "" {
		t := canonical.AutomationTrigger{Type: w.Trigger.Type}
		switch strings.ToLower(w.Trigger.Type) {
		case "list_addition", "subscribed":
			t.Type = "subscriber_added_to_list"
			t.ListID = strconv.FormatInt(w.Trigger.ListID, 10)
		case "tag_added":
			t.Type = "tag_added"
			t.Tag = w.Trigger.Tag
		case "custom_event", "event":
			t.Type = "custom_event"
			t.EventName = w.Trigger.Event
		default:
			t.Type = "custom_event"
			t.EventName = w.Trigger.Type
		}
		out.Triggers = append(out.Triggers, t)
	}

	for _, s := range w.Steps {
		node := canonical.AutomationNode{ID: s.ID}
		switch strings.ToLower(s.Type) {
		case "delay", "wait":
			node.Type = "wait"
			node.DurationSeconds = s.DelaySecs
		case "email", "send_email":
			node.Type = "send_email"
			if s.TemplateID > 0 {
				// Brevo template IDs live only in Brevo's namespace. Preserve the
				// source identity for review/remapping, but leave TemplateID empty
				// until the orchestrator proves a tenant-owned destination mapping.
				node.Metadata = map[string]interface{}{
					"source_platform":    string(canonical.SourceBrevo),
					"source_template_id": strconv.FormatInt(s.TemplateID, 10),
				}
			}
		default:
			node.Type = s.Type
		}
		out.Nodes = append(out.Nodes, node)
		if s.NextID != "" {
			out.Edges = append(out.Edges, canonical.AutomationEdge{From: s.ID, To: s.NextID})
		}
	}

	if raw, err := json.Marshal(w); err == nil {
		out.SourceDefinition = string(raw)
	}
	return out
}
