package social_capture

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type Repo struct {
	Pool *db.Pool
}

// ListRules returns auto-reply rules newest-first with keyset pagination on
// (updated_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned when
// more rows remain. updated_at is mutable, so a row edited concurrently may
// shift between pages — acceptable for this admin list.
func (r *Repo) ListRules(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]AutoReplyRule, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, network, status, trigger_phrases,
       questions, property_mappings, COALESCE(target_list_id::text, ''),
       COALESCE(target_segment_id::text, ''), COALESCE(sms_list_id::text, ''),
       COALESCE(sender_profile_id::text, ''), reply_template, consent_handoff,
       metadata, created_at, updated_at
FROM social_auto_reply_rules
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
`+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []AutoReplyRule{}
	for rows.Next() {
		item, err := scanRule(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateRule(ctx context.Context, tenantID string, in AutoReplyRule) (*AutoReplyRule, error) {
	normalizeRule(&in)
	questions, _ := json.Marshal(in.Questions)
	props, _ := json.Marshal(in.PropertyMappings)
	handoff, _ := json.Marshal(in.ConsentHandoff)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO social_auto_reply_rules
    (tenant_id, name, network, status, trigger_phrases, questions,
     property_mappings, target_list_id, target_segment_id, sms_list_id,
     sender_profile_id, reply_template, consent_handoff, metadata)
VALUES
    ($1::uuid, $2, $3, $4, $5::text[], $6::jsonb,
     $7::jsonb, NULLIF($8, '')::uuid, NULLIF($9, '')::uuid, NULLIF($10, '')::uuid,
     NULLIF($11, '')::uuid, $12, $13::jsonb, $14::jsonb)
RETURNING id::text, tenant_id::text, name, network, status, trigger_phrases,
       questions, property_mappings, COALESCE(target_list_id::text, ''),
       COALESCE(target_segment_id::text, ''), COALESCE(sms_list_id::text, ''),
       COALESCE(sender_profile_id::text, ''), reply_template, consent_handoff,
       metadata, created_at, updated_at`,
		tenantID, in.Name, in.Network, in.Status, in.TriggerPhrases,
		string(questions), string(props), in.TargetListID, in.TargetSegmentID,
		in.SMSListID, in.SenderProfileID, in.ReplyTemplate, string(handoff), string(meta))
	out, err := scanRule(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetRule(ctx context.Context, tenantID, id string) (*AutoReplyRule, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getRuleTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) RecordLead(ctx context.Context, tenantID, ruleID string, in EventInput) (*LeadCapture, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rule, err := getRuleTx(ctx, tx, tenantID, ruleID)
	if err != nil {
		return nil, err
	}
	answers := nilMap(in.Answers)
	mapped := map[string]any{}
	for answerKey, destAny := range rule.PropertyMappings {
		dest, ok := destAny.(string)
		if !ok || strings.TrimSpace(dest) == "" {
			continue
		}
		if value, exists := answers[answerKey]; exists {
			mapped[dest] = value
		}
	}
	answersRaw, _ := json.Marshal(answers)
	mappedRaw, _ := json.Marshal(mapped)
	meta := nilMap(in.Metadata)
	meta["rule_name"] = rule.Name
	metaRaw, _ := json.Marshal(meta)
	status := "captured"
	if rule.SMSListID != "" {
		status = "consent_pending"
	}
	row := tx.QueryRow(ctx, `
INSERT INTO social_lead_captures
    (tenant_id, rule_id, network, external_user_id, external_thread_id,
     subscriber_email, phone_e164, answers, mapped_properties, status, metadata)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, NULLIF($6, '')::citext, $7,
     $8::jsonb, $9::jsonb, $10, $11::jsonb)
RETURNING id::text, tenant_id::text, COALESCE(rule_id::text, ''), network,
       external_user_id, external_thread_id, COALESCE(subscriber_email::text, ''),
       phone_e164, answers, mapped_properties, status, metadata, created_at`,
		tenantID, rule.ID, defaulted(in.Network, rule.Network), in.ExternalUserID,
		in.ExternalThreadID, in.SubscriberEmail, in.PhoneE164, string(answersRaw),
		string(mappedRaw), status, string(metaRaw))
	out, err := scanLead(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListLeads returns captured leads newest-first with keyset pagination on
// (created_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned when
// more rows remain.
func (r *Repo) ListLeads(ctx context.Context, tenantID, ruleID string, limit int, cursor pagination.Cursor) ([]LeadCapture, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 rule_id filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(ruleID), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(rule_id::text, ''), network,
       external_user_id, external_thread_id, COALESCE(subscriber_email::text, ''),
       phone_e164, answers, mapped_properties, status, metadata, created_at
FROM social_lead_captures
WHERE tenant_id = $1::uuid AND ($2 = '' OR rule_id = $2::uuid)
`+keyset+`
ORDER BY created_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []LeadCapture{}
	for rows.Next() {
		item, err := scanLead(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	return out, next, nil
}

// ListTapLinks returns tap-to-text links newest-first with keyset pagination
// on (updated_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned when
// more rows remain. Keyset is applied here, before the handler hydrates each
// link. updated_at is mutable, so a row edited concurrently may shift between
// pages — acceptable for this admin list.
func (r *Repo) ListTapLinks(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]TapToTextLink, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, slug::text, name, status,
       COALESCE(sms_list_id::text, ''), COALESCE(sender_profile_id::text, ''),
       destination_phone, keyword, message_body, consent_text, success_url,
       proof_metadata, stats, created_at, updated_at
FROM tap_to_text_links
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
`+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []TapToTextLink{}
	for rows.Next() {
		item, err := scanTapLink(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateTapLink(ctx context.Context, tenantID string, in TapToTextLink) (*TapToTextLink, error) {
	if err := normalizeTapLink(&in); err != nil {
		return nil, err
	}
	proof, _ := json.Marshal(in.ProofMetadata)
	stats, _ := json.Marshal(in.Stats)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO tap_to_text_links
    (tenant_id, slug, name, status, sms_list_id, sender_profile_id,
     destination_phone, keyword, message_body, consent_text, success_url,
     proof_metadata, stats)
VALUES
    ($1::uuid, $2, $3, $4, $5::uuid, NULLIF($6, '')::uuid,
     $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
RETURNING id::text, tenant_id::text, slug::text, name, status,
       COALESCE(sms_list_id::text, ''), COALESCE(sender_profile_id::text, ''),
       destination_phone, keyword, message_body, consent_text, success_url,
       proof_metadata, stats, created_at, updated_at`,
		tenantID, in.Slug, in.Name, in.Status, in.SMSListID, in.SenderProfileID,
		in.DestinationPhone, in.Keyword, in.MessageBody, in.ConsentText,
		in.SuccessURL, string(proof), string(stats))
	out, err := scanTapLink(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetTapLink(ctx context.Context, tenantID, id string) (*TapToTextLink, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getTapLinkTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetPublicTapLink(ctx context.Context, slug string) (*TapToTextLink, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.public_tap_to_text_slug', $1, true)", strings.TrimSpace(slug)); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug::text, name, status,
       COALESCE(sms_list_id::text, ''), COALESCE(sender_profile_id::text, ''),
       destination_phone, keyword, message_body, consent_text, success_url,
       proof_metadata, stats, created_at, updated_at
FROM tap_to_text_links
WHERE slug = $1::citext AND status = 'active'
LIMIT 1`, strings.TrimSpace(slug))
	out, err := scanTapLink(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) RecordTapEvent(ctx context.Context, tenantID, linkID, eventType, phone, email string, metadata map[string]any) error {
	meta, _ := json.Marshal(nilMap(metadata))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO tap_to_text_events
    (tenant_id, link_id, event_type, phone_e164, subscriber_email, metadata)
VALUES
    ($1::uuid, NULLIF($2, '')::uuid, $3, $4, NULLIF($5, '')::citext, $6::jsonb)`,
		tenantID, linkID, eventType, phone, email, string(meta))
	if err != nil {
		return err
	}
	_, _ = tx.Exec(ctx, `
UPDATE tap_to_text_links
   SET stats = jsonb_set(
       COALESCE(stats, '{}'::jsonb),
       ARRAY[$3],
       to_jsonb(COALESCE((stats->>$3)::int, 0) + 1),
       true)
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, linkID, eventType)
	return tx.Commit(ctx)
}

func getRuleTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*AutoReplyRule, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, network, status, trigger_phrases,
       questions, property_mappings, COALESCE(target_list_id::text, ''),
       COALESCE(target_segment_id::text, ''), COALESCE(sms_list_id::text, ''),
       COALESCE(sender_profile_id::text, ''), reply_template, consent_handoff,
       metadata, created_at, updated_at
FROM social_auto_reply_rules
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanRule(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func getTapLinkTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*TapToTextLink, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug::text, name, status,
       COALESCE(sms_list_id::text, ''), COALESCE(sender_profile_id::text, ''),
       destination_phone, keyword, message_body, consent_text, success_url,
       proof_metadata, stats, created_at, updated_at
FROM tap_to_text_links
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanTapLink(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func scanRule(row pgx.Row) (*AutoReplyRule, error) {
	var out AutoReplyRule
	var questions, props, handoff, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Network,
		&out.Status, &out.TriggerPhrases, &questions, &props,
		&out.TargetListID, &out.TargetSegmentID, &out.SMSListID,
		&out.SenderProfileID, &out.ReplyTemplate, &handoff, &meta,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(questions, &out.Questions)
	out.PropertyMappings = decodeMap(props)
	out.ConsentHandoff = decodeMap(handoff)
	out.Metadata = decodeMap(meta)
	return &out, nil
}

func scanLead(row pgx.Row) (*LeadCapture, error) {
	var out LeadCapture
	var answers, mapped, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.RuleID, &out.Network,
		&out.ExternalUserID, &out.ExternalThreadID, &out.SubscriberEmail,
		&out.PhoneE164, &answers, &mapped, &out.Status, &meta,
		&out.CreatedAt); err != nil {
		return nil, err
	}
	out.Answers = decodeMap(answers)
	out.MappedProperties = decodeMap(mapped)
	out.Metadata = decodeMap(meta)
	return &out, nil
}

func scanTapLink(row pgx.Row) (*TapToTextLink, error) {
	var out TapToTextLink
	var proof, stats []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Slug, &out.Name,
		&out.Status, &out.SMSListID, &out.SenderProfileID,
		&out.DestinationPhone, &out.Keyword, &out.MessageBody,
		&out.ConsentText, &out.SuccessURL, &proof, &stats,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.ProofMetadata = decodeMap(proof)
	out.Stats = decodeMap(stats)
	return &out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

func nilMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	return in
}
