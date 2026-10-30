// SPDX-License-Identifier: AGPL-3.0-only
//
// postmark_notifier.go is the optional GiftNotifier implementation retained
// for a future provider-backed paid-gift lifecycle.
package paid_tiers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// PostmarkGiftNotifier implements GiftNotifier over Postmark transactional mail.
type PostmarkGiftNotifier struct {
	HTTPClient    *http.Client
	ServerToken   string
	BaseURL       string // e.g. https://api.postmarkapp.com
	From          string
	PublicBaseURL string // for building a redemption URL fallback
	Logger        *slog.Logger
}

// NewPostmarkGiftNotifier returns nil when Postmark is unconfigured. Callers
// must treat notification delivery as unavailable rather than as success.
func NewPostmarkGiftNotifier(serverToken, from, publicBaseURL string, logger *slog.Logger) GiftNotifier {
	if strings.TrimSpace(serverToken) == "" {
		return nil
	}
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	return &PostmarkGiftNotifier{
		HTTPClient:    &http.Client{Timeout: 10 * time.Second},
		ServerToken:   serverToken,
		BaseURL:       "https://api.postmarkapp.com",
		From:          from,
		PublicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		Logger:        logger,
	}
}

func (n *PostmarkGiftNotifier) redemptionURL(g GiftSub, rawToken string) string {
	if g.RedemptionURL != "" {
		return g.RedemptionURL
	}
	if n.PublicBaseURL != "" && rawToken != "" {
		return n.PublicBaseURL + "/gifts/" + rawToken
	}
	return ""
}

func (n *PostmarkGiftNotifier) SendGiftCreated(ctx context.Context, g GiftSub, rawToken string) {
	if g.RecipientEmail == "" {
		return
	}
	url := n.redemptionURL(g, rawToken)
	link := ""
	if url != "" {
		link = fmt.Sprintf(`<p><a href="%s">Claim your gift</a></p>`, safeAttr(url))
	}
	msg := ""
	if g.Message != "" {
		msg = fmt.Sprintf("<p><em>%s</em></p>", safeText(g.Message))
	}
	html := fmt.Sprintf(`<p>%s gifted you a %d-month subscription.</p>%s%s`,
		safeText(orFallback(g.PurchaserEmail, "Someone")), g.DurationMonths, msg, link)
	text := fmt.Sprintf("%s gifted you a %d-month subscription.\n%s\nClaim: %s\n",
		orFallback(g.PurchaserEmail, "Someone"), g.DurationMonths, g.Message, url)
	n.send(ctx, g.RecipientEmail, "You have received a Moosewave gift subscription", html, text)
}

func (n *PostmarkGiftNotifier) SendGiftRedeemed(ctx context.Context, g GiftSub) {
	if g.PurchaserEmail == "" {
		return
	}
	html := fmt.Sprintf("<p>Good news — %s claimed the gift subscription you sent.</p>", safeText(g.RecipientEmail))
	text := fmt.Sprintf("%s claimed the gift subscription you sent.\n", g.RecipientEmail)
	n.send(ctx, g.PurchaserEmail, "Your Moosewave gift was claimed", html, text)
}

func (n *PostmarkGiftNotifier) SendGiftCanceled(ctx context.Context, g GiftSub) {
	if g.RecipientEmail == "" {
		return
	}
	html := "<p>A pending gift subscription addressed to you was canceled. No action is needed.</p>"
	text := "A pending gift subscription addressed to you was canceled. No action is needed.\n"
	n.send(ctx, g.RecipientEmail, "A Moosewave gift was canceled", html, text)
}

func (n *PostmarkGiftNotifier) SendGiftExpired(ctx context.Context, g GiftSub) {
	if g.RecipientEmail == "" {
		return
	}
	html := "<p>An unclaimed gift subscription addressed to you has expired.</p>"
	text := "An unclaimed gift subscription addressed to you has expired.\n"
	n.send(ctx, g.RecipientEmail, "Your Moosewave gift expired", html, text)
}

func (n *PostmarkGiftNotifier) send(ctx context.Context, to, subject, html, text string) {
	body, err := json.Marshal(map[string]any{
		"From": n.From, "To": to, "Subject": subject,
		"HtmlBody": html, "TextBody": text, "MessageStream": "outbound",
	})
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(n.BaseURL, "/")+"/email", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postmark-Server-Token", n.ServerToken)
	resp, err := n.HTTPClient.Do(req)
	if err != nil {
		if n.Logger != nil {
			n.Logger.Warn("gift notifier: postmark send failed", "to", to, "err", err.Error())
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 && n.Logger != nil {
		n.Logger.Warn("gift notifier: postmark non-2xx", "to", to, "status", resp.StatusCode)
	}
}

func orFallback(s, fb string) string {
	if strings.TrimSpace(s) == "" {
		return fb
	}
	return s
}

// safeText / safeAttr are minimal HTML escapers for interpolating
// user-controlled strings into the transactional email body.
func safeText(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

func safeAttr(s string) string {
	r := strings.NewReplacer("&", "&amp;", "\"", "&quot;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}
