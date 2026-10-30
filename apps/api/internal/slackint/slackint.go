// SPDX-License-Identifier: AGPL-3.0-only
//
// Package slackint — first-class Slack integration on top of the
// existing webhook fanout pipeline.
//
// Why this isn't just "register a webhook with the Slack URL":
// Slack incoming webhooks want a specific `{text, blocks: [...]}`
// shape; the raw Moosewave envelope is `{event_type, body, ...}`.
// Without translation a tenant gets a JSON dump in their channel.
// The adapter formats each event type with tasteful defaults
// (see formatter.go) so what lands in Slack is human-readable.
//
// Storage shape:
//
//   - URL stored envelope-encrypted with the platform KEK (same
//     cipher used by webhooks.secret_envelope in 0039).
//   - On creation we return the URL once + a stable channel_hint;
//     subsequent reads omit the URL entirely.
//
// Dispatch path:
//
//  1. Producer fires a Moosewave event (subscriber.unsubscribed,
//     campaign.sent, etc.) via the regular webhook dispatcher.
//  2. The Slack adapter is also a producer — it watches the same
//     event stream and queues a separate `slack.deliver` outbox
//     row per matching integration.
//  3. The outbox worker calls SlackHandler.Handle which decrypts the
//     URL, formats the message, POSTs.
//
// We chose a SECOND outbox kind rather than reusing webhooks.deliver
// because the request body shape is fundamentally different (Slack
// payload vs Moosewave envelope) and the failure modes differ too
// (Slack returns 200 with `ok:false` JSON for "channel archived"
// while a generic webhook would return 4xx — handlers need to read
// each ESP's error contract).
package slackint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/chatdelivery"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// OutboxKind is the outbox row kind for Slack deliveries.
const OutboxKind = "slack.deliver"

// MaxURLLength caps the stored URL.
const MaxURLLength = 2048

// slackHookRE matches a valid Slack incoming-webhook URL. We don't try
// to validate the webhook is "live" at create time (no point — Slack
// could rotate it tomorrow); we just reject obvious garbage.
var slackHookRE = regexp.MustCompile(`^https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+$`)

// Integration is the persisted row (without the URL plaintext).
type Integration struct {
	ID                 string     `json:"id"`
	TenantID           string     `json:"tenant_id"`
	ChannelHint        string     `json:"channel_hint,omitempty"`
	Events             []string   `json:"events"`
	Enabled            bool       `json:"enabled"`
	LastDeliveryStatus string     `json:"last_delivery_status,omitempty"`
	LastDeliveryAt     *time.Time `json:"last_delivery_at,omitempty"`
	LastDeliveryError  string     `json:"last_delivery_error,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

// CreateInput is the body of POST /api/v1/integrations/slack.
type CreateInput struct {
	URL         string   `json:"url"`
	ChannelHint string   `json:"channel_hint,omitempty"`
	Events      []string `json:"events"`
}

// UpdateInput is the body of PATCH /api/v1/integrations/slack/{id}.
type UpdateInput struct {
	URL         *string   `json:"url,omitempty"`
	ChannelHint *string   `json:"channel_hint,omitempty"`
	Events      *[]string `json:"events,omitempty"`
	Enabled     *bool     `json:"enabled,omitempty"`
}

// Errors.
var (
	ErrNotFound           = errors.New("slackint: not found")
	ErrInvalidURL         = errors.New("slackint: invalid Slack incoming-webhook URL")
	ErrEventsRequired     = errors.New("slackint: at least one event type required")
	ErrCipherUnconfigured = errors.New("slackint: KEK envelope cipher not configured")
)

func validateURL(u string) error {
	u = strings.TrimSpace(u)
	if u == "" || len(u) > MaxURLLength {
		return ErrInvalidURL
	}
	if !slackHookRE.MatchString(u) {
		return ErrInvalidURL
	}
	return nil
}

func defaultHTTPClient() *http.Client {
	return &http.Client{
		Transport: outbound_webhooks.NewSecureTransport(),
		Timeout:   10 * time.Second,
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			return validateURL(req.URL.String())
		},
	}
}

// Repo wraps the pgx pool with slack_integrations CRUD.
type Repo struct {
	Pool   *db.Pool
	Cipher sending.EnvelopeEncryptor // shared with webhooks; wraps the URL
}

type WorkspaceConnectionStatus struct {
	Connected          bool      `json:"connected"`
	ID                 string    `json:"id,omitempty"`
	SlackTeamID        string    `json:"slack_team_id,omitempty"`
	SlackTeamName      string    `json:"slack_team_name,omitempty"`
	DefaultChannelID   string    `json:"default_channel_id,omitempty"`
	DefaultChannelName string    `json:"default_channel_name,omitempty"`
	CreatedAt          time.Time `json:"created_at,omitempty"`
	UpdatedAt          time.Time `json:"updated_at,omitempty"`
}

func (r *Repo) GetWorkspaceConnectionStatus(ctx context.Context, tenantID string) (*WorkspaceConnectionStatus, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("slackint: repo unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out WorkspaceConnectionStatus
	err = tx.QueryRow(ctx, `
SELECT id::text, slack_team_id, slack_team_name,
       COALESCE(default_channel_id, ''), COALESCE(default_channel_name, ''),
       created_at, updated_at
  FROM slack_workspace_connections
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID).Scan(
		&out.ID, &out.SlackTeamID, &out.SlackTeamName,
		&out.DefaultChannelID, &out.DefaultChannelName,
		&out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		if isNoRows(err) {
			_ = tx.Commit(ctx)
			return &WorkspaceConnectionStatus{Connected: false}, nil
		}
		return nil, err
	}
	out.Connected = true
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) DisconnectWorkspaceConnection(ctx context.Context, tenantID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, errors.New("slackint: repo unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM slack_workspace_connections
 WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// Create persists a new integration. The plaintext URL is encrypted
// before storage; we return the row WITHOUT the URL so the caller sees
// "channel_hint" as the user-visible identifier.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Integration, error) {
	if err := validateURL(in.URL); err != nil {
		return nil, err
	}
	if len(in.Events) == 0 {
		return nil, ErrEventsRequired
	}
	if r.Cipher == nil {
		return nil, ErrCipherUnconfigured
	}
	envelope, err := r.Cipher.Encrypt(ctx, []byte(in.URL))
	if err != nil {
		return nil, fmt.Errorf("encrypt url: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var integ Integration
	row := tx.QueryRow(ctx, `
INSERT INTO slack_integrations
    (tenant_id, webhook_url_envelope, channel_hint, events)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4)
RETURNING id::text, tenant_id::text, COALESCE(channel_hint, ''),
          events, enabled, COALESCE(last_delivery_status, ''),
          last_delivery_at, COALESCE(last_delivery_error, ''),
          created_at, updated_at`,
		tenantID, envelope, in.ChannelHint, in.Events)
	if err := scan(row, &integ); err != nil {
		return nil, err
	}
	return &integ, tx.Commit(ctx)
}

// List returns the tenant's integrations.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(channel_hint, ''),
       events, enabled, COALESCE(last_delivery_status, ''),
       last_delivery_at, COALESCE(last_delivery_error, ''),
       created_at, updated_at
  FROM slack_integrations
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Integration{}
	for rows.Next() {
		var i Integration
		if err := scan(rows, &i); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Update applies a partial patch.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Integration, error) {
	if in.URL != nil {
		if err := validateURL(*in.URL); err != nil {
			return nil, err
		}
	}
	if in.Events != nil && len(*in.Events) == 0 {
		return nil, ErrEventsRequired
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// We do URL rotation in two SQL statements (UPDATE-with-url then
	// UPDATE-rest) so an in.URL change rotates the envelope without
	// having to encrypt unchanged URLs.
	if in.URL != nil {
		if r.Cipher == nil {
			return nil, ErrCipherUnconfigured
		}
		envelope, err := r.Cipher.Encrypt(ctx, []byte(*in.URL))
		if err != nil {
			return nil, fmt.Errorf("encrypt url: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE slack_integrations SET webhook_url_envelope = $3
 WHERE tenant_id = $1::uuid AND id::text = $2`,
			tenantID, id, envelope,
		); err != nil {
			return nil, err
		}
	}
	var integ Integration
	row := tx.QueryRow(ctx, `
UPDATE slack_integrations SET
    channel_hint = COALESCE($3, channel_hint),
    events       = COALESCE($4, events),
    enabled      = COALESCE($5, enabled)
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, COALESCE(channel_hint, ''),
          events, enabled, COALESCE(last_delivery_status, ''),
          last_delivery_at, COALESCE(last_delivery_error, ''),
          created_at, updated_at`,
		tenantID, id,
		strPtr(in.ChannelHint),
		eventsPtr(in.Events),
		boolPtr(in.Enabled))
	if err := scan(row, &integ); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &integ, tx.Commit(ctx)
}

// Delete drops the integration.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM slack_integrations WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// LookupURL returns the decrypted URL for a tenant+id pair. Worker
// path; uses outbox_worker permissive policy when called outside a
// tenant context.
func (r *Repo) LookupURL(ctx context.Context, tenantID, id string) (string, error) {
	if r.Cipher == nil {
		return "", ErrCipherUnconfigured
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	if err := tx.QueryRow(ctx,
		`SELECT webhook_url_envelope FROM slack_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2 AND enabled = true`,
		tenantID, id,
	).Scan(&envelope); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	plaintext, err := r.Cipher.Decrypt(ctx, envelope, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt url: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// FindIntegrationsForEvent returns enabled integrations across ALL
// tenants that subscribe to eventType. Cross-tenant query; relies on
// the outbox_worker permissive policy. Used by the producer that
// listens to webhook events and queues slack.deliver rows.
func (r *Repo) FindIntegrationsForEvent(ctx context.Context, tenantID, eventType string) ([]string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text FROM slack_integrations
 WHERE tenant_id = $1::uuid AND enabled = true AND $2 = ANY(events)`,
		tenantID, eventType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RecordOutcome flips the dashboard fields after a delivery attempt.
// Best-effort: errors are returned for logging but the dispatcher
// shouldn't bounce a successful HTTP call over a flaky bookkeeping
// write.
func (r *Repo) RecordOutcome(ctx context.Context, tenantID, id string, deliveryErr error) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if deliveryErr == nil {
		_, err = tx.Exec(ctx, `
UPDATE slack_integrations SET
    last_delivery_status = 'success',
    last_delivery_at = now(),
    last_delivery_error = NULL
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	} else {
		msg := deliveryErr.Error()
		if len(msg) > 1024 {
			msg = msg[:1024]
		}
		_, err = tx.Exec(ctx, `
UPDATE slack_integrations SET
    last_delivery_status = 'failed',
    last_delivery_at = now(),
    last_delivery_error = $3
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, msg)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ----------------------------------------------------------------------
// Dispatcher: translates Moosewave webhook events into slack.deliver
// outbox rows so SlackHandler picks them up alongside webhooks.deliver.
// ----------------------------------------------------------------------

// Dispatcher is wired alongside webhooks.Dispatcher; both fire from
// the same producer call sites. We deliberately keep this a separate
// dispatcher (rather than folding into webhooks.Dispatcher) so a
// tenant who turns Slack OFF doesn't pay the per-row cost of a
// disabled integration in the webhooks query.
type Dispatcher struct {
	Outbox *outbox.Repo
	Repo   *Repo
}

// Fire enqueues one slack.deliver row per matching integration.
// Returns the count enqueued (0 = nobody listening, not an error).
//
// Same atomicity story as webhooks.Dispatcher.Fire: pass the same
// pgx.Tx the producer used for the business write, so Slack delivery
// is part of that tx.
func (d *Dispatcher) Fire(ctx context.Context, tx pgx.Tx, tenantID, eventType string, body any) (int, error) {
	if d == nil || d.Outbox == nil || d.Repo == nil {
		return 0, nil
	}
	if tenantID == "" {
		return 0, errors.New("slackint: TenantID required")
	}
	rows, err := tx.Query(ctx, `
SELECT id::text FROM slack_integrations
 WHERE tenant_id = $1::uuid AND enabled = true AND $2 = ANY(events)`,
		tenantID, eventType)
	if err != nil {
		return 0, fmt.Errorf("slackint: lookup integrations: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return 0, fmt.Errorf("slackint: marshal body: %w", err)
	}
	for _, id := range ids {
		env := DeliveryEnvelope{
			IntegrationID: id,
			EventType:     eventType,
			Body:          bodyBytes,
		}
		if _, err := d.Outbox.Append(ctx, tx, outbox.Append{
			TenantID: tenantID,
			Kind:     OutboxKind,
			Payload:  env,
		}); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// DeliveryEnvelope is the outbox row payload for slack.deliver.
type DeliveryEnvelope struct {
	IntegrationID string          `json:"integration_id"`
	EventType     string          `json:"event_type"`
	Body          json.RawMessage `json:"body"`
}

// ----------------------------------------------------------------------
// Outbox handler: decrypts URL, formats Slack message, POSTs.
// ----------------------------------------------------------------------

// SlackHandler is registered against OutboxKind.
type SlackHandler struct {
	Repo       *Repo
	HTTPClient *http.Client
}

// Handle implements outbox.HandlerFunc.
func (h *SlackHandler) Handle(ctx context.Context, ev outbox.Event) error {
	var p DeliveryEnvelope
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return fmt.Errorf("slackint: malformed payload: %w", err)
	}
	url, err := h.Repo.LookupURL(ctx, ev.TenantID, p.IntegrationID)
	if err != nil {
		// Integration deleted / disabled between Fire and Deliver — ack.
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	msg := FormatSlackMessage(p.EventType, p.Body)
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("slackint: marshal slack message: %w", err)
	}
	// Already posted for this outbox event.
	//
	// The outbox is at-least-once: this handler posts, then the worker marks
	// the event complete, and a crash or lease expiry between the two
	// redelivers it. Without this the person is notified again, and the
	// delivery log records two successes with no way to say they were one
	// event. The operator-triggered test path below deliberately has no such
	// guard: a second click is meant to send a second message.
	if chatdelivery.AlreadyDelivered(ctx, h.Repo.Pool, ev.TenantID, p.IntegrationID, ev.ID) {
		return nil
	}
	delErr := h.post(ctx, url, body)
	_ = h.Repo.RecordOutcome(ctx, ev.TenantID, p.IntegrationID, delErr)
	// INTG-033: append to the durable delivery history (best-effort).
	_ = chatdelivery.LogEvent(ctx, h.Repo.Pool, ev.TenantID, "slack", p.IntegrationID, p.EventType, ev.ID, delErr)
	return delErr
}

// sampleTestBody is the synthetic event payload rendered for a "Send test"
// (INTG-033). formatGeneric echoes it so the delivered card is clearly a test.
var sampleTestBody = json.RawMessage(`{"message":"Test notification from Moosewave — this integration is connected."}`)

// SendTest delivers a synthetic test notification to the integration's webhook
// and records the outcome (INTG-033). Returns ErrNotFound when the integration
// is gone so the handler can answer 404. Any post failure is returned so the
// caller can surface it to the operator.
func (h *SlackHandler) SendTest(ctx context.Context, tenantID, id string) error {
	url, err := h.Repo.LookupURL(ctx, tenantID, id)
	if err != nil {
		return err
	}
	msg := FormatSlackMessage("test", sampleTestBody)
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("slackint: marshal test message: %w", err)
	}
	delErr := h.post(ctx, url, body)
	_ = h.Repo.RecordOutcome(ctx, tenantID, id, delErr)
	_ = chatdelivery.Log(ctx, h.Repo.Pool, tenantID, "slack", id, "test", delErr)
	return delErr
}

// post issues the HTTP POST to Slack. Slack returns 200 + the literal
// string "ok" on success; any other body or non-2xx is a failure.
func (h *SlackHandler) post(ctx context.Context, url string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Moosewave-Slack/1.0")
	client := h.HTTPClient
	if client == nil {
		client = defaultHTTPClient()
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if !bytes.Equal(bytes.TrimSpace(respBody), []byte("ok")) {
		return fmt.Errorf("slack returned non-ok body: %s", strings.TrimSpace(string(respBody)))
	}
	return nil
}

// ----------------------------------------------------------------------
// scan helpers
// ----------------------------------------------------------------------

type rowScanner interface {
	Scan(dest ...any) error
}

func scan(r rowScanner, out *Integration) error {
	return r.Scan(
		&out.ID, &out.TenantID, &out.ChannelHint,
		&out.Events, &out.Enabled,
		&out.LastDeliveryStatus, &out.LastDeliveryAt, &out.LastDeliveryError,
		&out.CreatedAt, &out.UpdatedAt,
	)
}

func strPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func eventsPtr(p *[]string) any {
	if p == nil {
		return nil
	}
	return *p
}

func boolPtr(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}
