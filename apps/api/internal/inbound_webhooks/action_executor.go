package inbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ProductActionExecutor connects trigger matches to the source-of-truth
// sequence, tag, and automation runtimes. Every local mutation is idempotent.
type ProductActionExecutor struct {
	Pool                 *db.Pool
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
}

func (e *ProductActionExecutor) AddToSequence(ctx context.Context, tenantID, sequenceID, email string) error {
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM voice_sequences WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, sequenceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("sequence %s not found", sequenceID)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO sequence_enrollments (tenant_id, sequence_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (tenant_id, sequence_id, subscriber_email) DO NOTHING`, tenantID, sequenceID, strings.ToLower(strings.TrimSpace(email))); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (e *ProductActionExecutor) AddTag(ctx context.Context, tenantID, tag, email string) error {
	return e.changeTag(ctx, tenantID, tag, email, true)
}

func (e *ProductActionExecutor) RemoveTag(ctx context.Context, tenantID, tag, email string) error {
	return e.changeTag(ctx, tenantID, tag, email, false)
}

func (e *ProductActionExecutor) changeTag(ctx context.Context, tenantID, tag, email string, add bool) error {
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM subscribers
WHERE tenant_id=$1::uuid AND email=$2`, tenantID, strings.ToLower(strings.TrimSpace(email))).Scan(&subscriberID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("subscriber %s not found", email)
		}
		return err
	}
	var tagID string
	if add {
		err = tx.QueryRow(ctx, `
WITH inserted AS (
  INSERT INTO tags (tenant_id, name) VALUES ($1::uuid, $2::citext)
  ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id::text
)
SELECT id FROM inserted UNION ALL
SELECT id::text FROM tags WHERE tenant_id=$1::uuid AND name=$2::citext LIMIT 1`, tenantID, strings.TrimSpace(tag)).Scan(&tagID)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO subscriber_tags
(tenant_id, subscriber_id, tag_id, source)
VALUES ($1::uuid,$2::uuid,$3::uuid,'trigger')
ON CONFLICT (tenant_id,subscriber_id,tag_id) DO NOTHING`, tenantID, subscriberID, tagID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE subscribers SET tags=array_append(
array_remove(COALESCE(tags,'{}'::text[]),$3),$3), updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID, strings.TrimSpace(tag))
		}
	} else {
		err = tx.QueryRow(ctx, `SELECT id::text FROM tags
WHERE tenant_id=$1::uuid AND name=$2::citext`, tenantID, strings.TrimSpace(tag)).Scan(&tagID)
		if errors.Is(err, pgx.ErrNoRows) {
			return tx.Commit(ctx)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM subscriber_tags
WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$3::uuid`, tenantID, subscriberID, tagID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE subscribers SET tags=array_remove(
COALESCE(tags,'{}'::text[]),$3), updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID, strings.TrimSpace(tag))
		}
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (e *ProductActionExecutor) StartAutomation(ctx context.Context, tenantID, automationID, email string) error {
	return e.startAutomation(ctx, tenantID, automationID, email, "")
}

// ExecuteDurableAction implements DurableActionExecutor. Local mutations use
// source-of-truth uniqueness/upsert semantics; start_automation additionally
// propagates actionID as both source_event_id and Idempotency-Key so a response
// loss cannot enroll the subscriber twice.
func (e *ProductActionExecutor) ExecuteDurableAction(
	ctx context.Context,
	actionID, tenantID, actionType, targetID, email string,
) error {
	switch actionType {
	case ActionAddToSequence:
		return e.AddToSequence(ctx, tenantID, targetID, email)
	case ActionAddTag:
		return e.AddTag(ctx, tenantID, targetID, email)
	case ActionRemoveTag:
		return e.RemoveTag(ctx, tenantID, targetID, email)
	case ActionStartAutomation:
		return e.startAutomation(ctx, tenantID, targetID, email, actionID)
	default:
		return &actionExecutionError{
			code:      "unknown_action_type",
			permanent: true,
			err:       fmt.Errorf("unknown action type %q", actionType),
		}
	}
}

func (e *ProductActionExecutor) startAutomation(
	ctx context.Context,
	tenantID, automationID, email, idempotencyKey string,
) error {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(e.AutomationServiceURL), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return &actionExecutionError{
			code: "automation_url_invalid",
			err:  errors.New("automation service is not configured"),
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/v1/automations/trigger"
	body, _ := json.Marshal(map[string]any{
		"automation_id":    automationID,
		"trigger_type":     "inbound_webhook",
		"subscriber_email": strings.ToLower(strings.TrimSpace(email)),
		"source_event_id":  strings.TrimSpace(idempotencyKey),
		"payload":          map[string]any{"source": "inbound_webhook"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tenant-Id", tenantID)
	if idempotencyKey = strings.TrimSpace(idempotencyKey); idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	if token := strings.TrimSpace(e.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := e.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 10 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 300 {
		permanent := resp.StatusCode >= 400 && resp.StatusCode < 500 &&
			resp.StatusCode != http.StatusRequestTimeout &&
			resp.StatusCode != http.StatusTooEarly &&
			resp.StatusCode != http.StatusTooManyRequests
		return &actionExecutionError{
			code:       fmt.Sprintf("automation_http_%d", resp.StatusCode),
			httpStatus: resp.StatusCode,
			permanent:  permanent,
			err:        fmt.Errorf("automation trigger returned %d", resp.StatusCode),
		}
	}
	return nil
}
