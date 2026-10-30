// SPDX-License-Identifier: AGPL-3.0-only

package safety

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/breaker"
	"net/url"
	"strings"
	"time"
)

const anthropicMaxResponseBodyBytes int64 = 1 << 20 // 1 MiB

// AnthropicClient implements LLMClient using Anthropic's Messages API. It is
// intentionally tiny: the safety.Service owns the rubric and JSON parsing, so
// this client only transports system/user text and returns the model text.
type AnthropicClient struct {
	APIKey     string
	Model      string
	BaseURL    string
	HTTPClient *http.Client
}

// safetyLLMBreaker trips the safety-classifier LLM calls after repeated
// upstream failures so callers stop waiting out the full timeout on a dead provider.
var safetyLLMBreaker = breaker.New(5, 30*time.Second)

func NewAnthropicClient(apiKey, model, baseURL string) *AnthropicClient {
	if strings.TrimSpace(model) == "" {
		model = "claude-3-5-haiku-latest"
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://api.anthropic.com"
	}
	return &AnthropicClient{
		APIKey:     strings.TrimSpace(apiKey),
		Model:      strings.TrimSpace(model),
		BaseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTPClient: &http.Client{Timeout: 20 * time.Second, Transport: breaker.Transport(nil, safetyLLMBreaker)},
	}
}

func (c *AnthropicClient) Check(ctx context.Context, system, user string) (string, error) {
	if c == nil || c.APIKey == "" {
		return "", fmt.Errorf("anthropic safety client not configured")
	}
	body := map[string]any{
		"model":       c.Model,
		"max_tokens":  512,
		"temperature": 0,
		"system":      system,
		"messages": []map[string]string{
			{"role": "user", "content": user},
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	endpoint, err := anthropicURL(c.BaseURL, "/v1/messages")
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := c.http().Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if res.ContentLength > anthropicMaxResponseBodyBytes {
		return "", fmt.Errorf("anthropic response body too large")
	}
	if err := decodeJSONLimited(res.Body, anthropicMaxResponseBodyBytes, &out); err != nil {
		return "", err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if out.Error != nil {
			return "", fmt.Errorf("anthropic safety check failed: %s: %s", out.Error.Type, out.Error.Message)
		}
		return "", fmt.Errorf("anthropic safety check failed: HTTP %d", res.StatusCode)
	}
	for _, block := range out.Content {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			return strings.TrimSpace(block.Text), nil
		}
	}
	return "", fmt.Errorf("anthropic safety check returned no text")
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return fmt.Errorf("response body too large")
	}
	return json.Unmarshal(buf, out)
}

func (c *AnthropicClient) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 20 * time.Second, Transport: breaker.Transport(nil, safetyLLMBreaker)}
}

func anthropicURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid anthropic base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported anthropic base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe anthropic base URL")
	}
	cleanPath := strings.TrimLeft(path, "/")
	for _, segment := range strings.Split(cleanPath, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe anthropic request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe anthropic request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + cleanPath
	return base.String(), nil
}
