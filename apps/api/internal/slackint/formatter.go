package slackint

import (
	"encoding/json"
	"fmt"
)

// SlackMessage is the subset of the Slack incoming-webhook payload
// shape we emit. We use Block Kit because plain `text` looks like
// log-spam in a busy channel; Block Kit gets us section headers,
// fields, and tasteful spacing.
//
// Slack's full payload schema is huge; we keep only what we need.
type SlackMessage struct {
	Text   string       `json:"text"` // Slack uses this as the notification preview + as a fallback for old clients.
	Blocks []slackBlock `json:"blocks,omitempty"`
}

type slackBlock struct {
	Type   string      `json:"type"`
	Text   *slackText  `json:"text,omitempty"`
	Fields []slackText `json:"fields,omitempty"`
}

type slackText struct {
	Type  string `json:"type"` // "mrkdwn" | "plain_text"
	Text  string `json:"text"`
	Emoji bool   `json:"emoji,omitempty"`
}

// FormatSlackMessage picks a renderer for eventType. Unknown event
// types fall back to a generic JSON-dump renderer so the channel
// still gets *something*.
func FormatSlackMessage(eventType string, body json.RawMessage) SlackMessage {
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

// ---- per-event formatters ----

func formatSubscriberCreated(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	src := pickString(body, "source_platform")
	text := fmt.Sprintf(":sparkles: New subscriber: *%s*", emailOr(email, "unknown"))
	if src != "" {
		text += fmt.Sprintf(" via `%s`", src)
	}
	return SlackMessage{
		Text:   text,
		Blocks: section(text),
	}
}

func formatSubscriberUnsubscribed(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	reason := pickString(body, "unsubscribe_reason")
	text := fmt.Sprintf(":wave: Unsubscribed: *%s*", emailOr(email, "unknown"))
	if reason != "" {
		text += fmt.Sprintf(" — _%s_", reason)
	}
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatSubscriberBounced(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	text := fmt.Sprintf(":warning: Bounced: *%s* (auto-suppressed)", emailOr(email, "unknown"))
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatSubscriberComplained(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	text := fmt.Sprintf(":no_entry: Spam complaint: *%s* (auto-suppressed)", emailOr(email, "unknown"))
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatCampaignSent(body json.RawMessage) SlackMessage {
	name := pickString(body, "name")
	subj := pickString(body, "subject")
	text := fmt.Sprintf(":rocket: Campaign sent: *%s*", titleOr(name, "(untitled)"))
	blocks := section(text)
	if subj != "" {
		blocks = append(blocks, slackBlock{
			Type:   "context",
			Fields: []slackText{{Type: "mrkdwn", Text: "Subject: _" + subj + "_"}},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

func formatFormSubmitted(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	formID := pickString(body, "form_id")
	text := fmt.Sprintf(":pencil: Form submission from *%s*", emailOr(email, "unknown"))
	blocks := section(text)
	if formID != "" {
		blocks = append(blocks, slackBlock{
			Type:   "context",
			Fields: []slackText{{Type: "mrkdwn", Text: "Form: `" + formID + "`"}},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

func formatFormConfirmed(body json.RawMessage) SlackMessage {
	email := pickString(body, "email")
	text := fmt.Sprintf(":white_check_mark: Form confirmed by *%s*", emailOr(email, "unknown"))
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatAutomationCompleted(body json.RawMessage) SlackMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	text := fmt.Sprintf(":checkered_flag: Automation finished for *%s* — `%s`", emailOr(sub, "?"), autoID)
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatAutomationFailed(body json.RawMessage) SlackMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	errMsg := pickString(body, "error")
	text := fmt.Sprintf(":x: Automation FAILED for *%s* — `%s`", emailOr(sub, "?"), autoID)
	blocks := section(text)
	if errMsg != "" {
		blocks = append(blocks, slackBlock{
			Type:   "context",
			Fields: []slackText{{Type: "mrkdwn", Text: "Error: `" + truncate(errMsg, 200) + "`"}},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

func formatMigrationCompleted(body json.RawMessage) SlackMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	text := fmt.Sprintf(":truck: Migration from *%s* completed — `%s`", titleOr(src, "?"), jobID)
	return SlackMessage{Text: text, Blocks: section(text)}
}

func formatMigrationFailed(body json.RawMessage) SlackMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	errMsg := pickString(body, "error")
	text := fmt.Sprintf(":x: Migration from *%s* FAILED — `%s`", titleOr(src, "?"), jobID)
	blocks := section(text)
	if errMsg != "" {
		blocks = append(blocks, slackBlock{
			Type:   "context",
			Fields: []slackText{{Type: "mrkdwn", Text: "Error: `" + truncate(errMsg, 200) + "`"}},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

func formatSequenceGenerated(body json.RawMessage) SlackMessage {
	name := pickString(body, "name")
	tmpl := pickString(body, "template_id")
	text := fmt.Sprintf(":robot_face: Voice sequence generated: *%s*", titleOr(name, "(untitled)"))
	blocks := section(text)
	if tmpl != "" {
		blocks = append(blocks, slackBlock{
			Type:   "context",
			Fields: []slackText{{Type: "mrkdwn", Text: "Template: `" + tmpl + "`"}},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

// formatGeneric is the fallback. Dumps the event_type + truncated
// JSON. Better than silence when a new event lands; the operator can
// still see *something* in Slack while the formatter catches up.
func formatGeneric(eventType string, body json.RawMessage) SlackMessage {
	text := fmt.Sprintf(":information_source: Moosewave event: `%s`", eventType)
	preview := string(body)
	if len(preview) > 500 {
		preview = preview[:500] + "…"
	}
	blocks := section(text)
	if preview != "" {
		blocks = append(blocks, slackBlock{
			Type: "section",
			Text: &slackText{Type: "mrkdwn", Text: "```" + preview + "```"},
		})
	}
	return SlackMessage{Text: text, Blocks: blocks}
}

// ---- helpers ----

func section(mrkdwn string) []slackBlock {
	return []slackBlock{{
		Type: "section",
		Text: &slackText{Type: "mrkdwn", Text: mrkdwn},
	}}
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

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
