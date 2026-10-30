// SPDX-License-Identifier: AGPL-3.0-only
//
// Package whatsappsend: G-15 WhatsApp Business Platform ChannelSender.
//
// WhatsApp's Cloud API only accepts outbound business-initiated messages as
// pre-approved "message templates" (Meta reviews name+language+body before
// a template may send, and — since the July-2025 pricing change — billing
// is per delivered template message rather than per 24h conversation
// window). That approval gate is enforced twice: once at write-time by
// whatsapp_message_templates.status (migration 1746) and once here, so a
// send can never bypass an unapproved/rejected/paused template.
package whatsappsend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// WhatsAppProvider is the narrow send surface a live WhatsApp adapter
// implements. toPhone is E.164. vars are positional {{1}}, {{2}}, ...
// substitutions for the template body. Returns the provider (WAMID) message
// id on success.
type WhatsAppProvider interface {
	SendTemplate(ctx context.Context, toPhone, templateName, lang string, vars []string) (providerMessageID string, err error)
}

// ErrNotConfigured is returned by MetaCloudProvider.SendTemplate when the
// Meta Cloud API credentials are absent. The sender is inert-until-creds
// rather than a no-op: request construction below is real and fires the
// moment WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID are set.
const errNotConfiguredMsg = "WhatsApp Business account not configured"

// MetaCloudProvider sends WhatsApp template messages through the Meta
// (Facebook) Graph API's WhatsApp Business Cloud API:
//
//	POST https://graph.facebook.com/{version}/{phone_number_id}/messages
//	Authorization: Bearer {access_token}
//
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
type MetaCloudProvider struct {
	// PhoneNumberID is the Cloud API "Phone number ID" (not the phone
	// number itself) the message is sent from.
	PhoneNumberID string
	// AccessToken is a Meta system-user or page access token with the
	// whatsapp_business_messaging permission.
	AccessToken string
	// APIVersion defaults to "v20.0" when empty.
	APIVersion string
	// BaseURL defaults to "https://graph.facebook.com" when empty.
	// Overridable in tests.
	BaseURL string
	// HTTPClient defaults to a 10s-timeout client when nil.
	HTTPClient *http.Client
}

var defaultWhatsAppHTTPClient = &http.Client{Timeout: 10 * time.Second}

const whatsappProviderMaxResponseBytes int64 = 1 << 20 // 1 MiB

// NewMetaCloudProviderFromEnv builds a provider from WHATSAPP_PHONE_NUMBER_ID
// / WHATSAPP_ACCESS_TOKEN (+ optional WHATSAPP_API_VERSION /
// WHATSAPP_GRAPH_API_BASE_URL). Absent env vars leave the provider unconfigured
// — SendTemplate then fails closed with ErrNotConfigured rather than panicking
// or silently no-oping.
func NewMetaCloudProviderFromEnv() *MetaCloudProvider {
	return &MetaCloudProvider{
		PhoneNumberID: strings.TrimSpace(os.Getenv("WHATSAPP_PHONE_NUMBER_ID")),
		AccessToken:   strings.TrimSpace(os.Getenv("WHATSAPP_ACCESS_TOKEN")),
		APIVersion:    defaultedWA(strings.TrimSpace(os.Getenv("WHATSAPP_API_VERSION")), "v20.0"),
		BaseURL:       defaultedWA(strings.TrimSpace(os.Getenv("WHATSAPP_GRAPH_API_BASE_URL")), "https://graph.facebook.com"),
		HTTPClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

// Configured reports whether the credentials needed to call the Cloud API
// are present. nil-safe.
func (p *MetaCloudProvider) Configured() bool {
	return p != nil && strings.TrimSpace(p.PhoneNumberID) != "" && strings.TrimSpace(p.AccessToken) != ""
}

// whatsAppTemplateRequest is the Cloud API POST /messages body for a
// template send.
type whatsAppTemplateRequest struct {
	MessagingProduct string               `json:"messaging_product"`
	To               string               `json:"to"`
	Type             string               `json:"type"`
	Template         whatsAppTemplateBody `json:"template"`
}

type whatsAppTemplateBody struct {
	Name       string               `json:"name"`
	Language   whatsAppTemplateLang `json:"language"`
	Components []whatsAppComponent  `json:"components,omitempty"`
}

type whatsAppTemplateLang struct {
	Code string `json:"code"`
}

type whatsAppComponent struct {
	Type       string              `json:"type"`
	Parameters []whatsAppParameter `json:"parameters"`
}

type whatsAppParameter struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type whatsAppMessagesResponse struct {
	Messages []struct {
		ID string `json:"id"`
	} `json:"messages"`
	Error *struct {
		Message   string `json:"message"`
		Type      string `json:"type"`
		Code      int    `json:"code"`
		ErrorData struct {
			Details string `json:"details"`
		} `json:"error_data"`
	} `json:"error"`
}

// SendTemplate builds and issues the real Meta Graph API request. It fails
// closed with ErrNotConfigured when credentials are absent — never a silent
// no-op — so the sender is correctly inert until an operator sets
// WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID.
func (p *MetaCloudProvider) SendTemplate(ctx context.Context, toPhone, templateName, lang string, vars []string) (string, error) {
	if !p.Configured() {
		return "", fmt.Errorf("%s", errNotConfiguredMsg)
	}
	toPhone = strings.TrimSpace(toPhone)
	templateName = strings.TrimSpace(templateName)
	lang = strings.TrimSpace(lang)
	if toPhone == "" {
		return "", fmt.Errorf("whatsapp: recipient phone number is required")
	}
	if templateName == "" {
		return "", fmt.Errorf("whatsapp: template name is required")
	}
	if lang == "" {
		return "", fmt.Errorf("whatsapp: template language is required")
	}

	body := whatsAppTemplateRequest{
		MessagingProduct: "whatsapp",
		To:               toPhone,
		Type:             "template",
		Template: whatsAppTemplateBody{
			Name:     templateName,
			Language: whatsAppTemplateLang{Code: lang},
		},
	}
	if len(vars) > 0 {
		params := make([]whatsAppParameter, 0, len(vars))
		for _, v := range vars {
			params = append(params, whatsAppParameter{Type: "text", Text: v})
		}
		body.Template.Components = []whatsAppComponent{{Type: "body", Parameters: params}}
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("whatsapp: encode request: %w", err)
	}

	endpoint := strings.TrimRight(defaultedWA(p.BaseURL, "https://graph.facebook.com"), "/") +
		"/" + defaultedWA(p.APIVersion, "v20.0") +
		"/" + strings.TrimSpace(p.PhoneNumberID) + "/messages"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("whatsapp: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.AccessToken)

	client := p.HTTPClient
	if client == nil {
		client = defaultWhatsAppHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("whatsapp: send request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, whatsappProviderMaxResponseBytes+1))
	if readErr != nil {
		return "", fmt.Errorf("whatsapp: read response: %w", readErr)
	}
	if int64(len(raw)) > whatsappProviderMaxResponseBytes {
		return "", fmt.Errorf("whatsapp: response body too large")
	}

	var parsed whatsAppMessagesResponse
	_ = json.Unmarshal(raw, &parsed)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if parsed.Error != nil && parsed.Error.Message != "" {
			return "", fmt.Errorf("whatsapp send failed (%d): %s", parsed.Error.Code, parsed.Error.Message)
		}
		return "", fmt.Errorf("whatsapp send failed: %s", resp.Status)
	}
	if len(parsed.Messages) == 0 || parsed.Messages[0].ID == "" {
		return "", fmt.Errorf("whatsapp send: provider returned no message id")
	}
	return parsed.Messages[0].ID, nil
}

func defaultedWA(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}
