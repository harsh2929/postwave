// SPDX-License-Identifier: AGPL-3.0-only
//
// Package discordint — Discord incoming-webhook integration.
//
// Same shape as slackint: tenant pastes a Discord webhook URL +
// picks events, the dispatcher writes a per-integration outbox row
// when a matching event fires, the outbox handler decrypts the URL
// + formats a Discord embed + POSTs.
//
// Wire-format differences vs Slack (handled by formatter.go):
//   - Discord wants `{embeds: [{title, description, color, fields,
//     timestamp}]}` instead of Slack's Block Kit.
//   - Color is a decimal-int tint of the left-bar (red = 15158332,
//     green = 3066993, etc.).
//   - Plain-text fallback uses `content` instead of Slack's `text`.
//   - Discord returns 204 + empty body on success rather than Slack's
//     200 + literal "ok"; the handler distinguishes both contracts.
package discordint

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

// OutboxKind is the outbox row kind for Discord deliveries.
const OutboxKind = "discord.deliver"

// MaxURLLength caps the stored URL.
const MaxURLLength = 2048

// discordHookRE matches a valid Discord webhook URL. Format:
// https://discord.com/api/webhooks/<channel_id>/<token>
// We accept the canonical host plus the discordapp.com legacy alias.
var discordHookRE = regexp.MustCompile(`^https://(?:discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+$`)

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

// CreateInput is the body of POST /api/v1/integrations/discord.
type CreateInput struct {
	URL         string   `json:"url"`
	ChannelHint string   `json:"channel_hint,omitempty"`
	Events      []string `json:"events"`
}

// UpdateInput is the body of PATCH /api/v1/integrations/discord/{id}.
type UpdateInput struct {
	URL         *string   `json:"url,omitempty"`
	ChannelHint *string   `json:"channel_hint,omitempty"`
	Events      *[]string `json:"events,omitempty"`
	Enabled     *bool     `json:"enabled,omitempty"`
}

// Errors.
var (
	ErrNotFound           = errors.New("discordint: not found")
	ErrInvalidURL         = errors.New("discordint: invalid Discord webhook URL")
	ErrEventsRequired     = errors.New("discordint: at least one event type required")
	ErrCipherUnconfigured = errors.New("discordint: KEK envelope cipher not configured")
)

func validateURL(u string) error {
	u = strings.TrimSpace(u)
	if u == "" || len(u) > MaxURLLength {
		return ErrInvalidURL
	}
	if !discordHookRE.MatchString(u) {
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

// Repo wraps the pgx pool with discord_integrations CRUD.
type Repo struct {
	Pool   *db.Pool
	Cipher sending.EnvelopeEncryptor
}

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
INSERT INTO discord_integrations
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
  FROM discord_integrations
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
	if in.URL != nil {
		if r.Cipher == nil {
			return nil, ErrCipherUnconfigured
		}
		envelope, err := r.Cipher.Encrypt(ctx, []byte(*in.URL))
		if err != nil {
			return nil, fmt.Errorf("encrypt url: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE discord_integrations SET webhook_url_envelope = $3
 WHERE tenant_id = $1::uuid AND id::text = $2`,
			tenantID, id, envelope,
		); err != nil {
			return nil, err
		}
	}
	var integ Integration
	row := tx.QueryRow(ctx, `
UPDATE discord_integrations SET
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

func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM discord_integrations WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

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
		`SELECT webhook_url_envelope FROM discord_integrations
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

func (r *Repo) RecordOutcome(ctx context.Context, tenantID, id string, deliveryErr error) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if deliveryErr == nil {
		_, err = tx.Exec(ctx, `
UPDATE discord_integrations SET
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
UPDATE discord_integrations SET
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

// Dispatcher mirrors slackint.Dispatcher.
type Dispatcher struct {
	Outbox *outbox.Repo
	Repo   *Repo
}

// Fire enqueues one discord.deliver row per matching integration.
func (d *Dispatcher) Fire(ctx context.Context, tx pgx.Tx, tenantID, eventType string, body any) (int, error) {
	if d == nil || d.Outbox == nil || d.Repo == nil {
		return 0, nil
	}
	if tenantID == "" {
		return 0, errors.New("discordint: TenantID required")
	}
	rows, err := tx.Query(ctx, `
SELECT id::text FROM discord_integrations
 WHERE tenant_id = $1::uuid AND enabled = true AND $2 = ANY(events)`,
		tenantID, eventType)
	if err != nil {
		return 0, fmt.Errorf("discordint: lookup integrations: %w", err)
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
		return 0, fmt.Errorf("discordint: marshal body: %w", err)
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

type DeliveryEnvelope struct {
	IntegrationID string          `json:"integration_id"`
	EventType     string          `json:"event_type"`
	Body          json.RawMessage `json:"body"`
}

// DiscordHandler is registered against OutboxKind.
type DiscordHandler struct {
	Repo       *Repo
	HTTPClient *http.Client
}

func (h *DiscordHandler) Handle(ctx context.Context, ev outbox.Event) error {
	var p DeliveryEnvelope
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return fmt.Errorf("discordint: malformed payload: %w", err)
	}
	url, err := h.Repo.LookupURL(ctx, ev.TenantID, p.IntegrationID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	msg := FormatDiscordMessage(p.EventType, p.Body)
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("discordint: marshal discord message: %w", err)
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
	_ = chatdelivery.LogEvent(ctx, h.Repo.Pool, ev.TenantID, "discord", p.IntegrationID, p.EventType, ev.ID, delErr)
	return delErr
}

// post issues the HTTP POST. Discord returns 204 on success, 4xx
// for bad payloads, 5xx for transient. Retry-After honoring is
// asynq's job (the outbox worker uses the standard backoff curve).
// sampleTestBody is the synthetic event payload rendered for a "Send test"
// (INTG-033).
var sampleTestBody = json.RawMessage(`{"message":"Test notification from Moosewave — this integration is connected."}`)

// SendTest delivers a synthetic test notification to the integration's webhook
// and records the outcome (INTG-033). Returns ErrNotFound when the integration
// is gone.
func (h *DiscordHandler) SendTest(ctx context.Context, tenantID, id string) error {
	url, err := h.Repo.LookupURL(ctx, tenantID, id)
	if err != nil {
		return err
	}
	msg := FormatDiscordMessage("test", sampleTestBody)
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("discordint: marshal test message: %w", err)
	}
	delErr := h.post(ctx, url, body)
	_ = h.Repo.RecordOutcome(ctx, tenantID, id, delErr)
	_ = chatdelivery.Log(ctx, h.Repo.Pool, tenantID, "discord", id, "test", delErr)
	return delErr
}

func (h *DiscordHandler) post(ctx context.Context, url string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Moosewave-Discord/1.0")
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
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK {
		return nil
	}
	return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
}

// scan helpers.
type rowScanner interface{ Scan(dest ...any) error }

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
