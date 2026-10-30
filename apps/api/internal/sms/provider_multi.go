package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ProviderRouter picks the concrete SMS provider per sender profile. Twilio
// remains the default so existing tenants keep working without config changes.
type ProviderRouter struct {
	Default   string
	Providers map[string]Provider
}

func NewProviderRouterFromEnv() *ProviderRouter {
	twilio := NewTwilioProviderFromEnv()
	telnyx := NewTelnyxProviderFromEnv()
	bandwidth := NewBandwidthProviderFromEnv()
	return &ProviderRouter{
		Default: defaulted(strings.ToLower(strings.TrimSpace(os.Getenv("SMS_DEFAULT_PROVIDER"))), ProviderTwilio),
		Providers: map[string]Provider{
			ProviderTwilio:    twilio,
			ProviderTelnyx:    telnyx,
			ProviderBandwidth: bandwidth,
		},
	}
}

func (r *ProviderRouter) Send(ctx context.Context, msg ProviderOutbound) (ProviderResult, error) {
	if r == nil {
		return ProviderResult{}, fmt.Errorf("sms provider router is not configured")
	}
	providerName := defaulted(strings.ToLower(strings.TrimSpace(msg.Provider)), r.Default)
	providerName = defaulted(providerName, ProviderTwilio)
	provider := r.Providers[providerName]
	if provider == nil {
		return ProviderResult{Provider: providerName}, fmt.Errorf("%s sms provider is not configured", providerName)
	}
	msg.Provider = providerName
	result, err := safeProviderSend(ctx, provider, msg)
	if result.Provider == "" {
		result.Provider = providerName
	}
	return result, err
}

// ConfiguredForSender proves both credential presence and the selected
// sender's provider-specific origin/application identity. A non-nil router is
// not readiness: production intentionally constructs the router even when all
// provider environment variables are absent.
func (r *ProviderRouter) ConfiguredForSender(sender SenderProfile) bool {
	if r == nil {
		return false
	}
	providerName := defaulted(strings.ToLower(strings.TrimSpace(sender.Provider)), r.Default)
	provider := r.Providers[providerName]
	switch p := provider.(type) {
	case *TwilioProvider:
		return p.AccountConfigured() &&
			defaulted(strings.TrimSpace(sender.PhoneNumber), p.DefaultFromNumber) != ""
	case *TelnyxProvider:
		return p.Configured() &&
			defaulted(strings.TrimSpace(sender.PhoneNumber), p.DefaultFromNumber) != ""
	case *BandwidthProvider:
		return p.Configured() &&
			defaulted(strings.TrimSpace(sender.PhoneNumber), p.DefaultFromNumber) != "" &&
			defaulted(strings.TrimSpace(sender.MessagingServiceSID), p.DefaultApplicationID) != ""
	default:
		return false
	}
}

func providerConfiguredForSender(provider Provider, sender SenderProfile) bool {
	if router, ok := provider.(*ProviderRouter); ok {
		return router.ConfiguredForSender(sender)
	}
	// Alternate/test providers must opt into the same explicit readiness
	// contract; a non-nil interface alone never proves transport credentials.
	configured, ok := provider.(interface{ Configured() bool })
	return ok && configured.Configured()
}

func (d *Deps) hasConfiguredDispatchSender(ctx context.Context, tenantID string) (bool, error) {
	if d == nil || d.Provider == nil {
		return false, nil
	}
	senders, err := d.store().ListSenders(ctx, tenantID)
	if err != nil {
		return false, err
	}
	for _, sender := range senders {
		if sender.RegistrationStatus == RegistrationApproved && !SenderPaused(sender.Metadata) && providerConfiguredForSender(d.Provider, sender) {
			return true, nil
		}
	}
	return false, nil
}

func (r *ProviderRouter) Twilio() *TwilioProvider {
	if r == nil {
		return nil
	}
	provider, _ := r.Providers[ProviderTwilio].(*TwilioProvider)
	return provider
}

type TelnyxProvider struct {
	APIKey            string
	DefaultFromNumber string
	DefaultProfileID  string
	DefaultWebhookURL string
	BaseURL           string
	HTTPClient        *http.Client
}

func NewTelnyxProviderFromEnv() *TelnyxProvider {
	return &TelnyxProvider{
		APIKey:            strings.TrimSpace(os.Getenv("TELNYX_API_KEY")),
		DefaultFromNumber: strings.TrimSpace(os.Getenv("TELNYX_FROM_NUMBER")),
		DefaultProfileID:  strings.TrimSpace(os.Getenv("TELNYX_MESSAGING_PROFILE_ID")),
		DefaultWebhookURL: strings.TrimSpace(os.Getenv("TELNYX_WEBHOOK_URL")),
		BaseURL:           defaulted(strings.TrimSpace(os.Getenv("TELNYX_API_BASE_URL")), "https://api.telnyx.com"),
		HTTPClient:        &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *TelnyxProvider) Configured() bool {
	return p != nil && p.APIKey != ""
}

func (p *TelnyxProvider) Send(ctx context.Context, msg ProviderOutbound) (ProviderResult, error) {
	if !p.Configured() {
		return ProviderResult{Provider: ProviderTelnyx}, fmt.Errorf("telnyx provider is not configured")
	}
	payload := map[string]any{
		"to":   msg.To,
		"text": msg.Body,
		"type": "SMS",
	}
	from := defaulted(msg.FromNumber, p.DefaultFromNumber)
	if from != "" {
		payload["from"] = from
	}
	profileID := defaulted(msg.MessagingServiceSID, p.DefaultProfileID)
	if profileID != "" {
		payload["messaging_profile_id"] = profileID
	}
	if from == "" && profileID == "" {
		return ProviderResult{Provider: ProviderTelnyx}, fmt.Errorf("telnyx from number or messaging profile id is required")
	}
	if msg.MediaURL != "" {
		payload["type"] = "MMS"
		payload["media_urls"] = []string{msg.MediaURL}
	}
	if webhook := defaulted(msg.StatusCallbackURL, p.DefaultWebhookURL); webhook != "" {
		payload["webhook_url"] = webhook
	}
	raw, err := p.doTelnyxJSON(ctx, http.MethodPost, "/v2/messages", payload)
	if err != nil {
		return ProviderResult{Provider: ProviderTelnyx, Raw: raw, ErrorCode: telnyxErrorCode(raw), ErrorMessage: telnyxErrorMessage(raw), RetryAfter: retryAfterFromRaw(raw)}, err
	}
	data := mapFromAny(raw["data"])
	return ProviderResult{
		Provider:  ProviderTelnyx,
		MessageID: stringFromAny(data["id"]),
		// Preserve the carrier value for the saga's fail-closed classifier.
		// An absent or novel status is an uncertain outcome, not queued.
		Status:      strings.ToLower(strings.TrimSpace(telnyxRecipientStatus(data))),
		RetryAfter:  retryAfterFromRaw(raw),
		PriceMicros: telnyxCostMicros(data),
		Raw:         raw,
	}, nil
}

func (p *TelnyxProvider) SubmitBrandRegistration(ctx context.Context, in A2PBrandRegistrationInput) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("telnyx provider is not configured")
	}
	payload := compactMap(map[string]any{
		"entityType":        defaulted(in.EntityType, "PRIVATE_PROFIT"),
		"displayName":       in.DisplayName,
		"companyName":       in.CompanyName,
		"ein":               in.EIN,
		"phone":             in.Phone,
		"street":            in.Street,
		"city":              in.City,
		"state":             in.State,
		"postalCode":        in.PostalCode,
		"country":           defaulted(in.Country, "US"),
		"email":             in.Email,
		"website":           in.Website,
		"vertical":          in.Vertical,
		"altBusinessId":     in.AltBusinessID,
		"altBusinessIdType": in.AltBusinessIDType,
		"stockSymbol":       in.StockSymbol,
		"stockExchange":     in.StockExchange,
	})
	raw, err := p.doTelnyxJSON(ctx, http.MethodPost, "/v2/10dlc/brand", payload)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return telnyxRegistrationResource(raw, "brand"), nil
}

func (p *TelnyxProvider) FetchBrandRegistration(ctx context.Context, brandID string) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("telnyx provider is not configured")
	}
	raw, err := p.doTelnyxJSON(ctx, http.MethodGet, "/v2/10dlc/brand/"+url.PathEscape(strings.TrimSpace(brandID)), nil)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return telnyxRegistrationResource(raw, "brand"), nil
}

func (p *TelnyxProvider) SubmitA2PCampaign(ctx context.Context, in A2PCampaignRegistrationInput) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("telnyx provider is not configured")
	}
	samples := in.MessageSamples
	payload := compactMap(map[string]any{
		"brandId":            strings.TrimSpace(in.BrandRegistrationSID),
		"usecase":            defaulted(in.Usecase, "MARKETING"),
		"description":        in.Description,
		"sample1":            sampleAt(samples, 0),
		"sample2":            sampleAt(samples, 1),
		"sample3":            sampleAt(samples, 2),
		"sample4":            sampleAt(samples, 3),
		"sample5":            sampleAt(samples, 4),
		"messageFlow":        in.MessageFlow,
		"helpMessage":        in.HelpMessage,
		"optinKeywords":      defaulted(in.OptInKeywords, "START, YES, SUBSCRIBE"),
		"optoutKeywords":     defaulted(in.OptOutKeywords, "STOP, UNSUBSCRIBE, CANCEL, QUIT"),
		"helpKeywords":       defaulted(in.HelpKeywords, "HELP, INFO"),
		"embeddedLink":       in.HasEmbeddedLinks,
		"embeddedPhone":      in.HasEmbeddedPhone,
		"numberPool":         in.NumberPool,
		"ageGated":           in.AgeGated,
		"directLending":      in.DirectLending,
		"affiliateMarketing": in.AffiliateMarketing,
	})
	raw, err := p.doTelnyxJSON(ctx, http.MethodPost, "/v2/10dlc/campaignBuilder", payload)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return telnyxRegistrationResource(raw, "campaign"), nil
}

func (p *TelnyxProvider) FetchA2PCampaign(ctx context.Context, campaignID string) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("telnyx provider is not configured")
	}
	raw, err := p.doTelnyxJSON(ctx, http.MethodGet, "/v2/10dlc/campaignBuilder/"+url.PathEscape(strings.TrimSpace(campaignID)), nil)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return telnyxRegistrationResource(raw, "campaign"), nil
}

func (p *TelnyxProvider) doTelnyxJSON(ctx context.Context, method, path string, payload map[string]any) (map[string]any, error) {
	var body io.Reader
	if payload != nil {
		rawBody, _ := json.Marshal(payload)
		body = bytes.NewReader(rawBody)
	}
	endpoint, err := providerURL(p.BaseURL, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := p.HTTPClient
	if client == nil {
		client = defaultSMSHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, providerOperationError(ProviderTelnyx, "request", 0, "transport")
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := readProviderBodyLimited(resp.Body)
	raw := map[string]any{}
	if readErr == nil {
		_ = json.Unmarshal(respBody, &raw)
	}
	attachRetryAfter(raw, resp)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return raw, providerOperationError(ProviderTelnyx, "request", resp.StatusCode, "response_read")
		}
		return raw, providerOperationError(ProviderTelnyx, "request", resp.StatusCode, telnyxErrorCode(raw))
	}
	if readErr != nil {
		return raw, providerOperationError(ProviderTelnyx, "request", resp.StatusCode, "response_read")
	}
	return raw, nil
}

type BandwidthProvider struct {
	AccountID            string
	Username             string
	Password             string
	DefaultApplicationID string
	DefaultFromNumber    string
	BaseURL              string
	CampaignBaseURL      string
	HTTPClient           *http.Client
}

func NewBandwidthProviderFromEnv() *BandwidthProvider {
	return &BandwidthProvider{
		AccountID:            strings.TrimSpace(os.Getenv("BANDWIDTH_ACCOUNT_ID")),
		Username:             strings.TrimSpace(os.Getenv("BANDWIDTH_API_USERNAME")),
		Password:             strings.TrimSpace(os.Getenv("BANDWIDTH_API_PASSWORD")),
		DefaultApplicationID: strings.TrimSpace(os.Getenv("BANDWIDTH_APPLICATION_ID")),
		DefaultFromNumber:    strings.TrimSpace(os.Getenv("BANDWIDTH_FROM_NUMBER")),
		BaseURL:              defaulted(strings.TrimSpace(os.Getenv("BANDWIDTH_API_BASE_URL")), "https://messaging.bandwidth.com"),
		CampaignBaseURL:      defaulted(strings.TrimSpace(os.Getenv("BANDWIDTH_CAMPAIGN_API_BASE_URL")), "https://api.bandwidth.com"),
		HTTPClient:           &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *BandwidthProvider) Configured() bool {
	return p != nil && p.AccountID != "" && p.Username != "" && p.Password != ""
}

func (p *BandwidthProvider) Send(ctx context.Context, msg ProviderOutbound) (ProviderResult, error) {
	if !p.Configured() {
		return ProviderResult{Provider: ProviderBandwidth}, fmt.Errorf("bandwidth provider is not configured")
	}
	applicationID := defaulted(msg.MessagingServiceSID, p.DefaultApplicationID)
	from := defaulted(msg.FromNumber, p.DefaultFromNumber)
	if from == "" || applicationID == "" {
		return ProviderResult{Provider: ProviderBandwidth}, fmt.Errorf("bandwidth from number and application id are required")
	}
	payload := map[string]any{
		"to":            []string{msg.To},
		"from":          from,
		"text":          msg.Body,
		"applicationId": applicationID,
		"tag":           "postwave",
	}
	if msg.MediaURL != "" {
		payload["media"] = []string{msg.MediaURL}
	}
	raw, err := p.doJSON(ctx, payload)
	if err != nil {
		return ProviderResult{Provider: ProviderBandwidth, Raw: raw, ErrorCode: stringFromAny(raw["code"]), ErrorMessage: stringFromAny(raw["message"]), RetryAfter: retryAfterFromRaw(raw)}, err
	}
	return ProviderResult{
		Provider:  ProviderBandwidth,
		MessageID: stringFromAny(raw["id"]),
		// Bandwidth's accepted HTTP response is the only synchronous state it
		// returns here; do not invent a queued callback state.
		Status:      "accepted",
		RetryAfter:  retryAfterFromRaw(raw),
		PriceMicros: 0,
		Raw:         raw,
	}, nil
}

func (p *BandwidthProvider) doJSON(ctx context.Context, payload map[string]any) (map[string]any, error) {
	body, _ := json.Marshal(payload)
	path := "/api/v2/users/" + url.PathEscape(p.AccountID) + "/messages"
	endpoint, err := providerURL(p.BaseURL, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.Username, p.Password)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	client := p.HTTPClient
	if client == nil {
		client = defaultSMSHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, providerOperationError(ProviderBandwidth, "send", 0, "transport")
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := readProviderBodyLimited(resp.Body)
	raw := map[string]any{}
	if readErr == nil {
		_ = json.Unmarshal(respBody, &raw)
	}
	attachRetryAfter(raw, resp)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return raw, providerOperationError(ProviderBandwidth, "send", resp.StatusCode, "response_read")
		}
		return raw, providerOperationError(ProviderBandwidth, "send", resp.StatusCode, stringFromAny(raw["code"]))
	}
	if readErr != nil {
		return raw, providerOperationError(ProviderBandwidth, "send", resp.StatusCode, "response_read")
	}
	return raw, nil
}

func (p *BandwidthProvider) SubmitBrandRegistration(ctx context.Context, in A2PBrandRegistrationInput) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("bandwidth provider is not configured")
	}
	isMain := true
	if in.IsMain != nil {
		isMain = *in.IsMain
	}
	body := bandwidthBrandXML{
		EntityType:           defaulted(in.EntityType, "PRIVATE_PROFIT"),
		AltBusinessID:        in.AltBusinessID,
		AltBusinessIDType:    in.AltBusinessIDType,
		BrandRelationship:    in.BrandRelationship,
		City:                 in.City,
		CompanyName:          in.CompanyName,
		Country:              defaulted(in.Country, "US"),
		DisplayName:          in.DisplayName,
		EIN:                  in.EIN,
		Email:                in.Email,
		Phone:                in.Phone,
		PostalCode:           in.PostalCode,
		State:                in.State,
		Street:               in.Street,
		StockExchange:        in.StockExchange,
		StockSymbol:          in.StockSymbol,
		Vertical:             in.Vertical,
		Website:              in.Website,
		BusinessContactEmail: in.BusinessContactEmail,
		IsMain:               isMain,
	}
	raw, err := p.doBandwidthXML(ctx, http.MethodPost, "/api/accounts/"+url.PathEscape(p.AccountID)+"/campaignManagement/10dlc/brands", body)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	resp := bandwidthBrandResponse{}
	_ = xml.Unmarshal(raw, &resp)
	if resp.ResponseStatus.Description != "" {
		return SmsRegistrationResource{}, providerOperationError(ProviderBandwidth, "brand_registration", http.StatusUnprocessableEntity, resp.ResponseStatus.ErrorCode)
	}
	return SmsRegistrationResource{SID: resp.Brand.BrandID, Status: defaulted(resp.Brand.IdentityStatus, resp.Brand.Status), Raw: xmlRawMap(raw)}, nil
}

func (p *BandwidthProvider) FetchBrandRegistration(ctx context.Context, brandID string) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("bandwidth provider is not configured")
	}
	raw, err := p.doBandwidthXML(ctx, http.MethodGet, "/api/accounts/"+url.PathEscape(p.AccountID)+"/campaignManagement/10dlc/brands/"+url.PathEscape(strings.TrimSpace(brandID)), nil)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	resp := bandwidthBrandResponse{}
	_ = xml.Unmarshal(raw, &resp)
	if resp.ResponseStatus.Description != "" {
		return SmsRegistrationResource{}, providerOperationError(ProviderBandwidth, "brand_poll", http.StatusUnprocessableEntity, resp.ResponseStatus.ErrorCode)
	}
	return SmsRegistrationResource{SID: resp.Brand.BrandID, Status: defaulted(resp.Brand.IdentityStatus, resp.Brand.Status), Raw: xmlRawMap(raw)}, nil
}

func (p *BandwidthProvider) SubmitA2PCampaign(ctx context.Context, in A2PCampaignRegistrationInput) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("bandwidth provider is not configured")
	}
	autoRenewal := true
	if in.AutoRenewal != nil {
		autoRenewal = *in.AutoRenewal
	}
	body := bandwidthCampaignXML{
		BrandID:                strings.TrimSpace(in.BrandRegistrationSID),
		Usecase:                defaulted(in.Usecase, "MARKETING"),
		Vertical:               in.Vertical,
		Description:            in.Description,
		Sample1:                sampleAt(in.MessageSamples, 0),
		Sample2:                sampleAt(in.MessageSamples, 1),
		Sample3:                sampleAt(in.MessageSamples, 2),
		Sample4:                sampleAt(in.MessageSamples, 3),
		Sample5:                sampleAt(in.MessageSamples, 4),
		MessageFlow:            in.MessageFlow,
		HelpKeywords:           defaulted(in.HelpKeywords, "HELP"),
		HelpMessage:            in.HelpMessage,
		OptinKeywords:          defaulted(in.OptInKeywords, "START,YES"),
		OptinMessage:           in.OptInMessage,
		OptoutKeywords:         defaulted(in.OptOutKeywords, "STOP,NO"),
		OptoutMessage:          in.OptOutMessage,
		SubscriberOptIn:        in.SubscriberOptIn,
		SubscriberOptOut:       true,
		SubscriberHelp:         true,
		EmbeddedLink:           in.HasEmbeddedLinks,
		EmbeddedPhone:          in.HasEmbeddedPhone,
		NumberPool:             in.NumberPool,
		AgeGated:               in.AgeGated,
		DirectLending:          in.DirectLending,
		AffiliateMarketing:     in.AffiliateMarketing,
		AutoRenewal:            autoRenewal,
		TermsAndConditionsLink: in.TermsAndConditionsLink,
		PrivacyPolicyLink:      in.PrivacyPolicyLink,
	}
	raw, err := p.doBandwidthXML(ctx, http.MethodPost, "/api/accounts/"+url.PathEscape(p.AccountID)+"/campaignManagement/10dlc/campaigns", body)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	resp := bandwidthCampaignResponse{}
	_ = xml.Unmarshal(raw, &resp)
	if resp.ResponseStatus.Description != "" {
		return SmsRegistrationResource{}, providerOperationError(ProviderBandwidth, "campaign_registration", http.StatusUnprocessableEntity, resp.ResponseStatus.ErrorCode)
	}
	return SmsRegistrationResource{SID: resp.Campaign.CampaignID, Status: resp.Campaign.Status, Raw: xmlRawMap(raw)}, nil
}

func (p *BandwidthProvider) FetchA2PCampaign(ctx context.Context, campaignID string) (SmsRegistrationResource, error) {
	if !p.Configured() {
		return SmsRegistrationResource{}, fmt.Errorf("bandwidth provider is not configured")
	}
	raw, err := p.doBandwidthXML(ctx, http.MethodGet, "/api/accounts/"+url.PathEscape(p.AccountID)+"/campaignManagement/10dlc/campaigns/"+url.PathEscape(strings.TrimSpace(campaignID)), nil)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	resp := bandwidthCampaignResponse{}
	_ = xml.Unmarshal(raw, &resp)
	if resp.ResponseStatus.Description != "" {
		return SmsRegistrationResource{}, providerOperationError(ProviderBandwidth, "campaign_poll", http.StatusUnprocessableEntity, resp.ResponseStatus.ErrorCode)
	}
	return SmsRegistrationResource{SID: resp.Campaign.CampaignID, Status: resp.Campaign.Status, Raw: xmlRawMap(raw)}, nil
}

func (p *BandwidthProvider) doBandwidthXML(ctx context.Context, method, path string, payload any) ([]byte, error) {
	var body io.Reader
	if payload != nil {
		rawBody, _ := xml.Marshal(payload)
		body = bytes.NewReader(append([]byte(xml.Header), rawBody...))
	}
	base := defaulted(p.CampaignBaseURL, "https://api.bandwidth.com")
	endpoint, err := providerURL(base, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.Username, p.Password)
	req.Header.Set("Accept", "application/xml")
	if payload != nil {
		req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	}
	client := p.HTTPClient
	if client == nil {
		client = defaultSMSHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, providerOperationError(ProviderBandwidth, "registration", 0, "transport")
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := readProviderBodyLimited(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return respBody, fmt.Errorf("bandwidth campaign management failed: %s: %w", resp.Status, readErr)
		}
		return respBody, fmt.Errorf("bandwidth campaign management failed: %s", resp.Status)
	}
	if readErr != nil {
		return nil, fmt.Errorf("bandwidth campaign management failed: %w", readErr)
	}
	return respBody, nil
}

func mapFromAny(v any) map[string]any {
	if out, ok := v.(map[string]any); ok {
		return out
	}
	return map[string]any{}
}

func telnyxRecipientStatus(data map[string]any) string {
	items, ok := data["to"].([]any)
	if !ok || len(items) == 0 {
		return stringFromAny(data["status"])
	}
	first := mapFromAny(items[0])
	return stringFromAny(first["status"])
}

func telnyxCostMicros(data map[string]any) int64 {
	if cost := mapFromAny(data["cost"]); len(cost) > 0 {
		return priceMicros(cost["amount"])
	}
	return 0
}

func telnyxErrorCode(raw map[string]any) string {
	if data := mapFromAny(raw["data"]); len(data) > 0 {
		return stringFromAny(data["code"])
	}
	if errs, ok := raw["errors"].([]any); ok && len(errs) > 0 {
		return stringFromAny(mapFromAny(errs[0])["code"])
	}
	return stringFromAny(raw["code"])
}

func telnyxErrorMessage(raw map[string]any) string {
	if data := mapFromAny(raw["data"]); len(data) > 0 {
		return stringFromAny(data["detail"])
	}
	if errs, ok := raw["errors"].([]any); ok && len(errs) > 0 {
		item := mapFromAny(errs[0])
		return defaulted(stringFromAny(item["detail"]), stringFromAny(item["title"]))
	}
	return stringFromAny(raw["message"])
}

func telnyxRegistrationResource(raw map[string]any, kind string) SmsRegistrationResource {
	data := mapFromAny(raw["data"])
	idKeys := []string{"id", "sid"}
	if kind == "brand" {
		idKeys = append([]string{"brandId", "brand_id"}, idKeys...)
	} else {
		idKeys = append([]string{"campaignId", "campaign_id"}, idKeys...)
	}
	statusKeys := []string{"status"}
	if kind == "brand" {
		statusKeys = append([]string{"identityStatus", "identity_status"}, statusKeys...)
	}
	return SmsRegistrationResource{
		SID:    firstMapString(data, idKeys...),
		Status: firstMapString(data, statusKeys...),
		Raw:    raw,
	}
}

func compactMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range in {
		switch v := value.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				out[key] = strings.TrimSpace(v)
			}
		case []string:
			if len(v) > 0 {
				out[key] = v
			}
		default:
			out[key] = value
		}
	}
	return out
}

func sampleAt(samples []string, idx int) string {
	if idx < 0 || idx >= len(samples) {
		return ""
	}
	return strings.TrimSpace(samples[idx])
}

func firstMapString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(stringFromAny(m[key])); value != "" {
			return value
		}
	}
	return ""
}

func xmlRawMap(raw []byte) map[string]any {
	return map[string]any{"xml": string(raw)}
}

type bandwidthResponseStatus struct {
	ErrorCode   string `xml:"ErrorCode"`
	Description string `xml:"Description"`
}

type bandwidthBrandXML struct {
	XMLName              xml.Name `xml:"Brand"`
	EntityType           string   `xml:"EntityType,omitempty"`
	AltBusinessID        string   `xml:"AltBusinessId,omitempty"`
	AltBusinessIDType    string   `xml:"AltBusinessIdType,omitempty"`
	BrandRelationship    string   `xml:"BrandRelationship,omitempty"`
	City                 string   `xml:"City,omitempty"`
	CompanyName          string   `xml:"CompanyName,omitempty"`
	Country              string   `xml:"Country,omitempty"`
	DisplayName          string   `xml:"DisplayName,omitempty"`
	EIN                  string   `xml:"Ein,omitempty"`
	Email                string   `xml:"Email,omitempty"`
	Phone                string   `xml:"Phone,omitempty"`
	PostalCode           string   `xml:"PostalCode,omitempty"`
	State                string   `xml:"State,omitempty"`
	Street               string   `xml:"Street,omitempty"`
	StockExchange        string   `xml:"StockExchange,omitempty"`
	StockSymbol          string   `xml:"StockSymbol,omitempty"`
	Vertical             string   `xml:"Vertical,omitempty"`
	Website              string   `xml:"Website,omitempty"`
	BusinessContactEmail string   `xml:"BusinessContactEmail,omitempty"`
	IsMain               bool     `xml:"IsMain"`
}

type bandwidthBrandResponse struct {
	Brand struct {
		BrandID        string `xml:"BrandId"`
		Status         string `xml:"Status"`
		IdentityStatus string `xml:"IdentityStatus"`
	} `xml:"Brand"`
	ResponseStatus bandwidthResponseStatus `xml:"ResponseStatus"`
}

type bandwidthCampaignXML struct {
	XMLName                xml.Name `xml:"Campaign"`
	BrandID                string   `xml:"BrandId,omitempty"`
	Usecase                string   `xml:"Usecase,omitempty"`
	Vertical               string   `xml:"Vertical,omitempty"`
	Description            string   `xml:"Description,omitempty"`
	Sample1                string   `xml:"Sample1,omitempty"`
	Sample2                string   `xml:"Sample2,omitempty"`
	Sample3                string   `xml:"Sample3,omitempty"`
	Sample4                string   `xml:"Sample4,omitempty"`
	Sample5                string   `xml:"Sample5,omitempty"`
	MessageFlow            string   `xml:"MessageFlow,omitempty"`
	HelpKeywords           string   `xml:"HelpKeywords,omitempty"`
	HelpMessage            string   `xml:"HelpMessage,omitempty"`
	OptinKeywords          string   `xml:"OptinKeywords,omitempty"`
	OptinMessage           string   `xml:"OptinMessage,omitempty"`
	OptoutKeywords         string   `xml:"OptoutKeywords,omitempty"`
	OptoutMessage          string   `xml:"OptoutMessage,omitempty"`
	SubscriberOptIn        bool     `xml:"SubscriberOptIn"`
	SubscriberOptOut       bool     `xml:"SubscriberOptOut"`
	SubscriberHelp         bool     `xml:"SubscriberHelp"`
	EmbeddedLink           bool     `xml:"EmbeddedLink"`
	EmbeddedPhone          bool     `xml:"EmbeddedPhone"`
	NumberPool             bool     `xml:"NumberPool"`
	AgeGated               bool     `xml:"AgeGated"`
	DirectLending          bool     `xml:"DirectLending"`
	AffiliateMarketing     bool     `xml:"AffiliateMarketing"`
	AutoRenewal            bool     `xml:"AutoRenewal"`
	TermsAndConditionsLink string   `xml:"TermsAndConditionsLink,omitempty"`
	PrivacyPolicyLink      string   `xml:"PrivacyPolicyLink,omitempty"`
}

type bandwidthCampaignResponse struct {
	Campaign struct {
		CampaignID string `xml:"CampaignId"`
		Status     string `xml:"Status"`
	} `xml:"Campaign"`
	ResponseStatus bandwidthResponseStatus `xml:"ResponseStatus"`
}
