// SPDX-License-Identifier: AGPL-3.0-only
//
// shipping.go — native AfterShip + ShipStation post-purchase connectors.
//
// Shipment lifecycle (shipped / out-for-delivery / delivered / exception) powers
// the highest-engagement transactional + win-back email flows. Both reuse the
// Recharge pattern: a credential resolver + REST puller dispatched via
// Deps.providerPull, landing canonical ShipmentInput rows.
package subscription_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	afterShipDefaultAPIBaseURL = "https://api.aftership.com"
	afterShipDefaultUserAgent  = "Moosewave AfterShip Integration"
	afterShipDefaultPageSize   = 100
	afterShipCursorPrefix      = "aftership:"
	afterShipCursorComplete    = "aftership:complete"

	shipStationDefaultAPIBaseURL = "https://ssapi.shipstation.com"
	shipStationDefaultUserAgent  = "Moosewave ShipStation Integration"
	shipStationDefaultPageSize   = 100
	shipStationCursorPrefix      = "shipstation:"
	shipStationCursorComplete    = "shipstation:complete"
)

// ---------------- AfterShip ----------------

type AfterShipCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type AfterShipCredentialResolver interface {
	ResolveAfterShip(ctx context.Context, tenantID string, integration Integration) (AfterShipCredentials, error)
}

type afterShipCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p afterShipCredentialPayload) credentials() (AfterShipCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return AfterShipCredentials{}, fmt.Errorf("aftership api_key is required")
	}
	return AfterShipCredentials{APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type AfterShipSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r AfterShipSecretsCredentialResolver) ResolveAfterShip(ctx context.Context, _ string, integration Integration) (AfterShipCredentials, error) {
	if r.Secrets == nil {
		return AfterShipCredentials{}, fmt.Errorf("aftership credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return AfterShipCredentials{}, fmt.Errorf("aftership credentials_ref is required")
	}
	var payload afterShipCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AfterShipCredentials{}, fmt.Errorf("resolve aftership credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return afterShipCredentialPayload{APIKey: raw}.credentials()
}

type AfterShipBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AfterShipRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AfterShipCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type afterShipTracking struct {
	ID                   string   `json:"id"`
	TrackingNumber       string   `json:"tracking_number"`
	Slug                 string   `json:"slug"`
	Tag                  string   `json:"tag"`
	Emails               []string `json:"emails"`
	ExpectedDelivery     string   `json:"expected_delivery"`
	ShipmentDeliveryDate string   `json:"shipment_delivery_date"`
	UpdatedAt            string   `json:"updated_at"`
}

type afterShipResponse struct {
	Data struct {
		Page      int                 `json:"page"`
		Limit     int                 `json:"limit"`
		Count     int                 `json:"count"`
		Trackings []afterShipTracking `json:"trackings"`
	} `json:"data"`
}

func (b AfterShipRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAfterShip {
		return SyncRequest{}, fmt.Errorf("aftership backfill requires an AfterShip integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("aftership credential resolver is not configured")
	}
	page, done := decodePageCursor(cursor, afterShipCursorPrefix, afterShipCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: afterShipCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveAfterShip(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderAfterShip, 30*time.Second)
	limit := shippingPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), afterShipDefaultPageSize)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("limit", strconv.Itoa(limit))

	var out afterShipResponse
	if err := shippingDoJSON(ctx, client, firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), afterShipDefaultAPIBaseURL), "/v4/trackings", query,
		map[string]string{"aftership-api-key": strings.TrimSpace(creds.APIKey), "User-Agent": firstString(b.UserAgent, creds.UserAgent, afterShipDefaultUserAgent)}, &out); err != nil {
		return SyncRequest{}, err
	}
	shipments := make([]ShipmentInput, 0, len(out.Data.Trackings))
	for _, tr := range out.Data.Trackings {
		if s, ok := mapAfterShipTracking(tr); ok {
			shipments = append(shipments, s)
		}
	}
	nextCursor := afterShipCursorComplete
	if len(out.Data.Trackings) >= limit {
		nextCursor = afterShipCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Shipments: shipments, Cursor: nextCursor}, nil
}

func mapAfterShipTracking(tr afterShipTracking) (ShipmentInput, bool) {
	email := ""
	if len(tr.Emails) > 0 {
		email = strings.ToLower(strings.TrimSpace(tr.Emails[0]))
	}
	if email == "" {
		return ShipmentInput{}, false
	}
	out := ShipmentInput{
		SourceID:       "aftership://tracking/" + strings.TrimSpace(tr.ID),
		Email:          email,
		TrackingNumber: strings.TrimSpace(tr.TrackingNumber),
		Carrier:        strings.TrimSpace(tr.Slug),
		Status:         strings.TrimSpace(tr.Tag),
		Properties:     map[string]any{"aftership_tracking_id": tr.ID},
	}
	if t := parseRechargeTime(tr.ExpectedDelivery); t != nil {
		out.ETA = t
	}
	if strings.EqualFold(tr.Tag, "Delivered") {
		if t := parseRechargeTime(tr.ShipmentDeliveryDate); t != nil {
			out.DeliveredAt = t
		}
	}
	if t := parseRechargeTime(tr.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

// ---------------- ShipStation ----------------

type ShipStationCredentials struct {
	APIKey     string
	APISecret  string
	APIBaseURL string
	UserAgent  string
}

type ShipStationCredentialResolver interface {
	ResolveShipStation(ctx context.Context, tenantID string, integration Integration) (ShipStationCredentials, error)
}

type shipStationCredentialPayload struct {
	APIKey     string `json:"api_key"`
	APISecret  string `json:"api_secret"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p shipStationCredentialPayload) credentials() (ShipStationCredentials, error) {
	key := strings.TrimSpace(p.APIKey)
	secret := strings.TrimSpace(p.APISecret)
	if key == "" || secret == "" {
		return ShipStationCredentials{}, fmt.Errorf("shipstation api_key and api_secret are required")
	}
	return ShipStationCredentials{APIKey: key, APISecret: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ShipStationSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r ShipStationSecretsCredentialResolver) ResolveShipStation(ctx context.Context, _ string, integration Integration) (ShipStationCredentials, error) {
	if r.Secrets == nil {
		return ShipStationCredentials{}, fmt.Errorf("shipstation credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ShipStationCredentials{}, fmt.Errorf("shipstation credentials_ref is required")
	}
	var payload shipStationCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ShipStationCredentials{}, fmt.Errorf("resolve shipstation credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return ShipStationCredentials{}, fmt.Errorf("shipstation requires a JSON {api_key, api_secret} secret")
}

type ShipStationBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ShipStationRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ShipStationCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type shipStationOrder struct {
	OrderNumber     string `json:"orderNumber"`
	OrderStatus     string `json:"orderStatus"`
	CustomerEmail   string `json:"customerEmail"`
	ModifyDate      string `json:"modifyDate"`
	ShipDate        string `json:"shipDate"`
	AdvancedOptions struct {
		CarrierCode string `json:"carrierCode"`
	} `json:"advancedOptions"`
}

type shipStationResponse struct {
	Orders []shipStationOrder `json:"orders"`
	Total  int                `json:"total"`
	Page   int                `json:"page"`
	Pages  int                `json:"pages"`
}

func (b ShipStationRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderShipStation {
		return SyncRequest{}, fmt.Errorf("shipstation backfill requires a ShipStation integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("shipstation credential resolver is not configured")
	}
	page, done := decodePageCursor(cursor, shipStationCursorPrefix, shipStationCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: shipStationCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveShipStation(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderShipStation, 30*time.Second)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("pageSize", strconv.Itoa(shippingPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), shipStationDefaultPageSize)))
	if status := strings.TrimSpace(settingString(integration.Settings, "order_status")); status != "" {
		query.Set("orderStatus", status)
	}
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.APIKey) + ":" + strings.TrimSpace(creds.APISecret)))

	var out shipStationResponse
	if err := shippingDoJSON(ctx, client, firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), shipStationDefaultAPIBaseURL), "/orders", query,
		map[string]string{"Authorization": "Basic " + basic, "User-Agent": firstString(b.UserAgent, creds.UserAgent, shipStationDefaultUserAgent)}, &out); err != nil {
		return SyncRequest{}, err
	}
	shipments := make([]ShipmentInput, 0, len(out.Orders))
	for _, o := range out.Orders {
		if s, ok := mapShipStationOrder(o); ok {
			shipments = append(shipments, s)
		}
	}
	nextCursor := shipStationCursorComplete
	if out.Pages > page {
		nextCursor = shipStationCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Shipments: shipments, Cursor: nextCursor}, nil
}

func mapShipStationOrder(o shipStationOrder) (ShipmentInput, bool) {
	email := strings.ToLower(strings.TrimSpace(o.CustomerEmail))
	if email == "" {
		return ShipmentInput{}, false
	}
	out := ShipmentInput{
		SourceID:   "shipstation://order/" + strings.TrimSpace(o.OrderNumber),
		Email:      email,
		OrderID:    strings.TrimSpace(o.OrderNumber),
		Status:     strings.TrimSpace(o.OrderStatus),
		Carrier:    strings.TrimSpace(o.AdvancedOptions.CarrierCode),
		Properties: map[string]any{"shipstation_order_number": o.OrderNumber},
	}
	if t := parseRechargeTime(firstString(o.ModifyDate, o.ShipDate)); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

// ---------------- shared helpers ----------------

func decodePageCursor(cursor, prefix, complete string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == complete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, prefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func shippingPageSize(raw string, def int) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return def
	}
	if n > def {
		return def
	}
	return n
}

func shippingDoJSON(ctx context.Context, client *http.Client, baseURL, path string, query url.Values, headers map[string]string, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse shipping API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		if strings.TrimSpace(v) != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, rechargeResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return RechargeRESTError{StatusCode: resp.StatusCode, RetryAfter: parseRechargeRetryAfter(resp.Header.Get("Retry-After")), Snippet: rechargeTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode shipping response %s: %w", path, err)
	}
	return nil
}
