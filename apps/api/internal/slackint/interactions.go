// SPDX-License-Identifier: AGPL-3.0-only
//
// Slack Block-Kit interaction webhook. Slack POSTs an
// `application/x-www-form-urlencoded` body with a single `payload`
// field — a JSON document describing which button was clicked.
//
// Verification path (mandatory — never skip):
//  1. Read the entire raw request body.
//  2. Compute v0 = HMAC-SHA256(signing_secret, "v0:<timestamp>:<rawBody>")
//  3. Compare in constant time against X-Slack-Signature.
//  4. Reject if |now - timestamp| > 5 minutes (replay window).
//
// On success we resolve the approval, apply the decision (approve or
// reject), and respond with `response_action: update` so Slack swaps
// the original message for the post-decision render produced by
// buildDecidedBlocks.
package slackint

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// signingSecretSkew is the maximum age of a Slack-signed request. Per
// Slack's docs the canonical replay window is 5 minutes.
const signingSecretSkew = 5 * time.Minute

// SlackSigningSecretEnv is the env var Slack signs against.
const SlackSigningSecretEnv = "SLACK_SIGNING_SECRET"

// ApprovalDecider is the narrow interface InteractionsHandler uses to
// flip an approval's status. The approvals package provides this via
// its Service.Decide method; we keep the interface here to dodge a
// circular import.
type ApprovalDecider interface {
	// Decide should mark approvalID as approved or rejected for the
	// given tenant. action is "approve" or "reject".
	Decide(ctx context.Context, tenantID, approvalID, action, decidedByUserID, notes string) error
	// LookupSummary returns a one-liner used in the decided-state
	// message ("✓ Approved by …"). May be empty.
	LookupSummary(ctx context.Context, tenantID, approvalID string) string
}

// InteractionsDeps wires the handler. signingSecret defaults to the
// SLACK_SIGNING_SECRET env var. HMACKey is the same key used to sign
// Block-Kit button values in approvals.go.
type InteractionsDeps struct {
	Pool          *db.Pool
	Cipher        sending.EnvelopeEncryptor
	SigningSecret string
	HMACKey       []byte
	Decider       ApprovalDecider
	HTTPClient    *http.Client
	// MaxBodyBytes caps the request body we read; Slack interaction
	// payloads are well under 64 KiB.
	MaxBodyBytes int64
	// Logger receives server-side error logs for internal failures
	// (db lookups, decider errors). May be nil; httperror.WriteInternal
	// no-ops the log call in that case.
	Logger *slog.Logger
}

// NewInteractionsDeps builds the dep struct with sensible defaults.
func NewInteractionsDeps(pool *db.Pool, cipher sending.EnvelopeEncryptor, hmacKey []byte, decider ApprovalDecider) *InteractionsDeps {
	return &InteractionsDeps{
		Pool:          pool,
		Cipher:        cipher,
		HMACKey:       hmacKey,
		Decider:       decider,
		SigningSecret: os.Getenv(SlackSigningSecretEnv),
		HTTPClient:    &http.Client{Timeout: 10 * time.Second},
		MaxBodyBytes:  256 * 1024,
	}
}

// verifySlackSignature implements the v0 scheme described at
// https://api.slack.com/authentication/verifying-requests-from-slack.
//
// rawBody is the unmodified request body — `application/x-www-form-urlencoded`
// for interactions/commands, JSON for events. The signature is over
// `v0:<timestamp>:<rawBody>` and the comparator must use hmac.Equal.
func verifySlackSignature(secret string, header http.Header, rawBody []byte, now time.Time) error {
	if secret == "" {
		return errors.New("slack signing secret not configured")
	}
	ts := header.Get("X-Slack-Request-Timestamp")
	sig := header.Get("X-Slack-Signature")
	if ts == "" || sig == "" {
		return errors.New("missing Slack signature headers")
	}
	tsNum, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return fmt.Errorf("bad timestamp: %w", err)
	}
	delta := now.Unix() - tsNum
	if delta < 0 {
		delta = -delta
	}
	if time.Duration(delta)*time.Second > signingSecretSkew {
		return errors.New("timestamp outside replay window")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("v0:"))
	_, _ = mac.Write([]byte(ts))
	_, _ = mac.Write([]byte(":"))
	_, _ = mac.Write(rawBody)
	want := "v0=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return errors.New("signature mismatch")
	}
	return nil
}

// readVerifiedBody reads + signature-verifies the request body. It
// returns the raw bytes (so the caller can re-parse them) on success.
func (d *InteractionsDeps) readVerifiedBody(r *http.Request) ([]byte, error) {
	limit := d.MaxBodyBytes
	if limit <= 0 {
		limit = 256 * 1024
	}
	body, err := httpbody.ReadAtMost(r.Body, limit)
	if err != nil {
		return nil, err
	}
	if err := verifySlackSignature(d.SigningSecret, r.Header, body, time.Now()); err != nil {
		return nil, err
	}
	return body, nil
}

// ----------------------------------------------------------------------
// Payload shapes (subset)
// ----------------------------------------------------------------------

type interactionPayload struct {
	Type        string              `json:"type"`
	Team        interactionTeam     `json:"team"`
	User        interactionUser     `json:"user"`
	Channel     interactionChannel  `json:"channel"`
	Message     interactionMessage  `json:"message"`
	Actions     []interactionAction `json:"actions"`
	ResponseURL string              `json:"response_url"`
}

type interactionTeam struct {
	ID     string `json:"id"`
	Domain string `json:"domain"`
}

type interactionUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Name     string `json:"name"`
}

type interactionChannel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type interactionMessage struct {
	TS string `json:"ts"`
}

type interactionAction struct {
	ActionID string `json:"action_id"`
	Value    string `json:"value"`
	BlockID  string `json:"block_id"`
}

// ----------------------------------------------------------------------
// HTTP handler
// ----------------------------------------------------------------------

// InteractionsHandler implements POST /api/v1/slack/interactions.
func (d *InteractionsDeps) InteractionsHandler(w http.ResponseWriter, r *http.Request) {
	body, err := d.readVerifiedBody(r)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.WriteValidation(w, "payload_too_large", "Slack interaction payload too large")
			return
		}
		httperror.Write(w, http.StatusUnauthorized, "bad_signature", "Slack signature verification failed")
		return
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	rawPayload := form.Get("payload")
	if rawPayload == "" {
		httperror.WriteValidation(w, "missing_field", "payload field required")
		return
	}
	var p interactionPayload
	if err := json.Unmarshal([]byte(rawPayload), &p); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}
	if p.Type != "block_actions" || len(p.Actions) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	action := p.Actions[0]
	if action.ActionID != "approve" && action.ActionID != "reject" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	approvalID, verifiedAction, err := VerifyApprovalAction(d.HMACKey, action.Value)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "bad_action_token", "action token verification failed")
		return
	}
	if verifiedAction != action.ActionID {
		httperror.Write(w, http.StatusUnauthorized, "action_mismatch",
			"action_id and signed action disagree")
		return
	}
	conn, err := LoadConnectionByTeam(r.Context(), d.Pool, d.Cipher, p.Team.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if conn == nil {
		httperror.Write(w, http.StatusNotFound, "workspace_not_connected",
			"no Moosewave workspace connection for this Slack team")
		return
	}
	tenantID := conn.TenantID
	notes := fmt.Sprintf("decided via Slack by @%s", p.User.Username)
	if d.Decider != nil {
		if err := d.Decider.Decide(r.Context(), tenantID, approvalID, verifiedAction, "", notes); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	summary := ""
	if d.Decider != nil {
		summary = d.Decider.LookupSummary(r.Context(), tenantID, approvalID)
	}
	if summary == "" {
		summary = "Approval " + approvalID
	}
	display := p.User.Username
	if display == "" {
		display = p.User.Name
	}
	updated := buildDecidedBlocks(approvalID, summary, verifiedAction, display)
	resp := map[string]any{
		"replace_original": true,
		"text":             fmt.Sprintf("Approval %s by @%s", verifiedAction, display),
		"blocks":           updated,
	}
	writeJSON(w, http.StatusOK, resp)
}

// LookupSlackMessage resolves the (channel, ts) we recorded for an
// approval at post time. Used by the optional follow-up updater that
// runs when the approval is decided via the desktop UI rather than
// the Slack button — keeps the channel message in sync. tenantID
// MUST match the tenant the approval belongs to.
func LookupSlackMessage(ctx context.Context, pool *db.Pool, tenantID, approvalID string) (channelID, ts string, err error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx,
		`SELECT channel_id, message_ts FROM slack_approval_messages
		  WHERE tenant_id = $1::uuid AND approval_id = $2::uuid`,
		tenantID, approvalID).Scan(&channelID, &ts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil
		}
		return "", "", err
	}
	return channelID, ts, tx.Commit(ctx)
}
