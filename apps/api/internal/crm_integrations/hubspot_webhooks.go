// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	hubSpotWebhookV3DefaultTolerance = 5 * time.Minute
	hubSpotDefaultWebhookEventTypes  = "contact.creation,contact.propertyChange,contact.deletion,contact.privacyDeletion"
	hubSpotWebhookAPIVersion         = "2026-3"
)

var hubSpotDefaultWebhookPropertyNames = []string{
	"email",
	"firstname",
	"lastname",
	"phone",
	"company",
	"lifecyclestage",
}

var hubSpotWebhookV3QueryDecodeReplacer = strings.NewReplacer(
	"%3A", ":", "%3a", ":",
	"%2F", "/", "%2f", "/",
	"%3F", "?", "%3f", "?",
	"%40", "@",
	"%21", "!",
	"%24", "$",
	"%27", "'",
	"%28", "(",
	"%29", ")",
	"%2A", "*", "%2a", "*",
	"%2C", ",", "%2c", ",",
	"%3B", ";", "%3b", ";",
)

// VerifyHubSpotWebhookV3 validates an inbound HubSpot app webhook using the v3
// signature scheme: base64(HMAC-SHA256(clientSecret, method + requestURI + body +
// timestamp)). The timestamp (epoch milliseconds) must be within tolerance of now.
// The secret is the single app client secret, not a per-integration secret.
func VerifyHubSpotWebhookV3(clientSecret, method, requestURI string, body []byte, signature, timestamp string, now time.Time, tolerance time.Duration) error {
	clientSecret = strings.TrimSpace(clientSecret)
	signature = strings.TrimSpace(signature)
	timestamp = strings.TrimSpace(timestamp)
	if clientSecret == "" {
		return fmt.Errorf("hubspot webhook client secret is required")
	}
	if signature == "" {
		return fmt.Errorf("hubspot webhook signature is required")
	}
	if timestamp == "" {
		return fmt.Errorf("hubspot webhook timestamp is required")
	}
	if tolerance <= 0 {
		tolerance = hubSpotWebhookV3DefaultTolerance
	}
	ms, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("hubspot webhook timestamp is not a unix-millis integer: %w", err)
	}
	if drift := now.Sub(time.UnixMilli(ms)); drift > tolerance || drift < -tolerance {
		return fmt.Errorf("hubspot webhook timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(clientSecret))
	mac.Write([]byte(method))
	mac.Write([]byte(normalizeHubSpotWebhookV3RequestURI(requestURI)))
	mac.Write(body)
	mac.Write([]byte(timestamp))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return fmt.Errorf("hubspot webhook signature mismatch")
	}
	return nil
}

// HubSpot's v3 signature contract decodes only this allowlist in the query
// string. Decoding the path, '+' characters, or arbitrary percent escapes
// would produce a different signed URI.
func normalizeHubSpotWebhookV3RequestURI(requestURI string) string {
	if fragment := strings.IndexByte(requestURI, '#'); fragment >= 0 {
		requestURI = requestURI[:fragment]
	}
	query := strings.IndexByte(requestURI, '?')
	if query < 0 {
		return requestURI
	}
	return requestURI[:query+1] +
		hubSpotWebhookV3QueryDecodeReplacer.Replace(requestURI[query+1:])
}

// HubSpotWebhookRegistrar reconciles the app-level webhook subscriptions.
type HubSpotWebhookRegistrar interface {
	ReconcileSubscriptions(ctx context.Context) (HubSpotWebhookReconcileSummary, error)
}

// HubSpotWebhookReconcileSummary reports the outcome of an app-level reconcile.
type HubSpotWebhookReconcileSummary struct {
	Existing        int      `json:"existing"`
	Created         int      `json:"created"`
	Activated       int      `json:"activated,omitempty"`
	SettingsUpdated bool     `json:"settings_updated,omitempty"`
	SubscriptionIDs []string `json:"subscription_ids,omitempty"`
}

// HubSpotAppWebhookRegistrar idempotently ensures the app's webhook event
// subscriptions exist. This is an APP-LEVEL concern (one app, all installs),
// authenticated with the HubSpot developer API key — not per tenant.
type HubSpotAppWebhookRegistrar struct {
	HTTPClient      *http.Client
	APIBaseURL      string
	AppID           string
	DeveloperAPIKey string
	TargetURL       string
	EventTypes      []string
	PropertyNames   []string
	MaxConcurrency  int
	UserAgent       string
}

func (r HubSpotAppWebhookRegistrar) ReconcileSubscriptions(ctx context.Context) (HubSpotWebhookReconcileSummary, error) {
	if strings.TrimSpace(r.AppID) == "" || strings.TrimSpace(r.DeveloperAPIKey) == "" {
		return HubSpotWebhookReconcileSummary{}, fmt.Errorf("hubspot webhook reconcile requires app_id and developer API key")
	}
	summary := HubSpotWebhookReconcileSummary{}
	settingsUpdated, err := r.reconcileSettings(ctx)
	if err != nil {
		return summary, err
	}
	summary.SettingsUpdated = settingsUpdated
	desired := r.desiredSubscriptions()

	existing, err := r.listSubscriptions(ctx)
	if err != nil {
		return summary, err
	}
	have := make(map[string]string, len(existing))
	for _, sub := range existing {
		have[sub.key()] = sub.ID
	}

	summary.Existing = len(existing)
	for _, sub := range existing {
		summary.SubscriptionIDs = append(summary.SubscriptionIDs, sub.ID)
	}
	for _, wanted := range desired {
		if id, ok := have[wanted.key()]; ok {
			for _, current := range existing {
				if current.ID == id && !current.Active {
					if err := r.activateSubscription(ctx, id); err != nil {
						return summary, err
					}
					summary.Activated++
				}
			}
			continue
		}
		id, err := r.createSubscription(ctx, wanted)
		if err != nil {
			return summary, err
		}
		summary.Created++
		if id != "" {
			summary.SubscriptionIDs = append(summary.SubscriptionIDs, id)
		}
	}
	return summary, nil
}

type hubSpotSubscription struct {
	ID           string `json:"id"`
	EventType    string `json:"eventType"`
	PropertyName string `json:"propertyName,omitempty"`
	Active       bool   `json:"active"`
}

func (s hubSpotSubscription) key() string {
	return strings.ToLower(strings.TrimSpace(s.EventType)) + "\x00" + strings.ToLower(strings.TrimSpace(s.PropertyName))
}

func (r HubSpotAppWebhookRegistrar) desiredSubscriptions() []hubSpotSubscription {
	eventTypes := r.EventTypes
	if len(eventTypes) == 0 {
		eventTypes = ParseHubSpotOAuthScopes(strings.ReplaceAll(hubSpotDefaultWebhookEventTypes, ",", " "))
	}
	propertyNames := uniqueCRMStrings(r.PropertyNames)
	if len(propertyNames) == 0 {
		propertyNames = append([]string(nil), hubSpotDefaultWebhookPropertyNames...)
	}
	seen := map[string]bool{}
	out := make([]hubSpotSubscription, 0, len(eventTypes)+len(propertyNames))
	for _, eventType := range eventTypes {
		eventType = strings.TrimSpace(eventType)
		if eventType == "" {
			continue
		}
		if strings.EqualFold(eventType, "contact.propertyChange") {
			for _, propertyName := range propertyNames {
				item := hubSpotSubscription{EventType: "contact.propertyChange", PropertyName: propertyName, Active: true}
				if !seen[item.key()] {
					seen[item.key()] = true
					out = append(out, item)
				}
			}
			continue
		}
		item := hubSpotSubscription{EventType: eventType, Active: true}
		if !seen[item.key()] {
			seen[item.key()] = true
			out = append(out, item)
		}
	}
	return out
}

func (r HubSpotAppWebhookRegistrar) listSubscriptions(ctx context.Context) ([]hubSpotSubscription, error) {
	body, status, err := r.do(ctx, http.MethodGet, r.subscriptionsPath(), nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("hubspot list webhook subscriptions failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var raw []struct {
		ID           json.Number `json:"id"`
		EventType    string      `json:"eventType"`
		PropertyName string      `json:"propertyName"`
		Active       bool        `json:"active"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, fmt.Errorf("decode hubspot webhook subscriptions: %w", err)
		}
	}
	out := make([]hubSpotSubscription, 0, len(raw))
	for _, item := range raw {
		out = append(out, hubSpotSubscription{
			ID:           item.ID.String(),
			EventType:    strings.TrimSpace(item.EventType),
			PropertyName: strings.TrimSpace(item.PropertyName),
			Active:       item.Active,
		})
	}
	return out, nil
}

func (r HubSpotAppWebhookRegistrar) createSubscription(ctx context.Context, subscription hubSpotSubscription) (string, error) {
	input := map[string]any{"eventType": subscription.EventType, "active": true}
	if subscription.PropertyName != "" {
		input["propertyName"] = subscription.PropertyName
	}
	payload, _ := json.Marshal(input)
	body, status, err := r.do(ctx, http.MethodPost, r.subscriptionsPath(), payload)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("hubspot create webhook subscription %q/%q failed %d: %s", subscription.EventType, subscription.PropertyName, status, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		ID json.Number `json:"id"`
	}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &raw)
	}
	return raw.ID.String(), nil
}

func (r HubSpotAppWebhookRegistrar) activateSubscription(ctx context.Context, id string) error {
	payload, _ := json.Marshal(map[string]any{"active": true})
	body, status, err := r.do(ctx, http.MethodPut, r.subscriptionsPath()+"/"+url.PathEscape(strings.TrimSpace(id)), payload)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("hubspot activate webhook subscription %q failed %d: %s", id, status, truncateHubSpotString(string(body), 500))
	}
	return nil
}

func (r HubSpotAppWebhookRegistrar) subscriptionsPath() string {
	return "/webhooks/" + hubSpotWebhookAPIVersion + "/" + url.PathEscape(strings.TrimSpace(r.AppID)) + "/subscriptions"
}

func (r HubSpotAppWebhookRegistrar) settingsPath() string {
	return "/webhooks/" + hubSpotWebhookAPIVersion + "/" + url.PathEscape(strings.TrimSpace(r.AppID)) + "/settings"
}

func (r HubSpotAppWebhookRegistrar) reconcileSettings(ctx context.Context) (bool, error) {
	targetURL := strings.TrimSpace(r.TargetURL)
	if targetURL == "" {
		return false, nil
	}
	parsed, err := url.Parse(targetURL)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || strings.TrimSpace(parsed.Host) == "" {
		return false, fmt.Errorf("hubspot webhook target URL must be an absolute HTTPS URL")
	}
	body, status, err := r.do(ctx, http.MethodGet, r.settingsPath(), nil)
	if err != nil {
		return false, err
	}
	if status < 200 || status >= 300 {
		return false, fmt.Errorf("hubspot get webhook settings failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var current struct {
		WebhookURL            string `json:"webhookUrl"`
		TargetURL             string `json:"targetUrl"`
		MaxConcurrentRequests int    `json:"maxConcurrentRequests"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &current); err != nil {
			return false, fmt.Errorf("decode hubspot webhook settings: %w", err)
		}
	}
	maxConcurrency := r.MaxConcurrency
	if maxConcurrency <= 5 {
		maxConcurrency = 10
	}
	currentURL := firstString(current.WebhookURL, current.TargetURL)
	if currentURL == targetURL && current.MaxConcurrentRequests == maxConcurrency {
		return false, nil
	}
	payload, _ := json.Marshal(map[string]any{
		"targetUrl": targetURL,
		"throttling": map[string]any{
			"maxConcurrentRequests": maxConcurrency,
		},
	})
	responseBody, updateStatus, err := r.do(ctx, http.MethodPut, r.settingsPath(), payload)
	if err != nil {
		return false, err
	}
	if updateStatus < 200 || updateStatus >= 300 {
		return false, fmt.Errorf("hubspot update webhook settings failed %d: %s", updateStatus, truncateHubSpotString(string(responseBody), 500))
	}
	return true, nil
}

func (r HubSpotAppWebhookRegistrar) do(ctx context.Context, method, path string, payload []byte) ([]byte, int, error) {
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, hubSpotDefaultOAuthBaseURL), "/")
	u, err := url.Parse(baseURL + path)
	if err != nil {
		return nil, 0, fmt.Errorf("parse hubspot webhooks URL: %w", err)
	}
	query := u.Query()
	query.Set("hapikey", strings.TrimSpace(r.DeveloperAPIKey))
	u.RawQuery = query.Encode()

	var bodyReader io.Reader
	if payload != nil {
		bodyReader = strings.NewReader(string(payload))
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", firstString(r.UserAgent, hubSpotDefaultUserAgent))

	client := crmEgressClient(r.HTTPClient, ProviderHubSpot, 20*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		// net/http request errors normally include the full request URL. This
		// endpoint still authenticates with HubSpot's developer key in the
		// `hapikey` query parameter, so returning the transport error verbatim
		// could put that credential in startup logs.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, 0, fmt.Errorf(
				"hubspot webhooks %s request failed: %w",
				strings.ToLower(method),
				ctxErr,
			)
		}
		return nil, 0, fmt.Errorf(
			"hubspot webhooks %s request failed",
			strings.ToLower(method),
		)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, hubSpotResponseMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return respBody, resp.StatusCode, nil
}

const hubSpotWebhookMaxBodyBytes = 1 << 20

// hubSpotWebhookEvent is one entry in a HubSpot app-webhook delivery batch.
type hubSpotWebhookEvent struct {
	EventID          json.Number     `json:"eventId"`
	SubscriptionType string          `json:"subscriptionType"`
	EventType        string          `json:"eventType,omitempty"`
	SubscriptionID   json.Number     `json:"subscriptionId,omitempty"`
	AttemptNumber    int             `json:"attemptNumber,omitempty"`
	AppID            json.Number     `json:"appId"`
	PortalID         json.Number     `json:"portalId"`
	ObjectID         json.Number     `json:"objectId"`
	OccurredAt       int64           `json:"occurredAt"`
	PropertyName     string          `json:"propertyName,omitempty"`
	PropertyValue    json.RawMessage `json:"propertyValue,omitempty"`
	ChangeSource     string          `json:"changeSource,omitempty"`
}

// HubSpotWebhookSummary reports the outcome of processing a delivery batch.
type HubSpotWebhookSummary struct {
	Received       int      `json:"received"`
	Processed      int      `json:"processed"`
	Ignored        int      `json:"ignored"`
	Duplicate      int      `json:"duplicate"`
	Failed         int      `json:"failed,omitempty"`
	UnknownPortals []string `json:"unknown_portals,omitempty"`
}

// hubSpotContactFetcher is satisfied by HubSpotRESTBackfiller; the webhook
// runtime fetches the changed contact by objectId (HubSpot webhooks carry only
// the id, not the record).
type hubSpotContactFetcher interface {
	FetchContactByID(ctx context.Context, tenantID string, integration Integration, objectID string) (ContactInput, bool, error)
}

func decodeHubSpotWebhookEvents(body []byte) ([]hubSpotWebhookEvent, error) {
	var events []hubSpotWebhookEvent
	if err := json.Unmarshal(body, &events); err != nil {
		return nil, fmt.Errorf("decode hubspot webhook payload: %w", err)
	}
	for index := range events {
		subscriptionType := strings.TrimSpace(events[index].SubscriptionType)
		eventType := strings.TrimSpace(events[index].EventType)
		if subscriptionType != "" && eventType != "" && !strings.EqualFold(subscriptionType, eventType) {
			return nil, fmt.Errorf(
				"decode hubspot webhook payload: event %d has conflicting subscriptionType and eventType",
				index,
			)
		}
		if subscriptionType == "" {
			subscriptionType = eventType
		}
		events[index].SubscriptionType = subscriptionType
		events[index].EventType = ""
	}
	return events, nil
}

// hubSpotWebhookRequestURI reconstructs the exact URI HubSpot signed. The
// configured POSTWAVE_PUBLIC_BASE_URL must match the registered webhook target.
func (d *Deps) hubSpotWebhookRequestURI(r *http.Request) string {
	base := strings.TrimRight(d.publicBaseURL(r), "/")
	if base == "" {
		scheme := "https"
		if r.TLS == nil && strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")) == "" {
			scheme = "http"
		}
		base = scheme + "://" + r.Host
	}
	return base + r.URL.RequestURI()
}

func (d *Deps) HubSpotWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, hubSpotWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "HubSpot webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	secret := strings.TrimSpace(d.HubSpotOAuth.ClientSecret)
	appID := strings.TrimSpace(d.HubSpotOAuth.AppID)
	if secret == "" || appID == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "hubspot_oauth_unconfigured", "HubSpot app ID and client secret are not configured")
		return
	}
	if err := VerifyHubSpotWebhookV3(secret, r.Method, d.hubSpotWebhookRequestURI(r), body,
		r.Header.Get("X-HubSpot-Signature-v3"), r.Header.Get("X-HubSpot-Request-Timestamp"),
		d.now(), hubSpotWebhookV3DefaultTolerance); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	events, err := decodeHubSpotWebhookEvents(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	summary, err := d.processHubSpotWebhookEvents(r.Context(), events, body)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn(
				"hubspot webhook batch requires retry",
				"received", summary.Received,
				"processed", summary.Processed,
				"duplicate", summary.Duplicate,
				"failed", summary.Failed,
				"err", err.Error(),
			)
		}
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_retry_required", httperror.MessageInternal)
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) processHubSpotWebhookEvents(ctx context.Context, events []hubSpotWebhookEvent, _ []byte) (HubSpotWebhookSummary, error) {
	summary := HubSpotWebhookSummary{Received: len(events)}
	resolved := map[string]*Integration{}
	unknown := map[string]bool{}
	var retryable []error
	for _, ev := range events {
		appID := strings.TrimSpace(ev.AppID.String())
		portalID := strings.TrimSpace(ev.PortalID.String())
		eventID := strings.TrimSpace(ev.EventID.String())
		objectID := strings.TrimSpace(ev.ObjectID.String())
		subscriptionType := strings.TrimSpace(ev.SubscriptionType)
		routeKey := appID + "\x00" + portalID
		if appID == "" || appID != strings.TrimSpace(d.HubSpotOAuth.AppID) ||
			portalID == "" || eventID == "" || objectID == "" ||
			subscriptionType == "" || unknown[routeKey] {
			summary.Ignored++
			continue
		}
		integration, ok := resolved[routeKey]
		if !ok {
			found, err := d.Repo.FindHubSpotIntegrationByAppAndPortalID(ctx, appID, portalID)
			if err != nil {
				if errors.Is(err, ErrNotFound) {
					unknown[routeKey] = true
					summary.UnknownPortals = append(summary.UnknownPortals, portalID)
					summary.Ignored++
				} else {
					summary.Failed++
					retryable = append(
						retryable,
						fmt.Errorf("resolve HubSpot webhook install for portal %s: %w", portalID, err),
					)
				}
				continue
			}
			integration = found
			resolved[routeKey] = found
		}
		claimID, claimBody := hubSpotWebhookEventClaim(ev)
		claim, err := d.Repo.ClaimWebhook(
			ctx,
			integration.TenantID,
			integration.ID,
			ProviderHubSpot,
			claimID,
			strings.ToLower(strings.TrimSpace(ev.SubscriptionType)),
			claimBody,
		)
		if err != nil {
			summary.Failed++
			retryable = append(
				retryable,
				fmt.Errorf("claim HubSpot webhook event %s: %w", claimID, err),
			)
			continue
		}
		if claim == WebhookProcessed {
			summary.Duplicate++
			continue
		}
		if claim == WebhookInProgress {
			summary.Duplicate++
			summary.Failed++
			retryable = append(
				retryable,
				fmt.Errorf("HubSpot webhook event %s is already in progress", claimID),
			)
			continue
		}
		if err := d.handleHubSpotWebhookEvent(ctx, integration, ev); err != nil {
			summary.Failed++
			retryable = append(
				retryable,
				fmt.Errorf("process HubSpot webhook event %s: %w", claimID, err),
			)
			if markErr := d.Repo.MarkWebhookFailed(
				ctx,
				integration.TenantID,
				integration.ID,
				ProviderHubSpot,
				claimID,
				err,
			); markErr != nil {
				retryable = append(
					retryable,
					fmt.Errorf("mark HubSpot webhook event %s failed: %w", claimID, markErr),
				)
			}
			continue
		}
		if err := d.Repo.MarkWebhookProcessed(
			ctx,
			integration.TenantID,
			integration.ID,
			ProviderHubSpot,
			claimID,
		); err != nil {
			// Do not downgrade an unknown processed-write outcome to failed. If
			// the commit landed, the provider retry observes processed; if it did
			// not, the bounded stale-claim recovery makes the event claimable.
			summary.Failed++
			retryable = append(
				retryable,
				fmt.Errorf("finalize HubSpot webhook event %s: %w", claimID, err),
			)
			continue
		}
		summary.Processed++
	}
	return summary, errors.Join(retryable...)
}

func hubSpotWebhookEventClaim(ev hubSpotWebhookEvent) (string, []byte) {
	canonical := struct {
		AppID            string `json:"app_id"`
		PortalID         string `json:"portal_id"`
		EventID          string `json:"event_id"`
		SubscriptionID   string `json:"subscription_id,omitempty"`
		SubscriptionType string `json:"subscription_type"`
		ObjectID         string `json:"object_id"`
		OccurredAt       int64  `json:"occurred_at"`
		PropertyName     string `json:"property_name,omitempty"`
		PropertyValue    string `json:"property_value_sha256,omitempty"`
		ChangeSource     string `json:"change_source,omitempty"`
	}{
		AppID:            strings.TrimSpace(ev.AppID.String()),
		PortalID:         strings.TrimSpace(ev.PortalID.String()),
		EventID:          strings.TrimSpace(ev.EventID.String()),
		SubscriptionID:   strings.TrimSpace(ev.SubscriptionID.String()),
		SubscriptionType: strings.ToLower(strings.TrimSpace(ev.SubscriptionType)),
		ObjectID:         strings.TrimSpace(ev.ObjectID.String()),
		OccurredAt:       ev.OccurredAt,
		PropertyName:     strings.ToLower(strings.TrimSpace(ev.PropertyName)),
		PropertyValue:    hubSpotWebhookPropertyValueDigest(ev.PropertyValue),
		ChangeSource:     strings.ToLower(strings.TrimSpace(ev.ChangeSource)),
	}
	body, _ := json.Marshal(canonical)
	sum := sha256.Sum256(body)
	return "hubspot:" + base64.RawURLEncoding.EncodeToString(sum[:]), body
}

func hubSpotWebhookPropertyValueDigest(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		// The outer webhook decoder has already validated this RawMessage. Keep
		// this helper fail-closed and deterministic if it is called directly.
		sum := sha256.Sum256(raw)
		return base64.RawURLEncoding.EncodeToString(sum[:])
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		canonical = raw
	}
	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func hubSpotOAuthWebhookCapable(integration Integration) bool {
	mode := strings.ToLower(settingString(integration.Settings, "hubspot_auth_mode"))
	if mode == "managed_oauth" {
		return settingString(integration.Settings, "hubspot_app_id") != ""
	}
	return mode == "" &&
		settingEnabled(integration.Settings, "hubspot_oauth_managed_by_postwave") &&
		settingString(integration.Settings, "hubspot_app_id") != "" &&
		hubSpotIsStoredCredentialRef(integration.CredentialsRef)
}

func (d *Deps) handleHubSpotWebhookEvent(ctx context.Context, integration *Integration, ev hubSpotWebhookEvent) error {
	objectID := strings.TrimSpace(ev.ObjectID.String())
	switch strings.ToLower(strings.TrimSpace(ev.SubscriptionType)) {
	case "contact.creation", "contact.propertychange":
		fetcher, ok := d.HubSpotBackfiller.(hubSpotContactFetcher)
		if !ok {
			return fmt.Errorf("hubspot contact fetcher is not configured")
		}
		contact, ok, err := fetcher.FetchContactByID(ctx, integration.TenantID, *integration, objectID)
		if err != nil {
			return err
		}
		if !ok {
			return d.reconcileHubSpotContactState(ctx, integration, objectID, "no_email", ev)
		}
		req := normalizeSyncRequest(SyncRequest{Contacts: []ContactInput{contact}})
		req.RunMode = "webhook"
		started := d.now()
		summary := d.executeSync(ctx, integration.TenantID, integration, req)
		completed := d.now()
		if _, err := d.Repo.RecordSyncRun(ctx, integration.TenantID, integration.ID, summary, req, started, completed); err != nil {
			return err
		}
		if summary.Status == "failed" {
			return errors.New(summary.ErrorMessage)
		}
		return nil
	case "contact.deletion":
		return d.reconcileHubSpotContactState(ctx, integration, objectID, "deleted", ev)
	case "contact.privacydeletion":
		return d.reconcileHubSpotContactState(ctx, integration, objectID, "privacy_deleted", ev)
	default:
		return fmt.Errorf("unsupported HubSpot webhook subscription type %q", ev.SubscriptionType)
	}
}

func (d *Deps) reconcileHubSpotContactState(
	ctx context.Context,
	integration *Integration,
	objectID, state string,
	ev hubSpotWebhookEvent,
) error {
	if integration == nil {
		return fmt.Errorf("hubspot contact lifecycle integration is required")
	}
	lifecycle, ok := d.Profiles.(ProfileLifecycleSink)
	if !ok {
		return fmt.Errorf("hubspot contact lifecycle sink is not configured")
	}
	subscriberID, found, err := lifecycle.ReconcileCRMContactState(
		ctx,
		integration.TenantID,
		*integration,
		"hubspot://contact/"+strings.TrimSpace(objectID),
		state,
		map[string]any{
			"hubspot_event_id":          strings.TrimSpace(ev.EventID.String()),
			"hubspot_subscription_type": strings.TrimSpace(ev.SubscriptionType),
			"hubspot_property_name":     strings.TrimSpace(ev.PropertyName),
			"hubspot_occurred_at":       ev.OccurredAt,
		},
	)
	if err != nil || !found {
		return err
	}
	memberships, ok := d.ListMemberships.(ProviderContactMembershipLifecycleSink)
	if !ok {
		return fmt.Errorf("hubspot contact membership lifecycle sink is not configured")
	}
	_, err = memberships.RemoveProviderCRMContactMemberships(
		ctx,
		integration.TenantID,
		integration.ID,
		integration.Provider,
		subscriberID,
	)
	return err
}
