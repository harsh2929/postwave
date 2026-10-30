package discordint

import (
	"encoding/json"
	"fmt"
	"time"
)

// DiscordMessage is the subset of the Discord webhook payload shape
// we emit. Discord supports plaintext via `content` and rich cards
// via `embeds` — we lean on embeds for everything except the
// fallback path.
type DiscordMessage struct {
	Content string         `json:"content,omitempty"`
	Embeds  []discordEmbed `json:"embeds,omitempty"`
	// Bot username + avatar are tenant-controlled in V2; for V1 we
	// emit "Moosewave" so events from different workspaces look
	// distinct only by channel routing, not by per-row branding.
	Username  string `json:"username,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

type discordEmbed struct {
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	URL         string         `json:"url,omitempty"`
	Color       int            `json:"color,omitempty"` // decimal RGB tint of left bar
	Fields      []discordField `json:"fields,omitempty"`
	Timestamp   string         `json:"timestamp,omitempty"` // ISO-8601
	Footer      *discordFooter `json:"footer,omitempty"`
}

type discordField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline,omitempty"`
}

type discordFooter struct {
	Text string `json:"text"`
}

// Color palette. Discord's left-bar tint is encoded as a decimal int.
// These match common-sense semantics so a glance at the channel reads
// status at-a-color.
const (
	colorAccept  = 3066993  // green-ish
	colorWarn    = 15844367 // gold
	colorDanger  = 15158332 // red-ish
	colorInfo    = 3447003  // blue
	colorNeutral = 9807270  // grey
)

const postwaveBot = "Moosewave"

// FormatDiscordMessage picks a renderer for eventType.
func FormatDiscordMessage(eventType string, body json.RawMessage) DiscordMessage {
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

func formatSubscriberCreated(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	src := pickString(body, "source_platform")
	desc := fmt.Sprintf("**%s**", emailOr(email, "unknown"))
	if src != "" {
		desc += fmt.Sprintf(" via `%s`", src)
	}
	return embed("✨ New subscriber", desc, colorAccept, postwaveBot)
}

func formatSubscriberUnsubscribed(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	reason := pickString(body, "unsubscribe_reason")
	desc := fmt.Sprintf("**%s**", emailOr(email, "unknown"))
	if reason != "" {
		desc += fmt.Sprintf("\n_%s_", reason)
	}
	return embed("👋 Unsubscribed", desc, colorWarn, postwaveBot)
}

func formatSubscriberBounced(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	desc := fmt.Sprintf("**%s** (auto-suppressed)", emailOr(email, "unknown"))
	return embed("⚠️ Bounced", desc, colorWarn, postwaveBot)
}

func formatSubscriberComplained(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	desc := fmt.Sprintf("**%s** (auto-suppressed)", emailOr(email, "unknown"))
	return embed("⛔ Spam complaint", desc, colorDanger, postwaveBot)
}

func formatCampaignSent(body json.RawMessage) DiscordMessage {
	name := pickString(body, "name")
	subj := pickString(body, "subject")
	msg := withFields("🚀 Campaign sent",
		fmt.Sprintf("**%s**", titleOr(name, "(untitled)")),
		colorAccept,
		[]discordField{
			{Name: "Subject", Value: nonEmpty(subj, "_(no subject)_"), Inline: false},
		})
	return msg
}

func formatFormSubmitted(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	formID := pickString(body, "form_id")
	return withFields("📝 Form submission",
		fmt.Sprintf("from **%s**", emailOr(email, "unknown")),
		colorInfo,
		[]discordField{
			{Name: "Form", Value: nonEmpty(formID, "_(unknown)_"), Inline: true},
		})
}

func formatFormConfirmed(body json.RawMessage) DiscordMessage {
	email := pickString(body, "email")
	desc := fmt.Sprintf("**%s**", emailOr(email, "unknown"))
	return embed("✅ Form confirmed", desc, colorAccept, postwaveBot)
}

func formatAutomationCompleted(body json.RawMessage) DiscordMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	desc := fmt.Sprintf("**%s**\nfor `%s`", emailOr(sub, "?"), autoID)
	return embed("🏁 Automation finished", desc, colorAccept, postwaveBot)
}

func formatAutomationFailed(body json.RawMessage) DiscordMessage {
	autoID := pickString(body, "automation_id")
	sub := pickString(body, "subscriber_email")
	errMsg := pickString(body, "error")
	fields := []discordField{
		{Name: "Automation", Value: nonEmpty(autoID, "_(unknown)_"), Inline: true},
		{Name: "Subscriber", Value: nonEmpty(sub, "_(unknown)_"), Inline: true},
	}
	if errMsg != "" {
		fields = append(fields, discordField{Name: "Error", Value: "```" + truncate(errMsg, 200) + "```"})
	}
	return withFields("❌ Automation FAILED", "", colorDanger, fields)
}

func formatMigrationCompleted(body json.RawMessage) DiscordMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	return withFields("🚚 Migration completed",
		fmt.Sprintf("from **%s**", titleOr(src, "?")),
		colorAccept,
		[]discordField{
			{Name: "Job", Value: nonEmpty(jobID, "_(unknown)_"), Inline: true},
		})
}

func formatMigrationFailed(body json.RawMessage) DiscordMessage {
	src := pickString(body, "source")
	jobID := pickString(body, "job_id")
	errMsg := pickString(body, "error")
	fields := []discordField{
		{Name: "Source", Value: titleOr(src, "?"), Inline: true},
		{Name: "Job", Value: nonEmpty(jobID, "_(unknown)_"), Inline: true},
	}
	if errMsg != "" {
		fields = append(fields, discordField{Name: "Error", Value: "```" + truncate(errMsg, 200) + "```"})
	}
	return withFields("❌ Migration FAILED", "", colorDanger, fields)
}

func formatSequenceGenerated(body json.RawMessage) DiscordMessage {
	name := pickString(body, "name")
	tmpl := pickString(body, "template_id")
	return withFields("🤖 Voice sequence generated",
		fmt.Sprintf("**%s**", titleOr(name, "(untitled)")),
		colorInfo,
		[]discordField{
			{Name: "Template", Value: nonEmpty(tmpl, "_(custom)_"), Inline: true},
		})
}

func formatGeneric(eventType string, body json.RawMessage) DiscordMessage {
	preview := string(body)
	if len(preview) > 500 {
		preview = preview[:500] + "…"
	}
	return DiscordMessage{
		Username: postwaveBot,
		Embeds: []discordEmbed{{
			Title:       fmt.Sprintf("Moosewave event: `%s`", eventType),
			Description: "```" + preview + "```",
			Color:       colorNeutral,
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
		}},
	}
}

// helpers

func embed(title, desc string, color int, username string) DiscordMessage {
	return DiscordMessage{
		Username: username,
		Embeds: []discordEmbed{{
			Title:       title,
			Description: desc,
			Color:       color,
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
		}},
	}
}

func withFields(title, desc string, color int, fields []discordField) DiscordMessage {
	return DiscordMessage{
		Username: postwaveBot,
		Embeds: []discordEmbed{{
			Title:       title,
			Description: desc,
			Color:       color,
			Fields:      fields,
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
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
