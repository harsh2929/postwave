package service_suite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type rowScanner interface {
	Scan(dest ...any) error
}

type jsonbProjectionBound struct {
	raw      []byte
	maxBytes int32
}

// validateJSONBProjectionBounds asks PostgreSQL to measure the exact jsonb::text
// representation used by migration CHECKs. Go's json.Marshal output can differ
// by spaces and canonical key ordering, so this commit-time predicate prevents
// an accepted API payload from becoming a database constraint 500.
func validateJSONBProjectionBounds(ctx context.Context, tx pgx.Tx, bounds ...jsonbProjectionBound) error {
	if len(bounds) == 0 {
		return nil
	}
	values := make([]string, 0, len(bounds))
	limits := make([]int32, 0, len(bounds))
	for _, bound := range bounds {
		values = append(values, string(bound.raw))
		limits = append(limits, bound.maxBytes)
	}
	var valid bool
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(bool_and(octet_length(value::jsonb::text) <= max_bytes), false)
FROM unnest($1::text[], $2::integer[]) AS projection(value,max_bytes)`, values, limits).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrInvalidProjection
	}
	return nil
}

func (r *Repo) GetConfig(ctx context.Context, tenantID string) (*HubConfig, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT tenant_id::text, status, storefronts, content_blocks, personalization_rules,
       support_settings, order_history_enabled, favorites_enabled, coupons_enabled,
       recommendations_enabled, customer_agent_enabled, styling, metadata,
       created_at, updated_at
FROM customer_hub_configs
WHERE tenant_id = $1::uuid`, tenantID)
	out, err := scanHubConfig(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			out = defaultHubConfig(tenantID)
		} else {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ReplaceConfig(ctx context.Context, tenantID string, in HubConfig, expectedVersion string) (*HubConfig, error) {
	normalizeConfig(&in)
	if validation := ValidateConfig(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil {
		return nil, ErrPreconditionFailed
	}
	storefronts, _ := json.Marshal(in.Storefronts)
	blocks, _ := json.Marshal(in.ContentBlocks)
	rules, _ := json.Marshal(in.PersonalizationRules)
	support, _ := json.Marshal(in.SupportSettings)
	styling, _ := json.Marshal(in.Styling)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{storefronts, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{blocks, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{rules, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{support, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{styling, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{meta, helpdeskMetadataMaxBytes},
	); err != nil {
		return nil, err
	}
	var row rowScanner
	if expectsAbsent {
		row = tx.QueryRow(ctx, `
INSERT INTO customer_hub_configs
    (tenant_id, status, storefronts, content_blocks, personalization_rules,
     support_settings, order_history_enabled, favorites_enabled, coupons_enabled,
     recommendations_enabled, customer_agent_enabled, styling, metadata)
VALUES
    ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
     $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
ON CONFLICT (tenant_id) DO NOTHING
RETURNING tenant_id::text, status, storefronts, content_blocks, personalization_rules,
       support_settings, order_history_enabled, favorites_enabled, coupons_enabled,
       recommendations_enabled, customer_agent_enabled, styling, metadata,
       created_at, updated_at`,
			tenantID, in.Status, string(storefronts), string(blocks), string(rules),
			string(support), in.OrderHistoryEnabled, in.FavoritesEnabled,
			in.CouponsEnabled, in.RecommendationsEnabled, in.CustomerAgentEnabled,
			string(styling), string(meta))
	} else {
		row = tx.QueryRow(ctx, `
UPDATE customer_hub_configs SET
    status = $2,
    storefronts = $3::jsonb,
    content_blocks = $4::jsonb,
    personalization_rules = $5::jsonb,
    support_settings = $6::jsonb,
    order_history_enabled = $7,
    favorites_enabled = $8,
    coupons_enabled = $9,
    recommendations_enabled = $10,
    customer_agent_enabled = $11,
    styling = $12::jsonb,
    metadata = $13::jsonb,
    updated_at = now()
WHERE tenant_id = $1::uuid AND updated_at = $14::timestamptz
RETURNING tenant_id::text, status, storefronts, content_blocks, personalization_rules,
       support_settings, order_history_enabled, favorites_enabled, coupons_enabled,
       recommendations_enabled, customer_agent_enabled, styling, metadata,
       created_at, updated_at`,
			tenantID, in.Status, string(storefronts), string(blocks), string(rules),
			string(support), in.OrderHistoryEnabled, in.FavoritesEnabled,
			in.CouponsEnabled, in.RecommendationsEnabled, in.CustomerAgentEnabled,
			string(styling), string(meta), expected)
	}
	out, err := scanHubConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListChannels(ctx context.Context, tenantID, channelType string) ([]Channel, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, channel_type, status, external_ref,
       routing_rules, agent_settings, metadata, created_at, updated_at
FROM support_channels
WHERE tenant_id = $1::uuid AND ($2 = '' OR channel_type = $2)
ORDER BY updated_at DESC
LIMIT 200`, tenantID, strings.TrimSpace(channelType))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		item, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListChannelsPage(ctx context.Context, tenantID, channelType string, cursorKey []byte, cursor listCursor, limit int) (*TenantPage[Channel], error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, channel_type, status, external_ref,
       routing_rules, agent_settings, metadata, created_at, updated_at
FROM support_channels
WHERE tenant_id=$1::uuid AND ($2='' OR channel_type=$2)
  AND updated_at <= $7::timestamptz
  AND (NOT $3::boolean OR (updated_at,id)<($4::timestamptz,$5::uuid))
ORDER BY updated_at DESC,id DESC
LIMIT $6`, tenantID, channelType, cursor.ID != "", cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Channel, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanChannel(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "mutable_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "channels", "channel_type:"+channelType, limit, cursor.SnapshotAt, last.UpdatedAt, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TenantPage[Channel]{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) CreateChannel(ctx context.Context, tenantID string, in Channel) (*Channel, error) {
	normalizeChannel(&in)
	if validation := ValidateChannel(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	rules, _ := json.Marshal(in.RoutingRules)
	agent, _ := json.Marshal(in.AgentSettings)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{rules, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{agent, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{meta, helpdeskMetadataMaxBytes},
	); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_channels
    (tenant_id, name, channel_type, status, external_ref, routing_rules, agent_settings, metadata)
VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
RETURNING id::text, tenant_id::text, name, channel_type, status, external_ref,
       routing_rules, agent_settings, metadata, created_at, updated_at`,
		tenantID, in.Name, in.ChannelType, in.Status, in.ExternalRef,
		string(rules), string(agent), string(meta))
	out, err := scanChannel(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PatchChannel(ctx context.Context, tenantID, id string, patch ChannelPatch, expectedVersion string) (*Channel, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in, err := scanChannel(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, channel_type, status, external_ref,
       routing_rules, agent_settings, metadata, created_at, updated_at
FROM support_channels
WHERE tenant_id=$1::uuid AND id=$2::uuid
FOR UPDATE`, tenantID, id))
	if err != nil {
		return nil, mapNoRows(err)
	}
	if in.Version != expectedVersion {
		return nil, ErrPreconditionFailed
	}
	if patch.Name.Present {
		if patch.Name.Null {
			return nil, ErrInvalidPatch
		}
		in.Name = patch.Name.Value
	}
	if patch.ChannelType.Present {
		if patch.ChannelType.Null {
			return nil, ErrInvalidPatch
		}
		in.ChannelType = patch.ChannelType.Value
	}
	if patch.Status.Present {
		if patch.Status.Null {
			return nil, ErrInvalidPatch
		}
		in.Status = patch.Status.Value
	}
	if patch.ExternalRef.Present {
		in.ExternalRef = patch.ExternalRef.Value
		if patch.ExternalRef.Null {
			in.ExternalRef = ""
		}
	}
	if patch.RoutingRules.Present {
		in.RoutingRules = patch.RoutingRules.Value
		if patch.RoutingRules.Null {
			in.RoutingRules = map[string]any{}
		}
	}
	if patch.AgentSettings.Present {
		in.AgentSettings = patch.AgentSettings.Value
		if patch.AgentSettings.Null {
			in.AgentSettings = map[string]any{}
		}
	}
	if patch.Metadata.Present {
		in.Metadata = patch.Metadata.Value
		if patch.Metadata.Null {
			in.Metadata = map[string]any{}
		}
	}
	if validation := ValidateChannel(*in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidPatch, strings.Join(validation.Errors, "; "))
	}
	normalizeChannel(in)
	rules, _ := json.Marshal(in.RoutingRules)
	agent, _ := json.Marshal(in.AgentSettings)
	meta, _ := json.Marshal(in.Metadata)
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{rules, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{agent, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{meta, helpdeskMetadataMaxBytes},
	); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE support_channels
SET name = $3, channel_type = $4, status = $5, external_ref = $6,
    routing_rules = $7::jsonb, agent_settings = $8::jsonb, metadata = $9::jsonb,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at=$10::timestamptz
RETURNING id::text, tenant_id::text, name, channel_type, status, external_ref,
       routing_rules, agent_settings, metadata, created_at, updated_at`,
		tenantID, id, in.Name, in.ChannelType, in.Status, in.ExternalRef,
		string(rules), string(agent), string(meta), expected)
	out, err := scanChannel(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListConversations(ctx context.Context, tenantID, status string) ([]Conversation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
       created_at, updated_at
FROM support_conversations
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
ORDER BY COALESCE(last_message_at, updated_at) DESC
LIMIT 200`, tenantID, strings.TrimSpace(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conversation{}
	for rows.Next() {
		item, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListConversationsPage(ctx context.Context, tenantID, status string, cursorKey []byte, cursor listCursor, limit int) (*ConversationPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hasCursor := cursor.ID != ""
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
       created_at, updated_at
FROM support_conversations
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
  AND COALESCE(last_message_at, updated_at) <= $7::timestamptz
  AND (NOT $3::boolean OR (COALESCE(last_message_at, updated_at), id) < ($4::timestamptz, $5::uuid))
ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC
LIMIT $6`, tenantID, status, hasCursor, cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Conversation, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanConversation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "mutable_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		at := last.UpdatedAt
		if last.LastMessageAt != nil {
			at = *last.LastMessageAt
		}
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "conversations", status, limit, cursor.SnapshotAt, at, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ConversationPage{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) UpsertConversation(ctx context.Context, tenantID string, in Conversation) (*Conversation, error) {
	normalizeConversation(&in)
	if validation := ValidateConversation(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{meta, helpdeskMetadataMaxBytes}); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_conversations
    (tenant_id, channel_id, channel_type, source_type, external_thread_id,
     subscriber_id, requester_email, requester_phone, requester_name, subject,
     status, priority, assigned_to, tags, metadata, last_message_at)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5,
     NULLIF($6,'')::uuid, NULLIF($7,'')::citext, $8, $9, $10,
     $11, $12, $13, $14::text[], $15::jsonb, now())
ON CONFLICT (tenant_id, source_type, external_thread_id) WHERE (external_thread_id <> '') DO UPDATE SET
    channel_id = EXCLUDED.channel_id,
    channel_type = EXCLUDED.channel_type,
    subscriber_id = EXCLUDED.subscriber_id,
    requester_email = COALESCE(EXCLUDED.requester_email, support_conversations.requester_email),
    requester_phone = COALESCE(NULLIF(EXCLUDED.requester_phone,''), support_conversations.requester_phone),
    requester_name = COALESCE(NULLIF(EXCLUDED.requester_name,''), support_conversations.requester_name),
    subject = COALESCE(NULLIF(EXCLUDED.subject,''), support_conversations.subject),
    updated_at = now()
RETURNING id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
       created_at, updated_at`,
		tenantID, in.ChannelID, in.ChannelType, in.SourceType, in.ExternalThreadID,
		in.SubscriberID, in.RequesterEmail, in.RequesterPhone, in.RequesterName,
		in.Subject, in.Status, in.Priority, in.AssignedTo, in.Tags, string(meta))
	out, err := scanConversation(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetConversation(ctx context.Context, tenantID, id string) (*Conversation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getConversationTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetLastInboundMessage(ctx context.Context, tenantID, conversationID string) (*Message, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, err
	}
	out, err := scanMessage(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id=$1::uuid AND conversation_id=$2::uuid AND direction='inbound'
ORDER BY sent_at DESC, id DESC
LIMIT 1`, tenantID, conversationID))
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetTicket(ctx context.Context, tenantID, id string) (*Ticket, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getTicketTx(ctx, tx, tenantID, id, false)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListMessages(ctx context.Context, tenantID, conversationID string) ([]Message, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id = $1::uuid AND conversation_id = $2::uuid
ORDER BY sent_at ASC
LIMIT 500`, tenantID, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		item, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListMessagesPage(ctx context.Context, tenantID, conversationID, order string, cursorKey []byte, cursor listCursor, limit int) (*MessagePage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, err
	}
	hasCursor := cursor.ID != ""
	comparison := ">"
	ordering := "ASC"
	if order == "desc" {
		comparison = "<"
		ordering = "DESC"
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id = $1::uuid AND conversation_id = $2::uuid
  AND created_at <= $7::timestamptz
  AND (NOT $3::boolean OR (sent_at, id) `+comparison+` ($4::timestamptz, $5::uuid))
ORDER BY sent_at `+ordering+`, id `+ordering+`
LIMIT $6`, tenantID, conversationID, hasCursor, cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Message, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanMessage(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "created_at_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "messages:"+order, conversationID, limit, cursor.SnapshotAt, last.SentAt, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &MessagePage{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) CreateMessage(ctx context.Context, tenantID, conversationID string, in Message) (*Message, error) {
	normalizeMessage(&in)
	if !validateUUID(conversationID) {
		return nil, ErrInvalidProjection
	}
	if validation := ValidateMessage(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	attachments, _ := json.Marshal(in.Attachments)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{attachments, helpdeskMetadataMaxBytes},
		jsonbProjectionBound{meta, helpdeskMetadataMaxBytes},
	); err != nil {
		return nil, err
	}
	var createdAt time.Time
	if err = tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&createdAt); err != nil {
		return nil, err
	}
	createdAt = createdAt.UTC()
	if !in.SentAt.IsZero() && in.SentAt.After(createdAt) {
		return nil, ErrInvalidProjection
	}
	if _, err := getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_messages
    (tenant_id, conversation_id, source_type, source_id, direction, sender_type,
     sender, body_text, body_html, attachments, metadata, sent_at, created_at)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
     COALESCE(NULLIF($12,'')::timestamptz, $13::timestamptz), $13::timestamptz)
ON CONFLICT (tenant_id, source_type, source_id) WHERE (source_id <> '') DO NOTHING
RETURNING id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at`,
		tenantID, conversationID, in.SourceType, in.SourceID, in.Direction,
		in.SenderType, in.Sender, in.BodyText, in.BodyHTML, string(attachments),
		string(meta), timeString(in.SentAt), createdAt)
	out, scanErr := scanMessage(row)
	created := scanErr == nil
	if errors.Is(scanErr, pgx.ErrNoRows) && in.SourceID != "" {
		row = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id=$1::uuid AND source_type=$2 AND source_id=$3`, tenantID, in.SourceType, in.SourceID)
		out, scanErr = scanMessage(row)
		if scanErr == nil && !messageProjectionEquivalent(out, conversationID, in) {
			existingHash := messageProjectionHash(*out)
			incoming := in
			incoming.ConversationID = conversationID
			incomingHash := messageProjectionHash(incoming)
			if _, auditErr := tx.Exec(ctx, `
INSERT INTO support_ingest_conflicts
    (tenant_id, source_type, source_id_sha256, existing_message_id, existing_sha256, incoming_sha256, reason)
VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,'immutable_source_mismatch')`,
				tenantID, in.SourceType, sha256Hex("postwave/helpdesk/source-id/v1", in.SourceID), out.ID, existingHash, incomingHash); auditErr != nil {
				return nil, auditErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, commitErr
			}
			return nil, ErrSourceConflict
		}
	}
	if scanErr != nil {
		return nil, scanErr
	}
	if created {
		if _, err := tx.Exec(ctx, `
UPDATE support_conversations
SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'::timestamptz), $3),
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, conversationID, out.SentAt); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateInternalNote(ctx context.Context, tenantID, conversationID, actorID, storageKey, requestHash, body string) (*Message, bool, error) {
	if !validateUUID(conversationID) || strings.TrimSpace(actorID) == "" || strings.TrimSpace(storageKey) == "" ||
		len(requestHash) != 64 || !validHelpdeskDisplayText(body, 16<<10, false) {
		return nil, false, fmt.Errorf("service_suite: invalid internal-note intent")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, false, err
	}
	keyHash := sha256Hex("postwave/helpdesk/internal-note/key/v1", storageKey)
	principalHash := sha256Hex("postwave/helpdesk/internal-note/principal/v1", actorID)
	conversationHash := sha256Hex("postwave/helpdesk/internal-note/conversation/v1", conversationID)
	bindingHash := sha256Hex("postwave/helpdesk/internal-note/binding/v1", tenantID, actorID, conversationID, requestHash, body)
	var insertedIntent string
	err = tx.QueryRow(ctx, `
INSERT INTO support_internal_note_intents
    (tenant_id,intent_key_sha256,principal_sha256,conversation_sha256,binding_sha256,
     request_sha256,conversation_id,state)
VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,'pending')
ON CONFLICT (tenant_id,intent_key_sha256) DO NOTHING
RETURNING intent_key_sha256`, tenantID, keyHash, principalHash, conversationHash, bindingHash, requestHash, conversationID).Scan(&insertedIntent)
	if errors.Is(err, pgx.ErrNoRows) {
		var storedPrincipal, storedConversation, storedBinding, storedRequest, state string
		var messageID *string
		if err = tx.QueryRow(ctx, `
SELECT principal_sha256,conversation_sha256,binding_sha256,request_sha256,state,message_id::text
FROM support_internal_note_intents
WHERE tenant_id=$1::uuid AND intent_key_sha256=$2
FOR UPDATE`, tenantID, keyHash).Scan(&storedPrincipal, &storedConversation, &storedBinding, &storedRequest, &state, &messageID); err != nil {
			return nil, false, err
		}
		if storedPrincipal != principalHash || storedConversation != conversationHash || storedBinding != bindingHash || storedRequest != requestHash {
			return nil, false, ErrIdempotencyConflict
		}
		if state != "committed" || messageID == nil || *messageID == "" {
			return nil, false, ErrIntentResultMissing
		}
		out, scanErr := scanMessage(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, *messageID))
		if errors.Is(scanErr, pgx.ErrNoRows) {
			// The idempotency tombstone is lifecycle evidence, not request-path
			// mutable state. Privacy erasure for Helpdesk remains release-held, so
			// retain the committed intent and return an unambiguous terminal result.
			return nil, false, ErrIntentResultMissing
		}
		if scanErr != nil {
			return nil, false, scanErr
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return out, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var messageID string
	if err = tx.QueryRow(ctx, `
SELECT support_create_internal_note_result($1::uuid,$2,$3::uuid,$4,$5)::text`,
		tenantID, keyHash, conversationID, actorID, body).Scan(&messageID); err != nil {
		return nil, false, err
	}
	out, scanErr := scanMessage(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, conversation_id::text, source_type, source_id,
       direction, sender_type, sender, body_text, body_html, attachments,
       metadata, sent_at, created_at
FROM support_messages
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, messageID))
	if scanErr != nil {
		return nil, false, scanErr
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

func (r *Repo) AssignConversation(ctx context.Context, tenantID, conversationID string, in AssignmentInput, expectedVersion string) (*Conversation, error) {
	in.AssignedTo = strings.TrimSpace(in.AssignedTo)
	in.AssignedToUserID = strings.TrimSpace(in.AssignedToUserID)
	in.AssignedBy = strings.TrimSpace(in.AssignedBy)
	in.Reason = strings.TrimSpace(in.Reason)
	if !validateUUID(conversationID) || !validHelpdeskOpaqueID(in.AssignedBy, 320, false) ||
		!validHelpdeskDisplayText(in.Reason, 1024, true) ||
		(in.AssignedToUserID == "" && in.AssignedTo != "") ||
		(in.AssignedToUserID != "" && (!validateUUID(in.AssignedToUserID) || in.AssignedTo != in.AssignedToUserID)) {
		return nil, ErrInvalidProjection
	}
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.AssignedToUserID != "" {
		var memberID string
		if err = tx.QueryRow(ctx, `
SELECT id::text FROM users
WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='active' AND role IN ('owner','admin')
FOR KEY SHARE`, tenantID, in.AssignedToUserID).Scan(&memberID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrPrincipalNotMember
			}
			return nil, err
		}
	}
	row := tx.QueryRow(ctx, `
UPDATE support_conversations
SET assigned_to = $3, assigned_to_user_id=NULLIF($4,'')::uuid, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
  AND updated_at = $5::timestamptz
  AND (assigned_to IS DISTINCT FROM $3 OR assigned_to_user_id IS DISTINCT FROM NULLIF($4,'')::uuid)
RETURNING id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
	       created_at, updated_at`, tenantID, conversationID, strings.TrimSpace(in.AssignedTo), in.AssignedToUserID, expected)
	out, err := scanConversation(row)
	changed := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		out, err = getConversationTx(ctx, tx, tenantID, conversationID)
		if err == nil && out.Version != expectedVersion {
			return nil, ErrPreconditionFailed
		}
	}
	if err != nil {
		return nil, err
	}
	if changed {
		if _, err = tx.Exec(ctx, `
INSERT INTO support_assignments
    (tenant_id, conversation_id, assigned_to, assigned_to_user_id, assigned_by, reason)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4,'')::uuid, $5, $6)`,
			tenantID, conversationID, strings.TrimSpace(in.AssignedTo), in.AssignedToUserID, in.AssignedBy, in.Reason); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) SetConversationStatus(ctx context.Context, tenantID, conversationID, status, expectedVersion string) (*Conversation, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE support_conversations
SET status = $3, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
  AND updated_at = $4::timestamptz
RETURNING id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
	       created_at, updated_at`, tenantID, conversationID, status, expected)
	out, err := scanConversation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, lookupErr := getConversationTx(ctx, tx, tenantID, conversationID); lookupErr == nil {
			return nil, ErrPreconditionFailed
		} else {
			return nil, lookupErr
		}
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListTickets(ctx context.Context, tenantID, status string) ([]Ticket, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(conversation_id::text,''), ticket_number,
       title, status, priority, assignee, source_channel, due_at, resolved_at,
       metadata, created_at, updated_at
FROM support_tickets
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
ORDER BY updated_at DESC
LIMIT 200`, tenantID, strings.TrimSpace(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		item, err := scanTicket(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListTicketsPage(ctx context.Context, tenantID, status, conversationID string, cursorKey []byte, cursor listCursor, limit int) (*TenantPage[Ticket], error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(conversation_id::text,''), ticket_number,
       title, status, priority, assignee, source_channel, due_at, resolved_at,
       metadata, created_at, updated_at
FROM support_tickets
WHERE tenant_id=$1::uuid AND ($2='' OR status=$2)
  AND ($3='' OR conversation_id=$3::uuid)
  AND updated_at <= $8::timestamptz
  AND (NOT $4::boolean OR (updated_at,id)<($5::timestamptz,$6::uuid))
ORDER BY updated_at DESC,id DESC
LIMIT $7`, tenantID, status, conversationID, cursor.ID != "", cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Ticket, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanTicket(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	filter := "status:" + status + "\x00conversation:" + conversationID
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "mutable_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "tickets", filter, limit, cursor.SnapshotAt, last.UpdatedAt, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TenantPage[Ticket]{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) CreateTicket(ctx context.Context, tenantID string, in Ticket) (*Ticket, error) {
	normalizeTicket(&in)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var createdAt time.Time
	if err = tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&createdAt); err != nil {
		return nil, err
	}
	in.CreatedAt = createdAt.UTC()
	in.UpdatedAt = in.CreatedAt
	if validation := ValidateTicket(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	meta, _ := json.Marshal(in.Metadata)
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{meta, helpdeskMetadataMaxBytes}); err != nil {
		return nil, err
	}
	if in.ConversationID != "" {
		if _, err = getConversationTx(ctx, tx, tenantID, in.ConversationID); err != nil {
			return nil, err
		}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_tickets
    (tenant_id, conversation_id, title, status, priority, assignee, source_channel, due_at, resolved_at, metadata, created_at, updated_at)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $11::timestamptz)
RETURNING id::text, tenant_id::text, COALESCE(conversation_id::text,''), ticket_number,
       title, status, priority, assignee, source_channel, due_at, resolved_at,
       metadata, created_at, updated_at`,
		tenantID, in.ConversationID, in.Title, in.Status, in.Priority,
		in.Assignee, in.SourceChannel, in.DueAt, in.ResolvedAt, string(meta), in.CreatedAt)
	out, err := scanTicket(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PatchTicket(ctx context.Context, tenantID, id string, patch TicketPatch, expectedVersion string) (*Ticket, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in, err := scanTicket(tx.QueryRow(ctx, `
SELECT id::text,tenant_id::text,COALESCE(conversation_id::text,''),ticket_number,
       title,status,priority,assignee,source_channel,due_at,resolved_at,metadata,created_at,updated_at
FROM support_tickets WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, tenantID, id))
	if err != nil {
		return nil, mapNoRows(err)
	}
	if in.Version != expectedVersion {
		return nil, ErrPreconditionFailed
	}
	if patch.ConversationID.Present {
		if patch.ConversationID.Null {
			in.ConversationID = ""
		} else if !validateUUID(patch.ConversationID.Value) {
			return nil, ErrInvalidPatch
		} else {
			in.ConversationID = patch.ConversationID.Value
		}
	}
	if patch.Title.Present {
		if patch.Title.Null {
			return nil, ErrInvalidPatch
		}
		in.Title = patch.Title.Value
	}
	if patch.Status.Present {
		if patch.Status.Null {
			return nil, ErrInvalidPatch
		}
		in.Status = patch.Status.Value
	}
	if patch.Priority.Present {
		if patch.Priority.Null {
			return nil, ErrInvalidPatch
		}
		in.Priority = patch.Priority.Value
	}
	if patch.Assignee.Present {
		// Ticket assignee text has no tenant-member authority model. It cannot
		// be created or revived through this contract.
		if !patch.Assignee.Null && strings.TrimSpace(patch.Assignee.Value) != "" {
			return nil, ErrPrincipalNotMember
		}
		in.Assignee = ""
	}
	if patch.SourceChannel.Present {
		if patch.SourceChannel.Null {
			return nil, ErrInvalidPatch
		}
		in.SourceChannel = patch.SourceChannel.Value
	}
	if patch.DueAt.Present {
		in.DueAt = nil
		if !patch.DueAt.Null {
			value := patch.DueAt.Value.UTC()
			in.DueAt = &value
		}
	}
	if patch.ResolvedAt.Present {
		in.ResolvedAt = nil
		if !patch.ResolvedAt.Null {
			value := patch.ResolvedAt.Value.UTC()
			in.ResolvedAt = &value
		}
	}
	if patch.Metadata.Present {
		in.Metadata = patch.Metadata.Value
		if patch.Metadata.Null {
			in.Metadata = map[string]any{}
		}
	}
	if validation := ValidateTicket(*in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidPatch, strings.Join(validation.Errors, "; "))
	}
	if in.ConversationID != "" {
		if _, err = getConversationTx(ctx, tx, tenantID, in.ConversationID); err != nil {
			return nil, err
		}
	}
	normalizeTicket(in)
	meta, _ := json.Marshal(in.Metadata)
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{meta, helpdeskMetadataMaxBytes}); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE support_tickets
SET conversation_id = NULLIF($3,'')::uuid, title = $4, status = $5,
    priority = $6, assignee = $7, source_channel = $8, due_at = $9,
    resolved_at = $10, metadata = $11::jsonb, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at=$12::timestamptz
RETURNING id::text, tenant_id::text, COALESCE(conversation_id::text,''), ticket_number,
       title, status, priority, assignee, source_channel, due_at, resolved_at,
       metadata, created_at, updated_at`,
		tenantID, id, in.ConversationID, in.Title, in.Status, in.Priority,
		in.Assignee, in.SourceChannel, in.DueAt, in.ResolvedAt, string(meta), expected)
	out, err := scanTicket(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListViews(ctx context.Context, tenantID string) ([]View, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, visibility, filters, sort, status,
       created_by, created_at, updated_at
FROM support_views
WHERE tenant_id = $1::uuid AND status <> 'archived'
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []View{}
	for rows.Next() {
		item, err := scanView(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListViewsPage(ctx context.Context, tenantID string, cursorKey []byte, cursor listCursor, limit int) (*TenantPage[View], error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text,tenant_id::text,name,visibility,filters,sort,status,created_by,created_at,updated_at
FROM support_views
WHERE tenant_id=$1::uuid AND status<>'archived' AND updated_at<=$6::timestamptz
  AND (NOT $2::boolean OR (updated_at,id)<($3::timestamptz,$4::uuid))
ORDER BY updated_at DESC,id DESC LIMIT $5`, tenantID, cursor.ID != "", cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]View, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanView(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "mutable_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "views", "active", limit, cursor.SnapshotAt, last.UpdatedAt, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TenantPage[View]{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) UpsertView(ctx context.Context, tenantID, id string, in View) (*View, error) {
	normalizeView(&in)
	if validation := ValidateView(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	filters, _ := json.Marshal(in.Filters)
	sort, _ := json.Marshal(in.Sort)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{filters, helpdeskSmallJSONMaxBytes},
		jsonbProjectionBound{sort, helpdeskSmallJSONMaxBytes},
	); err != nil {
		return nil, err
	}
	var row rowScanner
	if strings.TrimSpace(id) == "" {
		row = tx.QueryRow(ctx, `
INSERT INTO support_views (tenant_id, name, visibility, filters, sort, status, created_by)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
RETURNING id::text, tenant_id::text, name, visibility, filters, sort, status,
       created_by, created_at, updated_at`,
			tenantID, in.Name, in.Visibility, string(filters), string(sort), in.Status, in.CreatedBy)
	} else {
		row = tx.QueryRow(ctx, `
UPDATE support_views
SET name = $3, visibility = $4, filters = $5::jsonb, sort = $6::jsonb,
    status = $7, created_by = $8, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, visibility, filters, sort, status,
       created_by, created_at, updated_at`,
			tenantID, id, in.Name, in.Visibility, string(filters), string(sort), in.Status, in.CreatedBy)
	}
	out, err := scanView(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PatchView(ctx context.Context, tenantID, id string, patch ViewPatch, expectedVersion string) (*View, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in, err := scanView(tx.QueryRow(ctx, `
SELECT id::text,tenant_id::text,name,visibility,filters,sort,status,created_by,created_at,updated_at
FROM support_views WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, tenantID, id))
	if err != nil {
		return nil, mapNoRows(err)
	}
	if in.Version != expectedVersion {
		return nil, ErrPreconditionFailed
	}
	if patch.Name.Present {
		if patch.Name.Null {
			return nil, ErrInvalidPatch
		}
		in.Name = patch.Name.Value
	}
	if patch.Visibility.Present {
		if patch.Visibility.Null {
			return nil, ErrInvalidPatch
		}
		in.Visibility = patch.Visibility.Value
	}
	if patch.Filters.Present {
		in.Filters = patch.Filters.Value
		if patch.Filters.Null {
			in.Filters = map[string]any{}
		}
	}
	if patch.Sort.Present {
		in.Sort = patch.Sort.Value
		if patch.Sort.Null {
			in.Sort = map[string]any{}
		}
	}
	if patch.Status.Present {
		if patch.Status.Null {
			return nil, ErrInvalidPatch
		}
		in.Status = patch.Status.Value
	}
	if validation := ValidateView(*in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidPatch, strings.Join(validation.Errors, "; "))
	}
	normalizeView(in)
	filters, _ := json.Marshal(in.Filters)
	sortWire, _ := json.Marshal(in.Sort)
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{filters, helpdeskSmallJSONMaxBytes},
		jsonbProjectionBound{sortWire, helpdeskSmallJSONMaxBytes},
	); err != nil {
		return nil, err
	}
	out, err := scanView(tx.QueryRow(ctx, `
UPDATE support_views SET name=$3,visibility=$4,filters=$5::jsonb,sort=$6::jsonb,status=$7,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND updated_at=$8::timestamptz
RETURNING id::text,tenant_id::text,name,visibility,filters,sort,status,created_by,created_at,updated_at`,
		tenantID, id, in.Name, in.Visibility, string(filters), string(sortWire), in.Status, expected))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListMacros(ctx context.Context, tenantID string) ([]Macro, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, body, channel_types, tags, status,
       use_count, last_used_at, metadata, created_at, updated_at
FROM support_macros
WHERE tenant_id = $1::uuid AND status <> 'archived'
ORDER BY use_count DESC, updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Macro{}
	for rows.Next() {
		item, err := scanMacro(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListMacrosPage(ctx context.Context, tenantID string, cursorKey []byte, cursor listCursor, limit int) (*TenantPage[Macro], error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text,tenant_id::text,name,body,channel_types,tags,status,use_count,last_used_at,metadata,created_at,updated_at
FROM support_macros
WHERE tenant_id=$1::uuid AND status<>'archived' AND updated_at<=$6::timestamptz
  AND (NOT $2::boolean OR (updated_at,id)<($3::timestamptz,$4::uuid))
ORDER BY updated_at DESC,id DESC LIMIT $5`, tenantID, cursor.ID != "", cursor.At, nullableUUID(cursor.ID), limit+1, cursor.SnapshotAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Macro, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanMacro(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	page := PageInfo{AsOf: cursor.SnapshotAt, Consistency: "mutable_window", MayReorder: true}
	if len(items) > limit {
		items = items[:limit]
		page.HasMore = true
		last := items[len(items)-1]
		next, encodeErr := encodeListCursor(cursorKey, tenantID, "macros", "active", limit, cursor.SnapshotAt, last.UpdatedAt, last.ID)
		if encodeErr != nil {
			return nil, encodeErr
		}
		page.NextCursor = &next
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TenantPage[Macro]{TenantID: tenantID, Items: items, Page: page}, nil
}

func (r *Repo) UpsertMacro(ctx context.Context, tenantID, id string, in Macro) (*Macro, error) {
	normalizeMacro(&in)
	if validation := ValidateMacro(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{meta, 16 << 10}); err != nil {
		return nil, err
	}
	var row rowScanner
	if strings.TrimSpace(id) == "" {
		row = tx.QueryRow(ctx, `
INSERT INTO support_macros (tenant_id, name, body, channel_types, tags, status, metadata)
VALUES ($1::uuid, $2, $3, $4::text[], $5::text[], $6, $7::jsonb)
RETURNING id::text, tenant_id::text, name, body, channel_types, tags, status,
       use_count, last_used_at, metadata, created_at, updated_at`,
			tenantID, in.Name, in.Body, in.ChannelTypes, in.Tags, in.Status, string(meta))
	} else {
		row = tx.QueryRow(ctx, `
UPDATE support_macros
SET name = $3, body = $4, channel_types = $5::text[], tags = $6::text[],
    status = $7, metadata = $8::jsonb, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, body, channel_types, tags, status,
       use_count, last_used_at, metadata, created_at, updated_at`,
			tenantID, id, in.Name, in.Body, in.ChannelTypes, in.Tags, in.Status, string(meta))
	}
	out, err := scanMacro(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PatchMacro(ctx context.Context, tenantID, id string, patch MacroPatch, expectedVersion string) (*Macro, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return nil, ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in, err := scanMacro(tx.QueryRow(ctx, `
SELECT id::text,tenant_id::text,name,body,channel_types,tags,status,use_count,last_used_at,metadata,created_at,updated_at
FROM support_macros WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, tenantID, id))
	if err != nil {
		return nil, mapNoRows(err)
	}
	if in.Version != expectedVersion {
		return nil, ErrPreconditionFailed
	}
	if patch.Name.Present {
		if patch.Name.Null {
			return nil, ErrInvalidPatch
		}
		in.Name = patch.Name.Value
	}
	if patch.Body.Present {
		if patch.Body.Null {
			return nil, ErrInvalidPatch
		}
		in.Body = patch.Body.Value
	}
	if patch.ChannelTypes.Present {
		in.ChannelTypes = patch.ChannelTypes.Value
		if patch.ChannelTypes.Null {
			in.ChannelTypes = []string{}
		}
	}
	if patch.Tags.Present {
		in.Tags = patch.Tags.Value
		if patch.Tags.Null {
			in.Tags = []string{}
		}
	}
	if patch.Status.Present {
		if patch.Status.Null {
			return nil, ErrInvalidPatch
		}
		in.Status = patch.Status.Value
	}
	if patch.Metadata.Present {
		in.Metadata = patch.Metadata.Value
		if patch.Metadata.Null {
			in.Metadata = map[string]any{}
		}
	}
	if validation := ValidateMacro(*in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidPatch, strings.Join(validation.Errors, "; "))
	}
	normalizeMacro(in)
	meta, _ := json.Marshal(in.Metadata)
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{meta, 16 << 10}); err != nil {
		return nil, err
	}
	out, err := scanMacro(tx.QueryRow(ctx, `
UPDATE support_macros SET name=$3,body=$4,channel_types=$5::text[],tags=$6::text[],status=$7,metadata=$8::jsonb,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND updated_at=$9::timestamptz
RETURNING id::text,tenant_id::text,name,body,channel_types,tags,status,use_count,last_used_at,metadata,created_at,updated_at`,
		tenantID, id, in.Name, in.Body, in.ChannelTypes, in.Tags, in.Status, string(meta), expected))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ArchiveViewOrMacro(ctx context.Context, tenantID, id, kind, expectedVersion string) (string, error) {
	expected, expectsAbsent, err := expectedUpdatedAt(expectedVersion)
	if err != nil || expectsAbsent {
		return "", ErrPreconditionFailed
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	table := "support_views"
	if kind == "macro" {
		table = "support_macros"
	}
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `UPDATE `+table+` SET status='archived',updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND updated_at=$3::timestamptz
RETURNING updated_at`, tenantID, id, expected).Scan(&updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if lookupErr := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+table+` WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, id).Scan(&exists); lookupErr != nil {
				return "", lookupErr
			}
			if exists {
				return "", ErrPreconditionFailed
			}
			return "", ErrNotFound
		}
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return resourceVersion(updatedAt), nil
}

func (r *Repo) UseMacro(ctx context.Context, tenantID, id string) (*Macro, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE support_macros
SET use_count = use_count + 1, last_used_at = now(), updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, body, channel_types, tags, status,
       use_count, last_used_at, metadata, created_at, updated_at`, tenantID, id)
	out, err := scanMacro(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateSpamAssessment(ctx context.Context, tenantID string, in SpamAssessment) (*SpamAssessment, error) {
	normalizeSpamAssessment(&in)
	in.AssessedBy = "operator"
	if validation := ValidateSpamAssessment(in); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidProjection, strings.Join(validation.Errors, "; "))
	}
	signals, _ := json.Marshal(in.Signals)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx, jsonbProjectionBound{signals, 16 << 10}); err != nil {
		return nil, err
	}
	var messageConversationID string
	if err = tx.QueryRow(ctx, `
SELECT conversation_id::text
FROM support_messages
WHERE tenant_id=$1::uuid AND id=$2::uuid
FOR KEY SHARE`, tenantID, in.MessageID).Scan(&messageConversationID); err != nil {
		return nil, mapNoRows(err)
	}
	if messageConversationID != in.ConversationID {
		return nil, ErrGroundingMismatch
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_spam_assessments
    (tenant_id, conversation_id, message_id, score, verdict, signals, assessed_by)
VALUES ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, $5, $6::jsonb, $7)
RETURNING id::text, tenant_id::text, COALESCE(conversation_id::text,''),
       COALESCE(message_id::text,''), score, verdict, signals, assessed_by, created_at`,
		tenantID, in.ConversationID, in.MessageID, in.Score, in.Verdict,
		string(signals), in.AssessedBy)
	out, err := scanSpamAssessment(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateAgentRun(ctx context.Context, tenantID, conversationID, ticketID string, in AgentRun) (*AgentRun, error) {
	if in.ToolPlan == nil {
		in.ToolPlan = map[string]any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	toolPlan, _ := json.Marshal(in.ToolPlan)
	meta, _ := json.Marshal(in.Metadata)
	if !validateUUID(conversationID) || (ticketID != "" && !validateUUID(ticketID)) ||
		!validHelpdeskDisplayText(in.Prompt, 4<<10, true) || !validHelpdeskDisplayText(in.Draft, 16<<10, false) ||
		!validHelpdeskSafeToken(in.Model, 128, true) ||
		!allowed(in.RunType, []string{"draft_reply", "triage", "handoff", "summary"}) ||
		!allowed(in.Status, []string{"drafted", "needs_handoff", "blocked", "accepted", "discarded"}) ||
		!validHelpdeskDisplayText(in.HandoffReason, 2<<10, true) || len(in.SafetyFlags) > 32 ||
		!validHelpdeskStringList(in.SafetyFlags, 32, 256, nil) ||
		!validHelpdeskJSON(in.ToolPlan, 32<<10, 8, 512) || !validHelpdeskJSON(in.Metadata, 16<<10, 8, 256) {
		return nil, ErrInvalidProjection
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = validateJSONBProjectionBounds(ctx, tx,
		jsonbProjectionBound{toolPlan, 32 << 10},
		jsonbProjectionBound{meta, 16 << 10},
	); err != nil {
		return nil, err
	}
	if _, err := getConversationTx(ctx, tx, tenantID, conversationID); err != nil {
		return nil, err
	}
	if ticketID != "" {
		ticket, ticketErr := getTicketTx(ctx, tx, tenantID, ticketID, true)
		if ticketErr != nil {
			return nil, ticketErr
		}
		if ticket.ConversationID != conversationID {
			return nil, ErrGroundingMismatch
		}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO support_agent_runs
    (tenant_id, conversation_id, ticket_id, run_type, status, model, prompt,
     draft, safety_flags, handoff_reason, tool_plan, metadata)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, $5, $6, $7,
     $8, $9::text[], $10, $11::jsonb, $12::jsonb)
RETURNING id::text, tenant_id::text, COALESCE(conversation_id::text,''),
       COALESCE(ticket_id::text,''), run_type, status, model, prompt, draft,
       safety_flags, handoff_reason, tool_plan, metadata, created_at, updated_at`,
		tenantID, conversationID, ticketID, in.RunType, in.Status, in.Model,
		in.Prompt, in.Draft, in.SafetyFlags, in.HandoffReason, string(toolPlan), string(meta))
	out, err := scanAgentRun(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
