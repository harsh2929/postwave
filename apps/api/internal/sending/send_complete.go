// SPDX-License-Identifier: AGPL-3.0-only
//
// send_complete.go: customer-facing "your campaign just finished
// sending" email path. Triggered from sendloop.go when the last
// pending recipient row of a campaign flips to 'sent' (or the queue
// drains in a non-pending terminal state). The dispatcher is gated
// per-recipient on the notifications.PrefSendComplete pref.
//
// Why it lives in this package (and not internal/notifications): the
// concrete email body references the campaign's subject + recipient
// counts, which the send-loop already has in hand. A separate package
// would force either a circular dep or a third "events" hop. Keeping
// it next to sendloop.go means the data is one struct away from the
// trigger site.
//
// Concurrency: the notifier is invoked fire-and-forget from sendloop
// (see sendloop.go's transitionCompletedCampaign call site). A slow
// mailer must NEVER block the send loop's next batch — that would
// stall the queue for an entire tenant. The notifier is therefore
// expected to be called from a goroutine with a fresh timeout-bound
// context; see the call site for the standard pattern.

package sending

import (
	"context"
	"fmt"
	"html/template"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// Mailer is the narrow contract the send-complete path needs from a
// transactional mailer. Defined here (not as a re-export of
// internal/mailer.Mailer) so the sending package stays free of an
// import dependency on internal/mailer and can be unit-tested with
// a hand-rolled stub. main.go wires an adapter over the real mailer.
type Mailer interface {
	Send(ctx context.Context, m MailMessage) error
}

// MailMessage is the typed envelope for one outbound transactional
// email. Mirrors the subset of mailer.Message the send-complete path
// uses; an adapter in main.go converts MailMessage → mailer.Message.
type MailMessage struct {
	From    string
	To      string
	Subject string
	Text    string
	HTML    string
}

// TenantUser is one (user_id, email) pair the send-complete notifier
// will consider as a recipient. Mirrors approvals.AdminRecipient in
// shape; separate type so the sending package doesn't import
// approvals.
type TenantUser struct {
	ID    string
	Email string
}

// TenantUserRepo enumerates users for a tenant, optionally filtered
// by role. Production wires this to the `users` table; tests pass a
// hand-rolled stub.
type TenantUserRepo interface {
	ListUsersForTenant(ctx context.Context, tenantID string, roles []string) ([]TenantUser, error)
}

// SendCompleteEvent is the typed payload the send loop hands to the
// notifier when a campaign transitions from 'sending' to 'sent'. The
// stats fields are precomputed by the send loop so the notifier
// doesn't have to round-trip back to Postgres for the same numbers.
type SendCompleteEvent struct {
	TenantID     string
	CampaignID   string
	CampaignName string
	Subject      string
	Recipients   int
	Sent         int
	Bounced      int
	Suppressed   int
	SentAt       time.Time
}

// SendCompleteNotifier emails the tenant's admin/editor users when a
// campaign finishes sending. Per-recipient gating: each user has
// their own notification_preferences row, consulted via Dispatcher.
// Fail-open: a DB error on the pref lookup means SEND (mirrors the
// PgDispatcher contract).
type SendCompleteNotifier struct {
	Mailer     Mailer
	Dispatcher notifications.Dispatcher
	TenantRepo TenantUserRepo
	BaseURL    string // for the campaign-report link in the body
	From       string // "Moosewave <noreply@moosewave.com>"
	Logger     *slog.Logger
	Feed       NotificationFeed
	// Roles narrows the recipient set. Defaults to owner+admin+editor
	// when empty so production callers don't have to spell it out.
	Roles []string
}

// FeedNotification is the narrow in-app notification shape needed by the
// sending package. The API layer adapts it to notification_feed.NewNotification.
type FeedNotification struct {
	Kind     string
	Title    string
	Body     string
	DeepLink string
	Payload  map[string]any
}

type NotificationFeed interface {
	Fanout(ctx context.Context, tenantID string, userIDs []string, n FeedNotification) error
}

// Notify fans the send-complete email out to every admin/editor user
// of the tenant that has PrefSendComplete enabled. A single failure
// (mailer error, gate error) does NOT abort the batch — each
// recipient is independent. Returns the LAST non-nil error
// encountered (or nil) so a caller has the option to log; the
// production call site fire-and-forgets it.
func (n *SendCompleteNotifier) Notify(ctx context.Context, evt SendCompleteEvent) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("send-complete panic: %v", rec)
		}
	}()
	if n == nil {
		return nil
	}
	logger := n.logger()
	if n.TenantRepo == nil || n.Mailer == nil {
		// Incomplete wiring: no-op so a partial-deploy doesn't crash
		// the send loop. We log loudly so an operator notices.
		logger.Warn("send-complete: notifier wired without TenantRepo or Mailer; skipping",
			"campaign_id", evt.CampaignID)
		return nil
	}
	roles := n.Roles
	if len(roles) == 0 {
		roles = []string{"owner", "admin", "editor"}
	}
	users, err := n.TenantRepo.ListUsersForTenant(ctx, evt.TenantID, roles)
	if err != nil {
		return fmt.Errorf("send-complete: list users: %w", err)
	}
	if len(users) == 0 {
		return nil
	}
	var lastErr error
	if n.Feed != nil {
		userIDs := make([]string, 0, len(users))
		for _, user := range users {
			if user.ID != "" {
				userIDs = append(userIDs, user.ID)
			}
		}
		feedErr := n.Feed.Fanout(ctx, evt.TenantID, userIDs, FeedNotification{
			Kind:     "campaign.sent",
			Title:    fmt.Sprintf("Campaign sent: %s", evt.CampaignName),
			Body:     fmt.Sprintf("%d sent · %d bounced · %d suppressed", evt.Sent, evt.Bounced, evt.Suppressed),
			DeepLink: "/app/campaigns/" + evt.CampaignID,
			Payload: map[string]any{
				"campaign_id": evt.CampaignID,
				"recipients":  evt.Recipients,
				"sent":        evt.Sent,
				"bounced":     evt.Bounced,
				"suppressed":  evt.Suppressed,
			},
		})
		if feedErr != nil {
			logger.Error("send-complete feed fanout failed", "tenant_id", evt.TenantID, "campaign_id", evt.CampaignID, "err", feedErr.Error())
			lastErr = feedErr
		}
	}
	for _, u := range users {
		if u.Email == "" {
			continue
		}
		ok := true
		if n.Dispatcher != nil {
			allowed, gerr := n.Dispatcher.Gate(ctx, evt.TenantID, u.ID, notifications.PrefSendComplete)
			if gerr != nil {
				logger.Warn("send-complete gate lookup failed; fail-open",
					"tenant_id", evt.TenantID, "user_id", u.ID, "err", gerr.Error())
				ok = true
			} else {
				ok = allowed
			}
		}
		if !ok {
			continue
		}
		msg := MailMessage{
			From:    n.From,
			To:      u.Email,
			Subject: fmt.Sprintf(`Campaign sent: %q (%d recipients)`, evt.CampaignName, evt.Recipients),
			HTML:    renderSendCompleteHTML(evt, n.BaseURL),
			Text:    renderSendCompleteText(evt, n.BaseURL),
		}
		if serr := n.Mailer.Send(ctx, msg); serr != nil {
			logger.Error("send-complete email failed",
				"tenant_id", evt.TenantID, "user_id", u.ID,
				"campaign_id", evt.CampaignID, "err", serr.Error())
			lastErr = serr
			// Continue with the next recipient — a single mailer
			// hiccup must not silence the rest of the team.
		}
	}
	return lastErr
}

func (n *SendCompleteNotifier) logger() *slog.Logger {
	if n != nil && n.Logger != nil {
		return n.Logger
	}
	return slog.Default()
}

// renderSendCompleteText is the plain-text body of the email.
// Pure function — tests assert content here without standing up a
// mailer.
func renderSendCompleteText(evt SendCompleteEvent, baseURL string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Your campaign %q finished sending to %d recipients at %s.\n\n",
		evt.CampaignName, evt.Recipients, evt.SentAt.Format("3:04 PM MST"))
	fmt.Fprintf(&b, "Sent:       %d\n", evt.Sent)
	if evt.Bounced > 0 {
		fmt.Fprintf(&b, "Bounced:    %d\n", evt.Bounced)
	}
	if evt.Suppressed > 0 {
		fmt.Fprintf(&b, "Suppressed: %d\n", evt.Suppressed)
	}
	if link := campaignReportLink(baseURL, evt.CampaignID); link != "" {
		fmt.Fprintf(&b, "\nView report: %s\n", link)
	}
	b.WriteString("\n— Moosewave\n")
	return b.String()
}

// renderSendCompleteHTML returns the multipart/alternative HTML body.
// We use html/template + manually-escaped data so XSS-from-campaign-
// name is structurally impossible — a tenant can name a campaign
// `<script>` and we render it literally.
func renderSendCompleteHTML(evt SendCompleteEvent, baseURL string) string {
	link := campaignReportLink(baseURL, evt.CampaignID)
	tmpl := template.Must(template.New("send-complete").Parse(`<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">Campaign sent</h2>
<p>Your campaign <strong>{{.Name}}</strong> finished sending to <strong>{{.Recipients}}</strong> recipients at {{.SentAt}}.</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0;font-size:14px">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Sent</td><td style="padding:4px 0"><strong>{{.Sent}}</strong></td></tr>
  {{if .HasBounced}}<tr><td style="padding:4px 12px 4px 0;color:#666">Bounced</td><td style="padding:4px 0"><strong>{{.Bounced}}</strong></td></tr>{{end}}
  {{if .HasSuppressed}}<tr><td style="padding:4px 12px 4px 0;color:#666">Suppressed</td><td style="padding:4px 0"><strong>{{.Suppressed}}</strong></td></tr>{{end}}
</table>
{{if .Link}}<p><a href="{{.Link}}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">View report</a></p>{{end}}
<p style="color:#666;font-size:12px;margin-top:24px">— Moosewave</p>
</body></html>`))
	data := struct {
		Name          string
		Recipients    int
		SentAt        string
		Sent          int
		Bounced       int
		Suppressed    int
		Link          string
		HasBounced    bool
		HasSuppressed bool
	}{
		Name:          evt.CampaignName,
		Recipients:    evt.Recipients,
		SentAt:        evt.SentAt.Format("3:04 PM MST"),
		Sent:          evt.Sent,
		Bounced:       evt.Bounced,
		Suppressed:    evt.Suppressed,
		Link:          link,
		HasBounced:    evt.Bounced > 0,
		HasSuppressed: evt.Suppressed > 0,
	}
	var b strings.Builder
	if err := tmpl.Execute(&b, data); err != nil {
		// Templates compile at package init; runtime Execute on a
		// validated template only fails for a non-printable type,
		// which our struct doesn't contain. Fall back to a minimal
		// text body so the caller still gets something useful.
		return fmt.Sprintf("<p>Campaign %s finished sending to %d recipients.</p>", evt.CampaignName, evt.Recipients)
	}
	return b.String()
}

// campaignReportLink returns a stable URL to the in-app campaign
// report, or "" when the base URL isn't configured. Keeping this
// here (not inlined into the templates) means the test can pin the
// link format without parsing HTML.
func campaignReportLink(baseURL, campaignID string) string {
	baseURL = strings.TrimSpace(baseURL)
	campaignID = strings.TrimSpace(campaignID)
	if baseURL == "" || campaignID == "" {
		return ""
	}
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	basePath := strings.TrimRight(u.Path, "/")
	rawBasePath := strings.TrimRight(u.EscapedPath(), "/")
	u.Path = basePath + "/campaigns/" + campaignID
	u.RawPath = rawBasePath + "/campaigns/" + url.PathEscape(campaignID)
	return u.String()
}
