// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	migrateadapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	klaviyomigrate "github.com/postwave/migrate/klaviyo"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	klaviyoNativeCursorPrefix  = "klaviyo_native:"
	klaviyoNativeCursorVersion = 1
	klaviyoNativeCursorType    = "native_json_api_provider_row"
	klaviyoNativeSyncModel     = "klaviyo_native_provider_row_json_api_profiles_source_events_signed_webhooks_managed_subscription_scheduled"
	klaviyoNativeVerification  = "klaviyo_credential_ref_native_json_api_profiles_source_events"
)

type KlaviyoCredentials struct {
	APIKey         string
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	APIBaseURL     string
	OAuthBaseURL   string
	TokenURL       string
	RevokeURL      string
	UserAgent      string
	Scope          string
	AccountID      string
	TokenExpiresAt *time.Time
}

type KlaviyoRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type KlaviyoCredentialResolver interface {
	ResolveKlaviyo(context.Context, string, Integration) (KlaviyoCredentials, error)
}

const klaviyoStoredCredentialPrefix = "marketing:klaviyo:"

type KlaviyoCredentialStore interface {
	GetKlaviyoCredentialSecret(context.Context, string, string) (string, error)
	PutKlaviyoCredentialSecret(context.Context, string, string, KlaviyoCredentials) error
}

type KlaviyoCredentialDeleter interface {
	DeleteKlaviyoCredentialSecret(context.Context, string, string) error
}

type KlaviyoSecretsCredentialResolver struct {
	Secrets     KlaviyoRuntimeSecretResolver
	Store       KlaviyoCredentialStore
	OAuthClient KlaviyoOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewKlaviyoSecretsCredentialResolver(secrets KlaviyoRuntimeSecretResolver) *KlaviyoSecretsCredentialResolver {
	return &KlaviyoSecretsCredentialResolver{Secrets: secrets}
}

func klaviyoIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), klaviyoStoredCredentialPrefix)
}

func (r *KlaviyoSecretsCredentialResolver) ResolveKlaviyo(ctx context.Context, tenantID string, integration Integration) (KlaviyoCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return KlaviyoCredentials{}, fmt.Errorf("klaviyo credential resolver is not configured")
	}
	ref := klaviyoCredentialRef(integration)
	if ref == "" {
		return KlaviyoCredentials{}, fmt.Errorf("klaviyo credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return KlaviyoCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.OAuthBaseURL == "" {
		creds.OAuthBaseURL = settingString(integration.Settings, "oauth_base_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	if creds.AccountID == "" {
		creds.AccountID = firstString(settingString(integration.Settings, "account_id"), settingString(integration.Settings, "klaviyo_account_id"))
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *KlaviyoSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (KlaviyoCredentials, error) {
	if r.Store != nil && klaviyoIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetKlaviyoCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseKlaviyoCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return KlaviyoCredentials{}, fmt.Errorf("resolve stored klaviyo credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return KlaviyoCredentials{}, fmt.Errorf("klaviyo credential secret resolver is not configured")
	}
	var payload klaviyoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return KlaviyoCredentials{}, fmt.Errorf("resolve klaviyo credentials %q: %w", ref, err)
		}
		return parseKlaviyoCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return KlaviyoCredentials{}, fmt.Errorf("resolve klaviyo credentials %q: %w", ref, err)
	}
	return parseKlaviyoCredentialSecret(raw)
}

func (r *KlaviyoSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds KlaviyoCredentials) (KlaviyoCredentials, error) {
	if strings.TrimSpace(creds.RefreshToken) == "" || strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" || creds.TokenExpiresAt == nil {
		return creds, nil
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	skew := r.RefreshSkew
	if skew <= 0 {
		skew = 5 * time.Minute
	}
	if now.Before(creds.TokenExpiresAt.Add(-skew)) {
		return creds, nil
	}
	client := r.OAuthClient
	if client.Now == nil && r.Now != nil {
		client.Now = r.Now
	}
	token, err := client.RefreshAccessToken(ctx, creds)
	if err != nil {
		return KlaviyoCredentials{}, fmt.Errorf("refresh klaviyo OAuth token: %w", err)
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	if r.Store != nil && klaviyoIsStoredCredentialRef(ref) {
		if err := r.Store.PutKlaviyoCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return KlaviyoCredentials{}, fmt.Errorf("persist refreshed klaviyo OAuth token: %w", err)
		}
	}
	return creds, nil
}

type klaviyoCredentialPayload struct {
	APIKey         string `json:"api_key"`
	PrivateAPIKey  string `json:"private_api_key"`
	KlaviyoAPIKey  string `json:"klaviyo_api_key"`
	KlaviyoPrivate string `json:"klaviyo_private_api_key"`
	Token          string `json:"token"`
	AccessToken    string `json:"access_token,omitempty"`
	OAuthToken     string `json:"oauth_access_token,omitempty"`
	BearerToken    string `json:"bearer_token,omitempty"`
	RefreshToken   string `json:"refresh_token,omitempty"`
	ClientID       string `json:"client_id,omitempty"`
	ClientSecret   string `json:"client_secret,omitempty"`
	APIBaseURL     string `json:"api_base_url"`
	BaseURL        string `json:"base_url"`
	OAuthBaseURL   string `json:"oauth_base_url,omitempty"`
	TokenURL       string `json:"token_url,omitempty"`
	RevokeURL      string `json:"revoke_url,omitempty"`
	UserAgent      string `json:"user_agent,omitempty"`
	Scope          string `json:"scope,omitempty"`
	AccountID      string `json:"account_id,omitempty"`
	ExpiresAt      string `json:"expires_at,omitempty"`
}

func (p klaviyoCredentialPayload) credentials() (KlaviyoCredentials, error) {
	oauthToken := normalizeKlaviyoBearerToken(firstString(p.OAuthToken, p.AccessToken, p.BearerToken))
	key := normalizeKlaviyoAPIKey(firstString(p.APIKey, p.PrivateAPIKey, p.KlaviyoAPIKey, p.KlaviyoPrivate, p.Token))
	if oauthToken == "" && key == "" {
		return KlaviyoCredentials{}, fmt.Errorf("klaviyo api_key or OAuth access_token is required")
	}
	creds := KlaviyoCredentials{
		APIKey:       key,
		AccessToken:  oauthToken,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		APIBaseURL:   strings.TrimRight(firstString(p.APIBaseURL, p.BaseURL), "/"),
		OAuthBaseURL: strings.TrimRight(strings.TrimSpace(p.OAuthBaseURL), "/"),
		TokenURL:     strings.TrimSpace(p.TokenURL),
		RevokeURL:    strings.TrimSpace(p.RevokeURL),
		UserAgent:    strings.TrimSpace(p.UserAgent),
		Scope:        strings.TrimSpace(p.Scope),
		AccountID:    strings.TrimSpace(p.AccountID),
	}
	if expires := strings.TrimSpace(p.ExpiresAt); expires != "" {
		if at, err := time.Parse(time.RFC3339, expires); err == nil {
			utc := at.UTC()
			creds.TokenExpiresAt = &utc
		}
	}
	return creds, nil
}

func klaviyoStoredCredentialJSON(creds KlaviyoCredentials) string {
	payload := klaviyoCredentialPayload{
		APIKey:       strings.TrimSpace(creds.APIKey),
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"),
		OAuthBaseURL: strings.TrimRight(strings.TrimSpace(creds.OAuthBaseURL), "/"),
		TokenURL:     strings.TrimSpace(creds.TokenURL),
		RevokeURL:    strings.TrimSpace(creds.RevokeURL),
		UserAgent:    strings.TrimSpace(creds.UserAgent),
		Scope:        strings.TrimSpace(creds.Scope),
		AccountID:    strings.TrimSpace(creds.AccountID),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseKlaviyoCredentialSecret(raw string) (KlaviyoCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return KlaviyoCredentials{}, fmt.Errorf("klaviyo credentials are empty")
	}
	var payload klaviyoCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return KlaviyoCredentials{}, fmt.Errorf("parse klaviyo credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "\n") {
		for _, line := range strings.Split(raw, "\n") {
			parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
			if len(parts) != 2 {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(parts[0])) {
			case "api_key", "private_api_key", "klaviyo_api_key", "klaviyo_private_api_key", "token":
				payload.APIKey = strings.TrimSpace(parts[1])
			case "access_token", "oauth_access_token", "bearer_token":
				payload.AccessToken = strings.TrimSpace(parts[1])
			case "refresh_token":
				payload.RefreshToken = strings.TrimSpace(parts[1])
			case "client_id":
				payload.ClientID = strings.TrimSpace(parts[1])
			case "client_secret":
				payload.ClientSecret = strings.TrimSpace(parts[1])
			case "api_base_url", "base_url":
				payload.APIBaseURL = strings.TrimSpace(parts[1])
			case "oauth_base_url":
				payload.OAuthBaseURL = strings.TrimSpace(parts[1])
			case "token_url":
				payload.TokenURL = strings.TrimSpace(parts[1])
			case "revoke_url":
				payload.RevokeURL = strings.TrimSpace(parts[1])
			case "user_agent":
				payload.UserAgent = strings.TrimSpace(parts[1])
			case "scope":
				payload.Scope = strings.TrimSpace(parts[1])
			case "account_id", "klaviyo_account_id":
				payload.AccountID = strings.TrimSpace(parts[1])
			case "expires_at":
				payload.ExpiresAt = strings.TrimSpace(parts[1])
			}
		}
		return payload.credentials()
	}
	return klaviyoCredentialPayload{APIKey: raw}.credentials()
}

func normalizeKlaviyoAPIKey(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "Klaviyo-API-Key ")
	raw = strings.TrimPrefix(raw, "klaviyo-api-key ")
	raw = strings.TrimPrefix(raw, "Bearer ")
	raw = strings.TrimPrefix(raw, "bearer ")
	return strings.TrimSpace(raw)
}

func normalizeKlaviyoBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "Bearer ")
	raw = strings.TrimPrefix(raw, "bearer ")
	return strings.TrimSpace(raw)
}

func (c KlaviyoCredentials) AuthorizationHeader() (string, error) {
	if token := normalizeKlaviyoBearerToken(c.AccessToken); token != "" {
		return "Bearer " + token, nil
	}
	if key := normalizeKlaviyoAPIKey(c.APIKey); key != "" {
		return "Klaviyo-API-Key " + key, nil
	}
	return "", fmt.Errorf("klaviyo credentials require api_key or OAuth access_token")
}

func klaviyoCredentialAuthScheme(creds KlaviyoCredentials) string {
	if normalizeKlaviyoBearerToken(creds.AccessToken) != "" {
		return "bearer"
	}
	return "private_api_key"
}

func klaviyoCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

type KlaviyoSourceAdapter interface {
	Authenticate(context.Context, migrateadapter.Credentials) (migrateadapter.Session, error)
	ListSubscribers(context.Context, migrateadapter.Session, string) ([]canonical.Subscriber, string, error)
	ListSegments(context.Context, migrateadapter.Session) ([]canonical.Segment, error)
	ListSourceEvents(context.Context, migrateadapter.Session, time.Time, string, int) (canonical.SourceEventBatch, error)
}

type KlaviyoProviderPuller interface {
	Pull(context.Context, string, Integration, SyncRequest, int) (SyncSummary, error)
}

type KlaviyoNativePuller struct {
	Credentials KlaviyoCredentialResolver
	NewAdapter  func() KlaviyoSourceAdapter
	Now         func() time.Time
}

type klaviyoNativeCursor struct {
	Version                  int    `json:"version"`
	Provider                 string `json:"provider"`
	CursorType               string `json:"cursor_type"`
	RunMode                  string `json:"run_mode,omitempty"`
	Phase                    string `json:"phase,omitempty"`
	ProfileCursor            string `json:"profile_cursor,omitempty"`
	SourceEventCursor        string `json:"source_event_cursor,omitempty"`
	SourceEventHighWatermark string `json:"source_event_high_watermark,omitempty"`
	Revision                 string `json:"revision,omitempty"`
	Attempt                  int    `json:"attempt,omitempty"`
	PreviousCursor           string `json:"previous_cursor,omitempty"`
	GeneratedAt              string `json:"generated_at,omitempty"`
}

func (p *KlaviyoNativePuller) Pull(ctx context.Context, tenantID string, integration Integration, in SyncRequest, maxRows int) (SyncSummary, error) {
	if p == nil {
		return SyncSummary{}, fmt.Errorf("klaviyo native puller is not configured")
	}
	if integration.Provider != ProviderKlaviyo {
		return SyncSummary{}, fmt.Errorf("klaviyo native puller received provider %q", integration.Provider)
	}
	if p.Credentials == nil {
		return SyncSummary{}, fmt.Errorf("klaviyo credential resolver is not configured")
	}
	if maxRows <= 0 {
		maxRows = 100
	}
	creds, err := p.Credentials.ResolveKlaviyo(ctx, tenantID, integration)
	if err != nil {
		return SyncSummary{}, err
	}
	adapter := p.adapter(creds)
	sess, err := adapter.Authenticate(ctx, migrateadapter.Credentials{
		APIKey:       creds.APIKey,
		AccessToken:  creds.AccessToken,
		RefreshToken: creds.RefreshToken,
		Extra: map[string]string{
			"auth_scheme":    klaviyoCredentialAuthScheme(creds),
			"account_id":     creds.AccountID,
			"oauth_scope":    creds.Scope,
			"api_base_url":   creds.APIBaseURL,
			"oauth_base_url": creds.OAuthBaseURL,
		},
	})
	if err != nil {
		return SyncSummary{}, err
	}
	state := p.initialCursorState(integration, in)
	switch in.RunMode {
	case "backfill":
		return p.pullBackfill(ctx, adapter, sess, integration, in, state, maxRows)
	case "dry_run":
		return p.pullDryRun(ctx, adapter, sess, integration, in, state)
	default:
		return p.pullSourceEvents(ctx, adapter, sess, integration, in, state, maxRows)
	}
}

func (p *KlaviyoNativePuller) pullBackfill(ctx context.Context, adapter KlaviyoSourceAdapter, sess migrateadapter.Session, integration Integration, in SyncRequest, state klaviyoNativeCursor, maxRows int) (SyncSummary, error) {
	profilesSeen := 0
	nextCursor := state.ProfileCursor
	for {
		profiles, next, err := adapter.ListSubscribers(ctx, sess, nextCursor)
		if err != nil {
			return SyncSummary{}, err
		}
		profilesSeen += len(profiles)
		nextCursor = next
		if nextCursor == "" || profilesSeen >= maxRows {
			break
		}
	}
	segments, err := adapter.ListSegments(ctx, sess)
	if err != nil {
		return SyncSummary{}, err
	}
	state.RunMode = in.RunMode
	state.Phase = "profiles"
	state.ProfileCursor = nextCursor
	if nextCursor == "" {
		state.Phase = "profiles_complete"
	}
	state.GeneratedAt = p.now().Format(time.RFC3339)
	return p.completedSummary(integration, in, state, profilesSeen, 0, len(segments)), nil
}

func (p *KlaviyoNativePuller) pullSourceEvents(ctx context.Context, adapter KlaviyoSourceAdapter, sess migrateadapter.Session, integration Integration, in SyncRequest, state klaviyoNativeCursor, maxRows int) (SyncSummary, error) {
	since := parseKlaviyoNativeTime(state.SourceEventHighWatermark)
	batch, err := adapter.ListSourceEvents(ctx, sess, since, state.SourceEventCursor, maxRows)
	if err != nil {
		return SyncSummary{}, err
	}
	profilesSeen := 0
	for _, event := range batch.Events {
		if event.Subscriber != nil {
			profilesSeen++
		}
	}
	state.RunMode = in.RunMode
	state.Phase = "source_events"
	state.SourceEventCursor = batch.NextCursor
	if !batch.HighWatermark.IsZero() {
		state.SourceEventHighWatermark = batch.HighWatermark.UTC().Format(time.RFC3339Nano)
	}
	if batch.NextCursor == "" {
		state.Phase = "source_events_checkpoint"
	}
	state.GeneratedAt = p.now().Format(time.RFC3339)
	return p.completedSummary(integration, in, state, profilesSeen, len(batch.Events), 0), nil
}

func (p *KlaviyoNativePuller) pullDryRun(_ context.Context, _ KlaviyoSourceAdapter, _ migrateadapter.Session, integration Integration, in SyncRequest, state klaviyoNativeCursor) (SyncSummary, error) {
	state.RunMode = in.RunMode
	state.Phase = "authenticated"
	state.GeneratedAt = p.now().Format(time.RFC3339)
	summary := p.completedSummary(integration, in, state, 0, 0, 0)
	summary.Metadata["dry_run"] = true
	return summary, nil
}

func (p *KlaviyoNativePuller) completedSummary(integration Integration, in SyncRequest, state klaviyoNativeCursor, profilesSeen, eventsSeen, listsSeen int) SyncSummary {
	metadata := cloneMap(in.Metadata)
	metadata["provider"] = ProviderKlaviyo
	metadata["sync_model"] = klaviyoNativeSyncModel
	metadata["verification_mode"] = klaviyoNativeVerification
	metadata["native_provider_row"] = true
	metadata["native_klaviyo_pull"] = true
	metadata["provider_row_scheduler_ready"] = true
	metadata["cursor_type"] = klaviyoNativeCursorType
	metadata["phase"] = state.Phase
	if state.ProfileCursor != "" {
		metadata["profile_cursor"] = state.ProfileCursor
	}
	if state.SourceEventCursor != "" {
		metadata["source_event_cursor"] = state.SourceEventCursor
	}
	if state.SourceEventHighWatermark != "" {
		metadata["source_event_high_watermark"] = state.SourceEventHighWatermark
	}
	return SyncSummary{
		IntegrationID: integration.ID,
		Status:        "completed",
		ProfilesSeen:  profilesSeen,
		EventsSeen:    eventsSeen,
		ListsSeen:     listsSeen,
		Cursor:        encodeKlaviyoNativeCursor(state),
		Metadata:      metadata,
	}
}

func (p *KlaviyoNativePuller) adapter(creds KlaviyoCredentials) KlaviyoSourceAdapter {
	if p.NewAdapter != nil {
		return p.NewAdapter()
	}
	adapter := klaviyomigrate.New()
	if creds.APIBaseURL != "" {
		adapter.BaseURL = creds.APIBaseURL
	}
	return adapter
}

func (p *KlaviyoNativePuller) initialCursorState(integration Integration, in SyncRequest) klaviyoNativeCursor {
	state := klaviyoNativeCursor{
		Version:    klaviyoNativeCursorVersion,
		Provider:   ProviderKlaviyo,
		CursorType: klaviyoNativeCursorType,
		RunMode:    firstString(in.RunMode, "manual"),
		Revision:   firstString(settingString(integration.Settings, "revision"), settingString(integration.Settings, "api_revision"), klaviyoDefaultAPIRevision),
		Attempt:    1,
	}
	mergeKlaviyoNativeCursor(&state, klaviyoNativeCursorFromRaw(integration.SyncCursor, integration, in), false)
	mergeKlaviyoNativeCursor(&state, klaviyoNativeCursorFromSettings(integration.Settings), true)
	requested := strings.TrimSpace(in.Cursor)
	if requested != "" {
		if decoded, ok := decodeKlaviyoNativeCursor(requested); ok {
			mergeKlaviyoNativeCursor(&state, decoded, true)
		} else if handoff, ok := decodeKlaviyoDelegatedHandoffCursor(requested); ok {
			mergeKlaviyoNativeCursor(&state, klaviyoNativeCursorFromHandoff(handoff), true)
		} else if in.RunMode == "backfill" {
			state.ProfileCursor = requested
		} else {
			state.SourceEventCursor = requested
		}
	}
	mergeKlaviyoNativeCursor(&state, klaviyoNativeCursorFromMetadata(in.Metadata), true)
	if in.RunMode == "retry" {
		state.Attempt++
	}
	return state
}

func klaviyoNativeCursorFromRaw(raw string, integration Integration, in SyncRequest) klaviyoNativeCursor {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return klaviyoNativeCursor{}
	}
	if decoded, ok := decodeKlaviyoNativeCursor(raw); ok {
		return decoded
	}
	if handoff, ok := decodeKlaviyoDelegatedHandoffCursor(raw); ok {
		return klaviyoNativeCursorFromHandoff(handoff)
	}
	return klaviyoNativeCursor{PreviousCursor: truncateCursorEvidence(raw), Revision: firstString(settingString(integration.Settings, "revision"), anyString(in.Metadata["revision"]))}
}

func klaviyoNativeCursorFromHandoff(handoff klaviyoDelegatedHandoffCursor) klaviyoNativeCursor {
	return klaviyoNativeCursor{
		Version:                  klaviyoNativeCursorVersion,
		Provider:                 ProviderKlaviyo,
		CursorType:               klaviyoNativeCursorType,
		RunMode:                  handoff.RunMode,
		ProfileCursor:            handoff.ImportCursor,
		SourceEventCursor:        handoff.SourceEventCursor,
		SourceEventHighWatermark: handoff.SourceEventHighWatermark,
		Revision:                 firstString(handoff.Revision, klaviyoDefaultAPIRevision),
		Attempt:                  handoff.Attempt,
		PreviousCursor:           firstString(handoff.PreviousCursor, handoff.ImportCursor, handoff.SourceEventCursor),
	}
}

func klaviyoNativeCursorFromSettings(settings map[string]any) klaviyoNativeCursor {
	return klaviyoNativeCursor{
		ProfileCursor:            firstString(settingString(settings, "profile_cursor"), settingString(settings, "import_cursor")),
		SourceEventCursor:        settingString(settings, "source_event_cursor"),
		SourceEventHighWatermark: firstString(settingString(settings, "source_event_high_watermark"), settingString(settings, "high_watermark")),
		Revision:                 firstString(settingString(settings, "revision"), settingString(settings, "api_revision")),
	}
}

func klaviyoNativeCursorFromMetadata(metadata map[string]any) klaviyoNativeCursor {
	return klaviyoNativeCursor{
		ProfileCursor:            firstString(anyString(metadata["profile_cursor"]), anyString(metadata["import_cursor"])),
		SourceEventCursor:        anyString(metadata["source_event_cursor"]),
		SourceEventHighWatermark: firstString(anyString(metadata["source_event_high_watermark"]), anyString(metadata["high_watermark"])),
		Revision:                 firstString(anyString(metadata["revision"]), anyString(metadata["api_revision"])),
	}
}

func mergeKlaviyoNativeCursor(dst *klaviyoNativeCursor, src klaviyoNativeCursor, overwrite bool) {
	if dst == nil {
		return
	}
	setHandoffString(&dst.Provider, src.Provider, overwrite)
	setHandoffString(&dst.CursorType, src.CursorType, overwrite)
	setHandoffString(&dst.RunMode, src.RunMode, overwrite)
	setHandoffString(&dst.Phase, src.Phase, overwrite)
	setHandoffString(&dst.ProfileCursor, src.ProfileCursor, overwrite)
	setHandoffString(&dst.SourceEventCursor, src.SourceEventCursor, overwrite)
	setHandoffString(&dst.SourceEventHighWatermark, src.SourceEventHighWatermark, overwrite)
	setHandoffString(&dst.Revision, src.Revision, overwrite)
	setHandoffString(&dst.PreviousCursor, src.PreviousCursor, overwrite)
	setHandoffInt(&dst.Attempt, src.Attempt, overwrite)
	if src.Version > 0 && (overwrite || dst.Version == 0) {
		dst.Version = src.Version
	}
}

func encodeKlaviyoNativeCursor(state klaviyoNativeCursor) string {
	if state.Provider == "" {
		state.Provider = ProviderKlaviyo
	}
	if state.CursorType == "" {
		state.CursorType = klaviyoNativeCursorType
	}
	if state.Version == 0 {
		state.Version = klaviyoNativeCursorVersion
	}
	raw, _ := json.Marshal(state)
	return klaviyoNativeCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func decodeKlaviyoNativeCursor(raw string) (klaviyoNativeCursor, bool) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, klaviyoNativeCursorPrefix) {
		return klaviyoNativeCursor{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, klaviyoNativeCursorPrefix))
	if err != nil {
		return klaviyoNativeCursor{}, false
	}
	var out klaviyoNativeCursor
	if err := json.Unmarshal(decoded, &out); err != nil {
		return klaviyoNativeCursor{}, false
	}
	if out.Provider != "" && out.Provider != ProviderKlaviyo {
		return klaviyoNativeCursor{}, false
	}
	return out, true
}

func klaviyoNativeCursorHasMore(raw string) bool {
	state, ok := decodeKlaviyoNativeCursor(raw)
	if !ok {
		return strings.TrimSpace(raw) != ""
	}
	switch state.Phase {
	case "profiles":
		return state.ProfileCursor != ""
	case "source_events":
		return state.SourceEventCursor != ""
	default:
		return false
	}
}

func parseKlaviyoNativeTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if out, err := time.Parse(layout, raw); err == nil {
			return out.UTC()
		}
	}
	return time.Time{}
}

func (p *KlaviyoNativePuller) now() time.Time {
	if p != nil && p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
}
