// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Store interface {
	ListIntegrations(context.Context, string) ([]Integration, error)
	GetIntegration(context.Context, string, string) (*Integration, error)
	UpsertIntegration(context.Context, string, IntegrationInput) (*Integration, error)
	ProvisionIngestIntegration(context.Context, string, IngestProvisionInput, string) (*Integration, error)
	RotateIngestToken(context.Context, string, string, string) (*Integration, error)
	PauseIntegration(context.Context, string, string) (*Integration, error)
	DisconnectIntegration(context.Context, string, string) error
	RecordSyncRun(context.Context, string, string, SyncSummary, SyncRequest, time.Time, time.Time) (*SyncRun, error)
	ListRuns(context.Context, string, string, int) ([]SyncRun, error)
}

type integrationProjectionStore interface {
	ListIntegrationProjections(context.Context, string, time.Time, time.Time, string, int) ([]IntegrationProjection, error)
	GetIntegrationProjection(context.Context, string, string) (*IntegrationProjection, error)
}

type providerCleanupDisconnectStore interface {
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, *DisconnectCleanupEvidence) error
}

type GorgiasCommerceResolver interface {
	ResolveGorgiasCommerceContext(ctx context.Context, tenantID string, integration Integration, email string, properties map[string]any) (map[string]any, error)
}

type Deps struct {
	Repo      Store
	Suite     SuiteSink
	Profiles  ProfileSink
	Events    EventSink
	Commerce  GorgiasCommerceResolver
	Logger    *slog.Logger
	CursorKey []byte
	// PublicBaseURL is used when verifying providers that sign the absolute
	// callback URI, such as HubSpot v3 app webhooks.
	PublicBaseURL string
	Now           func() time.Time
	MaxSyncRows   int
	// ZendeskBackfiller / IntercomBackfiller / GorgiasBackfiller /
	// FreshdeskBackfiller, when wired, let empty sync/backfill requests pull
	// tickets/conversations directly from the provider instead of requiring
	// caller-shaped rows.
	ZendeskBackfiller                ZendeskBackfiller
	IntercomBackfiller               IntercomBackfiller
	GorgiasBackfiller                GorgiasBackfiller
	FreshdeskBackfiller              FreshdeskBackfiller
	FreshchatBackfiller              FreshchatBackfiller
	TidioBackfiller                  TidioBackfiller
	AdaBackfiller                    AdaBackfiller
	GladlyBackfiller                 GladlyBackfiller
	GrooveBackfiller                 GrooveBackfiller
	HelpCrunchBackfiller             HelpCrunchBackfiller
	JiraServiceManagementBackfiller  JiraServiceManagementBackfiller
	LinearBackfiller                 LinearBackfiller
	AsanaSupportBackfiller           AsanaSupportBackfiller
	ClickUpSupportBackfiller         ClickUpSupportBackfiller
	HelpScoutBackfiller              HelpScoutBackfiller
	ReamazeBackfiller                ReamazeBackfiller
	FrontBackfiller                  FrontBackfiller
	CrispBackfiller                  CrispBackfiller
	KustomerBackfiller               KustomerBackfiller
	DriftBackfiller                  DriftBackfiller
	LiveChatBackfiller               LiveChatBackfiller
	ZohoDeskBackfiller               ZohoDeskBackfiller
	OlarkBackfiller                  OlarkBackfiller
	HubSpotServiceHubBackfiller      HubSpotServiceHubBackfiller
	SalesforceServiceCloudBackfiller SalesforceServiceCloudBackfiller
	KayakoBackfiller                 KayakoBackfiller
	// WebhookSecrets resolves provider webhook secrets for signed public support
	// callbacks and the generic support webhook ingest fallback.
	WebhookSecrets SupportRuntimeSecretResolver
	// HubSpotWebhookClientSecret is the app client secret used by HubSpot v3
	// app-webhook signature verification. When empty, HubSpot Service Hub can
	// still resolve a vault reference from integration settings.
	HubSpotWebhookClientSecret string
	// NewIngestToken overrides webhook ingest token minting (tests only).
	// Production leaves it nil and uses crypto/rand.
	NewIngestToken func() (string, error)
}

type archivedSupportRuntimeFixtureKey struct{}

func archivedSupportRuntimeFixture(r *http.Request) bool {
	if r == nil {
		return false
	}
	enabled, _ := r.Context().Value(archivedSupportRuntimeFixtureKey{}).(bool)
	return enabled
}

func withArchivedSupportRuntimeFixture(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), archivedSupportRuntimeFixtureKey{}, true)))
	})
}

type supportProviderPullMeta struct {
	Provider      string
	Cursor        string
	RetryDeferred bool
}

// providerPull dispatches an empty sync/backfill to a native provider puller.
func (d *Deps) providerPull(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	switch integration.Provider {
	case ProviderZendesk:
		if d.ZendeskBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ZendeskBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderIntercom:
		if d.IntercomBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.IntercomBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderGorgias:
		if d.GorgiasBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.GorgiasBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderFreshdesk:
		if d.FreshdeskBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.FreshdeskBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderFreshchat:
		if d.FreshchatBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.FreshchatBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderTidio:
		if d.TidioBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.TidioBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderAda:
		if d.AdaBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.AdaBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderGladly:
		if d.GladlyBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.GladlyBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderGroove:
		if d.GrooveBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.GrooveBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderHelpCrunch:
		if d.HelpCrunchBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.HelpCrunchBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderJiraServiceManagement:
		if d.JiraServiceManagementBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.JiraServiceManagementBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderLinear:
		if d.LinearBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.LinearBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderAsanaSupport:
		if d.AsanaSupportBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.AsanaSupportBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderClickUpSupport:
		if d.ClickUpSupportBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ClickUpSupportBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderHelpScout:
		if d.HelpScoutBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.HelpScoutBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderReamaze:
		if d.ReamazeBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ReamazeBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderFront:
		if d.FrontBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.FrontBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderCrisp:
		if d.CrispBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.CrispBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderKustomer:
		if d.KustomerBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.KustomerBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderDrift:
		if d.DriftBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.DriftBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderLiveChat:
		if d.LiveChatBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.LiveChatBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderZohoDesk:
		if d.ZohoDeskBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ZohoDeskBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderOlark:
		if d.OlarkBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.OlarkBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderHubSpotServiceHub:
		if d.HubSpotServiceHubBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.HubSpotServiceHubBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderSalesforceServiceCloud:
		if d.SalesforceServiceCloudBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.SalesforceServiceCloudBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderKayako:
		if d.KayakoBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.KayakoBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	default:
		return SyncRequest{}, false, nil
	}
}

func (d *Deps) providerPullWithRetry(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, supportProviderPullMeta, bool, error) {
	if integration == nil {
		return SyncRequest{}, supportProviderPullMeta{}, false, nil
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	meta := supportProviderPullMeta{Provider: integration.Provider, Cursor: cursor}
	cfg, err := supportBackfillConfig(integration.Provider)
	if err != nil {
		req, ok, pullErr := d.providerPull(ctx, tenantID, integration, cursor)
		return req, meta, ok, pullErr
	}
	backfiller := supportBackfillerForProvider(d, cfg.Provider)
	if backfiller == nil {
		return SyncRequest{}, supportProviderPullMeta{}, false, nil
	}
	effectiveCursor := strings.TrimSpace(cursor)
	retryBaseCursor := effectiveCursor
	if retry, ok, err := decodeSupportRetryCursor(cfg, effectiveCursor); err != nil {
		return SyncRequest{}, meta, true, err
	} else if ok {
		if !supportRetryCursorDue(retry, d.now()) {
			meta.RetryDeferred = true
			return SyncRequest{RunMode: "backfill", Cursor: effectiveCursor}, meta, true, nil
		}
		retryBaseCursor = effectiveCursor
		effectiveCursor = retry.Cursor
	}
	meta.Cursor = retryBaseCursor
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := supportBackfillRetryCursor(cfg, retryBaseCursor, "BACKFILL_FAILED", err, d.now())
		_ = d.recordSupportProviderFailure(ctx, tenantID, integration.ID, retryCursor, err)
		return SyncRequest{}, meta, true, err
	}
	return req, meta, true, nil
}

func (d *Deps) recordSupportProviderFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := d.now()
	completed := d.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "backfill", Cursor: cursor})
	summary := SyncSummary{
		IntegrationID: integrationID,
		Status:        "failed",
		Cursor:        cursor,
		ErrorMessage:  syncErr.Error(),
	}
	_, err := d.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func supportProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	cfg, err := supportBackfillConfig(provider)
	if err != nil {
		return "", false
	}
	return supportBackfillRetryCursor(cfg, cursor, status, retryErr, now), true
}

const supportJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireExactTenantAdmin
	chain := []func(http.Handler) http.Handler{protectSupportResponse, admin}
	r.With(chain...).Get("/api/v1/support-integrations/providers", d.ListProviders)
	// Webhook-ingest provisioning for fallback/support-provider callback URLs.
	// Registered before the {id} routes; chi matches the static "webhook-ingest"
	// segment ahead of the {id} wildcard.
	r.With(chain...).Get("/api/v1/support-integrations/webhook-ingest/providers", d.RuntimeHeld)
	r.With(chain...).Get("/api/v1/support-integrations/webhook-ingest", d.RuntimeHeld)
	r.With(chain...).Post("/api/v1/support-integrations/webhook-ingest", d.RuntimeHeld)
	r.With(chain...).Post("/api/v1/support-integrations/webhook-ingest/{id}/rotate", d.RuntimeHeld)
	r.With(chain...).Get("/api/v1/support-integrations", d.ListIntegrations)
	r.With(chain...).Post("/api/v1/support-integrations", d.RuntimeHeld)
	r.With(chain...).Get("/api/v1/support-integrations/{id}", d.GetIntegration)
	r.With(chain...).Post("/api/v1/support-integrations/{id}/sync", d.RuntimeHeld)
	r.With(chain...).Post("/api/v1/support-integrations/{id}/backfill", d.RuntimeHeld)
	r.With(chain...).Post("/api/v1/support-integrations/{id}/ingest", d.RuntimeHeld)
	r.With(chain...).Post("/api/v1/support-integrations/{id}/pause", d.RuntimeHeld)
	r.With(chain...).Delete("/api/v1/support-integrations/{id}", d.RuntimeHeld)
	r.With(chain...).Get("/api/v1/support-integrations/{id}/runs", d.RuntimeHeld)
}

// mountArchivedRoutesFixture keeps the pre-hold algorithms executable only
// from same-package tests. Production composition must call MountRoutes.
func mountArchivedRoutesFixture(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	chainAdmin := []func(http.Handler) http.Handler{withArchivedSupportRuntimeFixture, admin}
	chainRead := []func(http.Handler) http.Handler{withArchivedSupportRuntimeFixture, read}
	r.With(chainAdmin...).Get("/api/v1/support-integrations/providers", d.ListProviders)
	r.With(chainAdmin...).Get("/api/v1/support-integrations/webhook-ingest/providers", d.ListIngestProviders)
	r.With(chainAdmin...).Get("/api/v1/support-integrations/webhook-ingest", d.ListIngestEndpoints)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/webhook-ingest", d.ProvisionIngest)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/webhook-ingest/{id}/rotate", d.RotateIngest)
	r.With(chainRead...).Get("/api/v1/support-integrations", d.ListIntegrations)
	r.With(chainAdmin...).Post("/api/v1/support-integrations", d.CreateIntegration)
	r.With(chainRead...).Get("/api/v1/support-integrations/{id}", d.GetIntegration)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/{id}/sync", d.SyncIntegration)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/{id}/ingest", d.IngestEvent)
	r.With(chainAdmin...).Post("/api/v1/support-integrations/{id}/pause", d.PauseIntegration)
	r.With(chainAdmin...).Delete("/api/v1/support-integrations/{id}", d.DisconnectIntegration)
	r.With(chainRead...).Get("/api/v1/support-integrations/{id}/runs", d.ListRuns)
}

func protectSupportResponse(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func (d *Deps) RuntimeHeld(w http.ResponseWriter, r *http.Request) {
	writeSupportReleaseHold(w, "support_integration_runtime_held", "Support-provider configuration, synchronization, ingestion, and lifecycle mutations are release-held while Helpdesk privacy governance is incomplete.")
}

// EffectReplayBypass prevents a cached pre-Route41 success from crossing the
// provider-plane source hold before RuntimeHeld executes.
func EffectReplayBypass(r *http.Request, _ []byte) bool {
	if r == nil || (r.Method != http.MethodPost && r.Method != http.MethodDelete) {
		return false
	}
	path := strings.TrimSuffix(r.URL.EscapedPath(), "/")
	const prefix = "/api/v1/support-integrations"
	if path == prefix || path == prefix+"/webhook-ingest" {
		return true
	}
	if !strings.HasPrefix(path, prefix+"/") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix+"/"), "/")
	if r.Method == http.MethodDelete {
		return len(parts) == 1 && strings.TrimSpace(parts[0]) != ""
	}
	if len(parts) == 3 && parts[0] == "webhook-ingest" && parts[2] == "rotate" {
		return true
	}
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
		return false
	}
	switch parts[1] {
	case "sync", "backfill", "ingest", "pause":
		return true
	default:
		return false
	}
}

func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	items := make([]map[string]any, 0, len(ProviderSpecs()))
	for _, spec := range ProviderSpecs() {
		items = append(items, map[string]any{"key": spec.Provider, "name": spec.Name, "runtime_status": "held", "hold_code": "support_integration_runtime_held"})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "complete": true,
		"provenance": map[string]any{"tenant_bound": false, "source": "static_server_catalog"},
	})
}

func (d *Deps) ListIntegrations(w http.ResponseWriter, r *http.Request) {
	if archivedSupportRuntimeFixture(r) {
		d.archivedListIntegrationsFixture(w, r)
		return
	}
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	values, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil {
		httperror.Write(w, http.StatusBadRequest, "query_invalid", "query string is malformed")
		return
	}
	for name, entries := range values {
		if (name != "limit" && name != "cursor") || len(entries) != 1 {
			httperror.Write(w, http.StatusBadRequest, "query_invalid", "only one limit and one cursor query parameter are accepted")
			return
		}
	}
	limit, parseErr := parseSupportIntegrationListLimit(values)
	if parseErr != nil {
		httperror.Write(w, http.StatusBadRequest, "limit_invalid", "limit must be an integer from 1 through 100")
		return
	}
	projectionRepo, projectionOK := d.Repo.(integrationProjectionStore)
	if !projectionOK {
		writeSupportReleaseHold(w, "support_integration_projection_unavailable", "The minimized support-integration read projection is unavailable.")
		return
	}
	now := d.now().UTC()
	cursor := supportIntegrationCursor{TenantID: tenantID, Limit: limit, AsOf: now}
	if rawValues, present := values["cursor"]; present {
		raw := rawValues[0]
		if !validSupportIntegrationCursorToken(raw) {
			httperror.Write(w, http.StatusBadRequest, "cursor_invalid", "cursor is invalid for this tenant and query")
			return
		}
		var cursorErr error
		cursor, cursorErr = decodeSupportIntegrationCursor(d.CursorKey, raw, tenantID, limit, now)
		if cursorErr != nil {
			httperror.Write(w, http.StatusBadRequest, "cursor_invalid", "cursor is invalid for this tenant and query")
			return
		}
	}
	out, err := projectionRepo.ListIntegrationProjections(r.Context(), tenantID, cursor.AsOf, cursor.At, cursor.ID, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for index := range out {
		out[index], err = validateSupportIntegrationProjection(out[index], tenantID, cursor.AsOf)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	items := make([]map[string]any, 0, len(out))
	for i := range out {
		items = append(items, supportIntegrationReadProjection(out[i]))
	}
	var nextCursor *string
	if hasMore {
		last := out[len(out)-1]
		token, cursorErr := encodeSupportIntegrationCursor(d.CursorKey, supportIntegrationCursor{
			TenantID: tenantID, Limit: limit, AsOf: cursor.AsOf, At: last.UpdatedAt, ID: last.ID,
		})
		if cursorErr != nil {
			writeSupportReleaseHold(w, "support_integration_pagination_unavailable", "Support-integration pagination is unavailable until its dedicated key is configured.")
			return
		}
		nextCursor = &token
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId": tenantID, "items": items,
		"page": map[string]any{"has_more": hasMore, "next_cursor": nextCursor, "as_of": cursor.AsOf, "consistency": "mutable_window", "may_reorder": true},
	})
}

func (d *Deps) archivedListIntegrationsFixture(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListIntegrations(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for index := range out {
		out[index] = redactIngestToken(out[index])
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) GetIntegration(w http.ResponseWriter, r *http.Request) {
	if archivedSupportRuntimeFixture(r) {
		tenantID, ok := tenantID(r)
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
			return
		}
		out, err := d.Repo.GetIntegration(r.Context(), tenantID, chi.URLParam(r, "id"))
		if err != nil {
			d.writeRepoError(w, r, tenantID, err)
			return
		}
		writeJSON(w, http.StatusOK, redactIngestToken(*out))
		return
	}
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if !canonicalSupportUUID(id) {
		httperror.Write(w, http.StatusBadRequest, "id_invalid", "integration id must be a lowercase canonical UUID")
		return
	}
	values, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil || len(values) != 0 {
		httperror.Write(w, http.StatusBadRequest, "query_invalid", "query parameters are not accepted")
		return
	}
	projectionRepo, projectionOK := d.Repo.(integrationProjectionStore)
	if !projectionOK {
		writeSupportReleaseHold(w, "support_integration_projection_unavailable", "The minimized support-integration read projection is unavailable.")
		return
	}
	out, err := projectionRepo.GetIntegrationProjection(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	validated, err := validateSupportIntegrationProjection(*out, tenantID, d.now().UTC())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, supportIntegrationReadProjection(validated))
}

func canonicalSupportUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func validSupportProjectionText(value string, maxBytes int, allowEmpty bool) bool {
	if !utf8.ValidString(value) || len([]byte(value)) > maxBytes || strings.TrimSpace(value) != value || (!allowEmpty && value == "") {
		return false
	}
	for _, r := range value {
		// Integration names are line-oriented display labels. Reject every C0/C1
		// control so the API, desktop, CLI and SDK projections share one safe
		// wire boundary instead of accepting rows that strict clients cannot show.
		if unicode.IsControl(r) {
			return false
		}
		if r == '\u061c' || (r >= '\u200b' && r <= '\u200f') ||
			(r >= '\u2028' && r <= '\u202e') || (r >= '\u2060' && r <= '\u206f') || r == '\ufeff' {
			return false
		}
	}
	return true
}

func validSupportProjectionTime(value time.Time) bool {
	return !value.IsZero() && !value.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) &&
		value.Before(time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC))
}

func validateSupportIntegrationProjection(in IntegrationProjection, expectedTenant string, asOf time.Time) (IntegrationProjection, error) {
	if !canonicalSupportUUID(expectedTenant) || !canonicalSupportUUID(in.ID) || !canonicalSupportUUID(in.TenantID) || in.TenantID != expectedTenant {
		return IntegrationProjection{}, errors.New("support integration projection tenant or identity is invalid")
	}
	if !validSupportProjectionProvider(in.Provider) || !validSupportProjectionText(in.Name, 200, false) ||
		!validSupportIntegrationStatus(in.Status) {
		return IntegrationProjection{}, errors.New("support integration projection enum or text is invalid")
	}
	in.CreatedAt = in.CreatedAt.UTC()
	in.UpdatedAt = in.UpdatedAt.UTC()
	if !validSupportProjectionTime(in.CreatedAt) || !validSupportProjectionTime(in.UpdatedAt) ||
		in.UpdatedAt.Before(in.CreatedAt) || (!asOf.IsZero() && in.UpdatedAt.After(asOf.UTC())) {
		return IntegrationProjection{}, errors.New("support integration projection timestamp is invalid")
	}
	return in, nil
}

// Stored webhook-ingest rows may use a sanitized long-tail provider slug that
// is not a member of today's static provider catalog. The minimized historical
// projection preserves that bounded identifier without treating catalog
// membership as runtime availability. This intentionally matches the public
// SupportIntegrationProjection wire pattern.
func validSupportProjectionProvider(provider string) bool {
	if len(provider) < 1 || len(provider) > 64 {
		return false
	}
	for _, r := range provider {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func validSupportIntegrationStatus(status string) bool {
	switch status {
	case "connected", "active", "paused", "error", "disconnected":
		return true
	default:
		return false
	}
}

func supportIntegrationReadProjection(in IntegrationProjection) map[string]any {
	return map[string]any{
		"tenantId": in.TenantID, "tenant_id": in.TenantID, "id": in.ID,
		"provider": in.Provider, "name": in.Name, "status": in.Status,
		"runtime_status": "held", "hold_code": "support_integration_runtime_held",
		"credential_configured": in.CredentialConfigured,
		"created_at":            in.CreatedAt, "updated_at": in.UpdatedAt,
	}
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, supportJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalized, _, err := normalizeIntegrationInput(in)
	if err != nil {
		if errors.Is(err, errRawCredentialSetting) {
			httperror.Write(w, http.StatusUnprocessableEntity, "raw_credentials_rejected", err.Error())
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	normalized, err = d.prepareManagedSupportProviderResources(r.Context(), tenantID, normalized, d.publicBaseURL(r))
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "provider_webhook_registration_failed", httperror.MessageInternal)
		return
	}
	out, err := d.Repo.UpsertIntegration(r.Context(), tenantID, normalized)
	if err != nil {
		d.rollbackLiveChatManagedWebhooks(r.Context(), tenantID, normalized)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Klaviyo-style: import the provider's trailing history immediately on
	// connect (background, bounded). No-op for non-puller providers / opt-out.
	writeJSON(w, http.StatusCreated, out)
	d.maybeBackfillOnConnect(out)
}

func (d *Deps) prepareManagedSupportProviderResources(ctx context.Context, tenantID string, in IntegrationInput, publicBaseURL string) (IntegrationInput, error) {
	if in.Provider != ProviderLiveChat || !liveChatManageWebhookRequested(in.Settings) {
		return in, nil
	}
	manager, ok := d.LiveChatBackfiller.(LiveChatWebhookManager)
	if !ok || manager == nil {
		return IntegrationInput{}, fmt.Errorf("livechat managed webhook registration requires a LiveChatWebhookManager")
	}
	accountID := strings.TrimSpace(firstString(settingString(in.Settings, "account_id"), settingString(in.Settings, "license_id")))
	if accountID == "" {
		return IntegrationInput{}, fmt.Errorf("livechat account_id is required for managed webhook registration")
	}
	ownerClientID := liveChatOwnerClientID(in.Settings)
	if ownerClientID == "" {
		return IntegrationInput{}, fmt.Errorf("livechat owner_client_id is required for managed webhook registration")
	}
	publicBaseURL = strings.TrimRight(strings.TrimSpace(publicBaseURL), "/")
	if publicBaseURL == "" {
		return IntegrationInput{}, fmt.Errorf("public_base_url is required for managed LiveChat webhook registration")
	}
	settings := copySettings(in.Settings)
	routeID := strings.TrimSpace(firstString(
		settingString(settings, "livechat_webhook_id"),
		settingString(settings, "webhook_id"),
	))
	if routeID == "" {
		var err error
		routeID, err = d.newIngestToken()
		if err != nil {
			return IntegrationInput{}, fmt.Errorf("mint livechat webhook route token: %w", err)
		}
	}
	integration := Integration{Provider: in.Provider, TenantID: tenantID, CredentialsRef: in.CredentialsRef, Settings: settings}
	secret, err := d.liveChatWebhookSecret(ctx, &integration)
	if err != nil {
		return IntegrationInput{}, err
	}
	actions := liveChatWebhookActions(settings)
	if len(actions) == 0 {
		return IntegrationInput{}, fmt.Errorf("livechat managed webhook registration has no valid actions")
	}
	endpoint := publicBaseURL + "/api/public/support-integrations/livechat/" + url.PathEscape(accountID) + "/webhooks?webhook_id=" + url.QueryEscape(routeID)
	providerIDs := make([]string, 0, len(actions))
	for _, action := range actions {
		result, err := manager.RegisterLiveChatWebhook(ctx, tenantID, integration, LiveChatWebhookRegistrationInput{
			URL:           endpoint,
			Action:        action,
			SecretKey:     secret,
			OwnerClientID: ownerClientID,
			Description:   "Moosewave LiveChat " + action + " support webhook",
		})
		if err != nil {
			rollbackInput := in
			rollbackInput.Settings = settings
			settings["livechat_provider_webhook_ids"] = strings.Join(providerIDs, ",")
			settings["livechat_owner_client_id"] = ownerClientID
			settings["livechat_webhook_managed_by_postwave"] = true
			d.rollbackLiveChatManagedWebhooks(ctx, tenantID, rollbackInput)
			return IntegrationInput{}, err
		}
		if result.ProviderWebhookID != "" {
			providerIDs = append(providerIDs, result.ProviderWebhookID)
		}
	}
	if len(providerIDs) == 0 {
		return IntegrationInput{}, fmt.Errorf("livechat managed webhook registration returned no provider webhook ids")
	}
	settings["livechat_webhook_id"] = routeID
	settings["livechat_owner_client_id"] = ownerClientID
	settings["livechat_webhook_actions"] = strings.Join(actions, ",")
	settings["livechat_provider_webhook_ids"] = strings.Join(providerIDs, ",")
	settings["livechat_provider_webhook_id"] = providerIDs[0]
	settings["livechat_webhook_managed_by_postwave"] = true
	in.Settings = settings
	return in, nil
}

func (d *Deps) rollbackLiveChatManagedWebhooks(ctx context.Context, tenantID string, in IntegrationInput) {
	if in.Provider != ProviderLiveChat || !liveChatManagedWebhook(in.Settings) {
		return
	}
	manager, ok := d.LiveChatBackfiller.(LiveChatWebhookManager)
	if !ok || manager == nil {
		return
	}
	ownerClientID := liveChatOwnerClientID(in.Settings)
	if ownerClientID == "" {
		return
	}
	integration := Integration{Provider: in.Provider, TenantID: tenantID, CredentialsRef: in.CredentialsRef, Settings: in.Settings}
	for _, providerID := range liveChatProviderWebhookIDs(in.Settings) {
		_, _ = manager.UnregisterLiveChatWebhook(ctx, tenantID, integration, providerID, ownerClientID)
	}
}

func liveChatManageWebhookRequested(settings map[string]any) bool {
	raw := strings.ToLower(strings.TrimSpace(firstString(
		settingString(settings, "livechat_manage_webhook"),
		settingString(settings, "livechat_manage_webhooks"),
		settingString(settings, "manage_webhook"),
		settingString(settings, "manage_webhooks"),
	)))
	switch raw {
	case "1", "true", "yes", "y", "on", "managed", "postwave":
		return true
	default:
		return false
	}
}

func liveChatManagedWebhook(settings map[string]any) bool {
	raw := strings.ToLower(strings.TrimSpace(settingString(settings, "livechat_webhook_managed_by_postwave")))
	return raw == "1" || raw == "true" || raw == "yes"
}

func liveChatOwnerClientID(settings map[string]any) string {
	return strings.TrimSpace(firstString(
		settingString(settings, "livechat_owner_client_id"),
		settingString(settings, "owner_client_id"),
		settingString(settings, "livechat_client_id"),
	))
}

func liveChatWebhookActions(settings map[string]any) []string {
	values := liveChatSettingStrings(settings, "livechat_webhook_actions")
	if len(values) == 0 {
		values = liveChatSettingStrings(settings, "webhook_actions")
	}
	if len(values) == 0 {
		values = []string{"incoming_chat", "incoming_event"}
	}
	allowed := map[string]bool{
		"incoming_chat":    true,
		"incoming_event":   true,
		"chat_deactivated": true,
		"chat_started":     true,
		"chat_ended":       true,
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		action := strings.ToLower(strings.TrimSpace(value))
		if !allowed[action] || seen[action] {
			continue
		}
		seen[action] = true
		out = append(out, action)
	}
	return out
}

func liveChatProviderWebhookIDs(settings map[string]any) []string {
	keys := []string{"livechat_provider_webhook_ids", "livechat_provider_webhook_id", "livechat_registered_webhook_id"}
	out := []string{}
	seen := map[string]bool{}
	for _, key := range keys {
		for _, value := range liveChatSettingStrings(settings, key) {
			id := strings.TrimSpace(value)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func liveChatSettingStrings(settings map[string]any, key string) []string {
	if settings == nil {
		return nil
	}
	v, ok := settings[strings.ToLower(strings.TrimSpace(key))]
	if !ok || v == nil {
		return nil
	}
	var raw []string
	switch typed := v.(type) {
	case []string:
		raw = typed
	case []any:
		raw = make([]string, 0, len(typed))
		for _, part := range typed {
			raw = append(raw, strings.TrimSpace(fmt.Sprint(part)))
		}
	default:
		raw = strings.Split(strings.TrimSpace(fmt.Sprint(typed)), ",")
	}
	out := make([]string, 0, len(raw))
	for _, part := range raw {
		if value := strings.TrimSpace(part); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	d.sync(w, r, "")
}

func (d *Deps) BackfillIntegration(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	d.sync(w, r, "backfill")
}

func (d *Deps) IngestEvent(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if supportIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var event SupportEventInput
	if err := httpbody.DecodeJSON(w, r, supportJSONMaxBodyBytes, &event); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []SupportEventInput{event},
	})
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, req, started, completed)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) sync(w http.ResponseWriter, r *http.Request, forcedMode string) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if supportIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, supportJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	in = normalizeSyncRequest(in)
	if forcedMode != "" {
		in.RunMode = forcedMode
	}
	if !allowedRunMode(in.RunMode) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "run_mode must be manual, scheduled, backfill, retry, dry_run, or webhook")
		return
	}
	if len(in.Tickets)+len(in.Messages)+len(in.Events) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	var pullMeta supportProviderPullMeta
	providerPulled := false
	if len(in.Tickets)+len(in.Messages)+len(in.Events) == 0 {
		pulled, meta, ok, perr := d.providerPullWithRetry(r.Context(), tenantID, integration, in.Cursor)
		if perr != nil {
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "support sync/backfill requires canonical tickets, messages, or events; no provider puller is wired for this provider")
			return
		}
		pullMeta = meta
		providerPulled = true
		if meta.RetryDeferred {
			writeJSON(w, http.StatusAccepted, SyncSummary{IntegrationID: id, Cursor: pulled.Cursor})
			return
		}
		in = normalizeSyncRequest(pulled)
		if forcedMode != "" {
			in.RunMode = forcedMode
		}
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, in, started, completed)
	if err != nil {
		if providerPulled {
			if retryCursor, ok := supportProviderRetryCursor(pullMeta.Provider, pullMeta.Cursor, "SYNC_FAILED", err, d.now()); ok {
				_ = d.recordSupportProviderFailure(r.Context(), tenantID, id, retryCursor, err)
			}
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) PauseIntegration(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if supportIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	out, err := d.Repo.PauseIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	integrationID := strings.TrimSpace(chi.URLParam(r, "id"))
	if !canonicalSupportUUID(integrationID) {
		httperror.Write(w, http.StatusBadRequest, "id_invalid", "integration id must be a lowercase canonical UUID")
		return
	}
	values := r.URL.Query()
	if len(values) > 1 || len(values["limit"]) > 1 || (len(values) == 1 && len(values["limit"]) == 0) {
		httperror.Write(w, http.StatusBadRequest, "query_invalid", "only one limit query parameter is accepted")
		return
	}
	limit := 25
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		var parseErr error
		limit, parseErr = strconv.Atoi(raw)
		if parseErr != nil || limit < 1 || limit > 100 {
			httperror.Write(w, http.StatusBadRequest, "limit_invalid", "limit must be an integer from 1 through 100")
			return
		}
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, integrationID, limit+1)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	items := make([]map[string]any, 0, len(out))
	for _, run := range out {
		items = append(items, map[string]any{
			"tenantId": tenantID, "tenant_id": tenantID, "id": run.ID,
			"integration_id": run.IntegrationID, "run_mode": run.RunMode,
			"status": run.Status, "tickets_seen": run.TicketsSeen,
			"tickets_upserted": run.TicketsUpserted, "messages_seen": run.MessagesSeen,
			"messages_upserted": run.MessagesUpserted, "rows_failed": run.RowsFailed,
			"error_omitted": strings.TrimSpace(run.ErrorMessage) != "",
			"started_at":    run.StartedAt, "completed_at": run.CompletedAt, "created_at": run.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId": tenantID, "items": items,
		"page": map[string]any{"has_more": hasMore, "truncated": hasMore, "limit": limit, "as_of": d.now().UTC(), "consistency": "latest_capped_window", "may_reorder": true},
	})
}

func (d *Deps) executeSync(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) SyncSummary {
	summary := SyncSummary{
		IntegrationID: integration.ID,
		Status:        "completed",
		TicketsSeen:   len(in.Tickets),
		MessagesSeen:  len(in.Messages),
		EventsSeen:    len(in.Events),
		Cursor:        in.Cursor,
	}
	for _, ticket := range in.Tickets {
		var err error
		ticket, err = d.enrichGorgiasTicketCommerce(ctx, tenantID, integration, ticket)
		if err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		if d.Suite == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "service suite sink unavailable"
			continue
		}
		if _, _, err := d.Suite.UpsertSupportTicket(ctx, tenantID, integration.Provider, ticket); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.TicketsUpserted++
		if d.Profiles != nil {
			if _, err := d.Profiles.UpsertSupportProfile(ctx, tenantID, integration.Provider, ticket); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.ProfilesUpserted++
		}
		if d.Events != nil {
			if _, err := d.Events.TrackSupportEvent(ctx, tenantID, integration.Provider, eventForTicket(ticket)); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.EventsTracked++
		}
	}
	for _, message := range in.Messages {
		var err error
		message, err = d.enrichGorgiasMessageCommerce(ctx, tenantID, integration, message)
		if err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		if d.Suite == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "service suite sink unavailable"
			continue
		}
		if _, err := d.Suite.RecordSupportMessage(ctx, tenantID, integration.Provider, message); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.MessagesUpserted++
		if d.Events != nil {
			if _, err := d.Events.TrackSupportEvent(ctx, tenantID, integration.Provider, eventForMessage(message)); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.EventsTracked++
		}
	}
	for _, event := range in.Events {
		var err error
		event, err = d.enrichGorgiasEventCommerce(ctx, tenantID, integration, event)
		if err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		if d.Events == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "event sink unavailable"
			continue
		}
		if _, err := d.Events.TrackSupportEvent(ctx, tenantID, integration.Provider, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 &&
		summary.TicketsUpserted == 0 &&
		summary.MessagesUpserted == 0 &&
		summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "support-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) enrichGorgiasTicketCommerce(ctx context.Context, tenantID string, integration *Integration, ticket TicketInput) (TicketInput, error) {
	props, err := d.enrichGorgiasCommerceProperties(ctx, tenantID, integration, ticket.Email, ticket.Properties)
	if err != nil {
		return ticket, err
	}
	ticket.Properties = props
	return ticket, nil
}

func (d *Deps) enrichGorgiasMessageCommerce(ctx context.Context, tenantID string, integration *Integration, message MessageInput) (MessageInput, error) {
	props, err := d.enrichGorgiasCommerceProperties(ctx, tenantID, integration, message.Email, message.Properties)
	if err != nil {
		return message, err
	}
	message.Properties = props
	return message, nil
}

func (d *Deps) enrichGorgiasEventCommerce(ctx context.Context, tenantID string, integration *Integration, event SupportEventInput) (SupportEventInput, error) {
	props, err := d.enrichGorgiasCommerceProperties(ctx, tenantID, integration, event.Email, event.Properties)
	if err != nil {
		return event, err
	}
	event.Properties = props
	return event, nil
}

func (d *Deps) enrichGorgiasCommerceProperties(ctx context.Context, tenantID string, integration *Integration, email string, properties map[string]any) (map[string]any, error) {
	if d == nil || integration == nil || integration.Provider != ProviderGorgias {
		return properties, nil
	}
	resolver := d.Commerce
	if resolver == nil {
		if repoResolver, ok := d.Repo.(GorgiasCommerceResolver); ok {
			resolver = repoResolver
		}
	}
	if resolver == nil {
		return properties, nil
	}
	return resolver.ResolveGorgiasCommerceContext(ctx, tenantID, *integration, email, properties)
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "support integration not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func (d *Deps) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Deps) maxSyncRows() int {
	if d != nil && d.MaxSyncRows > 0 {
		return d.MaxSyncRows
	}
	return 1000
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func allowedRunMode(value string) bool {
	switch value {
	case "manual", "scheduled", "backfill", "retry", "dry_run", "webhook":
		return true
	default:
		return false
	}
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	out, err := strconv.Atoi(raw)
	if err != nil || out <= 0 {
		return fallback
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
