// mirror.go — GAP-LS-026. Re-import / mirror from external ESPs.
// Each provider exposes a paginated /suppressions endpoint; we walk
// recent pages and upsert into subscriber_suppressions via the X1
// Store.Add path so dedup on (tenant, source, source_event_id) keeps
// repeated mirror runs idempotent.
//
// Triggered by:
//
//	POST /api/v1/suppressions/mirror/{provider}
//
// where {provider} is one of: ses | mailgun | postmark | mailchimp |
// sendgrid. Admin scope is enforced at the main.go mount.
//
// All five providers ship real pull clients (mirror_clients.go and
// mirror_clients_esp.go) keyed off provider configuration or the provider's
// canonical credential chain. REST credentials resolve from the tenant's
// tenant_deliverability_providers config row
// (config->>'api_key') with a POSTWAVE_MIRROR_<PROVIDER>_API_KEY env
// fallback; an unconfigured provider surfaces a typed 503
// not_configured. NewNilMirrorClient remains only as the fail-loud SES startup
// fallback when the AWS SDK itself cannot be initialized.
//
// Why dependency-injected clients instead of inline HTTP: the webhook
// credential surfaces live in apps/api/internal/webhooks/
// deliverability_*.go and pulling them in here would double-import the
// HMAC verification machinery for code that only needs the
// list-and-upsert read path.

package suppressions

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MirrorProvider names the ESP we're pulling from.
type MirrorProvider string

const (
	MirrorProviderSES       MirrorProvider = "ses"
	MirrorProviderMailgun   MirrorProvider = "mailgun"
	MirrorProviderPostmark  MirrorProvider = "postmark"
	MirrorProviderMailchimp MirrorProvider = "mailchimp"
	MirrorProviderSendGrid  MirrorProvider = "sendgrid"
)

// MirrorRecord is one row pulled from an ESP. The fetcher normalises
// the provider-specific shape; the upsert path is the X1 Store.Add.
type MirrorRecord struct {
	Email         string
	Reason        Reason
	SourceEventID string
	CreatedAt     time.Time
	Metadata      map[string]any
}

// MirrorClient is the per-provider fetcher injected by main.go's
// wiring. Missing clients fail closed as not_configured; they never report a
// successful empty import.
type MirrorClient interface {
	// FetchRecent returns up to `limit` records added since `since`.
	// Implementations should paginate internally; the handler only
	// needs the flat list back.
	FetchRecent(ctx context.Context, tenantID string, since time.Time, limit int) ([]MirrorRecord, error)
}

// MirrorClients bundles the per-provider implementations. Nil entries
// are tolerated and surface a 503 "not configured" at the handler.
type MirrorClients struct {
	SES       MirrorClient
	Mailgun   MirrorClient
	Postmark  MirrorClient
	Mailchimp MirrorClient
	SendGrid  MirrorClient
}

// MountX1MirrorRoutes registers the mirror endpoint. Caller wraps in
// apikeys.RequireScope(ScopeAdmin) at the main.go mount.
func (h *StoreHandlers) MountX1MirrorRoutes(r chi.Router) {
	r.Post("/api/v1/suppressions/mirror/{provider}", h.Mirror)
}

// mirrorResponse is the wire shape.
type mirrorResponse struct {
	Provider       string `json:"provider"`
	Fetched        int    `json:"fetched"`
	Imported       int    `json:"imported"`
	Skipped        int    `json:"skipped"`
	Errors         int    `json:"errors"`
	WindowFromIso  string `json:"window_from"`
	WindowToIso    string `json:"window_to"`
	NotConfigured  bool   `json:"not_configured,omitempty"`
	NotConfigured2 string `json:"not_configured_reason,omitempty"`
}

// defaultMirrorWindow is how far back we walk on an ack-only invocation.
// Most providers cap suppression listings at a few thousand rows; a
// 7-day window keeps repeated runs bounded.
const defaultMirrorWindow = 7 * 24 * time.Hour

// Mirror POST /api/v1/suppressions/mirror/{provider}.
//
// Walks the provider's recent suppression list and upserts each row
// via Store.AddWithChannel so the (channel, scope) dimension is set.
// Returns a small summary the dashboard renders as a toast.
func (h *StoreHandlers) Mirror(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	provider := MirrorProvider(strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider"))))
	if h.Mirrors == nil {
		writeJSON(w, http.StatusServiceUnavailable, mirrorResponse{
			Provider:       string(provider),
			NotConfigured:  true,
			NotConfigured2: "mirror clients not wired",
		})
		return
	}
	client, source := h.pickMirrorClient(provider)
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, mirrorResponse{
			Provider:       string(provider),
			NotConfigured:  true,
			NotConfigured2: "no client configured for " + string(provider),
		})
		return
	}

	since := time.Now().UTC().Add(-defaultMirrorWindow)
	const limit = 5000
	records, err := client.FetchRecent(r.Context(), t.ID, since, limit)
	if err != nil {
		// Typed not-configured errors (no API key in the tenant's
		// provider config and no POSTWAVE_MIRROR_<PROVIDER>_API_KEY
		// env fallback, or a placeholder client) are an expected
		// runtime state, not a server fault → 503 + not_configured so
		// the dashboard renders a setup prompt instead of an error.
		if errors.Is(err, ErrMirrorNotConfigured) || errors.Is(err, ErrMirrorClientUnavailable) {
			writeJSON(w, http.StatusServiceUnavailable, mirrorResponse{
				Provider:       string(provider),
				NotConfigured:  true,
				NotConfigured2: "an internal error occurred",
			})
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	resp := mirrorResponse{
		Provider:      string(provider),
		Fetched:       len(records),
		WindowFromIso: since.Format(time.RFC3339),
		WindowToIso:   time.Now().UTC().Format(time.RFC3339),
	}
	importCutoff := time.Now().UTC().Add(-5 * time.Second)
	for _, rec := range records {
		if rec.Email == "" {
			resp.Errors++
			continue
		}
		reason := rec.Reason
		if reason == "" || !ValidReasons[reason] {
			reason = NormalizeReason(string(rec.Reason))
		}
		meta := rec.Metadata
		if meta == nil {
			meta = map[string]any{}
		}
		meta["mirror_source"] = string(provider)
		if !rec.CreatedAt.IsZero() {
			meta["provider_suppressed_at"] = rec.CreatedAt.UTC().Format(time.RFC3339)
		}
		entry, err := h.Store.AddWithChannel(r.Context(), t.ID, rec.Email,
			reason, source, rec.SourceEventID, nil, meta,
			ChannelEmail, ScopeMarketing)
		if err != nil {
			resp.Errors++
			continue
		}
		if entry != nil && entry.CreatedAt.After(importCutoff) {
			// The upsert preserves created_at on conflict, so a row
			// created "just now" means we inserted it this run.
			resp.Imported++
			h.recordAudit(r.Context(), t.ID, entry.Email, AuditActionAdd, string(entry.Reason),
				map[string]any{"id": entry.ID, "source": string(source),
					"mirror_provider": string(provider)})
		} else {
			// Existing row picked up by the idempotency guard.
			resp.Skipped++
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// pickMirrorClient resolves the per-provider client + the Source enum
// to record on the upserted row. Unknown provider names short-circuit
// to a nil client which the handler turns into a 503.
func (h *StoreHandlers) pickMirrorClient(p MirrorProvider) (MirrorClient, Source) {
	if h.Mirrors == nil {
		return nil, ""
	}
	switch p {
	case MirrorProviderSES:
		return h.Mirrors.SES, SourceSES
	case MirrorProviderMailgun:
		return h.Mirrors.Mailgun, SourceMailgun
	case MirrorProviderPostmark:
		return h.Mirrors.Postmark, SourcePostmark
	case MirrorProviderMailchimp:
		return h.Mirrors.Mailchimp, SourceMailchimp
	case MirrorProviderSendGrid:
		return h.Mirrors.SendGrid, SourceSendGrid
	}
	return nil, ""
}

// ErrMirrorClientUnavailable is the canonical error a placeholder
// client returns. Lets handler tests distinguish "provider client
// unavailable" from a real fetch error.
var ErrMirrorClientUnavailable = errors.New("suppressions: mirror client unavailable")

// nilMirrorClient is the zero-value placeholder main.go can drop in
// when a provider's webhook receiver is wired but the catch-up read
// path hasn't been built yet.
type nilMirrorClient struct{ provider MirrorProvider }

// NewNilMirrorClient returns a placeholder that always returns
// ErrMirrorClientUnavailable. Wired by main.go when an ESP's catch-up
// path is disabled, which keeps the route compilable and clearly
// signals the runtime configuration state.
func NewNilMirrorClient(p MirrorProvider) MirrorClient { return &nilMirrorClient{provider: p} }

// FetchRecent on the nil client always returns ErrMirrorClientUnavailable so
// the handler surfaces the typed not-configured 503 boundary.
func (n *nilMirrorClient) FetchRecent(_ context.Context, _ string, _ time.Time, _ int) ([]MirrorRecord, error) {
	return nil, fmt.Errorf("%w: %s", ErrMirrorClientUnavailable, n.provider)
}
