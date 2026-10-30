// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	RecordSyncRun(context.Context, string, string, SyncSummary, SyncRequest, time.Time, time.Time) (*SyncRun, error)
	ListRuns(context.Context, string, string, int) ([]SyncRun, error)
	ClaimWebhook(context.Context, string, string, string, string, string, []byte) (WebhookClaim, error)
	MarkWebhookProcessed(context.Context, string, string, string) error
	MarkWebhookFailed(context.Context, string, string, string, error) error
	FindIntegrationByProviderFormID(context.Context, string, string) (*Integration, error)
	FindFacebookLeadAdsIntegrationByPageAndForm(context.Context, string, string) (*Integration, error)
	FindIntegrationByProviderInstanceID(context.Context, string, string) (*Integration, error)
	FindIntegrationByProviderSiteID(context.Context, string, string) (*Integration, error)
	FindIntegrationByProviderSiteAndForm(context.Context, string, string, string, string) (*Integration, error)
	FindIntegrationByProviderAccountAndCampaign(context.Context, string, string, string) (*Integration, error)
}

type providerCleanupDisconnectStore interface {
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, *DisconnectCleanupEvidence) error
}

type Deps struct {
	Repo                              Store
	Profiles                          ProfileSink
	Events                            EventSink
	Logger                            *slog.Logger
	Now                               func() time.Time
	MaxSyncRows                       int
	PublicBaseURL                     string
	TypeformBackfiller                TypeformBackfiller
	TypeformCredentials               TypeformCredentialResolver
	TypeformWebhooks                  TypeformWebhookRegistrar
	SurveyMonkeyBackfiller            SurveyMonkeyBackfiller
	SurveyMonkeyCredentials           SurveyMonkeyCredentialResolver
	UnbounceBackfiller                UnbounceBackfiller
	UnbounceCredentials               UnbounceCredentialResolver
	LeadpagesBackfiller               LeadpagesBackfiller
	LeadpagesCredentials              LeadpagesCredentialResolver
	FormBuilder123Backfiller          FormBuilder123Backfiller
	FormBuilder123Credentials         FormBuilder123CredentialResolver
	InstapageBackfiller               InstapageBackfiller
	InstapageCredentials              InstapageCredentialResolver
	CarrdCredentials                  CarrdCredentialResolver
	OptinMonsterCredentials           OptinMonsterCredentialResolver
	PrivyCredentials                  PrivyCredentialResolver
	ConvertFlowCredentials            ConvertFlowCredentialResolver
	SleeknoteCredentials              SleeknoteCredentialResolver
	WisepopsCredentials               WisepopsCredentialResolver
	PoptinCredentials                 PoptinCredentialResolver
	HelloBarCredentials               HelloBarCredentialResolver
	LandingiCredentials               LandingiCredentialResolver
	KickoffLabsCredentials            KickoffLabsCredentialResolver
	NinjaFormsCredentials             NinjaFormsCredentialResolver
	OutgrowCredentials                OutgrowCredentialResolver
	ShortStackCredentials             ShortStackCredentialResolver
	RiddleCredentials                 RiddleCredentialResolver
	WixBackfiller                     WixBackfiller
	WixCredentials                    WixCredentialResolver
	JotformBackfiller                 JotformBackfiller
	JotformCredentials                JotformCredentialResolver
	JotformWebhooks                   JotformWebhookRegistrar
	WebflowBackfiller                 WebflowBackfiller
	WebflowCredentials                WebflowCredentialResolver
	WebflowWebhooks                   WebflowWebhookRegistrar
	PaperformBackfiller               PaperformBackfiller
	PaperformCredentials              PaperformCredentialResolver
	FormstackBackfiller               FormstackBackfiller
	FormstackCredentials              FormstackCredentialResolver
	FormsiteBackfiller                FormsiteBackfiller
	FormsiteCredentials               FormsiteCredentialResolver
	CognitoFormsBackfiller            CognitoFormsBackfiller
	CognitoFormsCredentials           CognitoFormsCredentialResolver
	GravityFormsBackfiller            GravityFormsBackfiller
	GravityFormsCredentials           GravityFormsCredentialResolver
	WPFormsBackfiller                 WPFormsBackfiller
	WPFormsCredentials                WPFormsCredentialResolver
	FormidableFormsBackfiller         FormidableFormsBackfiller
	FormidableFormsCredentials        FormidableFormsCredentialResolver
	FeatheryBackfiller                FeatheryBackfiller
	FeatheryCredentials               FeatheryCredentialResolver
	FormalooBackfiller                FormalooBackfiller
	FormalooCredentials               FormalooCredentialResolver
	FilloutBackfiller                 FilloutBackfiller
	FilloutCredentials                FilloutCredentialResolver
	FilloutWebhooks                   FilloutWebhookRegistrar
	TallyBackfiller                   TallyBackfiller
	TallyCredentials                  TallyCredentialResolver
	GoogleFormsBackfiller             GoogleFormsBackfiller
	GoogleFormsCredentials            GoogleFormsCredentialResolver
	HTTPClient                        *http.Client
	FacebookLeadAdsBackfiller         FacebookLeadAdsBackfiller
	FacebookLeadAdsCredentials        FacebookLeadAdsCredentialResolver
	FacebookLeadAdsPageSubscriptions  FacebookLeadAdsPageSubscriptionRegistrar
	FacebookLeadAdsWebhookVerifyToken string
	GoogleLeadFormsBackfiller         GoogleLeadFormsBackfiller
	GoogleLeadFormsCredentials        GoogleLeadFormsCredentialResolver
}

const leadJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/lead-integrations/providers", d.ListProviders)
	r.With(read).Get("/api/v1/lead-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/lead-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/lead-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/lead-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/lead-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/lead-integrations/{id}/ingest", d.IngestSubmission)
	r.With(admin).Post("/api/v1/lead-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Delete("/api/v1/lead-integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/lead-integrations/{id}/runs", d.ListRuns)
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
	if err := httpbody.DecodeJSON(w, r, leadJSONMaxBodyBytes, &in); err != nil {
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
	var createRollbacks []leadCreateRollback
	if normalized.Provider == ProviderTypeform && (d.typeformCredentialResolver() != nil || d.TypeformWebhooks != nil) {
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := copySettings(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		summary, err := d.reconcileTypeformWebhook(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderTypeform,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["typeform_webhook_id"] = summary.WebhookID
		normalized.Settings["typeform_webhook_tag"] = summary.Tag
		normalized.Settings["typeform_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["typeform_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["typeform_webhook_upserted"] = summary.Upserted
		normalized.Settings["typeform_webhook_verified"] = summary.Verified
		if !summary.VerifiedAt.IsZero() {
			normalized.Settings["typeform_webhook_verified_at"] = summary.VerifiedAt.Format(time.RFC3339)
		}
		normalized.Settings["typeform_webhook_event_types"] = summary.EventTypes
		normalized.Settings["typeform_webhook_managed_by_postwave"] = true
		if existing == nil {
			createRollbacks = append(createRollbacks, leadCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderTypeform,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       copySettings(normalized.Settings),
			}})
		}
	}
	if normalized.Provider == ProviderFillout && (d.filloutCredentialResolver() != nil || d.FilloutWebhooks != nil) {
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := copySettings(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		summary, err := d.reconcileFilloutWebhook(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderFillout,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["fillout_webhook_id"] = summary.WebhookID
		normalized.Settings["fillout_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["fillout_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["fillout_webhook_created"] = summary.Created
		normalized.Settings["fillout_webhook_managed_by_postwave"] = true
		if existing == nil && summary.Created {
			createRollbacks = append(createRollbacks, leadCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderFillout,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       copySettings(normalized.Settings),
			}})
		}
	}
	if normalized.Provider == ProviderJotform && (d.jotformCredentialResolver() != nil || d.JotformWebhooks != nil) {
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := copySettings(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		summary, err := d.reconcileJotformWebhook(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderJotform,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["jotform_webhook_id"] = summary.WebhookID
		normalized.Settings["jotform_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["jotform_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["jotform_webhook_created"] = summary.Created
		normalized.Settings["jotform_webhook_reused"] = summary.Reused
		normalized.Settings["jotform_webhook_managed_by_postwave"] = true
		if existing == nil && summary.Created {
			createRollbacks = append(createRollbacks, leadCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderJotform,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       copySettings(normalized.Settings),
			}})
		}
	}
	if normalized.Provider == ProviderWebflow && (d.webflowCredentialResolver() != nil || d.WebflowWebhooks != nil) {
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := copySettings(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		summary, err := d.reconcileWebflowWebhook(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderWebflow,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["webflow_webhook_id"] = summary.WebhookID
		normalized.Settings["webflow_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["webflow_webhook_trigger_type"] = summary.TriggerType
		normalized.Settings["webflow_webhook_filter"] = summary.Filter
		normalized.Settings["webflow_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["webflow_webhook_created"] = summary.Created
		normalized.Settings["webflow_webhook_reused"] = summary.Reused
		normalized.Settings["webflow_webhook_repaired"] = summary.Repaired
		normalized.Settings["webflow_webhook_reconciled_at"] = summary.RegisteredAt.Format(time.RFC3339)
		if summary.RepairReason != "" {
			normalized.Settings["webflow_webhook_repair_reason"] = summary.RepairReason
		} else {
			delete(normalized.Settings, "webflow_webhook_repair_reason")
		}
		if summary.PreviousWebhookID != "" {
			normalized.Settings["webflow_webhook_previous_id"] = summary.PreviousWebhookID
		} else {
			delete(normalized.Settings, "webflow_webhook_previous_id")
		}
		normalized.Settings["webflow_webhook_managed_by_postwave"] = true
		if existing == nil && summary.Created {
			createRollbacks = append(createRollbacks, leadCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderWebflow,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       copySettings(normalized.Settings),
			}})
		}
	}
	if normalized.Provider == ProviderFacebookLeadAds && (d.facebookLeadAdsCredentialResolver() != nil || d.FacebookLeadAdsPageSubscriptions != nil) {
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := copySettings(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		summary, err := d.reconcileFacebookLeadAdsPageSubscription(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderFacebookLeadAds,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "page_subscription_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["facebook_lead_ads_page_subscription_page_id"] = summary.PageID
		normalized.Settings["facebook_lead_ads_page_subscription_fields"] = summary.Fields
		normalized.Settings["facebook_lead_ads_page_subscription_endpoint"] = summary.Endpoint
		normalized.Settings["facebook_lead_ads_page_subscription_reconciled_at"] = summary.ReconciledAt.Format(time.RFC3339)
		normalized.Settings["facebook_lead_ads_page_subscription_subscribed"] = summary.Subscribed
		normalized.Settings["facebook_lead_ads_page_subscription_managed_by_postwave"] = true
		if existing == nil && summary.Subscribed {
			createRollbacks = append(createRollbacks, leadCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderFacebookLeadAds,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       copySettings(normalized.Settings),
			}})
		}
	}
	delete(normalized.Settings, "provider_cleanup")
	out, err := d.Repo.UpsertIntegration(r.Context(), tenantID, normalized)
	if err != nil {
		d.rollbackLeadCreateResources(r.Context(), tenantID, normalized.Name, d.publicBaseURL(r), createRollbacks)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Klaviyo-style: import the source's trailing history immediately on connect
	// (background, bounded). No-op for webhook-only providers / when opted out.
	writeJSON(w, http.StatusCreated, out)
	d.maybeBackfillOnConnect(out)
}

type leadCreateRollback struct {
	integration Integration
}

func (d *Deps) rollbackLeadCreateResources(ctx context.Context, tenantID, name, appBaseURL string, rollbacks []leadCreateRollback) {
	for _, rollback := range rollbacks {
		provider := rollback.integration.Provider
		var err error
		switch provider {
		case ProviderTypeform:
			_, err = d.cleanupTypeformWebhook(ctx, rollback.integration, appBaseURL)
		case ProviderFillout:
			_, err = d.cleanupFilloutWebhook(ctx, rollback.integration, appBaseURL)
		case ProviderJotform:
			_, err = d.cleanupJotformWebhook(ctx, rollback.integration, appBaseURL)
		case ProviderWebflow:
			_, err = d.cleanupWebflowWebhook(ctx, rollback.integration, appBaseURL)
		case ProviderFacebookLeadAds:
			_, err = d.cleanupFacebookLeadAdsPageSubscription(ctx, rollback.integration, appBaseURL)
		}
		if err != nil && d.Logger != nil {
			d.Logger.Warn("rollback lead provider resource after integration persistence failure failed",
				"tenant_id", tenantID,
				"provider", provider,
				"name", name,
				"error", err)
		}
	}
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "")
}

func (d *Deps) BackfillIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "backfill")
}

func (d *Deps) IngestSubmission(w http.ResponseWriter, r *http.Request) {
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
	var submission SubmissionInput
	if err := httpbody.DecodeJSON(w, r, leadJSONMaxBodyBytes, &submission); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
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
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, leadJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
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
	if len(in.Submissions) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	providerPulled := false
	providerPullCursor := ""
	if len(in.Submissions) == 0 {
		providerPullCursor = firstString(in.Cursor, integration.SyncCursor)
		pulled, ok, err := d.providerManagedSyncRequest(r.Context(), tenantID, integration, in)
		if err != nil {
			started := d.now()
			completed := d.now()
			failureReq := in
			failureCursor := firstString(in.Cursor, integration.SyncCursor)
			var providerErr providerManagedSyncError
			if errors.As(err, &providerErr) && strings.TrimSpace(providerErr.Cursor) != "" {
				failureCursor = strings.TrimSpace(providerErr.Cursor)
				failureReq.Cursor = failureCursor
			}
			summary := SyncSummary{
				IntegrationID: integration.ID,
				Status:        "failed",
				Cursor:        failureCursor,
				ErrorMessage:  err.Error(),
			}
			_, _ = d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, failureReq, started, completed)
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "lead sync/backfill requires canonical submissions or a configured provider-managed puller")
			return
		}
		in = pulled
		providerPulled = ok
		if len(in.Submissions) > d.maxSyncRows() {
			httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "provider sync returned too many rows")
			return
		}
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	completed := d.now()
	if providerPulled && syncRequestHasSubmissions(in) && summary.Status == "failed" {
		retryErr := errors.New(firstString(summary.ErrorMessage, "lead sync failed"))
		if retryCursor, ok := leadProviderBackfillRetryCursor(integration.Provider, providerPullCursor, "SYNC_FAILED", retryErr, d.now()); ok {
			summary.Cursor = retryCursor
			in.Cursor = retryCursor
		}
	}
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
	case ProviderTypeform:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.typeformBackfiller())
	case ProviderSurveyMonkey:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.surveyMonkeyBackfiller())
	case ProviderUnbounce:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.unbounceBackfiller())
	case ProviderLeadpages:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.leadpagesBackfiller())
	case Provider123FormBuilder:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.formBuilder123Backfiller())
	case ProviderInstapage:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.instapageBackfiller())
	case ProviderWix:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.wixBackfiller())
	case ProviderJotform:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.jotformBackfiller())
	case ProviderWebflow:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.webflowBackfiller())
	case ProviderPaperform:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.paperformBackfiller())
	case ProviderFormstack:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.formstackBackfiller())
	case ProviderFormsite:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.formsiteBackfiller())
	case ProviderCognitoForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.cognitoFormsBackfiller())
	case ProviderGravityForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.gravityFormsBackfiller())
	case ProviderWPForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.wpformsBackfiller())
	case ProviderFormidableForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.formidableFormsBackfiller())
	case ProviderFeathery:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.featheryBackfiller())
	case ProviderFormaloo:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.formalooBackfiller())
	case ProviderFillout:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.filloutBackfiller())
	case ProviderTally:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.tallyBackfiller())
	case ProviderGoogleForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.googleFormsBackfiller())
	case ProviderFacebookLeadAds:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.facebookLeadAdsBackfiller())
	case ProviderGoogleLeadForms:
		return d.providerManagedBackfillRequest(ctx, tenantID, integration, in, d.googleLeadFormsBackfiller())
	default:
		return SyncRequest{}, false, nil
	}
}

type leadBackfiller interface {
	BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
}

func (d *Deps) providerManagedBackfillRequest(ctx context.Context, tenantID string, integration *Integration, in SyncRequest, backfiller leadBackfiller) (SyncRequest, bool, error) {
	if backfiller == nil {
		return SyncRequest{}, false, nil
	}
	cursor := strings.TrimSpace(firstString(in.Cursor, integration.SyncCursor))
	effectiveCursor, notDue, err := leadProviderEffectiveCursor(integration.Provider, cursor, d.now())
	if err != nil {
		return SyncRequest{}, true, err
	}
	if notDue {
		req := normalizeSyncRequest(SyncRequest{
			RunMode: firstString(in.RunMode, "manual"),
			Cursor:  cursor,
		})
		return req, true, nil
	}
	retryCursorBase := effectiveCursor
	if strings.TrimSpace(cursor) != strings.TrimSpace(effectiveCursor) {
		retryCursorBase = cursor
	}
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		if retryCursor, ok := leadProviderBackfillRetryCursor(integration.Provider, retryCursorBase, "BACKFILL_FAILED", err, d.now()); ok {
			return SyncRequest{}, true, providerManagedSyncError{Err: err, Cursor: retryCursor}
		}
		return SyncRequest{}, true, err
	}
	req = normalizeSyncRequest(req)
	req.RunMode = firstString(in.RunMode, req.RunMode, "manual")
	if req.Cursor == "" {
		req.Cursor = effectiveCursor
	}
	return req, true, nil
}

func leadProviderEffectiveCursor(provider, cursor string, now time.Time) (string, bool, error) {
	switch provider {
	case ProviderTypeform:
		retry, ok, err := decodeTypeformRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !typeformRetryCursorDue(retry, now), nil
	case ProviderSurveyMonkey:
		retry, ok, err := decodeSurveyMonkeyRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !surveyMonkeyRetryCursorDue(retry, now), nil
	case ProviderUnbounce:
		retry, ok, err := decodeUnbounceRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !unbounceRetryCursorDue(retry, now), nil
	case ProviderLeadpages:
		retry, ok, err := decodeLeadpagesRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !leadpagesRetryCursorDue(retry, now), nil
	case Provider123FormBuilder:
		retry, ok, err := decodeFormBuilder123RetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !formBuilder123RetryCursorDue(retry, now), nil
	case ProviderInstapage:
		retry, ok, err := decodeInstapageRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !instapageRetryCursorDue(retry, now), nil
	case ProviderWix:
		retry, ok, err := decodeWixRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !wixRetryCursorDue(retry, now), nil
	case ProviderJotform:
		retry, ok, err := decodeJotformRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !jotformRetryCursorDue(retry, now), nil
	case ProviderWebflow:
		retry, ok, err := decodeWebflowRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !webflowRetryCursorDue(retry, now), nil
	case ProviderPaperform:
		retry, ok, err := decodePaperformRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !paperformRetryCursorDue(retry, now), nil
	case ProviderFormstack:
		retry, ok, err := decodeFormstackRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !formstackRetryCursorDue(retry, now), nil
	case ProviderFormsite:
		retry, ok, err := decodeFormsiteRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !formsiteRetryCursorDue(retry, now), nil
	case ProviderCognitoForms:
		retry, ok, err := decodeCognitoFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !cognitoFormsRetryCursorDue(retry, now), nil
	case ProviderGravityForms:
		retry, ok, err := decodeGravityFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !gravityFormsRetryCursorDue(retry, now), nil
	case ProviderWPForms:
		retry, ok, err := decodeWPFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !wpformsRetryCursorDue(retry, now), nil
	case ProviderFormidableForms:
		retry, ok, err := decodeFormidableFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !formidableFormsRetryCursorDue(retry, now), nil
	case ProviderFeathery:
		retry, ok, err := decodeFeatheryRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !featheryRetryCursorDue(retry, now), nil
	case ProviderFormaloo:
		retry, ok, err := decodeFormalooRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !formalooRetryCursorDue(retry, now), nil
	case ProviderFillout:
		retry, ok, err := decodeFilloutRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !filloutRetryCursorDue(retry, now), nil
	case ProviderTally:
		retry, ok, err := decodeTallyRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !tallyRetryCursorDue(retry, now), nil
	case ProviderGoogleForms:
		retry, ok, err := decodeGoogleFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !googleFormsRetryCursorDue(retry, now), nil
	case ProviderFacebookLeadAds:
		retry, ok, err := decodeFacebookLeadAdsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !facebookLeadAdsRetryCursorDue(retry, now), nil
	case ProviderGoogleLeadForms:
		retry, ok, err := decodeGoogleLeadFormsRetryCursor(cursor)
		if err != nil || !ok {
			return cursor, false, err
		}
		return retry.Cursor, !googleLeadFormsRetryCursorDue(retry, now), nil
	default:
		return cursor, false, nil
	}
}

func leadProviderBackfillRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderTypeform:
		return typeformBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderSurveyMonkey:
		return surveyMonkeyBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderUnbounce:
		return unbounceBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderLeadpages:
		return leadpagesBackfillRetryCursor(cursor, status, retryErr, now), true
	case Provider123FormBuilder:
		return formBuilder123BackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderInstapage:
		return instapageBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderWix:
		return wixBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderJotform:
		return jotformBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderWebflow:
		return webflowBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderPaperform:
		return paperformBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFormstack:
		return formstackBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFormsite:
		return formsiteBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderCognitoForms:
		return cognitoFormsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderGravityForms:
		return gravityFormsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderWPForms:
		return wpformsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFormidableForms:
		return formidableFormsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFeathery:
		return featheryBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFormaloo:
		return formalooBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFillout:
		return filloutBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderTally:
		return tallyBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderGoogleForms:
		return googleFormsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderFacebookLeadAds:
		return facebookLeadAdsBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderGoogleLeadForms:
		return googleLeadFormsBackfillRetryCursor(cursor, status, retryErr, now), true
	default:
		return "", false
	}
}

type providerManagedSyncError struct {
	Err    error
	Cursor string
}

func (e providerManagedSyncError) Error() string {
	if e.Err == nil {
		return "provider sync failed"
	}
	return e.Err.Error()
}

func (e providerManagedSyncError) Unwrap() error {
	return e.Err
}

func leadProviderRetryBaseCursor(provider, cursor string) string {
	cursor = strings.TrimSpace(cursor)
	switch provider {
	case ProviderTypeform:
		if retry, ok, err := decodeTypeformRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderSurveyMonkey:
		if retry, ok, err := decodeSurveyMonkeyRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderUnbounce:
		if retry, ok, err := decodeUnbounceRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderLeadpages:
		if retry, ok, err := decodeLeadpagesRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case Provider123FormBuilder:
		if retry, ok, err := decodeFormBuilder123RetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderInstapage:
		if retry, ok, err := decodeInstapageRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderWix:
		if retry, ok, err := decodeWixRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderJotform:
		if retry, ok, err := decodeJotformRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderWebflow:
		if retry, ok, err := decodeWebflowRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderPaperform:
		if retry, ok, err := decodePaperformRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFormstack:
		if retry, ok, err := decodeFormstackRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFormsite:
		if retry, ok, err := decodeFormsiteRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderCognitoForms:
		if retry, ok, err := decodeCognitoFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderGravityForms:
		if retry, ok, err := decodeGravityFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderWPForms:
		if retry, ok, err := decodeWPFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFormidableForms:
		if retry, ok, err := decodeFormidableFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFeathery:
		if retry, ok, err := decodeFeatheryRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFormaloo:
		if retry, ok, err := decodeFormalooRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFillout:
		if retry, ok, err := decodeFilloutRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderTally:
		if retry, ok, err := decodeTallyRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderGoogleForms:
		if retry, ok, err := decodeGoogleFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderFacebookLeadAds:
		if retry, ok, err := decodeFacebookLeadAdsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	case ProviderGoogleLeadForms:
		if retry, ok, err := decodeGoogleLeadFormsRetryCursor(cursor); err == nil && ok {
			return retry.Cursor
		}
	}
	return cursor
}

func (d *Deps) PauseIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.PauseIntegration(r.Context(), tenantID, chi.URLParam(r, "id"))
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
	var cleanup *DisconnectCleanupEvidence
	if integration != nil &&
		integration.Provider == ProviderTypeform &&
		hasManagedTypeformWebhook(*integration) &&
		(d.typeformCredentialResolver() != nil || d.TypeformWebhooks != nil) {
		summary, err := d.cleanupTypeformWebhook(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		cleanup = typeformDisconnectCleanupEvidence(*integration, summary)
	}
	if integration != nil &&
		integration.Provider == ProviderFillout &&
		strings.TrimSpace(settingString(integration.Settings, "fillout_webhook_id")) != "" &&
		(d.filloutCredentialResolver() != nil || d.FilloutWebhooks != nil) {
		summary, err := d.cleanupFilloutWebhook(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		cleanup = filloutDisconnectCleanupEvidence(*integration, summary)
	}
	if integration != nil &&
		integration.Provider == ProviderJotform &&
		strings.TrimSpace(settingString(integration.Settings, "jotform_webhook_id")) != "" &&
		(d.jotformCredentialResolver() != nil || d.JotformWebhooks != nil) {
		summary, err := d.cleanupJotformWebhook(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		cleanup = jotformDisconnectCleanupEvidence(*integration, summary)
	}
	if integration != nil &&
		integration.Provider == ProviderWebflow &&
		hasManagedWebflowWebhook(*integration) &&
		(d.webflowCredentialResolver() != nil || d.WebflowWebhooks != nil) {
		summary, err := d.cleanupWebflowWebhook(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		cleanup = webflowDisconnectCleanupEvidence(*integration, summary)
	}
	if integration != nil &&
		integration.Provider == ProviderFacebookLeadAds &&
		hasManagedFacebookLeadAdsPageSubscription(*integration) &&
		(d.facebookLeadAdsCredentialResolver() != nil || d.FacebookLeadAdsPageSubscriptions != nil) {
		summary, err := d.cleanupFacebookLeadAdsPageSubscription(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "page_subscription_cleanup_failed", httperror.MessageInternal)
			return
		}
		cleanup = facebookLeadAdsDisconnectCleanupEvidence(*integration, summary)
	}
	if integration != nil && integration.Provider == ProviderGoogleLeadForms {
		cleanup = googleLeadFormsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderSurveyMonkey {
		cleanup = surveyMonkeyDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderUnbounce {
		cleanup = unbounceDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderLeadpages {
		cleanup = leadpagesDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == Provider123FormBuilder {
		cleanup = formBuilder123DisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderInstapage {
		cleanup = instapageDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderCarrd {
		cleanup = carrdDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderOptinMonster {
		cleanup = optinMonsterDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderPrivy {
		cleanup = privyDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderConvertFlow {
		cleanup = convertFlowDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderSleeknote {
		cleanup = sleeknoteDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderWisepops {
		cleanup = wisepopsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderPoptin {
		cleanup = poptinDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderHelloBar {
		cleanup = helloBarDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderLandingi {
		cleanup = landingiDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderKickoffLabs {
		cleanup = kickoffLabsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderNinjaForms {
		cleanup = ninjaFormsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderOutgrow {
		cleanup = outgrowDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderShortStack {
		cleanup = shortStackDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderRiddle {
		cleanup = riddleDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderPaperform {
		cleanup = paperformDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderFormstack {
		cleanup = formstackDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderFormsite {
		cleanup = formsiteDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderCognitoForms {
		cleanup = cognitoFormsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderGravityForms {
		cleanup = gravityFormsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderWPForms {
		cleanup = wpformsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderFormidableForms {
		cleanup = formidableFormsDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderFeathery {
		cleanup = featheryDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderFormaloo {
		cleanup = formalooDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderTally {
		cleanup = tallyDisconnectCleanupEvidence(*integration)
	}
	if integration != nil && integration.Provider == ProviderGoogleForms {
		cleanup = googleFormsDisconnectCleanupEvidence(*integration)
	}
	if cleanup != nil {
		if recorder, ok := d.Repo.(providerCleanupDisconnectStore); ok {
			err = recorder.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup)
		} else {
			err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
		}
	} else {
		err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
	}
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	out := map[string]any{"ok": true}
	if cleanup != nil {
		out["provider_cleanup"] = cleanup
	}
	writeJSON(w, http.StatusOK, out)
}

func hasManagedTypeformWebhook(integration Integration) bool {
	settings := integration.Settings
	for _, key := range []string{"typeform_webhook_id", "typeform_webhook_tag", "webhook_tag"} {
		if strings.TrimSpace(settingString(settings, key)) != "" {
			return true
		}
	}
	return strings.EqualFold(strings.TrimSpace(settingString(settings, "typeform_webhook_managed_by_postwave")), "true")
}

func hasManagedWebflowWebhook(integration Integration) bool {
	settings := integration.Settings
	for _, key := range []string{"webflow_webhook_id", "webflow_webhook_endpoint", "webflow_webhook_reconciled_at"} {
		if strings.TrimSpace(settingString(settings, key)) != "" {
			return true
		}
	}
	return strings.EqualFold(strings.TrimSpace(settingString(settings, "webflow_webhook_managed_by_postwave")), "true")
}

func hasManagedFacebookLeadAdsPageSubscription(integration Integration) bool {
	settings := integration.Settings
	for _, key := range []string{
		"facebook_lead_ads_page_subscription_page_id",
		"facebook_lead_ads_page_subscription_reconciled_at",
		"facebook_lead_ads_page_subscription_endpoint",
	} {
		if strings.TrimSpace(settingString(settings, key)) != "" {
			return true
		}
	}
	return strings.EqualFold(strings.TrimSpace(settingString(settings, "facebook_lead_ads_page_subscription_managed_by_postwave")), "true")
}

func typeformDisconnectCleanupEvidence(integration Integration, summary TypeformWebhookCleanupSummary) *DisconnectCleanupEvidence {
	return leadDisconnectCleanupEvidence(integration, leadCleanupEvidenceInput{
		providerName:      "Typeform",
		cleanupKind:       "webhook",
		scopeType:         "typeform_form_id",
		scopeID:           settingString(integration.Settings, "form_id"),
		providerWebhookID: summary.WebhookID,
		endpoint:          summary.Endpoint,
		recordedAt:        summary.CleanedUpAt,
		deleted:           summary.Deleted,
		notFound:          summary.NotFound,
		webhookSecretRef: firstString(
			settingString(integration.Settings, "webhook_secret_ref"),
			settingString(integration.Settings, "typeform_webhook_secret_ref"),
		),
	})
}

func surveyMonkeyDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	surveyID := settingString(integration.Settings, "survey_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"survey_id", surveyID},
		{"survey_name", settingString(integration.Settings, "survey_name")},
		{"collector_id", settingString(integration.Settings, "collector_id")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"start_modified_at", settingString(integration.Settings, "start_modified_at")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "surveymonkey_response_pull",
		ProviderScopeType:       "surveymonkey_survey_id",
		ProviderScopeID:         surveyID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled SurveyMonkey provider pulls exclude disconnected rows",
			"manual SurveyMonkey sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the SurveyMonkey OAuth token referenced by credentials_ref if it is no longer used",
			"review SurveyMonkey survey, collector, and app access granted for this Moosewave connection",
			"remove duplicate or manually configured SurveyMonkey webhooks, exports, or destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the SurveyMonkey disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the SurveyMonkey integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST responses puller slice",
			"SurveyMonkey-side OAuth revocation, survey/collector access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func unbounceDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	pageID := settingString(integration.Settings, "page_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"page_id", pageID},
		{"page_name", settingString(integration.Settings, "page_name")},
		{"form_id", settingString(integration.Settings, "form_id")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"from", settingString(integration.Settings, "from")},
		{"to", settingString(integration.Settings, "to")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "unbounce_lead_pull",
		ProviderScopeType:       "unbounce_page_id",
		ProviderScopeID:         pageID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Unbounce provider pulls exclude disconnected rows",
			"manual Unbounce sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Unbounce OAuth token or API key referenced by credentials_ref if it is no longer used",
			"review Unbounce page, pop-up, sticky-bar, and API access granted for this Moosewave connection",
			"remove duplicate or manually configured Unbounce webhooks, exports, or destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Unbounce disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Unbounce integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST leads puller slice",
			"Unbounce-side token/API-key revocation, page access review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func leadpagesDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	pageID := settingString(integration.Settings, "page_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", settingString(integration.Settings, "account_id")},
		{"page_id", pageID},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"from", settingString(integration.Settings, "from")},
		{"to", settingString(integration.Settings, "to")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "leadpages_form_submission_pull",
		ProviderScopeType:       "leadpages_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "operator_review_dashboard_webhooks",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Leadpages provider pulls exclude disconnected rows",
			"manual Leadpages sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Leadpages API key referenced by credentials_ref if it is no longer used",
			"review Leadpages page/form access granted for this Moosewave connection",
			"remove duplicate or manually configured Leadpages webhook, export, or integration destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Leadpages disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Leadpages integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Leadpages-side API-key rotation, dashboard webhook cleanup, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func formBuilder123DisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", settingString(integration.Settings, "account_id")},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"start_date", settingString(integration.Settings, "start_date")},
		{"start_submission_id", settingString(integration.Settings, "start_submission_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "123formbuilder_submission_pull",
		ProviderScopeType:       "123formbuilder_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "operator_review_form_webhooks",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled 123FormBuilder provider pulls exclude disconnected rows",
			"manual 123FormBuilder sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the 123FormBuilder JWT or login credential referenced by credentials_ref if it is no longer used",
			"review 123FormBuilder form access granted for this Moosewave connection",
			"remove duplicate or manually configured 123FormBuilder webhooks, exports, or integration destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the 123FormBuilder disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the 123FormBuilder integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"123FormBuilder-side JWT/login credential rotation, form webhook cleanup, duplicate destination audit, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func instapageDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	workspaceID := settingString(integration.Settings, "workspace_id")
	pageID := settingString(integration.Settings, "page_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"workspace_id", workspaceID},
		{"page_id", pageID},
		{"page_name", settingString(integration.Settings, "page_name")},
		{"form_id", settingString(integration.Settings, "form_id")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"from", settingString(integration.Settings, "from")},
		{"to", settingString(integration.Settings, "to")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(workspaceID)+"/"+strings.TrimSpace(pageID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "instapage_submission_pull",
		ProviderScopeType:       "instapage_workspace_page",
		ProviderScopeID:         firstString(scopeID, workspaceID, pageID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Instapage provider pulls exclude disconnected rows",
			"manual Instapage sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Instapage personal API token referenced by credentials_ref if it is no longer used",
			"review Instapage workspace, landing page, and API access granted for this Moosewave connection",
			"remove duplicate or manually configured Instapage webhooks, exports, or destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Instapage disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Instapage integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Instapage-side API-token revocation, workspace/page access review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func carrdDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	siteID := settingString(integration.Settings, "site_id")
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_id", siteID},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(siteID)+"/"+strings.TrimSpace(formID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "carrd_custom_url_form_receiver",
		ProviderScopeType:       "carrd_site_form",
		ProviderScopeID:         firstString(scopeID, siteID, formID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(carrdCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_custom_url_form_destination",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Carrd Custom URL deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or change the Carrd Custom URL form destination that points at the Moosewave public receiver",
			"rotate the Carrd route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Carrd Custom URL destinations outside Moosewave",
			"record Carrd-side cleanup evidence in the customer change ticket before considering the Carrd disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Carrd integration disconnected before future Custom URL form writes",
			"Moosewave owns the receiver, token verification, idempotency, canonical lead import, and local disconnect guard",
			"Carrd-side Custom URL destination removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func optinMonsterDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "optinmonster_webhook_receiver",
		ProviderScopeType:       "optinmonster_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(optinMonsterCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_optinmonster_webhook_destination",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"OptinMonster Webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the OptinMonster Webhook integration destination that points at the Moosewave public receiver",
			"rotate the OptinMonster route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured OptinMonster webhook destinations outside Moosewave",
			"record OptinMonster-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the OptinMonster integration disconnected before future Webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"OptinMonster-side Webhook destination removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func privyDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "privy_custom_webhook_receiver",
		ProviderScopeType:       "privy_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(privyCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_privy_custom_webhook",
		CredentialCleanupStatus: "operator_rotate_basic_auth_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Privy custom webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Privy custom webhook destination that points at the Moosewave public receiver",
			"rotate the Privy Basic auth credentials referenced by credentials_ref if they are no longer used",
			"review duplicate or manually configured Privy webhook destinations outside Moosewave",
			"record Privy-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Privy integration disconnected before future custom webhook writes",
			"Moosewave owns the receiver, Basic auth verification, idempotency, canonical lead import, and local disconnect guard",
			"Privy-side custom webhook destination removal, Basic auth rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func convertFlowDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "convertflow_custom_webhook_receiver",
		ProviderScopeType:       "convertflow_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(convertFlowCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_convertflow_webhook_automation",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"ConvertFlow custom webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the ConvertFlow webhook automation that points at the Moosewave public receiver",
			"rotate the ConvertFlow route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured ConvertFlow automations outside Moosewave",
			"record ConvertFlow-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the ConvertFlow integration disconnected before future custom webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"ConvertFlow-side webhook automation removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func sleeknoteDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "sleeknote_custom_integration_receiver",
		ProviderScopeType:       "sleeknote_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(sleeknoteCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_sleeknote_custom_integration",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Sleeknote custom integration deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Sleeknote custom integration URL that points at the Moosewave public receiver",
			"rotate the Sleeknote route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Sleeknote custom integrations outside Moosewave",
			"record Sleeknote-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Sleeknote integration disconnected before future custom integration writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Sleeknote-side custom integration removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func wisepopsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
		{"hook_id", settingString(integration.Settings, "hook_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "wisepops_signed_webhook_receiver",
		ProviderScopeType:       "wisepops_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(wisepopsCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_wisepops_webhook_hook",
		CredentialCleanupStatus: "operator_rotate_api_key_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Wisepops signed webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Wisepops webhook hook that points at the Moosewave public receiver",
			"rotate the Wisepops API key referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Wisepops webhook hooks outside Moosewave",
			"record Wisepops-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Wisepops integration disconnected before future signed webhook writes",
			"Moosewave owns the receiver, HMAC verification, idempotency, canonical lead import, and local disconnect guard",
			"Wisepops-side hook removal, API-key rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func filloutDisconnectCleanupEvidence(integration Integration, summary FilloutWebhookCleanupSummary) *DisconnectCleanupEvidence {
	return leadDisconnectCleanupEvidence(integration, leadCleanupEvidenceInput{
		providerName:      "Fillout",
		cleanupKind:       "webhook",
		scopeType:         "fillout_form_id",
		scopeID:           settingString(integration.Settings, "form_id"),
		providerWebhookID: summary.WebhookID,
		endpoint:          summary.Endpoint,
		recordedAt:        summary.CleanedUpAt,
		deleted:           summary.Deleted,
		skipped:           summary.Skipped,
		skipReason:        summary.SkipReason,
		webhookSecretRef: firstString(
			settingString(integration.Settings, "webhook_secret_ref"),
			settingString(integration.Settings, "fillout_webhook_secret_ref"),
		),
	})
}

func jotformDisconnectCleanupEvidence(integration Integration, summary JotformWebhookCleanupSummary) *DisconnectCleanupEvidence {
	return leadDisconnectCleanupEvidence(integration, leadCleanupEvidenceInput{
		providerName:      "Jotform",
		cleanupKind:       "webhook",
		scopeType:         "jotform_form_id",
		scopeID:           settingString(integration.Settings, "form_id"),
		providerWebhookID: summary.WebhookID,
		endpoint:          summary.Endpoint,
		recordedAt:        summary.CleanedUpAt,
		deleted:           summary.Deleted,
		skipped:           summary.SkipReason != "",
		skipReason:        summary.SkipReason,
		webhookSecretRef: firstString(
			settingString(integration.Settings, "webhook_secret_ref"),
			settingString(integration.Settings, "jotform_webhook_secret_ref"),
		),
	})
}

func webflowDisconnectCleanupEvidence(integration Integration, summary WebflowWebhookCleanupSummary) *DisconnectCleanupEvidence {
	return leadDisconnectCleanupEvidence(integration, leadCleanupEvidenceInput{
		providerName:              "Webflow",
		cleanupKind:               "webhook",
		scopeType:                 "webflow_site_id",
		scopeID:                   firstString(settingString(integration.Settings, "site_id"), settingString(integration.Settings, "webflow_site_id"), settingString(integration.Settings, "provider_site_id")),
		providerWebhookID:         summary.WebhookID,
		previousProviderWebhookID: summary.PreviousWebhookID,
		endpoint:                  summary.Endpoint,
		recordedAt:                summary.CleanedUpAt,
		deleted:                   summary.Deleted,
		notFound:                  summary.NotFound,
		skipped:                   summary.Skipped,
		skipReason:                summary.SkipReason,
		cleanupReason:             summary.CleanupReason,
		webhookSecretRef: firstString(
			settingString(integration.Settings, "webhook_secret_ref"),
			settingString(integration.Settings, "webflow_webhook_secret_ref"),
		),
	})
}

func facebookLeadAdsDisconnectCleanupEvidence(integration Integration, summary FacebookLeadAdsPageSubscriptionCleanupSummary) *DisconnectCleanupEvidence {
	pageID := firstString(summary.PageID, settingString(integration.Settings, "page_id"))
	return leadDisconnectCleanupEvidence(integration, leadCleanupEvidenceInput{
		providerName: "Facebook Lead Ads",
		cleanupKind:  "page_subscription",
		scopeType:    "facebook_page_id",
		scopeID:      pageID,
		endpoint:     summary.Endpoint,
		recordedAt:   summary.CleanedUpAt,
		deleted:      summary.Deleted,
		skipped:      pageID == "",
		skipReason:   leadCleanupSkipReason(pageID == "", "missing_page_id"),
		fields:       summary.Fields,
		webhookSecretRef: firstString(
			settingString(integration.Settings, "webhook_secret_ref"),
			settingString(integration.Settings, "facebook_lead_ads_webhook_secret_ref"),
		),
	})
}

func googleLeadFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	customerID := firstString(settingString(integration.Settings, "customer_id"), settingString(integration.Settings, "google_ads_customer_id"))
	leadFormAssetID := settingString(integration.Settings, "lead_form_asset_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"customer_id", customerID},
		{"lead_form_asset_id", leadFormAssetID},
		{"campaign_id", settingString(integration.Settings, "campaign_id")},
		{"login_customer_id", settingString(integration.Settings, "login_customer_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "google_ads_lead_form_export",
		ProviderScopeType:       "google_ads_customer_id",
		ProviderScopeID:         customerID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Google Lead Form Extensions pulls exclude disconnected rows",
			"lead sync history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate Google Ads OAuth tokens if they are no longer used",
			"rotate or restrict Google Ads developer-token access if needed",
			"audit duplicate or manually configured lead form CRM export/webhook destinations",
			"confirm lead form asset permissions and data-delete evidence in the Google Ads account",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Google Lead Form Extensions integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or CRM export destination for this Search API slice",
			"Google Ads-side OAuth, developer-token, lead form asset, duplicate export, and data-delete cleanup remains operator-managed until live certification",
		},
	}
}

func tallyDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "tally_form_submission_pull",
		ProviderScopeType:       "tally_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Tally provider pulls exclude disconnected rows",
			"manual Tally sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Tally API token referenced by credentials_ref if it is no longer used",
			"review Tally form collaborators and API access granted for this Moosewave connection",
			"remove duplicate or manually configured Tally webhook, export, or automation destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Tally disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Tally integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Tally-side API-token rotation, form access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func poptinDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	popupID := settingString(integration.Settings, "popup_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"popup_id", popupID},
		{"popup_name", settingString(integration.Settings, "popup_name")},
		{"site_id", settingString(integration.Settings, "site_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(popupID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "poptin_webhook_receiver",
		ProviderScopeType:       "poptin_account_popup",
		ProviderScopeID:         firstString(scopeID, accountID, popupID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(poptinCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_poptin_webhook_integration",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Poptin webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Poptin Webhooks integration URL that points at the Moosewave public receiver",
			"rotate the Poptin route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Poptin Webhooks integrations outside Moosewave",
			"record Poptin-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Poptin integration disconnected before future webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Poptin-side Webhooks integration removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func helloBarDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	siteID := settingString(integration.Settings, "site_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_id", siteID},
		{"campaign_id", campaignID},
		{"bar_name", settingString(integration.Settings, "bar_name")},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"account_id", settingString(integration.Settings, "account_id")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(siteID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "hello_bar_webhook_receiver",
		ProviderScopeType:       "hello_bar_site_campaign",
		ProviderScopeID:         firstString(scopeID, siteID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(helloBarCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_hello_bar_webhook",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Hello Bar webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Hello Bar Webhook URL that points at the Moosewave public receiver",
			"rotate the Hello Bar route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Hello Bar webhook destinations outside Moosewave",
			"record Hello Bar-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Hello Bar integration disconnected before future webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Hello Bar-side Webhook removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func landingiDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	pageID := settingString(integration.Settings, "page_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"page_id", pageID},
		{"form_id", settingString(integration.Settings, "form_id")},
		{"page_name", settingString(integration.Settings, "page_name")},
		{"form_name", settingString(integration.Settings, "form_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(pageID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "landingi_webhook_receiver",
		ProviderScopeType:       "landingi_account_page",
		ProviderScopeID:         firstString(scopeID, accountID, pageID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(landingiCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_landingi_webhook",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Landingi webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Landingi Webhook integration URL that points at the Moosewave public receiver",
			"rotate the Landingi route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Landingi webhook integrations outside Moosewave",
			"record Landingi-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Landingi integration disconnected before future webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Landingi-side Webhook integration removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func kickoffLabsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"page_id", settingString(integration.Settings, "page_id")},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"page_name", settingString(integration.Settings, "page_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "kickofflabs_webhook_receiver",
		ProviderScopeType:       "kickofflabs_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(kickoffLabsCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_kickofflabs_outbound_webhook",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"KickoffLabs webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the KickoffLabs outbound webhook URL that points at the Moosewave public receiver",
			"rotate the KickoffLabs route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured KickoffLabs outbound webhook destinations outside Moosewave",
			"record KickoffLabs-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the KickoffLabs integration disconnected before future webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"KickoffLabs-side outbound webhook removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func ninjaFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	siteURL := settingString(integration.Settings, "site_url")
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_url", siteURL},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"wordpress_site_url", settingString(integration.Settings, "wordpress_site_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(siteURL)+"/"+strings.TrimSpace(formID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_wordpress_admin",
		ManagedProviderCleanup:  false,
		CleanupKind:             "ninja_forms_webhook_receiver",
		ProviderScopeType:       "ninja_forms_site_form",
		ProviderScopeID:         firstString(scopeID, siteURL, formID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(ninjaFormsCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_ninja_forms_webhook_action",
		CredentialCleanupStatus: "operator_rotate_route_token_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Ninja Forms webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Ninja Forms Webhooks action that points at the Moosewave public receiver",
			"rotate the Ninja Forms route token referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Ninja Forms Webhooks actions outside Moosewave",
			"record WordPress/Ninja Forms-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Ninja Forms integration disconnected before future webhook writes",
			"Moosewave owns the receiver, route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Ninja Forms-side Webhooks action removal, route-token rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func outgrowDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"calculator_id", settingString(integration.Settings, "calculator_id")},
		{"quiz_id", settingString(integration.Settings, "quiz_id")},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
		{"calculator_name", settingString(integration.Settings, "calculator_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "outgrow_webhook_receiver",
		ProviderScopeType:       "outgrow_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(outgrowCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_outgrow_webhook",
		CredentialCleanupStatus: "operator_rotate_route_or_basic_credentials_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Outgrow webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Outgrow webhook URL that points at the Moosewave public receiver",
			"rotate the Outgrow route token or Basic auth credentials referenced by credentials_ref if they are no longer used",
			"review duplicate or manually configured Outgrow webhook destinations outside Moosewave",
			"record Outgrow-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Outgrow integration disconnected before future webhook writes",
			"Moosewave owns the receiver, Basic-or-route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Outgrow-side webhook removal, credential rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func shortStackDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	campaignID := settingString(integration.Settings, "campaign_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"campaign_id", campaignID},
		{"form_id", settingString(integration.Settings, "form_id")},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"campaign_name", settingString(integration.Settings, "campaign_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(campaignID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "shortstack_webhook_receiver",
		ProviderScopeType:       "shortstack_account_campaign",
		ProviderScopeID:         firstString(scopeID, accountID, campaignID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(shortStackCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_shortstack_webhook_integration",
		CredentialCleanupStatus: "operator_rotate_webhook_secret_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"ShortStack webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the ShortStack Webhook form integration URL that points at the Moosewave public receiver",
			"rotate the ShortStack webhook secret key referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured ShortStack form integrations outside Moosewave",
			"record ShortStack-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the ShortStack integration disconnected before future webhook writes",
			"Moosewave owns the receiver, X-SS-Signature verification, idempotency, canonical lead import, and local disconnect guard",
			"ShortStack-side Webhook form integration removal, secret rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func riddleDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := settingString(integration.Settings, "account_id")
	quizID := settingString(integration.Settings, "quiz_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"account_id", accountID},
		{"quiz_id", quizID},
		{"campaign_id", settingString(integration.Settings, "campaign_id")},
		{"riddle_name", settingString(integration.Settings, "riddle_name")},
		{"quiz_name", settingString(integration.Settings, "quiz_name")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	scopeID := strings.Trim(strings.TrimSpace(accountID)+"/"+strings.TrimSpace(quizID), "/")
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "riddle_webhook_receiver",
		ProviderScopeType:       "riddle_account_quiz",
		ProviderScopeID:         firstString(scopeID, accountID, quizID),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: strings.TrimSpace(riddleCredentialRef(integration)) != "",
		WebhookCleanupStatus:    "operator_review_riddle_webhook",
		CredentialCleanupStatus: "operator_rotate_route_or_signature_credentials_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"Riddle webhook deliveries for disconnected rows fail closed before local writes",
			"lead webhook idempotency, sync history, and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"remove or disable the Riddle webhook URL that points at the Moosewave public receiver",
			"rotate the Riddle route token or signature key referenced by credentials_ref if it is no longer used",
			"review duplicate or manually configured Riddle webhook destinations outside Moosewave",
			"record Riddle-side cleanup evidence in the customer change ticket before considering the disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Riddle integration disconnected before future webhook writes",
			"Moosewave owns the receiver, signature-or-route-token verification, idempotency, canonical lead import, and local disconnect guard",
			"Riddle-side webhook removal, credential rotation, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func paperformDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "paperform_form_submission_pull",
		ProviderScopeType:       "paperform_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Paperform provider pulls exclude disconnected rows",
			"manual Paperform sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Paperform API key referenced by credentials_ref if it is no longer used",
			"review Paperform form collaborators and API access granted for this Moosewave connection",
			"remove duplicate or manually configured Paperform webhook, export, or automation destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Paperform disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Paperform integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Paperform-side API-key rotation, form access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func formstackDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "formstack_form_submission_pull",
		ProviderScopeType:       "formstack_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Formstack provider pulls exclude disconnected rows",
			"manual Formstack sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Formstack Personal Access Token referenced by credentials_ref if it is no longer used",
			"review Formstack form collaborators and API access granted for this Moosewave connection",
			"remove duplicate or manually configured Formstack webhook, export, or automation destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Formstack disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Formstack integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Formstack-side PAT rotation, form access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func formsiteDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := firstString(settingString(integration.Settings, "form_dir"), settingString(integration.Settings, "form_id"))
	userDir := firstString(settingString(integration.Settings, "user_dir"), settingString(integration.Settings, "account_id"))
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"user_dir", userDir},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "formsite_result_pull",
		ProviderScopeType:       "formsite_form_dir",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Formsite provider pulls exclude disconnected rows",
			"manual Formsite sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Formsite API access token referenced by credentials_ref if it is no longer used",
			"review Formsite account and form permissions granted for this Moosewave connection",
			"remove duplicate or manually configured Formsite webhooks, exports, or server posts outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Formsite disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Formsite integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST results puller slice",
			"Formsite-side token rotation, form access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func cognitoFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	viewID := firstString(settingString(integration.Settings, "view_id"), settingString(integration.Settings, "entry_view_id"))
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"organization_id", settingString(integration.Settings, "organization_id")},
		{"form_id", formID},
		{"view_id", viewID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"odata_base_url", settingString(integration.Settings, "odata_base_url")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "cognito_forms_odata_entry_pull",
		ProviderScopeType:       "cognito_forms_form_view",
		ProviderScopeID:         strings.Trim(strings.TrimSpace(formID)+"/"+strings.TrimSpace(viewID), "/"),
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Cognito Forms provider pulls exclude disconnected rows",
			"manual Cognito Forms sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Cognito Forms API key referenced by credentials_ref if it is no longer used",
			"review Cognito Forms integration scopes for Form:Read and Entry:Read access",
			"review the selected Cognito Forms grid view to confirm only intended fields remain exposed to Moosewave",
			"remove duplicate or manually configured Cognito Forms webhooks, OData consumers, exports, or automation destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Cognito Forms disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Cognito Forms integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this OData view-entry puller slice",
			"Cognito Forms-side API-key rotation, view/scope access review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func gravityFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_url", settingString(integration.Settings, "site_url")},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"status", settingString(integration.Settings, "status")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "gravity_forms_entry_pull",
		ProviderScopeType:       "gravity_forms_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Gravity Forms provider pulls exclude disconnected rows",
			"manual Gravity Forms sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the WordPress application password or Gravity Forms REST credentials referenced by credentials_ref if no longer used",
			"review Gravity Forms REST API enablement, form permissions, and WordPress user capability scope",
			"remove duplicate or manually configured Gravity Forms webhooks, feeds, exports, or notifications outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Gravity Forms disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Gravity Forms integration disconnected before future pulls",
			"Moosewave does not own a provider webhook, feed, or export destination for this REST entries puller slice",
			"WordPress/Gravity Forms credential revocation, REST API access review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func wpformsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_url", settingString(integration.Settings, "site_url")},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"status", settingString(integration.Settings, "status")},
		{"type", settingString(integration.Settings, "type")},
		{"date_from", settingString(integration.Settings, "date_from")},
		{"date_to", settingString(integration.Settings, "date_to")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "wpforms_entry_pull",
		ProviderScopeType:       "wpforms_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled WPForms provider pulls exclude disconnected rows",
			"manual WPForms sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the WordPress application password referenced by credentials_ref if no longer used",
			"review WordPress 6.9+, WPForms 1.9.9+ Pro entry access, and WPForms user capability scope",
			"remove duplicate or manually configured WPForms webhooks, exports, or third-party feeds outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the WPForms disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the WPForms integration disconnected before future pulls",
			"Moosewave does not own a provider webhook, export, or feed destination for this Abilities API entry-puller slice",
			"WordPress/WPForms credential revocation, plugin/version/license review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func formidableFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"site_url", settingString(integration.Settings, "site_url")},
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"plugin_namespace", settingString(integration.Settings, "plugin_namespace")},
		{"search", settingString(integration.Settings, "search")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "formidable_forms_entry_pull",
		ProviderScopeType:       "formidable_forms_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Formidable Forms provider pulls exclude disconnected rows",
			"manual Formidable Forms sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the WordPress application password or Formidable API key referenced by credentials_ref if no longer used",
			"review Formidable API add-on status, form permissions, and WordPress user capability scope",
			"remove duplicate or manually configured Formidable Forms webhooks, exports, API actions, or third-party feeds outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Formidable Forms disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Formidable Forms integration disconnected before future pulls",
			"Moosewave does not own a provider webhook, API action, export, or feed destination for this REST entries puller slice",
			"WordPress/Formidable credential revocation, plugin/license review, duplicate destination audit, and lead data-delete evidence remain operator-managed until live certification",
		},
	}
}

func featheryDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"workspace_id", settingString(integration.Settings, "workspace_id")},
		{"environment", settingString(integration.Settings, "environment")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"start_time", settingString(integration.Settings, "start_time")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "feathery_submission_pull",
		ProviderScopeType:       "feathery_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Feathery provider pulls exclude disconnected rows",
			"manual Feathery sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Feathery API key referenced by credentials_ref if it is no longer used",
			"review Feathery workspace, environment, and form access granted for this Moosewave connection",
			"remove duplicate or manually configured Feathery webhooks, exports, or destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Feathery disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Feathery integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST submissions puller slice",
			"Feathery-side API-key rotation, form access review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func formalooDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formSlug := firstString(settingString(integration.Settings, "form_slug"), settingString(integration.Settings, "form_id"))
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"workspace_id", settingString(integration.Settings, "workspace_id")},
		{"form_slug", settingString(integration.Settings, "form_slug")},
		{"form_id", settingString(integration.Settings, "form_id")},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"created_at_gte", settingString(integration.Settings, "created_at_gte")},
		{"updated_at_gte", settingString(integration.Settings, "updated_at_gte")},
		{"submit_time_gte", settingString(integration.Settings, "submit_time_gte")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CleanupKind:             "formaloo_rows_pull",
		ProviderScopeType:       "formaloo_form_slug",
		ProviderScopeID:         formSlug,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "operator_review_form_webhooks",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Formaloo provider pulls exclude disconnected rows",
			"manual Formaloo sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Formaloo API key, API secret, or authorization token referenced by credentials_ref if it is no longer used",
			"review Formaloo workspace and form access granted for this Moosewave connection",
			"remove duplicate or manually configured Formaloo webhooks, exports, or destinations outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Formaloo disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Formaloo integration disconnected before future pulls",
			"Moosewave does not own a provider webhook or export destination for this REST rows puller slice",
			"Formaloo-side API-key/API-secret/token rotation, form webhook cleanup, duplicate destination audit, reconnect proof, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

func googleFormsDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	formID := settingString(integration.Settings, "form_id")
	fields := []string{}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"form_id", formID},
		{"form_name", settingString(integration.Settings, "form_name")},
		{"api_base_url", settingString(integration.Settings, "api_base_url")},
		{"after_time", settingString(integration.Settings, "after_time")},
	} {
		if strings.TrimSpace(field.value) != "" {
			fields = append(fields, field.name+"="+strings.TrimSpace(field.value))
		}
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "provider_cleanup_operator_managed",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_google_workspace_drive",
		ManagedProviderCleanup:  false,
		CleanupKind:             "google_forms_response_pull",
		ProviderScopeType:       "google_forms_form_id",
		ProviderScopeID:         formID,
		Fields:                  fields,
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookCleanupStatus:    "provider_cleanup_not_applicable",
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled Google Forms provider pulls exclude disconnected rows",
			"manual Google Forms sync/backfill rejects disconnected rows before provider calls or local writes",
			"lead sync history and cursor audit evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Google OAuth token referenced by credentials_ref if it is no longer used",
			"review Google Forms and Drive sharing permissions granted for this Moosewave connection",
			"remove duplicate or manually configured Google Forms watches, Apps Script triggers, Sheets exports, or webhook bridges outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the Google Forms disconnect complete",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave marked the Google Forms integration disconnected before future pulls",
			"Moosewave does not own a provider watch channel, Apps Script trigger, linked Sheet, or webhook bridge for this REST responses puller slice",
			"Google-side OAuth revocation, form sharing review, duplicate destination audit, and data-delete evidence remain operator-managed until live certification",
		},
	}
}

type leadCleanupEvidenceInput struct {
	providerName              string
	cleanupKind               string
	scopeType                 string
	scopeID                   string
	providerWebhookID         string
	previousProviderWebhookID string
	endpoint                  string
	recordedAt                time.Time
	deleted                   bool
	notFound                  bool
	skipped                   bool
	skipReason                string
	cleanupReason             string
	fields                    []string
	webhookSecretRef          string
}

func leadDisconnectCleanupEvidence(integration Integration, in leadCleanupEvidenceInput) *DisconnectCleanupEvidence {
	recordedAt := in.recordedAt
	if recordedAt.IsZero() {
		recordedAt = time.Now().UTC()
	}
	return &DisconnectCleanupEvidence{
		Provider:                  integration.Provider,
		Status:                    leadCleanupStatus(in.deleted, in.notFound, in.skipped),
		RecordedAt:                recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:            "disconnected",
		ProviderCleanupPosture:    "postwave_managed_provider_api",
		ManagedProviderCleanup:    true,
		CleanupKind:               in.cleanupKind,
		ProviderScopeType:         in.scopeType,
		ProviderScopeID:           in.scopeID,
		ProviderWebhookID:         in.providerWebhookID,
		PreviousProviderWebhookID: in.previousProviderWebhookID,
		Endpoint:                  in.endpoint,
		Deleted:                   in.deleted,
		NotFound:                  in.notFound,
		Skipped:                   in.skipped,
		SkipReason:                in.skipReason,
		CleanupReason:             in.cleanupReason,
		Fields:                    append([]string(nil), in.fields...),
		CredentialRefPresent:      strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent:   strings.TrimSpace(in.webhookSecretRef) != "",
		WebhookCleanupStatus:      leadWebhookCleanupStatus(in.deleted, in.notFound, in.skipped),
		CredentialCleanupStatus:   "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local lead integration is marked disconnected",
			"scheduled " + in.providerName + " lead pulls exclude disconnected rows",
			"lead sync and webhook audit history is retained",
		},
		ProviderConsoleActions:  leadProviderConsoleActions(in),
		ProviderCleanupEvidence: leadProviderCleanupEvidence(in),
	}
}

func leadCleanupStatus(deleted, notFound, skipped bool) string {
	switch {
	case skipped:
		return "provider_cleanup_skipped"
	case deleted:
		return "provider_cleanup_completed"
	case notFound:
		return "provider_cleanup_already_absent"
	default:
		return "provider_cleanup_noop"
	}
}

func leadWebhookCleanupStatus(deleted, notFound, skipped bool) string {
	switch {
	case skipped:
		return "provider_cleanup_skipped"
	case deleted:
		return "provider_deleted"
	case notFound:
		return "provider_already_absent"
	default:
		return "provider_cleanup_not_required_or_missing_evidence"
	}
}

func leadProviderCleanupEvidence(in leadCleanupEvidenceInput) []string {
	action := "Moosewave called the " + in.providerName + " provider cleanup API before disconnect"
	if in.cleanupKind == "page_subscription" {
		action = "Moosewave called the Meta Page subscribed_apps cleanup API for leadgen before disconnect"
	}
	switch {
	case in.skipped:
		return []string{action, "provider cleanup did not run to completion: " + in.skipReason}
	case in.deleted:
		return []string{action, "provider reported the managed " + strings.ReplaceAll(in.cleanupKind, "_", " ") + " cleanup completed"}
	case in.notFound:
		return []string{action, "provider reported the managed " + strings.ReplaceAll(in.cleanupKind, "_", " ") + " was already absent"}
	default:
		return []string{action, "provider cleanup completed without a deletion confirmation"}
	}
}

func leadProviderConsoleActions(in leadCleanupEvidenceInput) []string {
	manualWebhookAction := "audit duplicate or manually configured " + in.providerName + " webhooks outside the Moosewave-managed " + strings.ReplaceAll(in.cleanupKind, "_", " ")
	switch in.providerName {
	case "Facebook Lead Ads":
		return []string{
			"revoke or rotate Meta Page, system-user, or OAuth tokens if they are no longer used",
			"audit duplicate or manually configured Meta CRM integrations and Page app subscriptions outside the Moosewave-managed leadgen subscription",
		}
	case "Webflow":
		return []string{
			"revoke or rotate Webflow OAuth or site API tokens if they are no longer used",
			"rotate Webflow webhook signing secrets if shared with other integrations",
			manualWebhookAction,
		}
	case "Typeform":
		return []string{
			"revoke or rotate Typeform personal or OAuth tokens if they are no longer used",
			manualWebhookAction,
		}
	case "Fillout":
		return []string{
			"revoke or rotate Fillout API keys if they are no longer used",
			manualWebhookAction,
		}
	case "Jotform":
		return []string{
			"revoke or rotate Jotform API keys if they are no longer used",
			manualWebhookAction,
		}
	default:
		return []string{
			"revoke or rotate provider credentials if they are no longer used",
			manualWebhookAction,
		}
	}
}

func leadCleanupSkipReason(skipped bool, reason string) string {
	if skipped {
		return reason
	}
	return ""
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

func (d *Deps) executeSync(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) SyncSummary {
	summary := SyncSummary{
		IntegrationID:   integration.ID,
		Status:          "completed",
		SubmissionsSeen: len(in.Submissions),
		Cursor:          in.Cursor,
	}
	for _, submission := range in.Submissions {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		if _, err := d.Profiles.UpsertLeadSubmission(ctx, tenantID, integration.Provider, submission); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.SubscribersUpserted++
		if d.Events == nil {
			continue
		}
		if _, err := d.Events.TrackLeadSubmission(ctx, tenantID, integration.Provider, submission); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 && summary.SubscribersUpserted == 0 && summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "lead-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "lead integration not found")
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

func (d *Deps) typeformBackfiller() TypeformBackfiller {
	if d == nil {
		return nil
	}
	if d.TypeformBackfiller != nil {
		return d.TypeformBackfiller
	}
	if d.TypeformCredentials != nil {
		return TypeformRESTBackfiller{Credentials: d.TypeformCredentials}
	}
	return nil
}

func (d *Deps) typeformCredentialResolver() TypeformCredentialResolver {
	if d == nil {
		return nil
	}
	return d.TypeformCredentials
}

func (d *Deps) surveyMonkeyBackfiller() SurveyMonkeyBackfiller {
	if d == nil {
		return nil
	}
	if d.SurveyMonkeyBackfiller != nil {
		return d.SurveyMonkeyBackfiller
	}
	if d.SurveyMonkeyCredentials != nil {
		return SurveyMonkeyRESTBackfiller{Credentials: d.SurveyMonkeyCredentials}
	}
	return nil
}

func (d *Deps) surveyMonkeyCredentialResolver() SurveyMonkeyCredentialResolver {
	if d == nil {
		return nil
	}
	return d.SurveyMonkeyCredentials
}

func (d *Deps) unbounceBackfiller() UnbounceBackfiller {
	if d == nil {
		return nil
	}
	if d.UnbounceBackfiller != nil {
		return d.UnbounceBackfiller
	}
	if d.UnbounceCredentials != nil {
		return UnbounceRESTBackfiller{Credentials: d.UnbounceCredentials}
	}
	return nil
}

func (d *Deps) unbounceCredentialResolver() UnbounceCredentialResolver {
	if d == nil {
		return nil
	}
	return d.UnbounceCredentials
}

func (d *Deps) leadpagesBackfiller() LeadpagesBackfiller {
	if d == nil {
		return nil
	}
	if d.LeadpagesBackfiller != nil {
		return d.LeadpagesBackfiller
	}
	if d.LeadpagesCredentials != nil {
		return LeadpagesRESTBackfiller{Credentials: d.LeadpagesCredentials}
	}
	return nil
}

func (d *Deps) leadpagesCredentialResolver() LeadpagesCredentialResolver {
	if d == nil {
		return nil
	}
	return d.LeadpagesCredentials
}

func (d *Deps) formBuilder123Backfiller() FormBuilder123Backfiller {
	if d == nil {
		return nil
	}
	if d.FormBuilder123Backfiller != nil {
		return d.FormBuilder123Backfiller
	}
	if d.FormBuilder123Credentials != nil {
		return FormBuilder123RESTBackfiller{Credentials: d.FormBuilder123Credentials}
	}
	return nil
}

func (d *Deps) formBuilder123CredentialResolver() FormBuilder123CredentialResolver {
	if d == nil {
		return nil
	}
	return d.FormBuilder123Credentials
}

func (d *Deps) instapageBackfiller() InstapageBackfiller {
	if d == nil {
		return nil
	}
	if d.InstapageBackfiller != nil {
		return d.InstapageBackfiller
	}
	if d.InstapageCredentials != nil {
		return InstapageRESTBackfiller{Credentials: d.InstapageCredentials}
	}
	return nil
}

func (d *Deps) instapageCredentialResolver() InstapageCredentialResolver {
	if d == nil {
		return nil
	}
	return d.InstapageCredentials
}

func (d *Deps) carrdCredentialResolver() CarrdCredentialResolver {
	if d == nil {
		return nil
	}
	return d.CarrdCredentials
}

func (d *Deps) optinMonsterCredentialResolver() OptinMonsterCredentialResolver {
	if d == nil {
		return nil
	}
	return d.OptinMonsterCredentials
}

func (d *Deps) privyCredentialResolver() PrivyCredentialResolver {
	if d == nil {
		return nil
	}
	return d.PrivyCredentials
}

func (d *Deps) convertFlowCredentialResolver() ConvertFlowCredentialResolver {
	if d == nil {
		return nil
	}
	return d.ConvertFlowCredentials
}

func (d *Deps) sleeknoteCredentialResolver() SleeknoteCredentialResolver {
	if d == nil {
		return nil
	}
	return d.SleeknoteCredentials
}

func (d *Deps) wisepopsCredentialResolver() WisepopsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.WisepopsCredentials
}

func (d *Deps) poptinCredentialResolver() PoptinCredentialResolver {
	if d == nil {
		return nil
	}
	return d.PoptinCredentials
}

func (d *Deps) helloBarCredentialResolver() HelloBarCredentialResolver {
	if d == nil {
		return nil
	}
	return d.HelloBarCredentials
}

func (d *Deps) landingiCredentialResolver() LandingiCredentialResolver {
	if d == nil {
		return nil
	}
	return d.LandingiCredentials
}

func (d *Deps) kickoffLabsCredentialResolver() KickoffLabsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.KickoffLabsCredentials
}

func (d *Deps) ninjaFormsCredentialResolver() NinjaFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.NinjaFormsCredentials
}

func (d *Deps) outgrowCredentialResolver() OutgrowCredentialResolver {
	if d == nil {
		return nil
	}
	return d.OutgrowCredentials
}

func (d *Deps) shortStackCredentialResolver() ShortStackCredentialResolver {
	if d == nil {
		return nil
	}
	return d.ShortStackCredentials
}

func (d *Deps) riddleCredentialResolver() RiddleCredentialResolver {
	if d == nil {
		return nil
	}
	return d.RiddleCredentials
}

func (d *Deps) reconcileTypeformWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookReconcileSummary, error) {
	registrar := d.TypeformWebhooks
	if registrar == nil {
		registrar = TypeformRESTWebhookRegistrar{Credentials: d.typeformCredentialResolver()}
	}
	return registrar.ReconcileWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupTypeformWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookCleanupSummary, error) {
	registrar := d.TypeformWebhooks
	if registrar == nil {
		registrar = TypeformRESTWebhookRegistrar{Credentials: d.typeformCredentialResolver()}
	}
	return registrar.CleanupWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) wixBackfiller() WixBackfiller {
	if d == nil {
		return nil
	}
	if d.WixBackfiller != nil {
		return d.WixBackfiller
	}
	if d.WixCredentials != nil {
		return WixRESTBackfiller{Credentials: d.WixCredentials}
	}
	return nil
}

func (d *Deps) wixCredentialResolver() WixCredentialResolver {
	if d == nil {
		return nil
	}
	return d.WixCredentials
}

func (d *Deps) jotformBackfiller() JotformBackfiller {
	if d == nil {
		return nil
	}
	if d.JotformBackfiller != nil {
		return d.JotformBackfiller
	}
	if d.JotformCredentials != nil {
		return JotformRESTBackfiller{Credentials: d.JotformCredentials}
	}
	return nil
}

func (d *Deps) jotformCredentialResolver() JotformCredentialResolver {
	if d == nil {
		return nil
	}
	return d.JotformCredentials
}

func (d *Deps) reconcileJotformWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookReconcileSummary, error) {
	registrar := d.JotformWebhooks
	if registrar == nil {
		registrar = JotformRESTWebhookRegistrar{Credentials: d.jotformCredentialResolver()}
	}
	return registrar.ReconcileWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupJotformWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookCleanupSummary, error) {
	registrar := d.JotformWebhooks
	if registrar == nil {
		registrar = JotformRESTWebhookRegistrar{Credentials: d.jotformCredentialResolver()}
	}
	return registrar.CleanupWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) webflowBackfiller() WebflowBackfiller {
	if d == nil {
		return nil
	}
	if d.WebflowBackfiller != nil {
		return d.WebflowBackfiller
	}
	if d.WebflowCredentials != nil {
		return WebflowRESTBackfiller{Credentials: d.WebflowCredentials}
	}
	return nil
}

func (d *Deps) webflowCredentialResolver() WebflowCredentialResolver {
	if d == nil {
		return nil
	}
	return d.WebflowCredentials
}

func (d *Deps) reconcileWebflowWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookReconcileSummary, error) {
	registrar := d.WebflowWebhooks
	if registrar == nil {
		registrar = WebflowRESTWebhookRegistrar{Credentials: d.webflowCredentialResolver()}
	}
	return registrar.ReconcileWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupWebflowWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookCleanupSummary, error) {
	registrar := d.WebflowWebhooks
	if registrar == nil {
		registrar = WebflowRESTWebhookRegistrar{Credentials: d.webflowCredentialResolver()}
	}
	return registrar.CleanupWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) filloutBackfiller() FilloutBackfiller {
	if d == nil {
		return nil
	}
	if d.FilloutBackfiller != nil {
		return d.FilloutBackfiller
	}
	if d.FilloutCredentials != nil {
		return FilloutRESTBackfiller{Credentials: d.FilloutCredentials}
	}
	return nil
}

func (d *Deps) filloutCredentialResolver() FilloutCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FilloutCredentials
}

func (d *Deps) paperformBackfiller() PaperformBackfiller {
	if d == nil {
		return nil
	}
	if d.PaperformBackfiller != nil {
		return d.PaperformBackfiller
	}
	if d.PaperformCredentials != nil {
		return PaperformRESTBackfiller{Credentials: d.PaperformCredentials}
	}
	return nil
}

func (d *Deps) paperformCredentialResolver() PaperformCredentialResolver {
	if d == nil {
		return nil
	}
	return d.PaperformCredentials
}

func (d *Deps) formstackBackfiller() FormstackBackfiller {
	if d == nil {
		return nil
	}
	if d.FormstackBackfiller != nil {
		return d.FormstackBackfiller
	}
	if d.FormstackCredentials != nil {
		return FormstackRESTBackfiller{Credentials: d.FormstackCredentials}
	}
	return nil
}

func (d *Deps) formstackCredentialResolver() FormstackCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FormstackCredentials
}

func (d *Deps) formsiteBackfiller() FormsiteBackfiller {
	if d == nil {
		return nil
	}
	if d.FormsiteBackfiller != nil {
		return d.FormsiteBackfiller
	}
	if d.FormsiteCredentials != nil {
		return FormsiteRESTBackfiller{Credentials: d.FormsiteCredentials}
	}
	return nil
}

func (d *Deps) formsiteCredentialResolver() FormsiteCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FormsiteCredentials
}

func (d *Deps) cognitoFormsBackfiller() CognitoFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.CognitoFormsBackfiller != nil {
		return d.CognitoFormsBackfiller
	}
	if d.CognitoFormsCredentials != nil {
		return CognitoFormsRESTBackfiller{Credentials: d.CognitoFormsCredentials}
	}
	return nil
}

func (d *Deps) cognitoFormsCredentialResolver() CognitoFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.CognitoFormsCredentials
}

func (d *Deps) gravityFormsBackfiller() GravityFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.GravityFormsBackfiller != nil {
		return d.GravityFormsBackfiller
	}
	if d.GravityFormsCredentials != nil {
		return GravityFormsRESTBackfiller{Credentials: d.GravityFormsCredentials}
	}
	return nil
}

func (d *Deps) gravityFormsCredentialResolver() GravityFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.GravityFormsCredentials
}

func (d *Deps) wpformsBackfiller() WPFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.WPFormsBackfiller != nil {
		return d.WPFormsBackfiller
	}
	if d.WPFormsCredentials != nil {
		return WPFormsRESTBackfiller{Credentials: d.WPFormsCredentials}
	}
	return nil
}

func (d *Deps) wpformsCredentialResolver() WPFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.WPFormsCredentials
}

func (d *Deps) formidableFormsBackfiller() FormidableFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.FormidableFormsBackfiller != nil {
		return d.FormidableFormsBackfiller
	}
	if d.FormidableFormsCredentials != nil {
		return FormidableFormsRESTBackfiller{Credentials: d.FormidableFormsCredentials}
	}
	return nil
}

func (d *Deps) formidableFormsCredentialResolver() FormidableFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FormidableFormsCredentials
}

func (d *Deps) featheryBackfiller() FeatheryBackfiller {
	if d == nil {
		return nil
	}
	if d.FeatheryBackfiller != nil {
		return d.FeatheryBackfiller
	}
	if d.FeatheryCredentials != nil {
		return FeatheryRESTBackfiller{Credentials: d.FeatheryCredentials}
	}
	return nil
}

func (d *Deps) featheryCredentialResolver() FeatheryCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FeatheryCredentials
}

func (d *Deps) formalooBackfiller() FormalooBackfiller {
	if d == nil {
		return nil
	}
	if d.FormalooBackfiller != nil {
		return d.FormalooBackfiller
	}
	if d.FormalooCredentials != nil {
		return FormalooRESTBackfiller{Credentials: d.FormalooCredentials}
	}
	return nil
}

func (d *Deps) formalooCredentialResolver() FormalooCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FormalooCredentials
}

func (d *Deps) tallyBackfiller() TallyBackfiller {
	if d == nil {
		return nil
	}
	if d.TallyBackfiller != nil {
		return d.TallyBackfiller
	}
	if d.TallyCredentials != nil {
		return TallyRESTBackfiller{Credentials: d.TallyCredentials}
	}
	return nil
}

func (d *Deps) tallyCredentialResolver() TallyCredentialResolver {
	if d == nil {
		return nil
	}
	return d.TallyCredentials
}

func (d *Deps) googleFormsBackfiller() GoogleFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.GoogleFormsBackfiller != nil {
		return d.GoogleFormsBackfiller
	}
	if d.GoogleFormsCredentials != nil {
		return GoogleFormsRESTBackfiller{Credentials: d.GoogleFormsCredentials}
	}
	return nil
}

func (d *Deps) googleFormsCredentialResolver() GoogleFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.GoogleFormsCredentials
}

func (d *Deps) facebookLeadAdsBackfiller() FacebookLeadAdsBackfiller {
	if d == nil {
		return nil
	}
	if d.FacebookLeadAdsBackfiller != nil {
		return d.FacebookLeadAdsBackfiller
	}
	if d.FacebookLeadAdsCredentials != nil {
		return FacebookLeadAdsRESTBackfiller{Credentials: d.FacebookLeadAdsCredentials}
	}
	return nil
}

func (d *Deps) facebookLeadAdsCredentialResolver() FacebookLeadAdsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.FacebookLeadAdsCredentials
}

func (d *Deps) facebookLeadAdsPageSubscriptionRegistrar() FacebookLeadAdsPageSubscriptionRegistrar {
	if d == nil {
		return nil
	}
	if d.FacebookLeadAdsPageSubscriptions != nil {
		return d.FacebookLeadAdsPageSubscriptions
	}
	if d.FacebookLeadAdsCredentials != nil {
		return FacebookLeadAdsRESTPageSubscriptionRegistrar{Credentials: d.FacebookLeadAdsCredentials}
	}
	return nil
}

func (d *Deps) reconcileFacebookLeadAdsPageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionSummary, error) {
	registrar := d.facebookLeadAdsPageSubscriptionRegistrar()
	if registrar == nil {
		return FacebookLeadAdsPageSubscriptionSummary{}, fmt.Errorf("facebook lead ads page subscription registrar is not configured")
	}
	return registrar.ReconcilePageSubscription(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupFacebookLeadAdsPageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionCleanupSummary, error) {
	registrar := d.facebookLeadAdsPageSubscriptionRegistrar()
	if registrar == nil {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{}, fmt.Errorf("facebook lead ads page subscription registrar is not configured")
	}
	return registrar.CleanupPageSubscription(ctx, integration, appBaseURL)
}

func (d *Deps) googleLeadFormsBackfiller() GoogleLeadFormsBackfiller {
	if d == nil {
		return nil
	}
	if d.GoogleLeadFormsBackfiller != nil {
		return d.GoogleLeadFormsBackfiller
	}
	if d.GoogleLeadFormsCredentials != nil {
		return GoogleLeadFormsRESTBackfiller{Credentials: d.GoogleLeadFormsCredentials}
	}
	return nil
}

func (d *Deps) googleLeadFormsCredentialResolver() GoogleLeadFormsCredentialResolver {
	if d == nil {
		return nil
	}
	return d.GoogleLeadFormsCredentials
}

func (d *Deps) reconcileFilloutWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookReconcileSummary, error) {
	registrar := d.FilloutWebhooks
	if registrar == nil {
		registrar = FilloutRESTWebhookRegistrar{Credentials: d.filloutCredentialResolver()}
	}
	return registrar.ReconcileWebhook(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupFilloutWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookCleanupSummary, error) {
	registrar := d.FilloutWebhooks
	if registrar == nil {
		registrar = FilloutRESTWebhookRegistrar{Credentials: d.filloutCredentialResolver()}
	}
	return registrar.CleanupWebhook(ctx, integration, appBaseURL)
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
