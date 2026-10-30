// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type SuiteSink interface {
	UpsertSupportTicket(ctx context.Context, tenantID, provider string, ticket TicketInput) (string, string, error)
	RecordSupportMessage(ctx context.Context, tenantID, provider string, message MessageInput) (string, error)
}

type ProfileSink interface {
	UpsertSupportProfile(ctx context.Context, tenantID, provider string, ticket TicketInput) (string, error)
}

type EventSink interface {
	TrackSupportEvent(ctx context.Context, tenantID, provider string, event SupportEventInput) (int64, error)
}

type suiteRepo interface {
	UpsertConversation(context.Context, string, service_suite.Conversation) (*service_suite.Conversation, error)
	CreateMessage(context.Context, string, string, service_suite.Message) (*service_suite.Message, error)
}

type ServiceSuiteSink struct {
	Repo suiteRepo
	Pool *db.Pool
}

func (s ServiceSuiteSink) UpsertSupportTicket(ctx context.Context, tenantID, provider string, ticket TicketInput) (string, string, error) {
	if s.Repo == nil || s.Pool == nil {
		return "", "", fmt.Errorf("support_integrations: service suite sink unavailable")
	}
	conv, err := s.Repo.UpsertConversation(ctx, tenantID, conversationForTicket(provider, ticket))
	if err != nil {
		return "", "", err
	}
	ticketID, err := s.upsertTicket(ctx, tenantID, provider, conv.ID, ticket)
	if err != nil {
		return "", "", err
	}
	return conv.ID, ticketID, nil
}

func (s ServiceSuiteSink) RecordSupportMessage(ctx context.Context, tenantID, provider string, message MessageInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("support_integrations: service suite sink unavailable")
	}
	conv, err := s.Repo.UpsertConversation(ctx, tenantID, conversationForMessage(provider, message))
	if err != nil {
		return "", err
	}
	_, err = s.Repo.CreateMessage(ctx, tenantID, conv.ID, service_suite.Message{
		SourceType:  provider,
		SourceID:    externalID(provider, firstString(message.SourceID, message.ConversationID)),
		Direction:   message.Direction,
		SenderType:  message.SenderType,
		Sender:      message.Sender,
		BodyText:    message.BodyText,
		BodyHTML:    message.BodyHTML,
		Attachments: []any{},
		Metadata:    mergeProperties(message.Properties, map[string]any{"provider": provider}),
		SentAt:      timeOrNow(message.OccurredAt),
	})
	if err != nil {
		return "", err
	}
	return conv.ID, nil
}

func (s ServiceSuiteSink) upsertTicket(ctx context.Context, tenantID, provider, conversationID string, ticket TicketInput) (string, error) {
	meta := mergeProperties(ticket.Properties, map[string]any{
		"provider":        provider,
		"source_id":       ticket.SourceID,
		"conversation_id": ticket.ConversationID,
		"requester_email": ticket.Email,
		"requester_name":  ticket.RequesterName,
		"tags":            ticket.Tags,
	})
	raw, _ := json.Marshal(meta)
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sourceID := externalID(provider, firstString(ticket.SourceID, ticket.ConversationID, ticket.Subject))
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO support_tickets
    (tenant_id, conversation_id, title, status, priority, assignee, source_channel,
     metadata, source_type, source_id, resolved_at)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
     CASE WHEN $4 IN ('resolved','closed') THEN now() ELSE NULL END)
ON CONFLICT (tenant_id, source_type, source_id) WHERE (source_id <> '') DO UPDATE SET
    conversation_id = EXCLUDED.conversation_id,
    title = EXCLUDED.title,
    source_channel = EXCLUDED.source_channel,
    updated_at = now()
RETURNING id::text`,
		tenantID, conversationID, firstString(ticket.Subject, "Support ticket"),
		ticket.Status, ticket.Priority, ticket.Assignee, provider, string(raw),
		provider, sourceID).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

func conversationForTicket(provider string, ticket TicketInput) service_suite.Conversation {
	return service_suite.Conversation{
		ChannelType:      "email",
		SourceType:       "manual",
		ExternalThreadID: externalID(provider, firstString(ticket.ConversationID, ticket.SourceID, ticket.Subject)),
		RequesterEmail:   ticket.Email,
		RequesterName:    ticket.RequesterName,
		Subject:          firstString(ticket.Subject, "Support ticket"),
		Status:           ticket.Status,
		Priority:         ticket.Priority,
		AssignedTo:       ticket.Assignee,
		Tags:             append([]string{provider}, ticket.Tags...),
		Metadata:         mergeProperties(ticket.Properties, map[string]any{"provider": provider, "source_id": ticket.SourceID}),
	}
}

func conversationForMessage(provider string, message MessageInput) service_suite.Conversation {
	return service_suite.Conversation{
		ChannelType:      "email",
		SourceType:       "manual",
		ExternalThreadID: externalID(provider, firstString(message.ConversationID, message.SourceID, message.Subject)),
		RequesterEmail:   message.Email,
		RequesterName:    message.RequesterName,
		Subject:          firstString(message.Subject, "Support conversation"),
		Status:           "open",
		Priority:         "normal",
		Tags:             []string{provider},
		Metadata:         mergeProperties(message.Properties, map[string]any{"provider": provider, "source_id": message.SourceID}),
	}
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type SubscriberSupportSink struct {
	Repo subscriberUpserter
}

func (s SubscriberSupportSink) UpsertSupportProfile(ctx context.Context, tenantID, provider string, ticket TicketInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("support_integrations: subscriber sink unavailable")
	}
	if strings.TrimSpace(ticket.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := mergeProperties(ticket.Properties, map[string]any{
		"support_provider":        provider,
		"support_source_id":       ticket.SourceID,
		"last_support_subject":    ticket.Subject,
		"last_support_status":     ticket.Status,
		"last_support_priority":   ticket.Priority,
		"last_support_assignee":   ticket.Assignee,
		"support_conversation_id": ticket.ConversationID,
	})
	tags := append([]string{provider, "support-contact"}, ticket.Tags...)
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(ticket.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 cleanStrings(tags),
		SourceID:             firstString(ticket.SourceID, ticket.ConversationID),
		SourcePlatform:       provider,
		FullName:             ticket.RequesterName,
		DisplayName:          ticket.RequesterName,
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_support_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

type trackRepo interface {
	ResolveSubscriberIdentity(context.Context, string, string, string) (track.SubscriberIdentity, error)
	Insert(context.Context, string, string, string, []byte, time.Time, string) (int64, error)
}

type TrackEventSink struct {
	Repo trackRepo
}

func (s TrackEventSink) TrackSupportEvent(ctx context.Context, tenantID, provider string, event SupportEventInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("support_integrations: event sink unavailable")
	}
	if strings.TrimSpace(event.Email) == "" {
		return 0, fmt.Errorf("email is required")
	}
	sub, err := s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", strings.ToLower(strings.TrimSpace(event.Email)))
	if err != nil {
		return 0, err
	}
	props := mergeProperties(event.Properties, map[string]any{
		"support_provider": provider,
		"source_id":        event.SourceID,
		"conversation_id":  event.ConversationID,
		"ticket_id":        event.TicketID,
		"status":           event.Status,
	})
	raw, _ := json.Marshal(props)
	eventName := firstString(event.EventName, "support.ticket.updated")
	return s.Repo.Insert(ctx, tenantID, sub.ID, eventName, raw, timeOrNow(event.OccurredAt), "")
}

func eventForTicket(ticket TicketInput) SupportEventInput {
	return SupportEventInput{
		SourceID:       ticket.SourceID,
		Email:          ticket.Email,
		EventName:      "support.ticket." + ticket.Status,
		ConversationID: ticket.ConversationID,
		TicketID:       ticket.SourceID,
		Status:         ticket.Status,
		Properties:     ticket.Properties,
		OccurredAt:     ticket.UpdatedAt,
	}
}

func eventForMessage(message MessageInput) SupportEventInput {
	return SupportEventInput{
		SourceID:       message.SourceID,
		Email:          message.Email,
		EventName:      "support.message.created",
		ConversationID: message.ConversationID,
		Properties:     message.Properties,
		OccurredAt:     message.OccurredAt,
	}
}

func externalID(provider, id string) string {
	value := strings.TrimSpace(id)
	if value == "" {
		value = "generated"
	}
	return provider + ":" + value
}

func mergeProperties(base map[string]any, extras map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extras {
		if v != nil && fmt.Sprint(v) != "" {
			out[k] = v
		}
	}
	return out
}

func timeOrNow(value *time.Time) time.Time {
	if value == nil || value.IsZero() {
		return time.Now().UTC()
	}
	return value.UTC()
}
