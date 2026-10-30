// SPDX-License-Identifier: AGPL-3.0-only
package actionticket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// The two-step link.
//
// GET previews and POST performs, and the split is not ceremony. Email clients,
// gateways and security scanners PREFETCH links: a GET that redeemed would
// approve things nobody clicked, from a scanner, before the message was opened.
// The link in a notification points at the preview; the button on that page
// posts the redeem.
//
// Both are unauthenticated by design — the bearer has no session, which is the
// entire reason tickets exist — so both are strictly bounded by what the ticket
// itself authorises and neither reveals anything about a secret it does not
// already hold.

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// Perform executes an authorised action. Injected rather than switched on
	// here: this package knows how to prove an action may happen and nothing
	// about approvals, campaigns or devices — and a switch statement here would
	// become a second place every actionable feature must register.
	Perform func(r *http.Request, redeemed Redeemed) error
}

// MountRoutes registers the ticket link surface.
//
// Unauthenticated: `route-contracts.json` classifies these as
// public-token-or-embed, because the ticket IS the credential.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/actions/preview", d.Preview)
	r.Post("/api/v1/actions/redeem", d.Redeem)
}

type previewResponse struct {
	Action       string    `json:"action"`
	Label        string    `json:"label"`
	ResourceKind string    `json:"resource_kind"`
	ResourceID   string    `json:"resource_id"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Preview GET /api/v1/actions/preview?ticket=SECRET
//
// Safe and idempotent. Consumes nothing, so a prefetch costs a read.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	setTicketResponseHeaders(w)
	if d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "unavailable", "action links are unavailable")
		return
	}
	secret := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if secret == "" {
		// Outstanding links minted before the descriptive query-key migration
		// remain valid for their short TTL. The request logger drops the entire
		// preview query for both forms, so this compatibility read adds no log
		// disclosure path.
		secret = strings.TrimSpace(r.URL.Query().Get("t"))
	}
	got, expiresAt, err := d.Repo.Preview(r.Context(), secret)
	if err != nil {
		d.writeInvalid(w, r, err)
		return
	}
	if actionWantsHTML(r) {
		writeActionPage(w, http.StatusOK, actionPageData{
			Title:       "Confirm action · Moosewave",
			Heading:     "Confirm action",
			Message:     "Review the action below. Opening this page did not perform it.",
			ActionLabel: labelFor(got.Action),
			Resource:    humanResourceKind(got.ResourceKind),
			ExpiresAt:   expiresAt.UTC().Format(time.RFC1123),
			Ticket:      secret,
			ShowForm:    true,
		})
		return
	}
	writeJSON(w, http.StatusOK, previewResponse{
		Action:       got.Action,
		Label:        labelFor(got.Action),
		ResourceKind: got.ResourceKind,
		ResourceID:   got.ResourceID,
		ExpiresAt:    expiresAt,
	})
}

type redeemRequest struct {
	Ticket string `json:"ticket"`
}

// Redeem POST /api/v1/actions/redeem
//
// The ticket travels in the BODY, not the query string. A secret in a URL ends
// up in access logs, proxy logs, and the Referer header of anything the
// resulting page loads; the preview link cannot avoid that, which is exactly
// why the preview consumes nothing and this step does not reuse the URL.
func (d *Deps) Redeem(w http.ResponseWriter, r *http.Request) {
	setTicketResponseHeaders(w)
	if d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "unavailable", "action links are unavailable")
		return
	}
	var in redeemRequest
	// httpbody so an over-size body is answered as one. The bare decoder
	// reported every failure as `bad_json`, which tells a caller to go looking
	// for a syntax error in a body that had none.
	//
	// The two leniencies are deliberate and preserve what this endpoint already
	// accepted. `DecodeJSON` is strict on both axes — it requires a JSON
	// Content-Type and rejects unknown fields — and the decoder being replaced
	// did neither. Tightening them here would be a silent contract change for
	// every existing client, arriving as a 415 or a 400 on a request that
	// worked yesterday, which is a bigger break than the diagnosis bug being
	// fixed. Whether this endpoint SHOULD be strict is a separate decision.
	if err := decodeRedeemRequest(w, r, &in); err != nil {
		if actionWantsHTML(r) {
			writeActionPage(w, httpbody.StatusCode(err), actionPageData{
				Title: "Action unavailable · Moosewave", Heading: "Action unavailable",
				Message: "The confirmation request was invalid. Return to the original message and try again.",
			})
		} else {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		}
		return
	}
	secret := strings.TrimSpace(in.Ticket)

	// Claim first, perform second, consume last. The lease prevents concurrent
	// clicks from both invoking the domain action, while a normal executor error
	// releases the ticket for retry. A process crash is recovered after the
	// bounded lease; registered performers are idempotent for Redeemed.ID.
	claimed, err := d.Repo.Claim(r.Context(), secret, clientIP(r))
	if err != nil {
		d.writeInvalid(w, r, err)
		return
	}

	if d.Perform == nil {
		_ = d.Repo.Release(r.Context(), *claimed, "action_unwired")
		httperror.Write(w, http.StatusServiceUnavailable, "action_unwired",
			"this action cannot be completed right now")
		return
	}
	if err := d.Perform(r, *claimed); err != nil {
		if releaseErr := d.Repo.Release(r.Context(), *claimed, "action_failed"); releaseErr != nil {
			d.log().Error("actionticket: failed to release action after executor error",
				"ticket_id", claimed.ID, "action", claimed.Action, "err", releaseErr.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.Repo.Complete(r.Context(), *claimed); err != nil {
		d.log().Error("actionticket: domain action succeeded but ticket completion failed",
			"ticket_id", claimed.ID, "action", claimed.Action, "err", err.Error())
		httperror.Write(w, http.StatusServiceUnavailable, "action_completion_pending",
			"the action was accepted but its confirmation receipt is still pending; retry shortly")
		return
	}
	if actionWantsHTML(r) {
		writeActionPage(w, http.StatusOK, actionPageData{
			Title: "Action completed · Moosewave", Heading: "Action completed",
			Message: "Your action was completed successfully.", ActionLabel: labelFor(claimed.Action),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"performed": true,
		"action":    claimed.Action,
	})
}

func (d *Deps) log() *slog.Logger {
	if d != nil && d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func decodeRedeemRequest(w http.ResponseWriter, r *http.Request, out *redeemRequest) error {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err == nil && strings.EqualFold(mediaType, "application/x-www-form-urlencoded") {
			r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
			if err := r.ParseForm(); err != nil {
				var maxErr *http.MaxBytesError
				if errors.As(err, &maxErr) {
					return httpbody.ErrTooLarge
				}
				return httpbody.ErrEmpty
			}
			out.Ticket = strings.TrimSpace(r.PostForm.Get("ticket"))
			if out.Ticket == "" {
				return httpbody.ErrEmpty
			}
			return nil
		}
	}
	return httpbody.DecodeJSONWith(w, r, 4<<10, out, httpbody.Options{
		AllowMissingContentType: true,
		AllowUnknownFields:      true,
	})
}

// writeInvalid answers every rejection identically.
//
// Unknown, expired, spent and mismatched all produce one message. Telling a
// bearer which it was turns this into an oracle for guessing secrets, and the
// person holding a real link cannot use the distinction anyway — for all four
// the answer is "ask for a new one".
func (d *Deps) writeInvalid(w http.ResponseWriter, r *http.Request, err error) {
	if !errors.Is(err, ErrInvalid) && !errors.Is(err, ErrExecutionInProgress) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if actionWantsHTML(r) {
		writeActionPage(w, http.StatusGone, actionPageData{
			Title: "Link unavailable · Moosewave", Heading: "This link is unavailable",
			Message: "This link has expired, has already been used, or is currently being completed.",
		})
		return
	}
	httperror.Write(w, http.StatusGone, "ticket_invalid",
		"this link has expired or has already been used")
}

// labelFor is the human sentence for an action, from the shared catalog.
//
// Looked up rather than restated so the preview page reads exactly like the
// in-app button — the catalog exists precisely so a person is not told two
// different things about one action.
func labelFor(action string) string {
	for _, event := range notifications.ActionEvents() {
		for _, a := range notifications.ActionsForEvent(event) {
			if a.ID == action {
				return a.Label
			}
		}
	}
	return action
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// A ticket link must never be cached by a shared proxy, and its response
	// must not be replayed from a browser's back-forward cache after the ticket
	// is spent.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func setTicketResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Vary", "Accept")
}

// ProtectResponses stamps the credential-bearing response boundary before a
// public rate limiter or any other middleware can return early. Ticket
// successes, refusals, and 429s must all remain non-cacheable and must never
// acquire a referrer policy that can forward the preview URL.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setTicketResponseHeaders(w)
		next.ServeHTTP(w, r)
	})
}

func actionWantsHTML(r *http.Request) bool {
	if r == nil {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err == nil && strings.EqualFold(mediaType, "application/x-www-form-urlencoded") {
		return true
	}
	htmlQuality, jsonQuality := -1.0, -1.0
	for _, candidate := range strings.Split(r.Header.Get("Accept"), ",") {
		mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(candidate))
		if err != nil {
			continue
		}
		quality := 1.0
		if rawQuality, exists := parameters["q"]; exists {
			quality, err = strconv.ParseFloat(rawQuality, 64)
			if err != nil || quality < 0 || quality > 1 {
				continue
			}
		}
		if quality == 0 {
			continue
		}
		switch strings.ToLower(mediaType) {
		case "text/html", "application/xhtml+xml", "text/*":
			htmlQuality = max(htmlQuality, quality)
		case "application/json", "application/*":
			jsonQuality = max(jsonQuality, quality)
		case "*/*":
			htmlQuality = max(htmlQuality, quality)
			jsonQuality = max(jsonQuality, quality)
		}
	}
	return htmlQuality > jsonQuality
}

func humanResourceKind(kind string) string {
	switch kind {
	case "approval":
		return "Approval request"
	default:
		return "Moosewave request"
	}
}

type actionPageData struct {
	Title       string
	Heading     string
	Message     string
	ActionLabel string
	Resource    string
	ExpiresAt   string
	Ticket      string
	ShowForm    bool
}

var actionPage = template.Must(template.New("action-ticket").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}}</title><style>
body{margin:0;background:#f6f7fb;color:#171923;font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:34rem;margin:8vh auto;padding:2rem;background:#fff;border:1px solid #dfe3eb;border-radius:1rem;box-shadow:0 12px 35px rgba(15,23,42,.08)}
h1{margin:.1rem 0 1rem;font-size:1.55rem}.summary{padding:1rem;background:#f2f5f9;border-radius:.7rem;margin:1rem 0}
button{border:0;border-radius:.55rem;background:#1d4ed8;color:#fff;padding:.75rem 1rem;font:inherit;font-weight:650;cursor:pointer}
.muted{color:#596273;font-size:.9rem}</style></head>
<body><main aria-labelledby="action-title"><h1 id="action-title">{{.Heading}}</h1><p aria-live="polite">{{.Message}}</p>
{{if .ActionLabel}}<div class="summary"><strong>{{.ActionLabel}}</strong>{{if .Resource}}<div class="muted">{{.Resource}}</div>{{end}}{{if .ExpiresAt}}<div class="muted">Link expires {{.ExpiresAt}}</div>{{end}}</div>{{end}}
{{if .ShowForm}}<form method="post" action="/api/v1/actions/redeem"><input type="hidden" name="ticket" value="{{.Ticket}}"><button type="submit">Confirm {{.ActionLabel}}</button></form>{{end}}
</main></body></html>`))

func writeActionPage(w http.ResponseWriter, status int, data actionPageData) {
	setTicketResponseHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = actionPage.Execute(w, data)
}

// clientIP records who redeemed, for the audit trail.
//
// Proxy headers are NOT trusted here: this endpoint is unauthenticated and
// reachable from anywhere, so a forwarded-for header is attacker-controlled
// input. A wrong address in an audit record is worse than none — it points an
// investigation at somebody uninvolved.
func clientIP(r *http.Request) string {
	if ip := middleware.ResolveClientIP(r, false); ip != nil {
		return ip.String()
	}
	return ""
}

// Linker mints tickets and renders them as preview URLs.
//
// It satisfies `notifyfanout.ActionTicketMinter`. The interface lives there and
// the implementation here for the same reason the poster does: that package
// holds no database dependency, and every collaborator it has is an interface
// so a test can fake exactly one channel.
type Linker struct {
	Repo *Repo
	// BaseURL is the public origin links are built against
	// (POSTWAVE_PUBLIC_BASE_URL). Empty disables minting entirely rather than
	// emitting a relative link: a relative URL in an email is not a link, and a
	// wrong absolute one sends somebody to a host that cannot redeem it.
	BaseURL string
}

// Validate verifies that a configured action-link base is an HTTPS origin,
// not an arbitrary URL. Userinfo, paths, queries, and fragments can change the
// authority or disclose the bearer ticket, so none are accepted.
func (l *Linker) Validate() error {
	if l == nil {
		return errors.New("actionticket: linker is unavailable")
	}
	_, err := actionTicketBaseOrigin(l.BaseURL)
	return err
}

func actionTicketBaseOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("actionticket: parse public base origin: %w", err)
	}
	if !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.Hostname() == "" {
		return "", errors.New("actionticket: public base must be an absolute HTTPS origin")
	}
	if parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" {
		return "", errors.New("actionticket: public base must not contain userinfo, a path, query, or fragment")
	}
	return "https://" + parsed.Host, nil
}

// Mint issues a ticket and returns the preview URL for it.
//
// The PREVIEW url, never the redeem endpoint. What goes in a message is fetched
// by scanners, and the only safe target is the half that consumes nothing.
func (l *Linker) Mint(
	ctx context.Context, tenantID, userID, action, resourceKind, resourceID string,
) (string, error) {
	if l == nil || l.Repo == nil {
		return "", nil
	}
	base, err := actionTicketBaseOrigin(l.BaseURL)
	if err != nil {
		return "", err
	}
	if base == "" {
		return "", nil
	}
	ticket, err := l.Repo.Mint(ctx, tenantID, userID, action, resourceKind, resourceID, 0)
	if err != nil {
		return "", err
	}
	preview, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("actionticket: construct preview URL: %w", err)
	}
	preview.Path = "/api/v1/actions/preview"
	query := preview.Query()
	query.Set("ticket", ticket.Secret)
	preview.RawQuery = query.Encode()
	return preview.String(), nil
}
