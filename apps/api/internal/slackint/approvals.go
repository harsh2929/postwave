// SPDX-License-Identifier: AGPL-3.0-only
//
// Approval-bot side of the Slack integration.
//
// PostApprovalRequest is the entry point. Given an approval row +
// tenant id, look up the workspace connection, render a Block-Kit
// message with [Approve]/[Reject] buttons, POST it via
// `chat.postMessage`, and persist the returned message ts so the
// interactions handler can update the same message later.
//
// The Block-Kit `value` field on each button carries an HMAC-signed
// envelope of (approval_id|action|expires) — 30-minute expiry — so a
// stale button cannot be replayed against /api/v1/slack/approvals/decision.
package slackint

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// ApprovalLike is the subset of approvals.Approval we need. Defined as
// an interface so this package does not import the approvals package
// (which avoids a circular import: approvals → slackint → approvals).
type ApprovalLike interface {
	GetID() string
	GetTenantID() string
	GetResourceType() string
	GetResourceID() string
	GetRequestedByActorLabel() string
	GetExpiresAt() time.Time
}

// ApprovalView is a plain-struct adapter that satisfies ApprovalLike;
// the approvals package or callers can use it directly.
type ApprovalView struct {
	ID                    string
	TenantID              string
	ResourceType          string
	ResourceID            string
	RequestedByActorLabel string
	ExpiresAt             time.Time
}

func (v ApprovalView) GetID() string                    { return v.ID }
func (v ApprovalView) GetTenantID() string              { return v.TenantID }
func (v ApprovalView) GetResourceType() string          { return v.ResourceType }
func (v ApprovalView) GetResourceID() string            { return v.ResourceID }
func (v ApprovalView) GetRequestedByActorLabel() string { return v.RequestedByActorLabel }
func (v ApprovalView) GetExpiresAt() time.Time          { return v.ExpiresAt }

// approvalActionTTL bounds how long a Block-Kit button stays redeemable.
const approvalActionTTL = 30 * time.Minute

// ApprovalDeps wires everything PostApprovalRequest needs. main.go
// constructs this once and stashes it on the approvals service via
// the Notifier slot.
type ApprovalDeps struct {
	Pool       *db.Pool
	Cipher     sending.EnvelopeEncryptor
	HMACKey    []byte
	HTTPClient *http.Client
	// SummaryFn renders an optional one-line summary for the approval
	// (e.g. campaign subject). Nil → use resource_type/resource_id.
	SummaryFn func(ctx context.Context, tenantID, resourceType, resourceID string) string
}

// PostApprovalRequest posts the approval message to the tenant's
// connected Slack workspace. It is best-effort: a missing connection
// returns nil; a transport / Slack error is returned to the caller so
// they can log it but is NOT expected to fail the surrounding request.
func (d *ApprovalDeps) PostApprovalRequest(ctx context.Context, a ApprovalLike) error {
	if d == nil || d.Pool == nil {
		return nil
	}
	conn, err := LoadConnectionByTenant(ctx, d.Pool, d.Cipher, a.GetTenantID())
	if err != nil {
		return fmt.Errorf("load slack connection: %w", err)
	}
	if conn == nil {
		// Tenant has not connected Slack — nothing to do.
		return nil
	}
	channel := conn.DefaultChannelID
	if channel == "" {
		// Without a default channel id we can't post; degrade
		// silently so the caller's request still succeeds.
		return nil
	}
	summary := ""
	if d.SummaryFn != nil {
		summary = d.SummaryFn(ctx, a.GetTenantID(), a.GetResourceType(), a.GetResourceID())
	}
	if summary == "" {
		summary = fmt.Sprintf("%s · %s", a.GetResourceType(), a.GetResourceID())
	}
	blocks := buildApprovalBlocks(a, summary, d.HMACKey)
	body := map[string]any{
		"channel": channel,
		"text":    fmt.Sprintf("Approval needed: %s", summary), // fallback notification text
		"blocks":  blocks,
	}
	resp, err := d.slackPost(ctx, conn.BotToken, "chat.postMessage", body)
	if err != nil {
		return err
	}
	if !resp.OK {
		return fmt.Errorf("slack chat.postMessage: %s", resp.Error)
	}
	if resp.TS != "" {
		_ = d.recordMessage(ctx, a.GetTenantID(), a.GetID(), channel, resp.TS)
	}
	return nil
}

// recordMessage persists the (approval_id, channel, ts) tuple so the
// interactions handler can update the same message in place.
func (d *ApprovalDeps) recordMessage(ctx context.Context, tenantID, approvalID, channel, ts string) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO slack_approval_messages (approval_id, tenant_id, channel_id, message_ts)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (approval_id) DO UPDATE SET
    channel_id = EXCLUDED.channel_id,
    message_ts = EXCLUDED.message_ts`,
		approvalID, tenantID, channel, ts)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ----------------------------------------------------------------------
// Block-Kit construction
// ----------------------------------------------------------------------

// buildApprovalBlocks renders the initial pending-state message.
func buildApprovalBlocks(a ApprovalLike, summary string, hmacKey []byte) []map[string]any {
	approveValue := signApprovalAction(hmacKey, a.GetID(), "approve", time.Now().Add(approvalActionTTL))
	rejectValue := signApprovalAction(hmacKey, a.GetID(), "reject", time.Now().Add(approvalActionTTL))
	requester := a.GetRequestedByActorLabel()
	if requester == "" {
		requester = "(unknown)"
	}
	return []map[string]any{
		{
			"type": "header",
			"text": map[string]any{
				"type":  "plain_text",
				"text":  "Approval needed",
				"emoji": true,
			},
		},
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*%s*\nRequested by `%s`\nExpires <!date^%d^{date_short_pretty} {time}|%s>",
					escapeMrkdwn(summary), escapeMrkdwn(requester),
					a.GetExpiresAt().Unix(), a.GetExpiresAt().UTC().Format(time.RFC3339)),
			},
		},
		{
			"type":     "actions",
			"block_id": "approval_actions:" + a.GetID(),
			"elements": []map[string]any{
				{
					"type":      "button",
					"action_id": "approve",
					"style":     "primary",
					"text": map[string]any{
						"type":  "plain_text",
						"text":  "Approve",
						"emoji": true,
					},
					"value": approveValue,
				},
				{
					"type":      "button",
					"action_id": "reject",
					"style":     "danger",
					"text": map[string]any{
						"type":  "plain_text",
						"text":  "Reject",
						"emoji": true,
					},
					"value": rejectValue,
				},
			},
		},
	}
}

// buildDecidedBlocks renders the post-decision message that replaces
// the original. `decidedByDisplay` is the Slack user who clicked.
func buildDecidedBlocks(approvalID, summary, decision, decidedByDisplay string) []map[string]any {
	icon := "✓" // ✓
	verb := "Approved"
	if decision == "reject" || decision == "rejected" {
		icon = "✗" // ✗
		verb = "Rejected"
	}
	by := decidedByDisplay
	if by == "" {
		by = "(unknown)"
	}
	return []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*%s %s*\n%s\nApproval `%s`",
					icon, verb, escapeMrkdwn(summary), approvalID),
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{
				{
					"type": "mrkdwn",
					"text": fmt.Sprintf("Decided by %s · <!date^%d^{date_short_pretty} {time}|%s>",
						escapeMrkdwn(by), time.Now().Unix(), time.Now().UTC().Format(time.RFC3339)),
				},
			},
		},
	}
}

func escapeMrkdwn(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// ----------------------------------------------------------------------
// Slack HTTP helper
// ----------------------------------------------------------------------

type slackResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	TS      string `json:"ts,omitempty"`
	Channel string `json:"channel,omitempty"`
}

func (d *ApprovalDeps) slackPost(ctx context.Context, botToken, method string, payload map[string]any) (*slackResponse, error) {
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://slack.com/api/"+method, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", "Bearer "+botToken)
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}
	var out slackResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode slack response: %w (%s)", err, strings.TrimSpace(string(body)))
	}
	return &out, nil
}

// ----------------------------------------------------------------------
// Action-token signing (Block-Kit button `value` field)
// ----------------------------------------------------------------------

// signApprovalAction returns `<approvalID>.<action>.<expUnix>.<sig>`.
func signApprovalAction(key []byte, approvalID, action string, exp time.Time) string {
	expStr := strconv.FormatInt(exp.Unix(), 10)
	payload := approvalID + "." + action + "." + expStr
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

// VerifyApprovalAction returns the embedded approvalID + action after
// confirming the signature and that the expiry is in the future.
func VerifyApprovalAction(key []byte, token string) (approvalID, action string, err error) {
	parts := strings.Split(token, ".")
	if len(parts) != 4 {
		return "", "", errors.New("bad action token format")
	}
	approvalID, action, expStr, sig := parts[0], parts[1], parts[2], parts[3]
	payload := approvalID + "." + action + "." + expStr
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return "", "", errors.New("bad action signature")
	}
	exp, perr := strconv.ParseInt(expStr, 10, 64)
	if perr != nil {
		return "", "", errors.New("bad action exp")
	}
	if time.Now().Unix() > exp {
		return "", "", errors.New("action token expired")
	}
	if action != "approve" && action != "reject" {
		return "", "", errors.New("bad action verb")
	}
	return approvalID, action, nil
}
