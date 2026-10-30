// SPDX-License-Identifier: AGPL-3.0-only
//
// Slack slash-command webhook for `/moosewave …`.
//
// Subcommands handled today:
//   - `/moosewave campaigns`           — list 5 most-recent campaigns
//   - `/moosewave send <campaign_id>`  — open a send-approval gate;
//     posts the same Block-Kit
//     approval message we'd post
//     from the desktop "Send" path.
//
// Slack signature verification reuses verifySlackSignature from
// interactions.go; never skipped.
package slackint

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// ApprovalCreator is implemented by approvals.Service (via a tiny
// adapter in main.go) so this package does not need to import the
// approvals package directly.
type ApprovalCreator interface {
	// CreateForCampaign creates a pending approval row for the given
	// campaign and returns an opaque ApprovalView ready for the
	// Block-Kit renderer.
	CreateForCampaign(ctx context.Context, tenantID, campaignID, requesterLabel string) (*ApprovalView, error)
}

// SlashCommandDeps wires the handler.
type SlashCommandDeps struct {
	Pool          *db.Pool
	Cipher        sending.EnvelopeEncryptor
	SigningSecret string
	HMACKey       []byte
	HTTPClient    *http.Client
	Approvals     ApprovalCreator
	// PostApproval is the same hook used by the approval-bot path.
	// Provided as a func so we don't hardcode a pointer to ApprovalDeps.
	PostApproval func(ctx context.Context, a ApprovalLike) error
	MaxBodyBytes int64
	// Logger receives server-side error logs for internal failures.
	// May be nil; httperror.WriteInternal tolerates a nil logger.
	Logger *slog.Logger
}

// SlashCommandsHandler implements POST /api/v1/slack/commands.
func (d *SlashCommandDeps) SlashCommandsHandler(w http.ResponseWriter, r *http.Request) {
	limit := d.MaxBodyBytes
	if limit <= 0 {
		limit = 64 * 1024
	}
	body, err := httpbody.ReadAtMost(r.Body, limit)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.WriteValidation(w, "payload_too_large", "Slack command payload too large")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := verifySlackSignature(d.SigningSecret, r.Header, body, time.Now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "bad_signature", "Slack signature verification failed")
		return
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	teamID := form.Get("team_id")
	channelID := form.Get("channel_id")
	userID := form.Get("user_id")
	userName := form.Get("user_name")
	text := strings.TrimSpace(form.Get("text"))

	conn, err := LoadConnectionByTeam(r.Context(), d.Pool, d.Cipher, teamID)
	if err != nil {
		writeEphemeral(w, fmt.Sprintf(":warning: workspace lookup failed: %s", err.Error()))
		return
	}
	if conn == nil {
		writeEphemeral(w, ":warning: This Slack workspace is not connected to a Moosewave tenant. Run `/moosewave` from a workspace where the bot has been installed.")
		return
	}
	tenantID := conn.TenantID
	parts := strings.Fields(text)
	sub := ""
	if len(parts) > 0 {
		sub = strings.ToLower(parts[0])
	}
	switch sub {
	case "", "help":
		writeEphemeral(w, "Moosewave commands:\n• `/moosewave campaigns` — list 5 most-recent campaigns\n• `/moosewave send <campaign_id>` — request approval to send a campaign")
	case "campaigns":
		d.handleCampaigns(r.Context(), w, tenantID)
	case "send":
		if len(parts) < 2 {
			writeEphemeral(w, ":warning: usage: `/moosewave send <campaign_id>`")
			return
		}
		d.handleSend(r.Context(), w, conn, channelID, userID, userName, parts[1])
	default:
		writeEphemeral(w, fmt.Sprintf(":warning: unknown subcommand `%s`. Try `/moosewave help`.", sub))
	}
}

func (d *SlashCommandDeps) handleCampaigns(ctx context.Context, w http.ResponseWriter, tenantID string) {
	rows, err := listRecentCampaigns(ctx, d.Pool, tenantID, 5)
	if err != nil {
		writeEphemeral(w, fmt.Sprintf(":warning: list campaigns failed: %s", err.Error()))
		return
	}
	if len(rows) == 0 {
		writeEphemeral(w, "_No campaigns yet. Create one in the desktop app._")
		return
	}
	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  "Recent campaigns",
				"emoji": true,
			},
		},
	}
	for _, c := range rows {
		blocks = append(blocks, map[string]any{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*%s*\nStatus: `%s` · `%s`",
					escapeMrkdwn(c.Name), c.Status, c.ID),
			},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"response_type": "ephemeral",
		"blocks":        blocks,
	})
}

func (d *SlashCommandDeps) handleSend(ctx context.Context, w http.ResponseWriter, conn *WorkspaceConnection, channelID, userID, userName, campaignID string) {
	if d.Approvals == nil {
		writeEphemeral(w, ":warning: approval service not configured")
		return
	}
	requester := userName
	if requester == "" {
		requester = userID
	}
	view, err := d.Approvals.CreateForCampaign(ctx, conn.TenantID, campaignID, "slack:"+requester)
	if err != nil {
		writeEphemeral(w, fmt.Sprintf(":warning: could not request approval: %s", err.Error()))
		return
	}
	// PostApproval uses the workspace's configured default channel.
	view.TenantID = conn.TenantID
	if d.PostApproval != nil {
		// We let PostApproval pick the configured default channel —
		// it ignores `target` today but the caller can still see the
		// ack below.
		if err := d.PostApproval(ctx, view); err != nil {
			writeEphemeral(w, fmt.Sprintf(":warning: approval created but Slack post failed: %s", err.Error()))
			return
		}
	}
	writeEphemeral(w, fmt.Sprintf(":hourglass_flowing_sand: Approval requested for campaign `%s`. The approval message has been posted to your default channel.", campaignID))
}

// writeEphemeral responds with a plain ephemeral message (only the
// invoking user sees it).
func writeEphemeral(w http.ResponseWriter, text string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"response_type": "ephemeral",
		"text":          text,
	})
}

// ----------------------------------------------------------------------
// Direct campaigns table reader. Lives here rather than importing the
// campaigns package so we don't widen its public surface for one query.
// ----------------------------------------------------------------------

type campaignSummary struct {
	ID     string
	Name   string
	Status string
}

func listRecentCampaigns(ctx context.Context, pool *db.Pool, tenantID string, limit int) ([]campaignSummary, error) {
	if tenantID == "" {
		return nil, errors.New("tenantID required")
	}
	if limit <= 0 || limit > 50 {
		limit = 5
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, COALESCE(name, ''), COALESCE(status, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		// `campaigns` table absent (older fork) → degrade silently.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := []campaignSummary{}
	for rows.Next() {
		var c campaignSummary
		if err := rows.Scan(&c.ID, &c.Name, &c.Status); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
