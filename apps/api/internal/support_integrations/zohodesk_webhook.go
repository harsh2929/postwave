// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const zohoDeskJWTDefaultLeeway = 5 * time.Minute

var (
	ErrMissingZohoDeskWebhookJWT = errors.New("zoho desk webhook JWT is required")
	ErrInvalidZohoDeskWebhookJWT = errors.New("invalid zoho desk webhook JWT")
)

type ZohoDeskWebhookStore interface {
	FindZohoDeskIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error)
}

type zohoDeskWebhookEvent struct {
	DeliveryID string
	Topic      string
	TicketID   string
	Raw        map[string]any
}

type ZohoDeskWebhookSummary struct {
	Received  int `json:"received"`
	Processed int `json:"processed"`
	Ignored   int `json:"ignored"`
	Duplicate int `json:"duplicate"`
}

type zohoDeskJWTHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

type zohoDeskJWTClaims struct {
	Iss string `json:"iss"`
	Aud any    `json:"aud"`
	Exp int64  `json:"exp"`
	Nbf int64  `json:"nbf"`
	Iat int64  `json:"iat"`
	Sub string `json:"sub"`
	Jti string `json:"jti"`
	Raw map[string]any
}

type zohoDeskJWKS struct {
	Keys []zohoDeskJWK `json:"keys"`
}

type zohoDeskJWK struct {
	Kid string   `json:"kid"`
	Kty string   `json:"kty"`
	Alg string   `json:"alg"`
	Use string   `json:"use"`
	N   string   `json:"n"`
	E   string   `json:"e"`
	X5C []string `json:"x5c"`
}

// ZohoDeskWebhook receives Zoho Desk webhook deliveries scoped to an
// organization. Zoho signs deliveries as a JWT in X-ZDesk-JWT; the payload is
// used as a sparse trigger, and canonical data is fetched from Tickets REST.
func (d *Deps) ZohoDeskWebhook(w http.ResponseWriter, r *http.Request) {
	organizationID := strings.TrimSpace(chi.URLParam(r, "organization_id"))
	if organizationID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_organization_id", "zoho desk organization id is required")
		return
	}
	store, ok := d.Repo.(ZohoDeskWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "zoho desk webhook lookup is not configured")
		return
	}
	webhookID := zohoDeskWebhookID(r)
	integration, err := store.FindZohoDeskIntegrationByOrganization(r.Context(), organizationID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "zoho desk integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "zoho desk payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read zoho desk webhook body")
		return
	}
	claims, err := d.verifyZohoDeskWebhookJWT(r.Context(), integration, zohoDeskWebhookJWT(r), organizationID, webhookID)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	events, err := decodeZohoDeskWebhookEvents(body, claims)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	summary, err := d.processZohoDeskWebhookEvents(r.Context(), integration, claimStore, webhookID, events, body)
	if err != nil {
		writeZohoDeskWebhookRefreshError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) processZohoDeskWebhookEvents(ctx context.Context, integration *Integration, claimStore SupportWebhookClaimStore, webhookID string, events []zohoDeskWebhookEvent, body []byte) (ZohoDeskWebhookSummary, error) {
	summary := ZohoDeskWebhookSummary{Received: len(events)}
	for _, ev := range events {
		if ev.TicketID == "" {
			summary.Ignored++
			continue
		}
		deliveryID := "zoho-desk:" + firstString(ev.DeliveryID, ev.TicketID)
		topic := firstString(ev.Topic, "ticket")
		claim, err := claimStore.ClaimSupportWebhook(ctx, integration.TenantID, integration.ID, ProviderZohoDesk, deliveryID, topic, body)
		if err != nil {
			return summary, err
		}
		if claim == WebhookProcessed || claim == WebhookInProgress {
			summary.Duplicate++
			continue
		}
		req, ok, err := d.refreshZohoDeskWebhookTicket(ctx, integration, ev, webhookID)
		if err != nil {
			if zohoDeskWebhookTicketMissing(err) {
				if markErr := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID); markErr != nil {
					return summary, markErr
				}
				summary.Ignored++
				continue
			}
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID, err)
			return summary, err
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID); err != nil {
				return summary, err
			}
			summary.Ignored++
			continue
		}
		started := d.now()
		syncSummary := d.executeSync(ctx, integration.TenantID, integration, req)
		completed := d.now()
		run, err := d.Repo.RecordSyncRun(ctx, integration.TenantID, integration.ID, syncSummary, req, started, completed)
		if err != nil {
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID, err)
			return summary, err
		}
		syncSummary.RunID = run.ID
		if syncSummary.Status == "failed" {
			err := errors.New(firstString(syncSummary.ErrorMessage, "zoho desk webhook processing failed"))
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID, err)
			return summary, err
		}
		if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderZohoDesk, deliveryID); err != nil {
			return summary, err
		}
		summary.Processed++
	}
	return summary, nil
}

func (d *Deps) refreshZohoDeskWebhookTicket(ctx context.Context, integration *Integration, ev zohoDeskWebhookEvent, webhookID string) (SyncRequest, bool, error) {
	refresher, ok := d.ZohoDeskBackfiller.(ZohoDeskTicketRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("zoho desk ticket refresh is not configured")
	}
	req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ev.TicketID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req.RunMode = "webhook"
	req.Cursor = "zoho-desk-webhook-" + firstString(ev.DeliveryID, ev.TicketID)
	for i := range req.Tickets {
		if req.Tickets[i].Properties == nil {
			req.Tickets[i].Properties = map[string]any{}
		}
		req.Tickets[i].Properties["zoho_desk_webhook_id"] = strings.TrimSpace(webhookID)
		req.Tickets[i].Properties["zoho_desk_webhook_event"] = strings.TrimSpace(ev.Topic)
		req.Tickets[i].Properties["zoho_desk_refresh_source"] = "webhook_sparse_ticket"
		req.Tickets[i].Properties["zoho_desk_raw"] = ev.Raw
	}
	req = normalizeSyncRequest(req)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func (d *Deps) verifyZohoDeskWebhookJWT(ctx context.Context, integration *Integration, token, organizationID, webhookID string) (zohoDeskJWTClaims, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return zohoDeskJWTClaims{}, ErrMissingZohoDeskWebhookJWT
	}
	header, claims, signingInput, sig, err := parseZohoDeskJWT(token)
	if err != nil {
		return zohoDeskJWTClaims{}, err
	}
	if !strings.EqualFold(header.Alg, "RS256") {
		return zohoDeskJWTClaims{}, fmt.Errorf("%w: unsupported alg %q", ErrInvalidZohoDeskWebhookJWT, header.Alg)
	}
	key, err := d.zohoDeskWebhookPublicKey(ctx, integration, header.Kid)
	if err != nil {
		return zohoDeskJWTClaims{}, err
	}
	digest := sha256.Sum256([]byte(signingInput))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
		return zohoDeskJWTClaims{}, fmt.Errorf("%w: signature mismatch", ErrInvalidZohoDeskWebhookJWT)
	}
	now := d.now()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if err := validateZohoDeskJWTClaims(claims, organizationID, webhookID, now.UTC()); err != nil {
		return zohoDeskJWTClaims{}, err
	}
	return claims, nil
}

func (d *Deps) zohoDeskWebhookPublicKey(ctx context.Context, integration *Integration, kid string) (*rsa.PublicKey, error) {
	jwksURL := zohoDeskJWKSURL(integration)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", zohoDeskDefaultUserAgent)
	client := supportEgressClient(nil, ProviderZohoDesk, 30*time.Second)
	if rest, ok := d.ZohoDeskBackfiller.(ZohoDeskRESTBackfiller); ok && rest.HTTPClient != nil {
		client = supportEgressClient(rest.HTTPClient, ProviderZohoDesk, 30*time.Second)
	}
	if rest, ok := d.ZohoDeskBackfiller.(*ZohoDeskRESTBackfiller); ok && rest.HTTPClient != nil {
		client = supportEgressClient(rest.HTTPClient, ProviderZohoDesk, 30*time.Second)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := httpbody.ReadAtMost(resp.Body, zohoDeskResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: fetch JWKS failed %d", ErrInvalidZohoDeskWebhookJWT, resp.StatusCode)
	}
	var jwks zohoDeskJWKS
	if err := json.Unmarshal(body, &jwks); err != nil {
		return nil, fmt.Errorf("%w: decode JWKS: %v", ErrInvalidZohoDeskWebhookJWT, err)
	}
	for _, key := range jwks.Keys {
		if strings.TrimSpace(kid) != "" && strings.TrimSpace(key.Kid) != strings.TrimSpace(kid) {
			continue
		}
		pub, err := key.publicKey()
		if err == nil {
			return pub, nil
		}
	}
	return nil, fmt.Errorf("%w: matching JWKS key not found", ErrInvalidZohoDeskWebhookJWT)
}

func parseZohoDeskJWT(token string) (zohoDeskJWTHeader, zohoDeskJWTClaims, string, []byte, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: malformed token", ErrInvalidZohoDeskWebhookJWT)
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: decode header", ErrInvalidZohoDeskWebhookJWT)
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: decode claims", ErrInvalidZohoDeskWebhookJWT)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: decode signature", ErrInvalidZohoDeskWebhookJWT)
	}
	var header zohoDeskJWTHeader
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: parse header", ErrInvalidZohoDeskWebhookJWT)
	}
	var claims zohoDeskJWTClaims
	dec := json.NewDecoder(bytes.NewReader(claimsJSON))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return zohoDeskJWTHeader{}, zohoDeskJWTClaims{}, "", nil, fmt.Errorf("%w: parse claims", ErrInvalidZohoDeskWebhookJWT)
	}
	claims.Raw = raw
	claims.Iss = zohoDeskClaimString(raw, "iss")
	claims.Sub = zohoDeskClaimString(raw, "sub")
	claims.Jti = zohoDeskClaimString(raw, "jti")
	claims.Aud = raw["aud"]
	claims.Exp = zohoDeskClaimUnix(raw, "exp")
	claims.Nbf = zohoDeskClaimUnix(raw, "nbf")
	claims.Iat = zohoDeskClaimUnix(raw, "iat")
	return header, claims, parts[0] + "." + parts[1], sig, nil
}

func validateZohoDeskJWTClaims(claims zohoDeskJWTClaims, organizationID, webhookID string, now time.Time) error {
	if claims.Exp > 0 && now.After(time.Unix(claims.Exp, 0).Add(zohoDeskJWTDefaultLeeway)) {
		return fmt.Errorf("%w: expired token", ErrInvalidZohoDeskWebhookJWT)
	}
	if claims.Nbf > 0 && now.Add(zohoDeskJWTDefaultLeeway).Before(time.Unix(claims.Nbf, 0)) {
		return fmt.Errorf("%w: token not yet valid", ErrInvalidZohoDeskWebhookJWT)
	}
	if claims.Iss != "" && !zohoDeskClaimMatches(claims.Iss, "orgId", organizationID) {
		return fmt.Errorf("%w: issuer does not match organization", ErrInvalidZohoDeskWebhookJWT)
	}
	if webhookID != "" && len(zohoDeskClaimAudiences(claims.Aud)) > 0 && !zohoDeskAnyClaimMatches(zohoDeskClaimAudiences(claims.Aud), "webhookId", webhookID) {
		return fmt.Errorf("%w: audience does not match webhook", ErrInvalidZohoDeskWebhookJWT)
	}
	return nil
}

func decodeZohoDeskWebhookEvents(body []byte, claims zohoDeskJWTClaims) ([]zohoDeskWebhookEvent, error) {
	var root any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("decode zoho desk webhook payload: %w", err)
	}
	nodes := zohoDeskWebhookEventNodes(root)
	if len(nodes) == 0 {
		return nil, fmt.Errorf("zoho desk webhook payload must contain at least one event")
	}
	out := make([]zohoDeskWebhookEvent, 0, len(nodes))
	for _, node := range nodes {
		out = append(out, zohoDeskWebhookEventFromRaw(node, claims))
	}
	return out, nil
}

func zohoDeskWebhookEventFromRaw(raw map[string]any, claims zohoDeskJWTClaims) zohoDeskWebhookEvent {
	ticketID := firstString(
		zohoDeskWebhookString(raw, "ticket", "id"),
		zohoDeskWebhookString(raw, "payload", "ticket", "id"),
		zohoDeskWebhookString(raw, "data", "ticket", "id"),
		zohoDeskWebhookString(raw, "ticketId"),
		zohoDeskWebhookString(raw, "ticket_id"),
		zohoDeskWebhookString(raw, "payload", "ticketId"),
		zohoDeskWebhookString(raw, "data", "ticketId"),
		zohoDeskWebhookString(raw, "entity", "id"),
		zohoDeskWebhookString(raw, "resource", "id"),
		zohoDeskWebhookString(raw, "id"),
	)
	topic := firstString(
		zohoDeskWebhookString(raw, "event"),
		zohoDeskWebhookString(raw, "eventType"),
		zohoDeskWebhookString(raw, "event_name"),
		zohoDeskWebhookString(raw, "action"),
		zohoDeskWebhookString(raw, "operation"),
		zohoDeskWebhookString(raw, "module"),
		"ticket",
	)
	return zohoDeskWebhookEvent{
		DeliveryID: firstString(
			zohoDeskWebhookString(raw, "eventId"),
			zohoDeskWebhookString(raw, "event_id"),
			zohoDeskWebhookString(raw, "notificationId"),
			zohoDeskWebhookString(raw, "notification_id"),
			claims.Jti,
			topic+"-"+ticketID,
		),
		Topic:    strings.TrimSpace(topic),
		TicketID: strings.TrimSpace(ticketID),
		Raw:      copySettings(raw),
	}
}

func (key zohoDeskJWK) publicKey() (*rsa.PublicKey, error) {
	if len(key.X5C) > 0 && strings.TrimSpace(key.X5C[0]) != "" {
		der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(key.X5C[0]))
		if err != nil {
			return nil, err
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, err
		}
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("JWKS x5c key is not RSA")
		}
		return pub, nil
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(key.N))
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(key.E))
	if err != nil {
		return nil, err
	}
	e := 0
	for _, b := range eBytes {
		e = e*256 + int(b)
	}
	if e == 0 {
		return nil, fmt.Errorf("JWKS RSA exponent is empty")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func zohoDeskJWKSURL(integration *Integration) string {
	if integration != nil {
		if explicit := strings.TrimSpace(settingString(integration.Settings, "zoho_desk_jwks_url")); explicit != "" {
			return explicit
		}
		base := strings.TrimSpace(firstString(settingString(integration.Settings, "api_base_url"), settingString(integration.Settings, "desk_api_base_url")))
		if base != "" {
			u, err := url.Parse(strings.TrimRight(base, "/"))
			if err == nil && u.Scheme != "" && u.Host != "" {
				u.Path = "/.well-known/jwks.json"
				u.RawQuery = ""
				return u.String()
			}
		}
	}
	return "https://desk.zoho.com/.well-known/jwks.json"
}

func zohoDeskWebhookTicketMissing(err error) bool {
	var restErr ZohoDeskRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeZohoDeskWebhookRefreshError(w http.ResponseWriter, err error) {
	var restErr ZohoDeskRESTError
	if errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		seconds := int(restErr.RetryAfter / time.Second)
		if restErr.RetryAfter%time.Second != 0 {
			seconds++
		}
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	httperror.Write(w, http.StatusServiceUnavailable, "zoho_desk_refresh_failed", httperror.MessageInternal)
}

func zohoDeskWebhookJWT(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-ZDesk-JWT"),
		r.Header.Get("X-ZohoDesk-JWT"),
		r.Header.Get("X-Zoho-Desk-JWT"),
	))
}

func zohoDeskWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("notification_id"),
		r.URL.Query().Get("subscription_id"),
		r.Header.Get("X-ZohoDesk-Webhook-Id"),
		r.Header.Get("X-ZDesk-Webhook-Id"),
		r.Header.Get("X-Zoho-Notification-Id"),
	))
}

func zohoDeskWebhookEventNodes(root any) []map[string]any {
	switch typed := root.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]any:
		for _, key := range []string{"events", "notifications", "data"} {
			if raw, ok := typed[key].([]any); ok {
				out := make([]map[string]any, 0, len(raw))
				for _, item := range raw {
					if m, ok := item.(map[string]any); ok {
						out = append(out, m)
					}
				}
				if len(out) > 0 {
					return out
				}
			}
		}
		return []map[string]any{typed}
	default:
		return nil
	}
}

func zohoDeskWebhookString(node map[string]any, path ...string) string {
	cur := any(node)
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		v, ok := m[key]
		if !ok || v == nil {
			return ""
		}
		if i == len(path)-1 {
			switch typed := v.(type) {
			case string:
				return strings.TrimSpace(typed)
			case json.Number:
				return strings.TrimSpace(typed.String())
			case float64:
				return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
			default:
				return strings.TrimSpace(fmt.Sprint(typed))
			}
		}
		cur = v
	}
	return ""
}

func zohoDeskClaimString(raw map[string]any, key string) string {
	if raw == nil || raw[key] == nil {
		return ""
	}
	switch typed := raw[key].(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func zohoDeskClaimUnix(raw map[string]any, key string) int64 {
	if raw == nil || raw[key] == nil {
		return 0
	}
	switch typed := raw[key].(type) {
	case json.Number:
		n, _ := typed.Int64()
		return n
	case float64:
		return int64(typed)
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return n
	default:
		return 0
	}
}

func zohoDeskClaimAudiences(raw any) []string {
	switch typed := raw.(type) {
	case string:
		return []string{strings.TrimSpace(typed)}
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if value := strings.TrimSpace(fmt.Sprint(item)); value != "" {
				out = append(out, value)
			}
		}
		return out
	case []string:
		return cleanStrings(typed)
	default:
		return nil
	}
}

func zohoDeskAnyClaimMatches(values []string, prefix, expected string) bool {
	for _, value := range values {
		if zohoDeskClaimMatches(value, prefix, expected) {
			return true
		}
	}
	return false
}

func zohoDeskClaimMatches(value, prefix, expected string) bool {
	value = strings.TrimSpace(value)
	expected = strings.TrimSpace(expected)
	if value == "" || expected == "" {
		return false
	}
	if strings.EqualFold(value, expected) {
		return true
	}
	want := strings.TrimSpace(prefix) + ":" + expected
	return strings.EqualFold(value, want)
}
