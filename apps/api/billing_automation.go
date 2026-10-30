package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/billing"
)

type billingAutomationEmitter struct {
	BaseURL          string
	InternalAPIToken string
	HTTPClient       *http.Client
}

func (e *billingAutomationEmitter) EmitBillingAutomationEvent(ctx context.Context, ev billing.AutomationEvent) error {
	if e == nil || strings.TrimSpace(e.BaseURL) == "" {
		return nil
	}
	at := ev.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	body := map[string]any{
		"tenant_id":        ev.TenantID,
		"subscriber_email": ev.SubscriberEmail,
		"event_type":       "product_event",
		"at":               at,
		"payload":          ev.Payload,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal automation event: %w", err)
	}
	endpoint, err := billingAutomationURL(e.BaseURL, "/v1/automations/event")
	if err != nil {
		return fmt.Errorf("build automation event URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("build automation event request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(e.InternalAPIToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := e.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("automation event request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("automation event request: %s", resp.Status)
	}
	return nil
}

func billingAutomationURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid automation base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported automation base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe automation base URL")
	}

	cleanPath := strings.TrimLeft(path, "/")
	pathPart, rawQuery, _ := strings.Cut(cleanPath, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe automation request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe automation request path")
		}
	}

	base.Path = strings.TrimRight(base.Path, "/") + "/" + pathPart
	base.RawQuery = rawQuery
	return base.String(), nil
}
