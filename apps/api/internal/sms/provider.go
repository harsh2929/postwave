package sms

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type TwilioProvider struct {
	AccountSID        string
	AuthToken         string
	DefaultFromNumber string
	DefaultServiceSID string
	StatusCallbackURL string
	BaseURL           string
	MessagingBaseURL  string
	HTTPClient        *http.Client
}

var defaultSMSHTTPClient = &http.Client{Timeout: 10 * time.Second}

const smsProviderMaxResponseBytes int64 = 1 << 20

func NewTwilioProviderFromEnv() *TwilioProvider {
	return &TwilioProvider{
		AccountSID:        strings.TrimSpace(os.Getenv("TWILIO_ACCOUNT_SID")),
		AuthToken:         strings.TrimSpace(os.Getenv("TWILIO_AUTH_TOKEN")),
		DefaultFromNumber: strings.TrimSpace(os.Getenv("TWILIO_FROM_NUMBER")),
		DefaultServiceSID: strings.TrimSpace(os.Getenv("TWILIO_MESSAGING_SERVICE_SID")),
		StatusCallbackURL: strings.TrimSpace(os.Getenv("TWILIO_STATUS_CALLBACK_URL")),
		BaseURL:           defaulted(strings.TrimSpace(os.Getenv("TWILIO_API_BASE_URL")), "https://api.twilio.com"),
		MessagingBaseURL:  defaulted(strings.TrimSpace(os.Getenv("TWILIO_MESSAGING_API_BASE_URL")), "https://messaging.twilio.com"),
		HTTPClient:        &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *TwilioProvider) AccountConfigured() bool {
	return p != nil && p.AccountSID != "" && p.AuthToken != ""
}

func (p *TwilioProvider) Configured() bool {
	return p.AccountConfigured() && (p.DefaultFromNumber != "" || p.DefaultServiceSID != "")
}

func (p *TwilioProvider) SubmitBrandRegistration(ctx context.Context, in TwilioBrandRegistrationInput) (SmsRegistrationResource, error) {
	if !p.AccountConfigured() {
		return SmsRegistrationResource{}, fmt.Errorf("twilio provider is not configured")
	}
	form := url.Values{}
	form.Set("CustomerProfileBundleSid", strings.TrimSpace(in.CustomerProfileBundleSID))
	form.Set("A2PProfileBundleSid", strings.TrimSpace(in.A2PProfileBundleSID))
	form.Set("BrandType", defaulted(in.BrandType, "STANDARD"))
	form.Set("SkipAutomaticSecVet", twilioBool(in.SkipAutomaticSecVet))

	raw, err := p.doMessagingForm(ctx, http.MethodPost, "/v1/a2p/BrandRegistrations", form)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return twilioRegistrationResource(raw), nil
}

func (p *TwilioProvider) FetchBrandRegistration(ctx context.Context, brandRegistrationSID string) (SmsRegistrationResource, error) {
	if !p.AccountConfigured() {
		return SmsRegistrationResource{}, fmt.Errorf("twilio provider is not configured")
	}
	path := "/v1/a2p/BrandRegistrations/" + url.PathEscape(strings.TrimSpace(brandRegistrationSID))
	raw, err := p.doMessagingGet(ctx, path)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return twilioRegistrationResource(raw), nil
}

func (p *TwilioProvider) SubmitA2PCampaign(ctx context.Context, messagingServiceSID string, in A2PCampaignRegistrationInput) (SmsRegistrationResource, error) {
	if !p.AccountConfigured() {
		return SmsRegistrationResource{}, fmt.Errorf("twilio provider is not configured")
	}
	serviceSID := strings.TrimSpace(defaulted(messagingServiceSID, p.DefaultServiceSID))
	if serviceSID == "" {
		return SmsRegistrationResource{}, fmt.Errorf("twilio messaging service SID is required")
	}
	if strings.TrimSpace(in.PrivacyPolicyLink) == "" || strings.TrimSpace(in.TermsAndConditionsLink) == "" {
		return SmsRegistrationResource{}, fmt.Errorf("twilio A2P campaign privacy_policy_link and terms_and_conditions_link are required")
	}
	form := url.Values{}
	form.Set("BrandRegistrationSid", strings.TrimSpace(in.BrandRegistrationSID))
	form.Set("UsAppToPersonUsecase", defaulted(in.Usecase, "MARKETING"))
	form.Set("Description", strings.TrimSpace(in.Description))
	form.Set("MessageFlow", strings.TrimSpace(in.MessageFlow))
	for _, sample := range in.MessageSamples {
		if strings.TrimSpace(sample) != "" {
			form.Add("MessageSamples", strings.TrimSpace(sample))
		}
	}
	form.Set("SubscriberOptIn", twilioBool(in.SubscriberOptIn))
	form.Set("HasEmbeddedLinks", twilioBool(in.HasEmbeddedLinks))
	form.Set("HasEmbeddedPhone", twilioBool(in.HasEmbeddedPhone))
	form.Set("AgeGated", twilioBool(in.AgeGated))
	form.Set("DirectLending", twilioBool(in.DirectLending))
	form.Set("OptInKeywords", defaulted(in.OptInKeywords, "START, UNSTOP"))
	form.Set("OptInMessage", strings.TrimSpace(in.OptInMessage))
	form.Set("OptOutKeywords", defaulted(in.OptOutKeywords, "STOP, STOPALL, UNSUBSCRIBE, CANCEL, END"))
	form.Set("OptOutMessage", strings.TrimSpace(in.OptOutMessage))
	form.Set("HelpKeywords", defaulted(in.HelpKeywords, "HELP"))
	form.Set("HelpMessage", strings.TrimSpace(in.HelpMessage))
	form.Set("PrivacyPolicyUrl", strings.TrimSpace(in.PrivacyPolicyLink))
	form.Set("TermsAndConditionsUrl", strings.TrimSpace(in.TermsAndConditionsLink))

	path := "/v1/Services/" + url.PathEscape(serviceSID) + "/Compliance/Usa2p"
	raw, err := p.doMessagingForm(ctx, http.MethodPost, path, form)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return twilioRegistrationResource(raw), nil
}

func (p *TwilioProvider) FetchA2PCampaign(ctx context.Context, messagingServiceSID, campaignRegistrationSID string) (SmsRegistrationResource, error) {
	if !p.AccountConfigured() {
		return SmsRegistrationResource{}, fmt.Errorf("twilio provider is not configured")
	}
	serviceSID := strings.TrimSpace(defaulted(messagingServiceSID, p.DefaultServiceSID))
	if serviceSID == "" {
		return SmsRegistrationResource{}, fmt.Errorf("twilio messaging service SID is required")
	}
	path := "/v1/Services/" + url.PathEscape(serviceSID) + "/Compliance/Usa2p/" + url.PathEscape(strings.TrimSpace(campaignRegistrationSID))
	raw, err := p.doMessagingGet(ctx, path)
	if err != nil {
		return SmsRegistrationResource{}, err
	}
	return twilioRegistrationResource(raw), nil
}

func (p *TwilioProvider) Send(ctx context.Context, msg ProviderOutbound) (ProviderResult, error) {
	if !p.Configured() {
		return ProviderResult{}, fmt.Errorf("twilio provider is not configured")
	}
	form := url.Values{}
	form.Set("To", msg.To)
	form.Set("Body", msg.Body)
	if msg.MediaURL != "" {
		form.Add("MediaUrl", msg.MediaURL)
	}
	callback := defaulted(msg.StatusCallbackURL, p.StatusCallbackURL)
	if callback != "" {
		form.Set("StatusCallback", callback)
	}
	serviceSID := defaulted(msg.MessagingServiceSID, p.DefaultServiceSID)
	fromNumber := defaulted(msg.FromNumber, p.DefaultFromNumber)
	if serviceSID != "" {
		form.Set("MessagingServiceSid", serviceSID)
	} else {
		form.Set("From", fromNumber)
	}

	endpoint, err := providerURL(p.BaseURL, "/2010-04-01/Accounts/"+url.PathEscape(p.AccountSID)+"/Messages.json")
	if err != nil {
		return ProviderResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return ProviderResult{}, err
	}
	req.SetBasicAuth(p.AccountSID, p.AuthToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := p.HTTPClient
	if client == nil {
		client = defaultSMSHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return ProviderResult{Provider: ProviderTwilio}, providerOperationError(ProviderTwilio, "send", 0, "transport")
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readProviderBodyLimited(resp.Body)

	var raw map[string]any
	if readErr == nil {
		_ = json.Unmarshal(body, &raw)
	}
	retryAfter := attachRetryAfter(raw, resp)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return ProviderResult{Provider: ProviderTwilio, RetryAfter: retryAfter}, providerOperationError(ProviderTwilio, "send", resp.StatusCode, "response_read")
		}
		if raw != nil {
			return ProviderResult{Raw: raw, ErrorCode: stringFromAny(raw["code"]), ErrorMessage: stringFromAny(raw["message"]), RetryAfter: retryAfter},
				providerOperationError(ProviderTwilio, "send", resp.StatusCode, stringFromAny(raw["code"]))
		}
		return ProviderResult{Provider: ProviderTwilio, RetryAfter: retryAfter}, providerOperationError(ProviderTwilio, "send", resp.StatusCode, "")
	}
	if readErr != nil {
		return ProviderResult{Provider: ProviderTwilio, RetryAfter: retryAfter}, providerOperationError(ProviderTwilio, "send", resp.StatusCode, "response_read")
	}

	return ProviderResult{
		Provider:  ProviderTwilio,
		MessageID: stringFromAny(raw["sid"]),
		// Preserve the carrier value. The durable reply boundary classifies it
		// fail-closed; missing/unknown must enter reconciliation rather than be
		// manufactured into an authoritative queued result.
		Status:       strings.ToLower(strings.TrimSpace(stringFromAny(raw["status"]))),
		ErrorCode:    stringFromAny(raw["error_code"]),
		ErrorMessage: stringFromAny(raw["error_message"]),
		RetryAfter:   retryAfter,
		PriceMicros:  priceMicros(raw["price"]),
		Raw:          raw,
	}, nil
}

func (p *TwilioProvider) doMessagingForm(ctx context.Context, method, path string, form url.Values) (map[string]any, error) {
	base := defaulted(p.MessagingBaseURL, "https://messaging.twilio.com")
	endpoint, err := providerURL(base, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.AccountSID, p.AuthToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return p.doTwilioJSON(req)
}

func (p *TwilioProvider) doMessagingGet(ctx context.Context, path string) (map[string]any, error) {
	base := defaulted(p.MessagingBaseURL, "https://messaging.twilio.com")
	endpoint, err := providerURL(base, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.AccountSID, p.AuthToken)
	return p.doTwilioJSON(req)
}

func (p *TwilioProvider) doTwilioJSON(req *http.Request) (map[string]any, error) {
	client := p.HTTPClient
	if client == nil {
		client = defaultSMSHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, providerOperationError(ProviderTwilio, "registration", 0, "transport")
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readProviderBodyLimited(resp.Body)
	var raw map[string]any
	if readErr == nil {
		_ = json.Unmarshal(body, &raw)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return nil, providerOperationError(ProviderTwilio, "registration", resp.StatusCode, "response_read")
		}
		if raw != nil {
			return raw, providerOperationError(ProviderTwilio, "registration", resp.StatusCode, stringFromAny(raw["code"]))
		}
		return nil, providerOperationError(ProviderTwilio, "registration", resp.StatusCode, "")
	}
	if readErr != nil {
		return nil, providerOperationError(ProviderTwilio, "registration", resp.StatusCode, "response_read")
	}
	if raw == nil {
		raw = map[string]any{}
	}
	return raw, nil
}

// providerOperationError is deliberately content-minimized. Upstream response
// text and transport errors can echo recipients, message bodies, account IDs,
// request URLs or credentials; only fixed operation names, HTTP status and a
// reviewed provider code are safe for application/OTel logs.
func providerOperationError(provider, operation string, status int, code string) error {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if !oneOf(provider, ProviderTwilio, ProviderTelnyx, ProviderBandwidth) {
		provider = "sms_provider"
	}
	operation = safeInboxProviderCode(operation)
	if operation == "" {
		operation = "request"
	}
	code = safeInboxProviderCode(code)
	if status >= 100 && status <= 599 {
		if code != "" {
			return fmt.Errorf("%s %s failed (http %d, code %s)", provider, operation, status, code)
		}
		return fmt.Errorf("%s %s failed (http %d)", provider, operation, status)
	}
	if code != "" {
		return fmt.Errorf("%s %s failed (code %s)", provider, operation, code)
	}
	return fmt.Errorf("%s %s failed", provider, operation)
}

func readProviderBodyLimited(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, smsProviderMaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > smsProviderMaxResponseBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return body, nil
}

func attachRetryAfter(raw map[string]any, resp *http.Response) time.Duration {
	retryAfter := providerRetryAfter(resp)
	if retryAfter > 0 && raw != nil {
		raw["_retry_after_seconds"] = int(retryAfter.Round(time.Second) / time.Second)
	}
	return retryAfter
}

func providerRetryAfter(resp *http.Response) time.Duration {
	if resp == nil {
		return 0
	}
	raw := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		if seconds <= 0 {
			return 0
		}
		return cappedBackoff(time.Duration(seconds)*time.Second, time.Hour)
	}
	if when, err := http.ParseTime(raw); err == nil {
		d := time.Until(when)
		if d <= 0 {
			return 0
		}
		return cappedBackoff(d, time.Hour)
	}
	return 0
}

func retryAfterFromRaw(raw map[string]any) time.Duration {
	seconds := int64(0)
	switch v := raw["_retry_after_seconds"].(type) {
	case int:
		seconds = int64(v)
	case int64:
		seconds = v
	case float64:
		seconds = int64(v)
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			seconds = n
		}
	}
	if seconds <= 0 {
		return 0
	}
	return cappedBackoff(time.Duration(seconds)*time.Second, time.Hour)
}

func twilioRegistrationResource(raw map[string]any) SmsRegistrationResource {
	return SmsRegistrationResource{
		SID: defaulted(
			stringFromAny(raw["sid"]),
			defaulted(stringFromAny(raw["brand_registration_sid"]), stringFromAny(raw["campaign_sid"])),
		),
		Status: defaulted(
			stringFromAny(raw["status"]),
			defaulted(stringFromAny(raw["brand_registration_status"]), stringFromAny(raw["campaign_status"])),
		),
		Raw: raw,
	}
}

func twilioBool(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func priceMicros(v any) int64 {
	s := strings.TrimSpace(stringFromAny(v))
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	if f < 0 {
		f = -f
	}
	return int64(f * 1_000_000)
}

func stringFromAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}
