// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Store interface {
	ListIntegrations(context.Context, string) ([]Integration, error)
	GetIntegration(context.Context, string, string) (*Integration, error)
	UpsertIntegration(context.Context, string, IntegrationInput) (*Integration, error)
	PauseIntegration(context.Context, string, string) (*Integration, error)
	DisconnectIntegration(context.Context, string, string) error
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, *DisconnectCleanupEvidence) error
	RecordSyncRun(context.Context, string, string, SyncSummary, SyncRequest, time.Time, time.Time) (*SyncRun, error)
	ListRuns(context.Context, string, string, int) ([]SyncRun, error)
	ClaimWebhook(context.Context, string, string, string, string, string, []byte) (WebhookClaim, error)
	MarkWebhookProcessed(context.Context, string, string, string, string) error
	MarkWebhookFailed(context.Context, string, string, string, string, error) error
	FindPipedriveIntegrationByWebhookID(context.Context, string) (*Integration, error)
	FindHubSpotIntegrationByAppAndPortalID(context.Context, string, string) (*Integration, error)
}

type Deps struct {
	Repo                   Store
	Profiles               ProfileSink
	Events                 EventSink
	ListMemberships        ListMembershipSink
	Logger                 *slog.Logger
	Now                    func() time.Time
	MaxSyncRows            int
	PublicBaseURL          string
	HubSpotBackfiller      HubSpotBackfiller
	HubSpotCredentials     HubSpotCredentialResolver
	HubSpotWebhooks        HubSpotWebhookRegistrar
	HubSpotOAuth           HubSpotOAuthConfig
	HubSpotOAuthClient     HubSpotOAuthClient
	SalesforceBackfiller   SalesforceBackfiller
	SalesforceCredentials  SalesforceCredentialResolver
	SalesforceOAuth        SalesforceOAuthConfig
	SalesforceOAuthClient  SalesforceOAuthClient
	PipedriveBackfiller    PipedriveBackfiller
	PipedriveCredentials   PipedriveCredentialResolver
	PipedriveWebhooks      PipedriveWebhookRegistrar
	PipedriveOAuth         PipedriveOAuthConfig
	PipedriveOAuthClient   PipedriveOAuthClient
	ZohoBackfiller         ZohoBackfiller
	ZohoCredentials        ZohoCredentialResolver
	ZohoOAuth              ZohoOAuthConfig
	ZohoOAuthClient        ZohoOAuthClient
	Dynamics365Backfiller  Dynamics365Backfiller
	Dynamics365Credentials Dynamics365CredentialResolver
	Dynamics365OAuth       Dynamics365OAuthConfig
	Dynamics365OAuthClient Dynamics365OAuthClient
	KeapBackfiller         KeapBackfiller
	KeapCredentials        KeapCredentialResolver
	KeapOAuth              KeapOAuthConfig
	KeapOAuthClient        KeapOAuthClient
	HighLevelBackfiller    HighLevelBackfiller
	HighLevelCredentials   HighLevelCredentialResolver
	HighLevelOAuth         HighLevelOAuthConfig
	HighLevelOAuthClient   HighLevelOAuthClient
	CloseBackfiller        CloseBackfiller
	CloseCredentials       CloseCredentialResolver
	CopperBackfiller       CopperBackfiller
	CopperCredentials      CopperCredentialResolver
	FreshsalesBackfiller   FreshsalesBackfiller
	FreshsalesCredentials  FreshsalesCredentialResolver
	PostscriptBackfiller   PostscriptBackfiller
	PostscriptCredentials  PostscriptCredentialResolver
	AttentiveBackfiller    AttentiveBackfiller
	AttentiveCredentials   AttentiveCredentialResolver
}

const crmJSONMaxBodyBytes int64 = 1 << 20

var errCRMIntegrationDisconnected = errors.New("crm integration disconnected")

func crmIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/crm/providers", d.ListProviders)
	// OAuth is one parameterized public contract. The dispatcher below keeps
	// the provider allowlist explicit while avoiding a documented
	// /crm/{provider}/... route that did not exist in chi (and therefore made
	// generated clients appear to call a 404-only surface).
	r.With(read).Get("/api/v1/crm/{provider}/oauth/availability", d.CRMOAuthAvailability)
	r.With(admin).Get("/api/v1/crm/{provider}/oauth/start", d.CRMOAuthStart)
	r.With(read).Get("/api/v1/crm/integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/crm/integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/crm/integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/crm/integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/crm/integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/crm/integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Post("/api/v1/crm/integrations/{id}/resume", d.ResumeIntegration)
	r.With(admin).Delete("/api/v1/crm/integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/crm/integrations/{id}/runs", d.ListRuns)
}

// CRMOAuthAvailability dispatches the documented parameterized CRM OAuth
// availability route to a provider implementation. Unknown values are a
// stable 404, rather than accidentally falling through to a different CRM
// resource or exposing an unconfigured provider as supported.
func (d *Deps) CRMOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	switch crmOAuthProviderSlug(r) {
	case "pipedrive":
		d.PipedriveOAuthAvailability(w, r)
	case "hubspot":
		d.HubSpotOAuthAvailability(w, r)
	case "salesforce":
		d.SalesforceOAuthAvailability(w, r)
	case "zoho":
		d.ZohoOAuthAvailability(w, r)
	case "dynamics365":
		d.Dynamics365OAuthAvailability(w, r)
	case "keap":
		d.KeapOAuthAvailability(w, r)
	case "gohighlevel":
		d.HighLevelOAuthAvailability(w, r)
	default:
		writeUnknownCRMOAuthProvider(w)
	}
}

// CRMOAuthStart dispatches the admin-scoped OAuth start route. Scope
// enforcement remains on the route registration, so every provider has the
// same authorization boundary.
func (d *Deps) CRMOAuthStart(w http.ResponseWriter, r *http.Request) {
	// The redirect carries a one-time tenant-bound state token. Never let a
	// browser or intermediary cache and replay it after expiry.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch crmOAuthProviderSlug(r) {
	case "pipedrive":
		d.PipedriveOAuthStart(w, r)
	case "hubspot":
		d.HubSpotOAuthStart(w, r)
	case "salesforce":
		d.SalesforceOAuthStart(w, r)
	case "zoho":
		d.ZohoOAuthStart(w, r)
	case "dynamics365":
		d.Dynamics365OAuthStart(w, r)
	case "keap":
		d.KeapOAuthStart(w, r)
	case "gohighlevel":
		d.HighLevelOAuthStart(w, r)
	default:
		writeUnknownCRMOAuthProvider(w)
	}
}

// CRMOAuthCallback dispatches the unauthenticated provider callback. Each
// implementation still validates its own one-time state and exchanges the
// authorization code using the provider-specific client.
func (d *Deps) CRMOAuthCallback(w http.ResponseWriter, r *http.Request) {
	// Callback query parameters and responses contain one-time OAuth material.
	// This also opts out of the public conditional-GET middleware's ETag path.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	switch crmOAuthProviderSlug(r) {
	case "pipedrive":
		d.PipedriveOAuthCallback(w, r)
	case "hubspot":
		d.HubSpotOAuthCallback(w, r)
	case "salesforce":
		d.SalesforceOAuthCallback(w, r)
	case "zoho":
		d.ZohoOAuthCallback(w, r)
	case "dynamics365":
		d.Dynamics365OAuthCallback(w, r)
	case "keap":
		d.KeapOAuthCallback(w, r)
	case "gohighlevel":
		d.HighLevelOAuthCallback(w, r)
	default:
		writeUnknownCRMOAuthProvider(w)
	}
}

func crmOAuthProviderSlug(r *http.Request) string {
	return strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
}

func writeUnknownCRMOAuthProvider(w http.ResponseWriter) {
	httperror.Write(w, http.StatusNotFound, "crm_oauth_provider_not_found", "CRM OAuth provider not found")
}

// MountOAuthCallbackRoutes registers human browser redirects inside the
// gateway's shared public IP limiter. Provider webhook traffic has a separate
// mount below because it uses provider credentials and has different burst
// characteristics.
func MountOAuthCallbackRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/crm/{provider}/oauth/callback", d.CRMOAuthCallback)
}

func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	// Pipedrive's uninstall callback is provider-originated and authenticated
	// with the configured client-id/client-secret Basic credential. It also
	// must remain outside tenant middleware because the provider supplies the
	// tenant lookup tuple in its signed/authenticated payload.
	r.Delete("/api/v1/crm/pipedrive/oauth/callback", d.PipedriveOAuthUninstallCallback)
	r.Post("/api/public/crm-integrations/pipedrive/webhooks", d.PipedriveWebhook)
	r.Post("/api/public/crm-integrations/hubspot/webhooks", d.HubSpotWebhook)
	r.Post("/api/public/crm-integrations/close/webhooks/{webhook_token}", d.CloseWebhook)
	r.Post("/api/public/crm-integrations/copper/webhooks/{webhook_token}", d.CopperWebhook)
	r.Post("/api/public/crm-integrations/freshsales/webhooks/{webhook_token}", d.FreshsalesWebhook)
	r.Post("/api/public/crm-integrations/highlevel/webhooks/{webhook_token}", d.HighLevelWebhook)
	r.Post("/api/public/crm-integrations/postscript/webhooks/{webhook_token}", d.PostscriptWebhook)
	r.Post("/api/public/crm-integrations/attentive/webhooks/{webhook_token}", d.AttentiveWebhook)
}

func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": ProviderSpecs()})
}

func (d *Deps) ListIntegrations(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) GetIntegration(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, crmJSONMaxBodyBytes, &in); err != nil {
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
	normalized, err = d.preparePipedriveManagedWebhooks(r.Context(), tenantID, normalized, d.publicBaseURL(r))
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
		return
	}
	out, err := d.Repo.UpsertIntegration(r.Context(), tenantID, normalized)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "")
}

func (d *Deps) BackfillIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "backfill")
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
	if crmIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", "CRM integration is disconnected; reconnect it before syncing")
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, crmJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	in = normalizeSyncRequest(in)
	if forcedMode != "" {
		in.RunMode = forcedMode
	}
	if !allowedRunMode(in.RunMode) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "run_mode must be manual, scheduled, backfill, retry, or dry_run")
		return
	}
	if len(in.Contacts)+len(in.Events) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	providerPulled := false
	providerPullBaseCursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
	if len(in.Contacts)+len(in.Events) == 0 {
		pulled, ok, err := d.providerManagedSyncRequest(r.Context(), tenantID, integration, in)
		if err != nil {
			if errors.Is(err, errCRMIntegrationDisconnected) {
				httperror.Write(w, http.StatusConflict, "integration_disconnected", "CRM integration is disconnected; reconnect it before syncing")
				return
			}
			started := d.now()
			completed := d.now()
			cursor := firstString(in.Cursor, integration.SyncCursor)
			if retryCursor, ok := crmProviderRetryCursor(integration.Provider, cursor, "BACKFILL_FAILED", err, d.now()); ok {
				cursor = retryCursor
			}
			in.Cursor = cursor
			summary := SyncSummary{
				IntegrationID: integration.ID,
				Status:        "failed",
				Cursor:        cursor,
				ErrorMessage:  err.Error(),
			}
			_, _ = d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, in, started, completed)
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "CRM sync/backfill requires canonical contacts or events, or a configured provider-managed puller")
			return
		}
		in = pulled
		providerPulled = ok
		if len(in.Contacts)+len(in.Events) > d.maxSyncRows() {
			httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "provider sync returned too many rows")
			return
		}
	}
	if providerPulled {
		current, err := d.Repo.GetIntegration(r.Context(), tenantID, integration.ID)
		if err != nil {
			d.writeRepoError(w, r, tenantID, err)
			return
		}
		if crmIntegrationDisconnected(current) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", "CRM integration is disconnected; reconnect it before syncing")
			return
		}
		integration = current
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	if providerPulled && crmProviderPulledSyncFailed(in, summary) {
		syncErr := crmSyncFailureError(integration.Provider, summary)
		if retryCursor, ok := crmProviderRetryCursor(integration.Provider, providerPullBaseCursor, "SYNC_FAILED", syncErr, d.now()); ok {
			in.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.ErrorMessage = syncErr.Error()
		}
	}
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, in, started, completed)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) providerManagedSyncRequest(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	switch integration.Provider {
	case ProviderHubSpot:
		backfiller := d.hubSpotBackfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor := cursor
		if retry, ok, err := decodeHubSpotRetryCursor(effectiveCursor); err != nil {
			return SyncRequest{}, true, err
		} else if ok {
			if !hubSpotRetryCursorDue(retry, d.now()) {
				return normalizeSyncRequest(SyncRequest{
					RunMode: firstString(in.RunMode, "manual"),
					Cursor:  effectiveCursor,
				}), true, nil
			}
			effectiveCursor = retry.Cursor
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderSalesforce:
		backfiller := d.salesforceBackfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor := cursor
		if retry, ok, err := decodeSalesforceRetryCursor(effectiveCursor); err != nil {
			return SyncRequest{}, true, err
		} else if ok {
			if !salesforceRetryCursorDue(retry, d.now()) {
				return normalizeSyncRequest(SyncRequest{
					RunMode: firstString(in.RunMode, "manual"),
					Cursor:  effectiveCursor,
				}), true, nil
			}
			effectiveCursor = retry.Cursor
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderPipedrive:
		return d.pipedriveProviderManagedSyncRequest(ctx, tenantID, integration, in)
	case ProviderZohoCRM:
		backfiller := d.zohoBackfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor, deferred, err := crmRESTRetryCursorState(integration.Provider, cursor, d.now())
		if err != nil {
			return SyncRequest{}, true, err
		}
		if deferred {
			return normalizeSyncRequest(SyncRequest{
				RunMode: firstString(in.RunMode, "manual"),
				Cursor:  cursor,
			}), true, nil
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderDynamics365:
		backfiller := d.dynamics365Backfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor, deferred, err := crmRESTRetryCursorState(integration.Provider, cursor, d.now())
		if err != nil {
			return SyncRequest{}, true, err
		}
		if deferred {
			return normalizeSyncRequest(SyncRequest{
				RunMode: firstString(in.RunMode, "manual"),
				Cursor:  cursor,
			}), true, nil
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderKeap:
		backfiller := d.keapBackfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor, deferred, err := crmRESTRetryCursorState(integration.Provider, cursor, d.now())
		if err != nil {
			return SyncRequest{}, true, err
		}
		if deferred {
			return normalizeSyncRequest(SyncRequest{
				RunMode: firstString(in.RunMode, "manual"),
				Cursor:  cursor,
			}), true, nil
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderHighLevel:
		backfiller := d.highLevelBackfiller()
		if backfiller == nil {
			return SyncRequest{}, false, nil
		}
		cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
		effectiveCursor := cursor
		if retry, ok, err := decodeHighLevelRetryCursor(effectiveCursor); err != nil {
			return SyncRequest{}, true, err
		} else if ok {
			if !highLevelRetryCursorDue(retry, d.now()) {
				return normalizeSyncRequest(SyncRequest{
					RunMode: firstString(in.RunMode, "manual"),
					Cursor:  effectiveCursor,
				}), true, nil
			}
			effectiveCursor = retry.Cursor
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
		if err != nil {
			return SyncRequest{}, true, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
		if req.Cursor == "" {
			req.Cursor = effectiveCursor
		}
		return req, true, nil
	case ProviderClose, ProviderCopper, ProviderFreshsales:
		return d.crmStaticProviderManagedSyncRequest(ctx, tenantID, integration, in)
	case ProviderPostscript:
		return d.smsProviderManagedSyncRequest(ctx, tenantID, integration, in)
	case ProviderAttentive:
		return d.smsProviderManagedSyncRequest(ctx, tenantID, integration, in)
	default:
		return SyncRequest{}, false, nil
	}
}

func crmRESTRetryCursorState(provider, cursor string, now time.Time) (string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	switch provider {
	case ProviderZohoCRM:
		retry, ok, err := decodeZohoRetryCursor(cursor)
		if err != nil {
			return "", false, err
		}
		if ok {
			if !zohoRetryCursorDue(retry, now) {
				return cursor, true, nil
			}
			return retry.Cursor, false, nil
		}
	case ProviderDynamics365:
		retry, ok, err := decodeDynamics365RetryCursor(cursor)
		if err != nil {
			return "", false, err
		}
		if ok {
			if !dynamics365RetryCursorDue(retry, now) {
				return cursor, true, nil
			}
			return retry.Cursor, false, nil
		}
	case ProviderKeap:
		retry, ok, err := decodeKeapRetryCursor(cursor)
		if err != nil {
			return "", false, err
		}
		if ok {
			if !keapRetryCursorDue(retry, now) {
				return cursor, true, nil
			}
			return retry.Cursor, false, nil
		}
	}
	return cursor, false, nil
}

func (d *Deps) pipedriveProviderManagedSyncRequest(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) (SyncRequest, bool, error) {
	backfiller := d.pipedriveBackfiller()
	if backfiller == nil {
		return SyncRequest{}, false, nil
	}
	current, err := d.Repo.GetIntegration(ctx, tenantID, integration.ID)
	if err != nil {
		return SyncRequest{}, true, err
	}
	if crmIntegrationDisconnected(current) {
		return SyncRequest{}, true, errCRMIntegrationDisconnected
	}
	integration = current
	cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
	effectiveCursor := cursor
	if retry, ok, err := decodePipedriveRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, true, err
	} else if ok {
		if !pipedriveRetryCursorDue(retry, d.now()) {
			return normalizeSyncRequest(SyncRequest{
				RunMode: firstString(in.RunMode, "manual"),
				Cursor:  effectiveCursor,
			}), true, nil
		}
		effectiveCursor = retry.Cursor
	}
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		return SyncRequest{}, true, err
	}
	req = normalizeSyncRequest(req)
	req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
	if req.Cursor == "" {
		req.Cursor = effectiveCursor
	}
	return req, true, nil
}

func (d *Deps) smsProviderManagedSyncRequest(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) (SyncRequest, bool, error) {
	var backfiller smsBackfiller
	switch integration.Provider {
	case ProviderPostscript:
		backfiller = d.postscriptBackfiller()
	case ProviderAttentive:
		backfiller = d.attentiveBackfiller()
	default:
		return SyncRequest{}, false, nil
	}
	if backfiller == nil {
		return SyncRequest{}, false, nil
	}
	cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
	effectiveCursor := cursor
	if retry, ok, err := decodeSMSRetryCursorForProvider(integration.Provider, effectiveCursor); err != nil {
		return SyncRequest{}, true, err
	} else if ok {
		if !smsRetryCursorDue(retry, d.now()) {
			return normalizeSyncRequest(SyncRequest{
				RunMode: firstString(in.RunMode, "manual"),
				Cursor:  effectiveCursor,
			}), true, nil
		}
		effectiveCursor = retry.Cursor
	}
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		return SyncRequest{}, true, err
	}
	req = normalizeSyncRequest(req)
	req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
	if req.Cursor == "" {
		req.Cursor = effectiveCursor
	}
	return req, true, nil
}

func (d *Deps) crmStaticProviderManagedSyncRequest(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	backfiller := crmStaticBackfillerForProvider(d, integration.Provider)
	if backfiller == nil {
		return SyncRequest{}, false, nil
	}
	cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
	_, effectiveCursor, deferred, err := crmStaticRetryCursorState(integration.Provider, cursor, d.now())
	if err != nil {
		return SyncRequest{}, true, err
	}
	if deferred {
		return normalizeSyncRequest(SyncRequest{
			RunMode: firstString(in.RunMode, "manual"),
			Cursor:  cursor,
		}), true, nil
	}
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		return SyncRequest{}, true, err
	}
	req = normalizeSyncRequest(req)
	req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
	if req.Cursor == "" {
		req.Cursor = effectiveCursor
	}
	return req, true, nil
}

func crmProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderHubSpot:
		return hubSpotBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderSalesforce:
		return salesforceBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderPipedrive:
		return pipedriveBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderZohoCRM:
		return zohoBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderDynamics365:
		return dynamics365BackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderKeap:
		return keapBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderHighLevel:
		return highLevelBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderClose, ProviderCopper, ProviderFreshsales:
		return crmStaticBackfillRetryCursor(provider, cursor, status, retryErr, now)
	case ProviderPostscript, ProviderAttentive:
		return smsBackfillRetryCursor(provider, cursor, status, retryErr, now)
	default:
		return "", false
	}
}

func (d *Deps) PauseIntegration(w http.ResponseWriter, r *http.Request) {
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
	if crmIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", "CRM integration is disconnected; reconnect it before pausing")
		return
	}
	out, err := d.Repo.PauseIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type integrationResumer interface {
	ResumeIntegration(context.Context, string, string) (*Integration, error)
}

func (d *Deps) ResumeIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	resumer, ok := d.Repo.(integrationResumer)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "resume_unavailable", "CRM resume is not configured")
		return
	}
	out, err := resumer.ResumeIntegration(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DisconnectIntegration(w http.ResponseWriter, r *http.Request) {
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
	if integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		writeJSON(w, http.StatusOK, DisconnectResponse{OK: true, ProviderCleanup: crmDisconnectCleanupEvidenceFromSettings(integration.Settings)})
		return
	}
	var pipedriveWebhookCleanup PipedriveWebhookCleanupSummary
	pipedriveWebhookCleanupAttempted := false
	if integration != nil &&
		integration.Provider == ProviderPipedrive &&
		pipedriveManagedWebhooksPresent(integration.Settings) &&
		(d.pipedriveCredentialResolver() != nil || d.PipedriveWebhooks != nil) {
		pipedriveWebhookCleanup, err = d.cleanupPipedriveWebhooks(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		pipedriveWebhookCleanupAttempted = true
	}
	var pipedriveRevocation PipedriveOAuthRevocationSummary
	if integration != nil && integration.Provider == ProviderPipedrive {
		pipedriveRevocation, err = d.revokePipedriveOAuthOnDisconnect(r.Context(), tenantID, *integration)
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "oauth_revocation_failed", httperror.MessageInternal)
			return
		}
		if err := d.deletePipedriveManagedCredentialSecret(r.Context(), tenantID, *integration); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	var hubSpotRevocation HubSpotOAuthRevocationSummary
	if integration != nil && integration.Provider == ProviderHubSpot {
		hubSpotRevocation, err = d.revokeHubSpotOAuthOnDisconnect(r.Context(), tenantID, *integration)
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "oauth_revocation_failed", httperror.MessageInternal)
			return
		}
	}
	var salesforceRevocation SalesforceOAuthRevocationSummary
	if integration != nil && integration.Provider == ProviderSalesforce {
		salesforceRevocation, err = d.revokeSalesforceOAuthOnDisconnect(r.Context(), tenantID, *integration)
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "oauth_revocation_failed", httperror.MessageInternal)
			return
		}
	}
	var zohoRevocation ZohoOAuthRevocationSummary
	if integration != nil && integration.Provider == ProviderZohoCRM {
		zohoRevocation, err = d.revokeZohoOAuthOnDisconnect(r.Context(), tenantID, *integration)
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "oauth_revocation_failed", httperror.MessageInternal)
			return
		}
	}
	cleanup := crmDisconnectCleanupEvidence(integration, d.now(), crmDisconnectCleanupInput{
		pipedriveWebhookCleanup:          pipedriveWebhookCleanup,
		pipedriveWebhookCleanupAttempted: pipedriveWebhookCleanupAttempted,
		pipedriveOAuthRevocation:         pipedriveRevocation,
		hubSpotOAuthRevocation:           hubSpotRevocation,
		salesforceOAuthRevocation:        salesforceRevocation,
		zohoOAuthRevocation:              zohoRevocation,
	})
	if err := d.Repo.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup); err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if integration != nil && integration.Provider == ProviderHubSpot && hubSpotIsStoredCredentialRef(hubSpotCredentialRef(*integration)) {
		if deleter := d.hubSpotCredentialDeleter(); deleter != nil {
			if err := deleter.DeleteHubSpotCredentialSecret(r.Context(), tenantID, hubSpotCredentialRef(*integration)); err != nil {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
				return
			}
		}
	}
	if integration != nil && integration.Provider == ProviderSalesforce && salesforceIsStoredCredentialRef(salesforceCredentialRef(*integration)) {
		if deleter := d.salesforceCredentialDeleter(); deleter != nil {
			if err := deleter.DeleteSalesforceCredentialSecret(r.Context(), tenantID, salesforceCredentialRef(*integration)); err != nil {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
				return
			}
		}
	}
	if integration != nil && integration.Provider == ProviderZohoCRM {
		if err := d.deleteZohoManagedCredentialSecret(r.Context(), tenantID, *integration); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	if integration != nil && integration.Provider == ProviderDynamics365 {
		if err := d.deleteDynamics365ManagedCredentialSecret(r.Context(), tenantID, *integration); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	if integration != nil && integration.Provider == ProviderKeap {
		if err := d.deleteKeapManagedCredentialSecret(r.Context(), tenantID, *integration); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	if integration != nil && integration.Provider == ProviderHighLevel {
		if err := d.deleteHighLevelManagedCredentialSecret(r.Context(), tenantID, *integration); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
	}
	body := DisconnectResponse{OK: true, ProviderCleanup: cleanup}
	if hubSpotRevocation.Revoked || hubSpotRevocation.Skipped {
		revocation := hubSpotRevocation
		body.HubSpotOAuthRevocation = &revocation
	}
	if pipedriveRevocation.Revoked || pipedriveRevocation.Skipped {
		revocation := pipedriveRevocation
		body.PipedriveOAuthRevocation = &revocation
	}
	if salesforceRevocation.Revoked || salesforceRevocation.Skipped {
		revocation := salesforceRevocation
		body.SalesforceOAuthRevocation = &revocation
	}
	writeJSON(w, http.StatusOK, body)
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, chi.URLParam(r, "id"), queryInt(r, "limit", 25))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) PipedriveWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, pipedriveWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Pipedrive webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodePipedriveWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	subscriptionID := pipedriveWebhookSubscriptionID(payload)
	if subscriptionID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_webhook_id", "Pipedrive webhook meta.webhook_id is required")
		return
	}
	integration, err := d.Repo.FindPipedriveIntegrationByWebhookID(r.Context(), subscriptionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Pipedrive integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.pipedriveCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Pipedrive credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolvePipedrive(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := verifyPipedriveWebhookBasicAuth(creds, r); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_auth", "request authentication failed")
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Pipedrive integration not found")
		return
	}
	integration = current
	if err := validatePipedriveWebhookRouteIdentity(payload, *integration); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("pipedrive webhook identity mismatch", "integration", integration.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Pipedrive integration not found")
		return
	}
	deliveryID := pipedriveWebhookDeliveryID(payload, body)
	topic := pipedriveWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID, topic, body)
	if err != nil {
		if errors.Is(err, ErrCRMWebhookBodyMismatch) {
			httperror.Write(w, http.StatusConflict, "webhook_body_mismatch", "webhook delivery id was reused with a different body")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	req, handled := mapPipedriveWebhookSyncRequest(payload, *integration, deliveryID)
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	current, err = d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID, err)
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID, errCRMIntegrationDisconnected)
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Pipedrive integration not found")
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "pipedrive webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	} else if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderPipedrive, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) executeSync(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) SyncSummary {
	summary := SyncSummary{
		IntegrationID: integration.ID,
		Status:        "completed",
		ContactsSeen:  len(in.Contacts),
		EventsSeen:    len(in.Events),
		Cursor:        in.Cursor,
	}
	if err := d.beginCRMNativeListMembershipScans(ctx, tenantID, integration, in); err != nil {
		summary.RowsFailed++
		summary.Status = "partial"
		summary.ErrorMessage = err.Error()
	}
	for _, contact := range in.Contacts {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		subscriberID, err := d.Profiles.UpsertCRMContact(ctx, tenantID, *integration, contact)
		if err != nil {
			if errors.Is(err, ErrCRMContactSourceRevisionStale) ||
				errors.Is(err, ErrCRMContactPrivacyDeleted) {
				continue
			}
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.ContactsUpserted++
		if err := d.materializeCRMListMemberships(ctx, tenantID, integration, contact, subscriberID); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
		}
	}
	for _, event := range in.Events {
		if d.Events == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "event sink unavailable"
			continue
		}
		if _, err := d.Events.TrackCRMEvent(ctx, tenantID, integration.Provider, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
		if err := d.materializeCRMEventListMemberships(ctx, tenantID, integration, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
		}
	}
	if summary.RowsFailed > 0 && summary.ContactsUpserted == 0 && summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.RowsFailed == 0 {
		if err := d.completeCRMNativeListMembershipScans(ctx, tenantID, integration, in); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
		}
	}
	if summary.Cursor == "" {
		summary.Cursor = "crm-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "CRM integration not found")
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

func (d *Deps) existingIntegrationByProviderName(ctx context.Context, tenantID, provider, name string) *Integration {
	if d == nil || d.Repo == nil {
		return nil
	}
	lookup, ok := d.Repo.(interface {
		FindIntegrationByTenantProviderName(context.Context, string, string, string) (*Integration, error)
	})
	if !ok {
		return nil
	}
	existing, err := lookup.FindIntegrationByTenantProviderName(ctx, tenantID, provider, name)
	if err != nil {
		return nil
	}
	return existing
}

func (d *Deps) publicBaseURL(r *http.Request) string {
	if d != nil && strings.TrimSpace(d.PublicBaseURL) != "" {
		return strings.TrimRight(strings.TrimSpace(d.PublicBaseURL), "/")
	}
	if r == nil {
		return ""
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return ""
	}
	proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return strings.TrimRight(proto+"://"+host, "/")
}

func pipedriveManageWebhooks(settings map[string]any) bool {
	raw := strings.ToLower(strings.TrimSpace(firstString(settingString(settings, "manage_webhooks"), settingString(settings, "pipedrive_manage_webhooks"))))
	return raw == "true" || raw == "1" || raw == "yes"
}

func pipedriveManagedWebhooksPresent(settings map[string]any) bool {
	if !strings.EqualFold(settingString(settings, "pipedrive_webhooks_managed_by_postwave"), "true") {
		return false
	}
	return strings.TrimSpace(settingString(settings, "pipedrive_webhook_endpoint")) != ""
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
