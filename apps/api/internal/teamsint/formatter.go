package teamsint

import (
	"encoding/json"
	"fmt"
)

// TeamsMessage is the legacy Office 365 Connector "MessageCard"
// schema. Reference:
// https://learn.microsoft.com/en-us/outlook/actionable-messages/message-card-reference
//
// We use MessageCard (not Adaptive Cards) because incoming-webhook
// Connectors only accept MessageCard. Adaptive Cards require a Power
// Automate Workflow on the Teams side, which means each tenant
// pre-builds a flow before pasting the URL — high friction. The
// trade-off is MessageCard's deprecation: when MS turns it off (TBD),
// we'll need an Adaptive Cards variant. For V1 the connector format
// works in 100% of installs.
type TeamsMessage struct {
	// @type and @context are MessageCard schema literals.
	Type    string `json:"@type"`
	Context string `json:"@context"`
	// Summary is the notification preview shown in the activity feed.
	Summary string `json:"summary"`
	// ThemeColor is the hex tint of the left-edge bar (without leading #).
	ThemeColor string         `json:"themeColor,omitempty"`
	Title      string         `json:"title,omitempty"`
	Sections   []teamsSection `json:"sections,omitempty"`
}

type teamsSection struct {
	ActivityTitle    string      `json:"activityTitle,omitempty"`
	ActivitySubtitle string      `json:"activitySubtitle,omitempty"`
	Text             string      `json:"text,omitempty"`
	Facts            []teamsFact `json:"facts,omitempty"`
	Markdown         bool        `json:"markdown,omitempty"`
}

type teamsFact struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Color palette (hex without #).
const (
	colorAccept  = "36a64f"
	colorWarn    = "f5a623"
	colorDanger  = "d50000"
	colorInfo    = "1f78d1"
	colorNeutral = "9e9e9e"
)

// FormatTeamsMessage picks a renderer for eventType. Same dispatch
// table as the Slack and Discord formatters; differences are
// per-event field selection + the wire format wrapper.
func FormatTeamsMessage(eventType string, body json.RawMessage) TeamsMessage {
	switch eventType {
	case "subscriber.created":
		return formatSubscriberCreated(body)
	case "subscriber.unsubscribed":
		return formatSubscriberUnsubscribed(body)
	case "subscriber.bounced":
		return formatSubscriberBounced(body)
	case "subscriber.complained":
		return formatSubscriberComplained(body)
	case "campaign.sent":
		return formatCampaignSent(body)
	case "form.submitted":
		return formatFormSubmitted(body)
	case "form.confirmed":
		return formatFormConfirmed(body)
	case "automation.completed":
		return formatAutomationCompleted(body)
	case "automation.failed":
		return formatAutomationFailed(body)
	case "migration.completed":
		return formatMigrationCompleted(body)
	case "migration.failed":
		return formatMigrationFailed(body)
	case "sequence.generated":
		return formatSequenceGenerated(body)
	default:
		return formatGeneric(eventType, body)
	}
}

func formatSubscriberCreated(body json.RawMessage) TeamsMessage {
	email := pickString(body, "email")
	src := pickString(body, "source_platform")
	subtitle := emailOr(email, "unknown")
	if src != "" {
		subtitle += fmt.Sprintf(" via %s", src)
	}
	return card("New subscriber", subtitle, colorAccept)
}

func formatSubscriberUnsubscribed(body json.RawMessage) TeamsMessage {
	email := pickString(body, "email")
	reason := pickString(body, "unsubscribe_reason")
	subtitle := emailOr(email, "unknown")
	if reason != "" {
		subtitle += fmt.Sprintf(" — %s", reason)
	}
	return card("Unsubscribed", subtitle, colorWarn)
}

func formatSubscriberBounced(body json.RawMessage) TeamsMessage {
	return card("Bounced (auto-suppressed)",
		emailOr(pickString(body, "email"), "unknown"), colorWarn)
}

func formatSubscriberComplained(body json.RawMessage) TeamsMessage {
	return card("Spam complaint (auto-suppressed)",
		emailOr(pickString(body, "email"), "unknown"), colorDanger)
}

func formatCampaignSent(body json.RawMessage) TeamsMessage {
	name := pickString(body, "name")
	subj := pickString(body, "subject")
	return cardWithFacts("Campaign sent", titleOr(name, "(untitled)"), colorAccept, []teamsFact{
		{Name: "Subject", Value: nonEmpty(subj, "(no subject)")},
	})
}

func formatFormSubmitted(body json.RawMessage) TeamsMessage {
	email := pickString(body, "email")
	formID := pickString(body, "form_id")
	return cardWithFacts("Form submission", emailOr(email, "unknown"), colorInfo, []teamsFact{
		{Name: "Form", Value: nonEmpty(formID, "(unknown)")},
	})
}

func formatFormConfirmed(body json.RawMessage) TeamsMessage {
	return card("Form confirmed",
		emailOr(pickString(body, "email"), "unknown"), colorAccept)
}

func formatAutomationCompleted(body json.RawMessage) TeamsMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	return cardWithFacts("Automation finished", emailOr(sub, "?"), colorAccept, []teamsFact{
		{Name: "Automation", Value: nonEmpty(autoID, "(unknown)")},
	})
}

func formatAutomationFailed(body json.RawMessage) TeamsMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	errMsg := pickString(body, "error")
	facts := []teamsFact{
		{Name: "Automation", Value: nonEmpty(autoID, "(unknown)")},
		{Name: "Subscriber", Value: nonEmpty(sub, "(unknown)")},
	}
	if errMsg != "" {
		facts = append(facts, teamsFact{Name: "Error", Value: truncate(errMsg, 200)})
	}
	return cardWithFacts("Automation FAILED", "", colorDanger, facts)
}

func formatMigrationCompleted(body json.RawMessage) TeamsMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	return cardWithFacts("Migration completed", titleOr(src, "?"), colorAccept, []teamsFact{
		{Name: "Job", Value: nonEmpty(jobID, "(unknown)")},
	})
}

func formatMigrationFailed(body json.RawMessage) TeamsMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	errMsg := pickString(body, "error")
	facts := []teamsFact{
		{Name: "Source", Value: titleOr(src, "?")},
		{Name: "Job", Value: nonEmpty(jobID, "(unknown)")},
	}
	if errMsg != "" {
		facts = append(facts, teamsFact{Name: "Error", Value: truncate(errMsg, 200)})
	}
	return cardWithFacts("Migration FAILED", "", colorDanger, facts)
}

func formatSequenceGenerated(body json.RawMessage) TeamsMessage {
	name := pickString(body, "name")
	tmpl := pickString(body, "template_id")
	return cardWithFacts("Voice sequence generated",
		titleOr(name, "(untitled)"), colorInfo,
		[]teamsFact{{Name: "Template", Value: nonEmpty(tmpl, "(custom)")}})
}

func formatGeneric(eventType string, body json.RawMessage) TeamsMessage {
	preview := string(body)
	if len(preview) > 500 {
		preview = preview[:500] + "…"
	}
	return TeamsMessage{
		Type:       "MessageCard",
		Context:    "https://schema.org/extensions",
		Summary:    "Moosewave event",
		ThemeColor: colorNeutral,
		Title:      fmt.Sprintf("Moosewave event: %s", eventType),
		Sections: []teamsSection{{
			Text:     "```\n" + preview + "\n```",
			Markdown: true,
		}},
	}
}

// helpers

func card(title, subtitle, color string) TeamsMessage {
	return TeamsMessage{
		Type:       "MessageCard",
		Context:    "https://schema.org/extensions",
		Summary:    title,
		ThemeColor: color,
		Title:      title,
		Sections: []teamsSection{{
			ActivitySubtitle: subtitle,
			Markdown:         true,
		}},
	}
}

func cardWithFacts(title, subtitle, color string, facts []teamsFact) TeamsMessage {
	return TeamsMessage{
		Type:       "MessageCard",
		Context:    "https://schema.org/extensions",
		Summary:    title,
		ThemeColor: color,
		Title:      title,
		Sections: []teamsSection{{
			ActivitySubtitle: subtitle,
			Facts:            facts,
			Markdown:         true,
		}},
	}
}

func pickString(body json.RawMessage, key string) string {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func emailOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func titleOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
