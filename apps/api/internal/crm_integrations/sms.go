// SPDX-License-Identifier: AGPL-3.0-only
//
// sms.go — native Postscript + Attentive SMS contact-source pullers.
//
// Postscript and Attentive are the two dominant Shopify SMS platforms. Pulling
// their subscriber lists (phone + email + name) into Moosewave profiles enables
// cross-channel (email <-> SMS) segmentation. Both authenticate with a durable
// bearer API key, so they reuse the static-token recipe (crm_static.go helpers)
// and land canonical ContactInput rows dispatched via providerManagedSyncRequest.
//
// Identity note: SMS subscribers can be phone-first. Postscript and Attentive
// contacts therefore use the CRM sink's phone-aware identify path when a phone
// is present, while email-bearing rows still merge onto the same identity.
package crm_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ---------------- Postscript ----------------

const (
	postscriptDefaultAPIBaseURL = "https://api.postscript.io/api/v2"
	postscriptDefaultUserAgent  = "Moosewave Postscript Integration"
	postscriptDefaultPageSize   = 100
	postscriptMaxPageSize       = 500
	postscriptCursorPrefix      = "postscript:"
	postscriptCursorComplete    = "postscript:complete"
)

type PostscriptCredentials struct {
	APIKey              string
	APIBaseURL          string
	UserAgent           string
	WebhookSigningToken string
}

type PostscriptCredentialResolver interface {
	ResolvePostscript(context.Context, string, Integration) (PostscriptCredentials, error)
}

type postscriptCredentialPayload struct {
	APIKey              string `json:"api_key"`
	Token               string `json:"token"`
	APIBaseURL          string `json:"api_base_url"`
	UserAgent           string `json:"user_agent"`
	WebhookSigningToken string `json:"webhook_signing_token"`
	WebhookSignature    string `json:"webhook_signature"`
	WebhookToken        string `json:"webhook_token"`
	SigningToken        string `json:"signing_token"`
}

func (p postscriptCredentialPayload) credentials() (PostscriptCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return PostscriptCredentials{}, fmt.Errorf("postscript api_key is required")
	}
	return PostscriptCredentials{
		APIKey:              key,
		APIBaseURL:          strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:           strings.TrimSpace(p.UserAgent),
		WebhookSigningToken: strings.TrimSpace(firstString(p.WebhookSigningToken, p.WebhookSignature, p.WebhookToken, p.SigningToken)),
	}, nil
}

type PostscriptSecretsCredentialResolver struct {
	Secrets CRMStaticSecretResolver
}

func NewPostscriptSecretsCredentialResolver(secrets CRMStaticSecretResolver) *PostscriptSecretsCredentialResolver {
	return &PostscriptSecretsCredentialResolver{Secrets: secrets}
}

func (r *PostscriptSecretsCredentialResolver) ResolvePostscript(ctx context.Context, _ string, integration Integration) (PostscriptCredentials, error) {
	if r == nil || r.Secrets == nil {
		return PostscriptCredentials{}, fmt.Errorf("postscript credential resolver is not configured")
	}
	ref := crmStaticCredentialRef(integration)
	if ref == "" {
		return PostscriptCredentials{}, fmt.Errorf("postscript credentials_ref is required")
	}
	var payload postscriptCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return smsBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PostscriptCredentials{}, fmt.Errorf("resolve postscript credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return smsBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := postscriptCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return PostscriptCredentials{}, err
	}
	return smsBaseURL(creds, integration), nil
}

func smsBaseURL(creds PostscriptCredentials, integration Integration) PostscriptCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type PostscriptBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type PostscriptRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PostscriptCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type postscriptSubscriber struct {
	ID          string `json:"id"`
	PhoneNumber string `json:"phone_number"`
	Email       string `json:"email"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
}

func (b PostscriptRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPostscript {
		return SyncRequest{}, fmt.Errorf("postscript backfill requires a Postscript integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("postscript credential resolver is not configured")
	}
	state := smsDecodeCursor(cursor, postscriptCursorPrefix, postscriptCursorComplete)
	if state == postscriptCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: postscriptCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolvePostscript(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderPostscript)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), postscriptDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), postscriptDefaultPageSize, postscriptMaxPageSize)))
	if state != "" {
		query.Set("cursor", state)
	}
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIKey)}

	var out struct {
		Subscribers []postscriptSubscriber `json:"subscribers"`
		NextCursor  string                 `json:"next_cursor"`
	}
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, "/subscribers", query, headers, nil, firstString(b.UserAgent, creds.UserAgent, postscriptDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(out.Subscribers))
	for _, s := range out.Subscribers {
		if mapped, ok := mapPostscriptSubscriber(s, integration); ok {
			contacts = append(contacts, mapped)
		}
	}
	nextCursor := postscriptCursorComplete
	if strings.TrimSpace(out.NextCursor) != "" {
		nextCursor = postscriptCursorPrefix + strings.TrimSpace(out.NextCursor)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: nextCursor}), nil
}

func mapPostscriptSubscriber(s postscriptSubscriber, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.Email))
	phone := strings.TrimSpace(s.PhoneNumber)
	if email == "" && phone == "" {
		return ContactInput{}, false
	}
	id := firstString(strings.TrimSpace(s.ID), email, phone)
	return ContactInput{
		SourceID:   "postscript://subscriber/" + id,
		Email:      email,
		FirstName:  strings.TrimSpace(s.FirstName),
		LastName:   strings.TrimSpace(s.LastName),
		Phone:      phone,
		ListIDs:    crmListIDs(integration),
		Tags:       crmDefaultTags(integration, "postscript"),
		Properties: map[string]any{"postscript_id": id, "sms_phone": phone, "sms_channel": "postscript"},
	}, true
}

// ---------------- Attentive ----------------

const (
	attentiveDefaultAPIBaseURL = "https://api.attentivemobile.com/v1"
	attentiveDefaultUserAgent  = "Moosewave Attentive Integration"
	attentiveDefaultPageSize   = 100
	attentiveMaxPageSize       = 1000
	attentiveCursorPrefix      = "attentive:"
	attentiveCursorComplete    = "attentive:complete"
)

type AttentiveCredentials struct {
	APIKey        string
	APIBaseURL    string
	UserAgent     string
	WebhookSecret string
}

type AttentiveCredentialResolver interface {
	ResolveAttentive(context.Context, string, Integration) (AttentiveCredentials, error)
}

type attentiveCredentialPayload struct {
	APIKey              string `json:"api_key"`
	Token               string `json:"token"`
	APIBaseURL          string `json:"api_base_url"`
	UserAgent           string `json:"user_agent"`
	WebhookSecret       string `json:"webhook_secret"`
	WebhookSigningKey   string `json:"webhook_signing_key"`
	WebhookSigningToken string `json:"webhook_signing_token"`
	SigningKey          string `json:"signing_key"`
}

func (p attentiveCredentialPayload) credentials() (AttentiveCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return AttentiveCredentials{}, fmt.Errorf("attentive api_key is required")
	}
	return AttentiveCredentials{
		APIKey:        key,
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:     strings.TrimSpace(p.UserAgent),
		WebhookSecret: strings.TrimSpace(firstString(p.WebhookSecret, p.WebhookSigningKey, p.WebhookSigningToken, p.SigningKey)),
	}, nil
}

type AttentiveSecretsCredentialResolver struct {
	Secrets CRMStaticSecretResolver
}

func NewAttentiveSecretsCredentialResolver(secrets CRMStaticSecretResolver) *AttentiveSecretsCredentialResolver {
	return &AttentiveSecretsCredentialResolver{Secrets: secrets}
}

func (r *AttentiveSecretsCredentialResolver) ResolveAttentive(ctx context.Context, _ string, integration Integration) (AttentiveCredentials, error) {
	if r == nil || r.Secrets == nil {
		return AttentiveCredentials{}, fmt.Errorf("attentive credential resolver is not configured")
	}
	ref := crmStaticCredentialRef(integration)
	if ref == "" {
		return AttentiveCredentials{}, fmt.Errorf("attentive credentials_ref is required")
	}
	var payload attentiveCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return attentiveBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AttentiveCredentials{}, fmt.Errorf("resolve attentive credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return attentiveBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := attentiveCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return AttentiveCredentials{}, err
	}
	return attentiveBaseURL(creds, integration), nil
}

func attentiveBaseURL(creds AttentiveCredentials, integration Integration) AttentiveCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type AttentiveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AttentiveRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AttentiveCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type attentiveSubscriber struct {
	ID        string `json:"id"`
	Phone     string `json:"phone"`
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

func (b AttentiveRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAttentive {
		return SyncRequest{}, fmt.Errorf("attentive backfill requires an Attentive integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("attentive credential resolver is not configured")
	}
	state := smsDecodeCursor(cursor, attentiveCursorPrefix, attentiveCursorComplete)
	if state == attentiveCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: attentiveCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveAttentive(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderAttentive)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), attentiveDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), attentiveDefaultPageSize, attentiveMaxPageSize)))
	if state != "" {
		query.Set("cursor", state)
	}
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIKey)}

	var out struct {
		Subscribers []attentiveSubscriber `json:"subscribers"`
		NextCursor  string                `json:"nextCursor"`
	}
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, "/subscribers", query, headers, nil, firstString(b.UserAgent, creds.UserAgent, attentiveDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(out.Subscribers))
	for _, s := range out.Subscribers {
		if mapped, ok := mapAttentiveSubscriber(s, integration); ok {
			contacts = append(contacts, mapped)
		}
	}
	nextCursor := attentiveCursorComplete
	if strings.TrimSpace(out.NextCursor) != "" {
		nextCursor = attentiveCursorPrefix + strings.TrimSpace(out.NextCursor)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: nextCursor}), nil
}

func mapAttentiveSubscriber(s attentiveSubscriber, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.Email))
	phone := strings.TrimSpace(s.Phone)
	if email == "" && phone == "" {
		return ContactInput{}, false
	}
	id := firstString(strings.TrimSpace(s.ID), email, phone)
	return ContactInput{
		SourceID:   "attentive://subscriber/" + id,
		Email:      email,
		FirstName:  strings.TrimSpace(s.FirstName),
		LastName:   strings.TrimSpace(s.LastName),
		Phone:      phone,
		ListIDs:    crmListIDs(integration),
		Tags:       crmDefaultTags(integration, "attentive"),
		Properties: map[string]any{"attentive_id": id, "sms_phone": phone, "sms_channel": "attentive"},
	}, true
}

func smsDecodeCursor(cursor, prefix, complete string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == complete {
		return complete
	}
	return strings.TrimPrefix(cursor, prefix)
}
