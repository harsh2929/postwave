// SPDX-License-Identifier: AGPL-3.0-only
package service_suite

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Row scanners, projection decoders and small value helpers shared by the
// service-suite Repo methods in repo.go.

func getConversationTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Conversation, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(channel_id::text,''), channel_type,
       source_type, external_thread_id, COALESCE(subscriber_id::text,''),
       COALESCE(requester_email::text,''), requester_phone, requester_name,
       subject, status, priority, assigned_to, COALESCE(helpdesk_active_assignee(tenant_id,assigned_to_user_id)::text,''), tags, last_message_at, metadata,
       created_at, updated_at
FROM support_conversations
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanConversation(row)
	return out, mapNoRows(err)
}

func getTicketTx(ctx context.Context, tx pgx.Tx, tenantID, id string, forKeyShare bool) (*Ticket, error) {
	lock := ""
	if forKeyShare {
		lock = " FOR KEY SHARE"
	}
	out, err := scanTicket(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(conversation_id::text,''), ticket_number,
       title, status, priority, assignee, source_channel, due_at, resolved_at,
       metadata, created_at, updated_at
FROM support_tickets
WHERE tenant_id=$1::uuid AND id=$2::uuid`+lock, tenantID, id))
	return out, mapNoRows(err)
}

func scanHubConfig(row rowScanner) (*HubConfig, error) {
	var out HubConfig
	var storefronts, blocks, rules, support, styling, meta []byte
	if err := row.Scan(&out.TenantID, &out.Status, &storefronts, &blocks, &rules,
		&support, &out.OrderHistoryEnabled, &out.FavoritesEnabled,
		&out.CouponsEnabled, &out.RecommendationsEnabled, &out.CustomerAgentEnabled,
		&styling, &meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(storefronts, &out.Storefronts, "storefronts", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(blocks, &out.ContentBlocks, "content_blocks", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(rules, &out.PersonalizationRules, "personalization_rules", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(support, &out.SupportSettings, "support_settings", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(styling, &out.Styling, "styling", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	normalizeConfig(&out)
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if !validateUUID(out.TenantID) {
		return nil, errors.New("service_suite: unsafe customer hub tenant projection")
	}
	if validation := ValidateConfig(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe customer hub projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.Version = resourceVersion(out.UpdatedAt)
	out.RuntimeAvailable = false
	out.RuntimeStatus = "held"
	out.RuntimeReasonCode = "customer_hub_runtime_unavailable"
	out.CustomerAgentEffective = false
	return &out, nil
}

func scanChannel(row rowScanner) (*Channel, error) {
	var out Channel
	var routing, agent, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.ChannelType,
		&out.Status, &out.ExternalRef, &routing, &agent, &meta,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(routing, &out.RoutingRules, "routing_rules", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(agent, &out.AgentSettings, "agent_settings", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) {
		return nil, errors.New("service_suite: unsafe channel identity projection")
	}
	if validation := ValidateChannel(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe channel projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.Version = resourceVersion(out.UpdatedAt)
	out.RuntimeAvailable = false
	out.RuntimeStatus = "held"
	out.RuntimeReasonCode = "helpdesk_channel_runtime_unavailable"
	return &out, nil
}

func scanConversation(row rowScanner) (*Conversation, error) {
	var out Conversation
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ChannelID, &out.ChannelType,
		&out.SourceType, &out.ExternalThreadID, &out.SubscriberID,
		&out.RequesterEmail, &out.RequesterPhone, &out.RequesterName,
		&out.Subject, &out.Status, &out.Priority, &out.AssignedTo,
		&out.AssignedToUserID, &out.Tags, &out.LastMessageAt, &meta, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if out.LastMessageAt != nil {
		value := out.LastMessageAt.UTC()
		out.LastMessageAt = &value
	}
	rawAssignment := strings.TrimSpace(out.AssignedTo)
	verifiedUserID := strings.TrimSpace(out.AssignedToUserID)
	switch {
	case verifiedUserID != "":
		out.AssignedTo = verifiedUserID
		out.AssignedToUserID = verifiedUserID
		out.AssignmentState = "tenant_active_user"
	case rawAssignment != "":
		out.AssignedTo = ""
		out.AssignedToUserID = ""
		out.AssignmentState = "legacy_unverified"
	default:
		out.AssignedTo = ""
		out.AssignedToUserID = ""
		out.AssignmentState = "unassigned"
	}
	projection := out
	projection.AssignedTo = ""
	projection.AssignedToUserID = ""
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) ||
		(out.AssignmentState == "tenant_active_user" && !validateUUID(verifiedUserID)) {
		return nil, errors.New("service_suite: unsafe conversation identity projection")
	}
	if validation := ValidateConversation(projection); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe conversation projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.Version = resourceVersion(out.UpdatedAt)
	return &out, nil
}

func scanMessage(row rowScanner) (*Message, error) {
	var out Message
	var attachments, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConversationID,
		&out.SourceType, &out.SourceID, &out.Direction, &out.SenderType,
		&out.Sender, &out.BodyText, &out.BodyHTML, &attachments, &meta,
		&out.SentAt, &out.CreatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(attachments, &out.Attachments, "attachments", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if out.Attachments == nil {
		out.Attachments = []any{}
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.SentAt = out.SentAt.UTC()
	out.CreatedAt = out.CreatedAt.UTC()
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) || !validateUUID(out.ConversationID) ||
		!validHelpdeskSafeToken(out.SourceType, 64, false) || !validHelpdeskOpaqueID(out.SourceID, 1024, true) ||
		!allowed(out.Direction, []string{"inbound", "outbound", "internal"}) ||
		!allowed(out.SenderType, []string{"customer", "agent", "system", "ai"}) ||
		!validHelpdeskProjectionTime(out.SentAt, false) || !validHelpdeskProjectionTime(out.CreatedAt, false) ||
		out.SentAt.After(out.CreatedAt) || len(out.Attachments) > 64 ||
		!validHelpdeskJSON(out.Attachments, helpdeskMetadataMaxBytes, 8, 512) ||
		!validHelpdeskJSON(out.Metadata, helpdeskMetadataMaxBytes, 8, 512) ||
		len([]byte(out.BodyHTML)) > 256<<10 || !utf8.ValidString(out.BodyHTML) {
		return nil, errors.New("service_suite: unsafe message projection")
	}
	out.TenantBinding = out.TenantID
	out.AttachmentCount = len(out.Attachments)
	out.ProjectionTruncated = out.BodyHTML != "" || out.AttachmentCount != 0 || len(out.Metadata) != 0
	if strings.TrimSpace(out.BodyText) == "" {
		out.BodyText = ""
		switch {
		case out.BodyHTML != "":
			out.BodyOmittedReason = "html_only"
		case out.AttachmentCount > 0:
			out.BodyOmittedReason = "attachments_only"
		default:
			out.BodyOmittedReason = "source_body_empty"
		}
	} else if !validHelpdeskDisplayText(out.BodyText, 16<<10, true) {
		out.BodyText = ""
		out.BodyOmittedReason = "source_body_unsafe"
		out.ProjectionTruncated = true
	}
	if !validHelpdeskDisplayText(out.Sender, 320, true) {
		out.Sender = ""
		out.ProjectionTruncated = true
	}
	switch out.Direction {
	case "internal":
		out.RecordKind = "internal_note"
		out.DeliveryStatus = "not_applicable"
	case "inbound":
		out.RecordKind = "inbound_record"
		out.DeliveryStatus = "received"
	case "outbound":
		out.RecordKind = "outbound_record"
		out.DeliveryStatus = "unverified"
	default:
		out.RecordKind = "unknown_record"
		out.DeliveryStatus = "unverified"
	}
	return &out, nil
}

func scanTicket(row rowScanner) (*Ticket, error) {
	var out Ticket
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConversationID,
		&out.TicketNumber, &out.Title, &out.Status, &out.Priority,
		&out.Assignee, &out.SourceChannel, &out.DueAt, &out.ResolvedAt,
		&meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", helpdeskMetadataMaxBytes); err != nil {
		return nil, err
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	if strings.TrimSpace(out.Assignee) != "" {
		out.AssignmentState = "legacy_unverified"
		out.Assignee = ""
	} else {
		out.AssignmentState = "unassigned"
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if out.DueAt != nil {
		value := out.DueAt.UTC()
		out.DueAt = &value
	}
	if out.ResolvedAt != nil {
		value := out.ResolvedAt.UTC()
		out.ResolvedAt = &value
	}
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) || out.TicketNumber < 1 {
		return nil, errors.New("service_suite: unsafe ticket identity projection")
	}
	if validation := ValidateTicket(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe ticket projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.Version = resourceVersion(out.UpdatedAt)
	return &out, nil
}

func scanView(row rowScanner) (*View, error) {
	var out View
	var filters, sort []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Visibility,
		&filters, &sort, &out.Status, &out.CreatedBy, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(filters, &out.Filters, "filters", helpdeskSmallJSONMaxBytes); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(sort, &out.Sort, "sort", helpdeskSmallJSONMaxBytes); err != nil {
		return nil, err
	}
	if out.Filters == nil {
		out.Filters = map[string]any{}
	}
	if out.Sort == nil {
		out.Sort = map[string]any{}
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) {
		return nil, errors.New("service_suite: unsafe view identity projection")
	}
	if validation := ValidateView(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe view projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.Version = resourceVersion(out.UpdatedAt)
	return &out, nil
}

func scanMacro(row rowScanner) (*Macro, error) {
	var out Macro
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Body,
		&out.ChannelTypes, &out.Tags, &out.Status, &out.UseCount,
		&out.LastUsedAt, &meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", 16<<10); err != nil {
		return nil, err
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if out.LastUsedAt != nil {
		value := out.LastUsedAt.UTC()
		out.LastUsedAt = &value
	}
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) {
		return nil, errors.New("service_suite: unsafe macro identity projection")
	}
	if validation := ValidateMacro(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe macro projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	out.UsageEvidenceStatus = "unverified"
	out.Version = resourceVersion(out.UpdatedAt)
	return &out, nil
}

func scanSpamAssessment(row rowScanner) (*SpamAssessment, error) {
	var out SpamAssessment
	var signals []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConversationID,
		&out.MessageID, &out.Score, &out.Verdict, &signals,
		&out.AssessedBy, &out.CreatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(signals, &out.Signals, "signals", 16<<10); err != nil {
		return nil, err
	}
	if out.Signals == nil {
		out.Signals = map[string]any{}
	}
	out.CreatedAt = out.CreatedAt.UTC()
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) {
		return nil, errors.New("service_suite: unsafe spam-assessment identity projection")
	}
	if validation := ValidateSpamAssessment(out); !validation.Valid {
		return nil, fmt.Errorf("service_suite: unsafe spam-assessment projection: %s", strings.Join(validation.Errors, "; "))
	}
	out.TenantBinding = out.TenantID
	if out.AssessedBy == "rule" || strings.HasPrefix(out.AssessedBy, "rule_") {
		out.AssessmentMode = "rule_based"
		out.CertificationStatus = "unverified_rule_based"
	} else {
		out.AssessmentMode = "operator_record"
		out.CertificationStatus = "unverified_operator_record"
	}
	return &out, nil
}

func scanAgentRun(row rowScanner) (*AgentRun, error) {
	var out AgentRun
	var toolPlan, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConversationID,
		&out.TicketID, &out.RunType, &out.Status, &out.Model, &out.Prompt,
		&out.Draft, &out.SafetyFlags, &out.HandoffReason, &toolPlan,
		&meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(toolPlan, &out.ToolPlan, "tool_plan", 32<<10); err != nil {
		return nil, err
	}
	if err := decodeBoundedJSONProjection(meta, &out.Metadata, "metadata", 16<<10); err != nil {
		return nil, err
	}
	if out.ToolPlan == nil {
		out.ToolPlan = map[string]any{}
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	if !validateUUID(out.ID) || !validateUUID(out.TenantID) || !validateUUID(out.ConversationID) ||
		(out.TicketID != "" && !validateUUID(out.TicketID)) ||
		!allowed(out.RunType, []string{"draft_reply", "triage", "handoff", "summary"}) ||
		!allowed(out.Status, []string{"drafted", "needs_handoff", "blocked", "accepted", "discarded"}) ||
		!validHelpdeskSafeToken(out.Model, 128, true) ||
		!validHelpdeskDisplayText(out.Prompt, 4<<10, true) ||
		!validHelpdeskDisplayText(out.Draft, 16<<10, false) ||
		!validHelpdeskStringList(out.SafetyFlags, 32, 256, nil) ||
		!validHelpdeskDisplayText(out.HandoffReason, 2<<10, true) ||
		!validHelpdeskJSON(out.ToolPlan, 32<<10, 8, 512) ||
		!validHelpdeskJSON(out.Metadata, 16<<10, 8, 256) ||
		!validHelpdeskProjectionTime(out.CreatedAt, false) ||
		!validHelpdeskProjectionTime(out.UpdatedAt, false) || out.UpdatedAt.Before(out.CreatedAt) {
		return nil, errors.New("service_suite: unsafe agent-run projection")
	}
	out.ExecutionMode = "deterministic_template"
	out.ProviderExecuted = false
	out.TenantBinding = out.TenantID
	return &out, nil
}

func defaultHubConfig(tenantID string) *HubConfig {
	out := &HubConfig{
		TenantID:               tenantID,
		Status:                 "draft",
		OrderHistoryEnabled:    true,
		FavoritesEnabled:       true,
		CouponsEnabled:         true,
		RecommendationsEnabled: true,
	}
	normalizeConfig(out)
	out.TenantBinding = tenantID
	out.Version = absentResourceVersion
	out.RuntimeAvailable = false
	out.RuntimeStatus = "held"
	out.RuntimeReasonCode = "customer_hub_runtime_unavailable"
	out.CustomerAgentEffective = false
	return out
}

func timeString(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func nullableUUID(id string) any {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return id
}

func truncateUTF8Bytes(value string, limit int) string {
	if limit <= 0 || len([]byte(value)) <= limit {
		return value
	}
	for len(value) > limit {
		_, size := utf8.DecodeLastRuneInString(value)
		if size <= 0 {
			return ""
		}
		value = value[:len(value)-size]
	}
	return value
}

func messageProjectionEquivalent(existing *Message, conversationID string, incoming Message) bool {
	if existing == nil || existing.ConversationID != conversationID || existing.SourceType != incoming.SourceType ||
		existing.SourceID != incoming.SourceID || existing.Direction != incoming.Direction ||
		existing.SenderType != incoming.SenderType || existing.Sender != incoming.Sender ||
		existing.BodyText != incoming.BodyText || existing.BodyHTML != incoming.BodyHTML {
		return false
	}
	existingAttachments, _ := json.Marshal(existing.Attachments)
	incomingAttachments, _ := json.Marshal(incoming.Attachments)
	existingMeta, _ := json.Marshal(existing.Metadata)
	incomingMeta, _ := json.Marshal(incoming.Metadata)
	if string(existingAttachments) != string(incomingAttachments) || string(existingMeta) != string(incomingMeta) {
		return false
	}
	return incoming.SentAt.IsZero() || existing.SentAt.Equal(incoming.SentAt.UTC())
}

func messageProjectionHash(message Message) string {
	projection := struct {
		ConversationID string         `json:"conversation_id"`
		SourceType     string         `json:"source_type"`
		SourceID       string         `json:"source_id"`
		Direction      string         `json:"direction"`
		SenderType     string         `json:"sender_type"`
		Sender         string         `json:"sender"`
		BodyText       string         `json:"body_text"`
		BodyHTML       string         `json:"body_html"`
		Attachments    []any          `json:"attachments"`
		Metadata       map[string]any `json:"metadata"`
	}{message.ConversationID, message.SourceType, message.SourceID, message.Direction,
		message.SenderType, message.Sender, message.BodyText, message.BodyHTML,
		message.Attachments, message.Metadata}
	raw, _ := json.Marshal(projection)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func sha256Hex(purpose string, values ...string) string {
	h := sha256.New()
	_, _ = h.Write([]byte(purpose))
	for _, value := range values {
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(value))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func decodeJSONProjection(raw []byte, target any, field string) error {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("service_suite: %s projection is null or empty", field)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("service_suite: decode %s projection: %w", field, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("service_suite: decode %s projection: trailing JSON value", field)
	}
	return nil
}

func decodeBoundedJSONProjection(raw []byte, target any, field string, maxBytes int) error {
	if len(raw) > maxBytes {
		return fmt.Errorf("service_suite: %s projection exceeds %d canonical jsonb bytes", field, maxBytes)
	}
	return decodeJSONProjection(raw, target, field)
}

func mapNoRows(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
