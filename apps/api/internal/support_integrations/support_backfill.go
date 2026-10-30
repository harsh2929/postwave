// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	zendeskRetryCursorPrefix           = "zendesk_retry:"
	intercomRetryCursorPrefix          = "intercom_retry:"
	helpScoutRetryCursorPrefix         = "help_scout_retry:"
	gorgiasRetryCursorPrefix           = "gorgias_retry:"
	freshdeskRetryCursorPrefix         = "freshdesk_retry:"
	freshchatRetryCursorPrefix         = "freshchat_retry:"
	tidioRetryCursorPrefix             = "tidio_retry:"
	adaRetryCursorPrefix               = "ada_retry:"
	gladlyRetryCursorPrefix            = "gladly_retry:"
	grooveRetryCursorPrefix            = "groove_retry:"
	helpCrunchRetryCursorPrefix        = "helpcrunch_retry:"
	jiraServiceRetryCursorPrefix       = "jira_service_management_retry:"
	linearRetryCursorPrefix            = "linear_retry:"
	asanaSupportRetryCursorPrefix      = "asana_support_retry:"
	clickUpSupportRetryCursorPrefix    = "clickup_support_retry:"
	frontRetryCursorPrefix             = "front_retry:"
	reamazeRetryCursorPrefix           = "reamaze_retry:"
	crispRetryCursorPrefix             = "crisp_retry:"
	kustomerRetryCursorPrefix          = "kustomer_retry:"
	driftRetryCursorPrefix             = "drift_retry:"
	liveChatRetryCursorPrefix          = "livechat_retry:"
	zohoDeskRetryCursorPrefix          = "zoho_desk_retry:"
	olarkRetryCursorPrefix             = "olark_retry:"
	kayakoRetryCursorPrefix            = "kayako_retry:"
	hubSpotRetryCursorPrefix           = "hubspot_service_hub_retry:"
	salesforceServiceRetryCursorPrefix = "salesforce_service_cloud_retry:"
	supportBulkBackfillMaxPages        = 10
	supportRetryInitialDelay           = 15 * time.Minute
	supportRetryMaxDelay               = 6 * time.Hour
)

var errIntegrationDisconnected = errors.New("support integration is disconnected")

type SupportProviderBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type supportBackfillProviderConfig struct {
	Provider       string
	DisplayName    string
	RetryPrefix    string
	CompleteCursor string
	DecodeCursor   func(string) string
}

type supportRetryState struct {
	Cursor         string `json:"cursor"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type SupportBulkBackfillRunner struct {
	Deps       *Deps
	Provider   string
	Backfiller SupportProviderBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SupportBulkBackfillSummary struct {
	Provider          string `json:"provider"`
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	TicketsSeen       int    `json:"tickets_seen"`
	TicketsUpserted   int    `json:"tickets_upserted"`
	MessagesSeen      int    `json:"messages_seen"`
	MessagesUpserted  int    `json:"messages_upserted"`
	ProfilesUpserted  int    `json:"profiles_upserted"`
	EventsSeen        int    `json:"events_seen"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r SupportBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SupportBulkBackfillSummary, error) {
	cfg, err := supportBackfillConfig(r.Provider)
	if err != nil {
		return SupportBulkBackfillSummary{}, err
	}
	if r.Deps == nil || r.Deps.Repo == nil {
		return SupportBulkBackfillSummary{}, fmt.Errorf("%s bulk backfill deps are required", cfg.DisplayName)
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = supportBackfillerForProvider(r.Deps, cfg.Provider)
	}
	if backfiller == nil {
		return SupportBulkBackfillSummary{}, fmt.Errorf("%s bulk backfiller is required", cfg.DisplayName)
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SupportBulkBackfillSummary{}, err
	}
	if integration == nil {
		return SupportBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != cfg.Provider {
		return SupportBulkBackfillSummary{}, fmt.Errorf("%s bulk backfill requires a %s integration", cfg.DisplayName, cfg.DisplayName)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SupportBulkBackfillSummary{Provider: cfg.Provider, IntegrationID: integration.ID, Cursor: cursor}
	if supportIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeSupportRetryCursor(cfg, cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !supportRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := supportBackfillRetryCursor(cfg, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		started := r.now()
		pageSummary := r.Deps.executeSync(ctx, tenantID, integration, req)
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := supportBackfillRetryCursor(cfg, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if supportSyncRequestHasRows(req) {
			summary.Pages++
		}
		summary.TicketsSeen += pageSummary.TicketsSeen
		summary.TicketsUpserted += pageSummary.TicketsUpserted
		summary.MessagesSeen += pageSummary.MessagesSeen
		summary.MessagesUpserted += pageSummary.MessagesUpserted
		summary.ProfilesUpserted += pageSummary.ProfilesUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if req.StopAfterPage {
			return summary, nil
		}
		if !supportSyncRequestHasRows(req) {
			if cursor == cfg.CompleteCursor {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SupportBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{
		IntegrationID: integrationID,
		Status:        "failed",
		Cursor:        cursor,
		ErrorMessage:  syncErr.Error(),
	}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r SupportBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return supportBulkBackfillMaxPages
	}
	return r.MaxPages
}

func (r SupportBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func supportSyncRequestHasRows(req SyncRequest) bool {
	return len(req.Tickets)+len(req.Messages)+len(req.Events) > 0
}

func supportIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func supportBackfillerForProvider(deps *Deps, provider string) SupportProviderBackfiller {
	if deps == nil {
		return nil
	}
	switch provider {
	case ProviderZendesk:
		return deps.ZendeskBackfiller
	case ProviderIntercom:
		return deps.IntercomBackfiller
	case ProviderHelpScout:
		return deps.HelpScoutBackfiller
	case ProviderGorgias:
		return deps.GorgiasBackfiller
	case ProviderFreshdesk:
		return deps.FreshdeskBackfiller
	case ProviderFreshchat:
		return deps.FreshchatBackfiller
	case ProviderTidio:
		return deps.TidioBackfiller
	case ProviderAda:
		return deps.AdaBackfiller
	case ProviderGladly:
		return deps.GladlyBackfiller
	case ProviderGroove:
		return deps.GrooveBackfiller
	case ProviderHelpCrunch:
		return deps.HelpCrunchBackfiller
	case ProviderJiraServiceManagement:
		return deps.JiraServiceManagementBackfiller
	case ProviderLinear:
		return deps.LinearBackfiller
	case ProviderAsanaSupport:
		return deps.AsanaSupportBackfiller
	case ProviderClickUpSupport:
		return deps.ClickUpSupportBackfiller
	case ProviderFront:
		return deps.FrontBackfiller
	case ProviderReamaze:
		return deps.ReamazeBackfiller
	case ProviderCrisp:
		return deps.CrispBackfiller
	case ProviderKustomer:
		return deps.KustomerBackfiller
	case ProviderDrift:
		return deps.DriftBackfiller
	case ProviderLiveChat:
		return deps.LiveChatBackfiller
	case ProviderZohoDesk:
		return deps.ZohoDeskBackfiller
	case ProviderOlark:
		return deps.OlarkBackfiller
	case ProviderKayako:
		return deps.KayakoBackfiller
	case ProviderHubSpotServiceHub:
		return deps.HubSpotServiceHubBackfiller
	case ProviderSalesforceServiceCloud:
		return deps.SalesforceServiceCloudBackfiller
	default:
		return nil
	}
}

func supportBackfillConfig(provider string) (supportBackfillProviderConfig, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderZendesk:
		return supportBackfillProviderConfig{
			Provider:       ProviderZendesk,
			DisplayName:    "Zendesk",
			RetryPrefix:    zendeskRetryCursorPrefix,
			CompleteCursor: zendeskCursorComplete,
			DecodeCursor:   decodeZendeskCursor,
		}, nil
	case ProviderIntercom:
		return supportBackfillProviderConfig{
			Provider:       ProviderIntercom,
			DisplayName:    "Intercom",
			RetryPrefix:    intercomRetryCursorPrefix,
			CompleteCursor: intercomCursorComplete,
			DecodeCursor:   decodeIntercomCursor,
		}, nil
	case ProviderHelpScout:
		return supportBackfillProviderConfig{
			Provider:       ProviderHelpScout,
			DisplayName:    "Help Scout",
			RetryPrefix:    helpScoutRetryCursorPrefix,
			CompleteCursor: helpScoutCursorComplete,
			DecodeCursor:   decodeHelpScoutCursor,
		}, nil
	case ProviderGorgias:
		return supportBackfillProviderConfig{
			Provider:       ProviderGorgias,
			DisplayName:    "Gorgias",
			RetryPrefix:    gorgiasRetryCursorPrefix,
			CompleteCursor: gorgiasCursorComplete,
			DecodeCursor:   decodeGorgiasCursor,
		}, nil
	case ProviderFreshdesk:
		return supportBackfillProviderConfig{
			Provider:       ProviderFreshdesk,
			DisplayName:    "Freshdesk",
			RetryPrefix:    freshdeskRetryCursorPrefix,
			CompleteCursor: freshdeskCursorComplete,
			DecodeCursor:   decodeFreshdeskCursor,
		}, nil
	case ProviderFreshchat:
		return supportBackfillProviderConfig{
			Provider:       ProviderFreshchat,
			DisplayName:    "Freshchat",
			RetryPrefix:    freshchatRetryCursorPrefix,
			CompleteCursor: freshchatCursorComplete,
			DecodeCursor:   decodeFreshchatCursor,
		}, nil
	case ProviderTidio:
		return supportBackfillProviderConfig{
			Provider:       ProviderTidio,
			DisplayName:    "Tidio",
			RetryPrefix:    tidioRetryCursorPrefix,
			CompleteCursor: tidioCursorComplete,
			DecodeCursor:   decodeTidioCursor,
		}, nil
	case ProviderAda:
		return supportBackfillProviderConfig{
			Provider:       ProviderAda,
			DisplayName:    "Ada",
			RetryPrefix:    adaRetryCursorPrefix,
			CompleteCursor: adaCursorComplete,
			DecodeCursor:   decodeAdaCursor,
		}, nil
	case ProviderGladly:
		return supportBackfillProviderConfig{
			Provider:       ProviderGladly,
			DisplayName:    "Gladly",
			RetryPrefix:    gladlyRetryCursorPrefix,
			CompleteCursor: gladlyCursorComplete,
			DecodeCursor:   decodeGladlyCursor,
		}, nil
	case ProviderGroove:
		return supportBackfillProviderConfig{
			Provider:       ProviderGroove,
			DisplayName:    "Groove",
			RetryPrefix:    grooveRetryCursorPrefix,
			CompleteCursor: grooveCursorComplete,
			DecodeCursor:   decodeGrooveCursor,
		}, nil
	case ProviderHelpCrunch:
		return supportBackfillProviderConfig{
			Provider:       ProviderHelpCrunch,
			DisplayName:    "HelpCrunch",
			RetryPrefix:    helpCrunchRetryCursorPrefix,
			CompleteCursor: helpCrunchCursorComplete,
			DecodeCursor:   decodeHelpCrunchCursor,
		}, nil
	case ProviderJiraServiceManagement:
		return supportBackfillProviderConfig{
			Provider:       ProviderJiraServiceManagement,
			DisplayName:    "Jira Service Management",
			RetryPrefix:    jiraServiceRetryCursorPrefix,
			CompleteCursor: jiraServiceCursorComplete,
			DecodeCursor:   decodeJiraServiceManagementCursor,
		}, nil
	case ProviderLinear:
		return supportBackfillProviderConfig{
			Provider:       ProviderLinear,
			DisplayName:    "Linear",
			RetryPrefix:    linearRetryCursorPrefix,
			CompleteCursor: linearCursorComplete,
			DecodeCursor:   decodeLinearCursor,
		}, nil
	case ProviderAsanaSupport:
		return supportBackfillProviderConfig{
			Provider:       ProviderAsanaSupport,
			DisplayName:    "Asana Support",
			RetryPrefix:    asanaSupportRetryCursorPrefix,
			CompleteCursor: asanaCursorComplete,
			DecodeCursor:   decodeAsanaSupportCursor,
		}, nil
	case ProviderClickUpSupport:
		return supportBackfillProviderConfig{
			Provider:       ProviderClickUpSupport,
			DisplayName:    "ClickUp Support",
			RetryPrefix:    clickUpSupportRetryCursorPrefix,
			CompleteCursor: clickUpCursorComplete,
			DecodeCursor:   decodeClickUpSupportCursor,
		}, nil
	case ProviderFront:
		return supportBackfillProviderConfig{
			Provider:       ProviderFront,
			DisplayName:    "Front",
			RetryPrefix:    frontRetryCursorPrefix,
			CompleteCursor: frontCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(frontCursorPrefix, frontCursorComplete),
		}, nil
	case ProviderReamaze:
		return supportBackfillProviderConfig{
			Provider:       ProviderReamaze,
			DisplayName:    "Reamaze",
			RetryPrefix:    reamazeRetryCursorPrefix,
			CompleteCursor: reamazeCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(reamazeCursorPrefix, reamazeCursorComplete),
		}, nil
	case ProviderCrisp:
		return supportBackfillProviderConfig{
			Provider:       ProviderCrisp,
			DisplayName:    "Crisp",
			RetryPrefix:    crispRetryCursorPrefix,
			CompleteCursor: crispCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(crispCursorPrefix, crispCursorComplete),
		}, nil
	case ProviderKustomer:
		return supportBackfillProviderConfig{
			Provider:       ProviderKustomer,
			DisplayName:    "Kustomer",
			RetryPrefix:    kustomerRetryCursorPrefix,
			CompleteCursor: kustomerCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(kustomerCursorPrefix, kustomerCursorComplete),
		}, nil
	case ProviderDrift:
		return supportBackfillProviderConfig{
			Provider:       ProviderDrift,
			DisplayName:    "Drift",
			RetryPrefix:    driftRetryCursorPrefix,
			CompleteCursor: driftCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(driftCursorPrefix, driftCursorComplete),
		}, nil
	case ProviderLiveChat:
		return supportBackfillProviderConfig{
			Provider:       ProviderLiveChat,
			DisplayName:    "LiveChat",
			RetryPrefix:    liveChatRetryCursorPrefix,
			CompleteCursor: liveChatCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(liveChatCursorPrefix, liveChatCursorComplete),
		}, nil
	case ProviderZohoDesk:
		return supportBackfillProviderConfig{
			Provider:       ProviderZohoDesk,
			DisplayName:    "Zoho Desk",
			RetryPrefix:    zohoDeskRetryCursorPrefix,
			CompleteCursor: zohoDeskCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(zohoDeskCursorPrefix, zohoDeskCursorComplete),
		}, nil
	case ProviderOlark:
		return supportBackfillProviderConfig{
			Provider:       ProviderOlark,
			DisplayName:    "Olark",
			RetryPrefix:    olarkRetryCursorPrefix,
			CompleteCursor: olarkCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(olarkCursorPrefix, olarkCursorComplete),
		}, nil
	case ProviderKayako:
		return supportBackfillProviderConfig{
			Provider:       ProviderKayako,
			DisplayName:    "Kayako",
			RetryPrefix:    kayakoRetryCursorPrefix,
			CompleteCursor: kayakoCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(kayakoCursorPrefix, kayakoCursorComplete),
		}, nil
	case ProviderHubSpotServiceHub:
		return supportBackfillProviderConfig{
			Provider:       ProviderHubSpotServiceHub,
			DisplayName:    "HubSpot Service Hub",
			RetryPrefix:    hubSpotRetryCursorPrefix,
			CompleteCursor: hubSpotServiceCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(hubSpotServiceCursorPrefix, hubSpotServiceCursorComplete),
		}, nil
	case ProviderSalesforceServiceCloud:
		return supportBackfillProviderConfig{
			Provider:       ProviderSalesforceServiceCloud,
			DisplayName:    "Salesforce Service Cloud",
			RetryPrefix:    salesforceServiceRetryCursorPrefix,
			CompleteCursor: salesforceServiceCursorComplete,
			DecodeCursor:   prefixedSupportCursorDecoder(salesforceServiceCursorPrefix, salesforceServiceCursorComplete),
		}, nil
	default:
		return supportBackfillProviderConfig{}, fmt.Errorf("support scheduled backfill is not configured for provider %q", provider)
	}
}

func prefixedSupportCursorDecoder(prefix, complete string) func(string) string {
	return func(cursor string) string {
		cursor = strings.TrimSpace(cursor)
		if cursor == "" || cursor == complete {
			return complete
		}
		return strings.TrimSpace(strings.TrimPrefix(cursor, prefix))
	}
}

func decodeZendeskRetryCursor(cursor string) (supportRetryState, bool, error) {
	cfg, _ := supportBackfillConfig(ProviderZendesk)
	return decodeSupportRetryCursor(cfg, cursor)
}

func decodeIntercomRetryCursor(cursor string) (supportRetryState, bool, error) {
	cfg, _ := supportBackfillConfig(ProviderIntercom)
	return decodeSupportRetryCursor(cfg, cursor)
}

func decodeHelpScoutRetryCursor(cursor string) (supportRetryState, bool, error) {
	cfg, _ := supportBackfillConfig(ProviderHelpScout)
	return decodeSupportRetryCursor(cfg, cursor)
}

func decodeGorgiasRetryCursor(cursor string) (supportRetryState, bool, error) {
	cfg, _ := supportBackfillConfig(ProviderGorgias)
	return decodeSupportRetryCursor(cfg, cursor)
}

func decodeFreshdeskRetryCursor(cursor string) (supportRetryState, bool, error) {
	cfg, _ := supportBackfillConfig(ProviderFreshdesk)
	return decodeSupportRetryCursor(cfg, cursor)
}

func decodeSupportRetryCursor(cfg supportBackfillProviderConfig, cursor string) (supportRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, cfg.RetryPrefix) {
		return supportRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, cfg.RetryPrefix))
	if err != nil {
		return supportRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", cfg.DisplayName, err)
	}
	var state supportRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return supportRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", cfg.DisplayName, err)
	}
	state = normalizeSupportRetryState(cfg, state)
	return state, true, nil
}

func encodeSupportRetryCursor(cfg supportBackfillProviderConfig, state supportRetryState) string {
	state = normalizeSupportRetryState(cfg, state)
	raw, _ := json.Marshal(state)
	return cfg.RetryPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeSupportRetryState(cfg supportBackfillProviderConfig, state supportRetryState) supportRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" && cfg.DecodeCursor != nil {
		if providerCursor := cfg.DecodeCursor(state.Cursor); providerCursor != cfg.CompleteCursor {
			state.ProviderCursor = strings.TrimSpace(providerCursor)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = supportTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func supportRetryCursorDue(state supportRetryState, now time.Time) bool {
	next := strings.TrimSpace(state.NextAttemptAt)
	if next == "" {
		return true
	}
	at, err := time.Parse(time.RFC3339, next)
	if err != nil {
		return true
	}
	return !at.After(now.UTC())
}

func supportBackfillRetryCursor(cfg supportBackfillProviderConfig, cursor, status string, retryErr error, now time.Time) string {
	state := supportRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSupportRetryCursor(cfg, cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if state.LastStatus == "" {
		state.LastStatus = "ERROR"
	}
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	state.NextAttemptAt = now.UTC().Add(supportRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSupportRetryCursor(cfg, state)
}

func supportRetryDelay(attempt int, err error) time.Duration {
	var zendeskErr ZendeskRESTError
	if err != nil && errors.As(err, &zendeskErr) && zendeskErr.RetryAfter > 0 {
		return minSupportRetryDelay(zendeskErr.RetryAfter)
	}
	var gorgiasErr GorgiasRESTError
	if err != nil && errors.As(err, &gorgiasErr) && gorgiasErr.RetryAfter > 0 {
		return minSupportRetryDelay(gorgiasErr.RetryAfter)
	}
	var intercomErr IntercomRESTError
	if err != nil && errors.As(err, &intercomErr) && intercomErr.RetryAfter > 0 {
		return minSupportRetryDelay(intercomErr.RetryAfter)
	}
	var helpScoutErr HelpScoutRESTError
	if err != nil && errors.As(err, &helpScoutErr) && helpScoutErr.RetryAfter > 0 {
		return minSupportRetryDelay(helpScoutErr.RetryAfter)
	}
	var freshdeskErr FreshdeskRESTError
	if err != nil && errors.As(err, &freshdeskErr) && freshdeskErr.RetryAfter > 0 {
		return minSupportRetryDelay(freshdeskErr.RetryAfter)
	}
	var freshchatErr FreshchatRESTError
	if err != nil && errors.As(err, &freshchatErr) && freshchatErr.RetryAfter > 0 {
		return minSupportRetryDelay(freshchatErr.RetryAfter)
	}
	var tidioErr TidioRESTError
	if err != nil && errors.As(err, &tidioErr) && tidioErr.RetryAfter > 0 {
		return minSupportRetryDelay(tidioErr.RetryAfter)
	}
	var adaErr AdaRESTError
	if err != nil && errors.As(err, &adaErr) && adaErr.RetryAfter > 0 {
		return minSupportRetryDelay(adaErr.RetryAfter)
	}
	var gladlyErr GladlyRESTError
	if err != nil && errors.As(err, &gladlyErr) && gladlyErr.RetryAfter > 0 {
		return minSupportRetryDelay(gladlyErr.RetryAfter)
	}
	var grooveErr GrooveRESTError
	if err != nil && errors.As(err, &grooveErr) && grooveErr.RetryAfter > 0 {
		return minSupportRetryDelay(grooveErr.RetryAfter)
	}
	var helpCrunchErr HelpCrunchRESTError
	if err != nil && errors.As(err, &helpCrunchErr) && helpCrunchErr.RetryAfter > 0 {
		return minSupportRetryDelay(helpCrunchErr.RetryAfter)
	}
	var jiraServiceErr JiraServiceManagementRESTError
	if err != nil && errors.As(err, &jiraServiceErr) && jiraServiceErr.RetryAfter > 0 {
		return minSupportRetryDelay(jiraServiceErr.RetryAfter)
	}
	var linearErr LinearRESTError
	if err != nil && errors.As(err, &linearErr) && linearErr.RetryAfter > 0 {
		return minSupportRetryDelay(linearErr.RetryAfter)
	}
	var asanaErr AsanaSupportRESTError
	if err != nil && errors.As(err, &asanaErr) && asanaErr.RetryAfter > 0 {
		return minSupportRetryDelay(asanaErr.RetryAfter)
	}
	var clickUpErr ClickUpSupportRESTError
	if err != nil && errors.As(err, &clickUpErr) && clickUpErr.RetryAfter > 0 {
		return minSupportRetryDelay(clickUpErr.RetryAfter)
	}
	var frontErr FrontRESTError
	if err != nil && errors.As(err, &frontErr) && frontErr.RetryAfter > 0 {
		return minSupportRetryDelay(frontErr.RetryAfter)
	}
	var reamazeErr ReamazeRESTError
	if err != nil && errors.As(err, &reamazeErr) && reamazeErr.RetryAfter > 0 {
		return minSupportRetryDelay(reamazeErr.RetryAfter)
	}
	var crispErr CrispRESTError
	if err != nil && errors.As(err, &crispErr) && crispErr.RetryAfter > 0 {
		return minSupportRetryDelay(crispErr.RetryAfter)
	}
	var kustomerErr KustomerRESTError
	if err != nil && errors.As(err, &kustomerErr) && kustomerErr.RetryAfter > 0 {
		return minSupportRetryDelay(kustomerErr.RetryAfter)
	}
	var driftErr DriftRESTError
	if err != nil && errors.As(err, &driftErr) && driftErr.RetryAfter > 0 {
		return minSupportRetryDelay(driftErr.RetryAfter)
	}
	var liveChatErr LiveChatRESTError
	if err != nil && errors.As(err, &liveChatErr) && liveChatErr.RetryAfter > 0 {
		return minSupportRetryDelay(liveChatErr.RetryAfter)
	}
	var zohoDeskErr ZohoDeskRESTError
	if err != nil && errors.As(err, &zohoDeskErr) && zohoDeskErr.RetryAfter > 0 {
		return minSupportRetryDelay(zohoDeskErr.RetryAfter)
	}
	var olarkErr OlarkRESTError
	if err != nil && errors.As(err, &olarkErr) && olarkErr.RetryAfter > 0 {
		return minSupportRetryDelay(olarkErr.RetryAfter)
	}
	var kayakoErr KayakoRESTError
	if err != nil && errors.As(err, &kayakoErr) && kayakoErr.RetryAfter > 0 {
		return minSupportRetryDelay(kayakoErr.RetryAfter)
	}
	var hubSpotServiceErr HubSpotServiceHubRESTError
	if err != nil && errors.As(err, &hubSpotServiceErr) && hubSpotServiceErr.RetryAfter > 0 {
		return minSupportRetryDelay(hubSpotServiceErr.RetryAfter)
	}
	var salesforceServiceErr SalesforceServiceCloudRESTError
	if err != nil && errors.As(err, &salesforceServiceErr) && salesforceServiceErr.RetryAfter > 0 {
		return minSupportRetryDelay(salesforceServiceErr.RetryAfter)
	}
	if attempt <= 1 {
		return supportRetryInitialDelay
	}
	delay := supportRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= supportRetryMaxDelay {
			return supportRetryMaxDelay
		}
	}
	return delay
}

func minSupportRetryDelay(delay time.Duration) time.Duration {
	if delay > supportRetryMaxDelay {
		return supportRetryMaxDelay
	}
	return delay
}

func supportTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
