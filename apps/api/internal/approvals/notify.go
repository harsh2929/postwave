// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// PostmarkNotifier is the production Notifier. It POSTs a transactional email
// to the Postmark `/email` endpoint with a one-click approve/reject link.
//
// Recipient model: the notifier consults AdminLister to enumerate the
// tenant's owner+admin users (one row per user with their user_id +
// email), then gates each recipient individually via Dispatcher. When
// AdminLister returns an empty list the notifier falls back to the
// legacy single-mailbox path (tenants.approval_notify_email) so older
// tenants without a populated users table still receive an email.
//
// Best-effort: a 4xx/5xx from Postmark for one recipient is logged and
// does not abort the remaining recipients. The aggregate error returned
// from NotifyRequested is the LAST non-nil send error (or nil if every
// send succeeded). Callers in Service.Request goroutine-dispatch and
// discard the error anyway.
type PostmarkNotifier struct {
	HTTPClient    *http.Client
	ServerToken   string
	BaseURL       string // e.g. https://api.postmarkapp.com
	From          string
	PublicBaseURL string // e.g. https://app.moosewave.com
	Service       *Service
	Repo          *Repo

	// AdminLister enumerates the (user_id, email) pairs that should
	// receive an approval-request email for the tenant. nil = fall back
	// to the single-mailbox legacy path.
	AdminLister AdminLister

	// Dispatcher gates each recipient individually on the per-user
	// PrefApprovalRequest column. nil = no gating (every listed
	// recipient receives the email — matches the legacy single-mailbox
	// behaviour where no per-user pref was consulted).
	Dispatcher notifications.Dispatcher

	// Push optionally delivers a browser web push to each gated recipient
	// in parallel with the email, so an approver sees the request instantly
	// even with their inbox closed. nil = email-only (the default). The same
	// PrefApprovalRequest gate governs both channels.
	Push PushNotifier

	// Logger captures per-recipient gate + send outcomes. nil-safe;
	// falls back to slog.Default() inside the notifier.
	Logger *slog.Logger
}

// NewPostmarkNotifier wires defaults. Passing an empty ServerToken disables
// outbound calls (returns nil).
func NewPostmarkNotifier(serverToken, from, publicBaseURL string, svc *Service, repo *Repo) *PostmarkNotifier {
	if serverToken == "" {
		return nil
	}
	return &PostmarkNotifier{
		HTTPClient:    &http.Client{Timeout: 10 * time.Second},
		ServerToken:   serverToken,
		BaseURL:       "https://api.postmarkapp.com",
		From:          from,
		PublicBaseURL: publicBaseURL,
		Service:       svc,
		Repo:          repo,
	}
}

// NotifyRequested implements Notifier. Enumerates the tenant's approval
// recipients via AdminLister; gates each on PrefApprovalRequest; sends a
// signed approve/reject email to every recipient that passes the gate.
//
// When AdminLister is unset (or returns no recipients) the notifier
// falls back to the single tenants.approval_notify_email path so older
// tenants keep working. The legacy fallback is NOT gated per-user
// (there is no user_id to key the gate on); that path is effectively
// "fire-or-not" and matches the pre-refactor behaviour.
func (n *PostmarkNotifier) NotifyRequested(ctx context.Context, tenantID string, a *Approval) error {
	if n == nil {
		return nil
	}
	logger := notifierLogger(n.Logger)
	recipients, err := n.listRecipients(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("list recipients: %w", err)
	}
	if len(recipients) == 0 {
		// Fallback: legacy single-mailbox path. Read the
		// tenants.approval_notify_email column and, if set, send one
		// email to that address with no user-level gate (no user_id).
		// Repo may be nil in unit tests that exercise the per-recipient
		// path only; in that case there's no fallback path to take and
		// we no-op cleanly rather than nil-deref.
		if n.Repo == nil {
			return nil
		}
		to, lerr := n.Repo.LookupTenantApprovalNotifyEmail(ctx, tenantID)
		if lerr != nil {
			return fmt.Errorf("lookup notify email: %w", lerr)
		}
		if to == "" {
			return nil
		}
		return n.send(ctx, tenantID, a, to)
	}

	var lastErr error
	for _, r := range recipients {
		if r.Email == "" {
			continue
		}
		if !gateRecipient(ctx, n.Dispatcher, logger, tenantID, r) {
			logger.Info("approvals: skipping recipient per user pref",
				"tenant_id", tenantID, "user_id", r.UserID)
			continue
		}
		// Browser push, in parallel with the email. Best-effort: a push
		// failure (or no registered browser) never blocks the email, and
		// the Push impl no-ops when web push is unconfigured.
		n.pushRequested(ctx, logger, tenantID, a, r.UserID)
		if serr := n.send(ctx, tenantID, a, r.Email); serr != nil {
			logger.Warn("approvals: per-recipient send failed",
				"tenant_id", tenantID, "user_id", r.UserID, "err", serr.Error())
			lastErr = serr
			// Continue with remaining recipients — one Postmark hiccup
			// shouldn't silence the rest of the admin team.
		}
	}
	return lastErr
}

// pushRequested fires a best-effort browser push to one gated recipient. A
// nil Push (web push unwired) or any delivery error is swallowed after logging
// — the email is the system of record, the push is a convenience channel.
func (n *PostmarkNotifier) pushRequested(ctx context.Context, logger *slog.Logger, tenantID string, a *Approval, userID string) {
	if n.Push == nil || userID == "" {
		return
	}
	if _, err := n.Push.SendToUser(ctx, tenantID, userID, PushNotification{
		Title: "Approval needed",
		Body:  fmt.Sprintf("%s / %s is waiting for your approval.", a.ResourceType, a.ResourceID),
		URL:   "/app/approvals",
		Tag:   "approval-" + a.ID,
	}); err != nil {
		logger.Warn("approvals: web push failed",
			"tenant_id", tenantID, "user_id", userID, "err", err.Error())
	}
}

// listRecipients consults the configured AdminLister, returning an
// empty slice (not nil-but-with-error) when the lister itself is unset
// so the caller can fall through to the legacy single-mailbox path
// without a special-case nil check.
func (n *PostmarkNotifier) listRecipients(ctx context.Context, tenantID string) ([]AdminRecipient, error) {
	if n.AdminLister == nil {
		return nil, nil
	}
	return n.AdminLister.ListApprovalRecipients(ctx, tenantID)
}

// send fires one Postmark email with signed approve+reject links for
// the given approval to the given address. Centralised here so the
// per-recipient loop and the legacy fallback share the exact same
// rendering + transport.
func (n *PostmarkNotifier) send(ctx context.Context, tenantID string, a *Approval, to string) error {
	exp := a.ExpiresAt
	// Bind the token to the recipient email (approvals CRITICAL F1).
	// A forwarded link is now useless to anyone other than `to`.
	approveTok := n.Service.SignToken(a.ID, DecisionApprove, exp, to)
	rejectTok := n.Service.SignToken(a.ID, DecisionReject, exp, to)

	approveURL := n.linkFor(a.ID, DecisionApprove, approveTok)
	rejectURL := n.linkFor(a.ID, DecisionReject, rejectTok)

	subject := fmt.Sprintf("[Moosewave] Approval needed: %s", a.ResourceType)
	html := fmt.Sprintf(
		`<p>An action requires your approval.</p>
<p><strong>Resource:</strong> %s / %s</p>
<p><strong>Requested by:</strong> %s (%s)</p>
<p><a href="%s">Approve</a> &middot; <a href="%s">Reject</a></p>
<p style="color:#888;font-size:12px">This link expires at %s.</p>`,
		a.ResourceType, a.ResourceID,
		safe(a.RequestedByActorLabel), safe(a.RequestedByActorType),
		approveURL, rejectURL,
		exp.Format(time.RFC3339),
	)
	text := fmt.Sprintf(
		"Approval needed for %s/%s.\nApprove: %s\nReject: %s\nExpires: %s\n",
		a.ResourceType, a.ResourceID, approveURL, rejectURL, exp.Format(time.RFC3339),
	)

	body := map[string]any{
		"From":          n.From,
		"To":            to,
		"Subject":       subject,
		"HtmlBody":      html,
		"TextBody":      text,
		"MessageStream": "outbound",
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	endpoint, err := postmarkNotifierURL(n.BaseURL, "/email")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postmark-Server-Token", n.ServerToken)
	resp, err := n.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("postmark: %d", resp.StatusCode)
	}
	_ = tenantID // reserved for future per-tenant Postmark server token routing
	return nil
}

func (n *PostmarkNotifier) linkFor(id string, decision Decision, token string) string {
	v := url.Values{}
	v.Set("token", token)
	v.Set("decision", string(decision))
	return fmt.Sprintf("%s/api/public/approvals/%s/decide?%s", strings.TrimRight(n.PublicBaseURL, "/"), url.PathEscape(id), v.Encode())
}

func postmarkNotifierURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid postmark notifier base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported postmark notifier base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe postmark notifier base URL")
	}
	cleanPath := strings.TrimLeft(path, "/")
	for _, segment := range strings.Split(cleanPath, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe postmark notifier request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe postmark notifier request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + cleanPath
	return base.String(), nil
}

// safe substitutes a sentinel when a label string is empty so the rendered
// email does not show "(/)" placeholders.
func safe(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
