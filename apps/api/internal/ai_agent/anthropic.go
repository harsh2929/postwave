// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/breaker"
	"strings"
	"time"
)

const anthropicMaxResponseBytes int64 = 4 << 20 // 4 MiB

// AnthropicConfig configures the tool-calling LLM client.
type AnthropicConfig struct {
	APIKey    string
	Model     string
	BaseURL   string
	MaxTokens int
	Timeout   time.Duration
}

// anthropicToolClient implements LLMClient against Anthropic's Messages API
// with tool use. Unlike safety.AnthropicClient (text-only), this client
// passes tool definitions, parses tool_use blocks, and accepts tool_result
// blocks in the conversation.
type anthropicToolClient struct {
	cfg  AnthropicConfig
	http *http.Client
}

// NewAnthropicLLM builds a tool-calling client. Defaults fill in a
// tool-capable model, the public base URL, and sensible token/timeout caps.

// agentLLMBreaker trips the in-app agent's Anthropic tool calls after repeated
// upstream failures.
var agentLLMBreaker = breaker.New(5, 30*time.Second)

func NewAnthropicLLM(cfg AnthropicConfig) LLMClient {
	if strings.TrimSpace(cfg.Model) == "" {
		// Current tool-capable default; override with AI_AGENT_MODEL.
		cfg.Model = "claude-sonnet-4-6"
	}
	if strings.TrimSpace(cfg.BaseURL) == "" {
		cfg.BaseURL = "https://api.anthropic.com"
	}
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.MaxTokens <= 0 {
		cfg.MaxTokens = 2048
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 60 * time.Second
	}
	return &anthropicToolClient{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout, Transport: breaker.Transport(nil, agentLLMBreaker)}}
}

func (c *anthropicToolClient) Message(ctx context.Context, system string, messages []LLMMessage, tools []ToolDefn) (*LLMResponse, error) {
	if c == nil || strings.TrimSpace(c.cfg.APIKey) == "" {
		return nil, fmt.Errorf("ai_agent: anthropic client not configured (no API key)")
	}
	reqBody := map[string]any{
		"model":      c.cfg.Model,
		"max_tokens": c.cfg.MaxTokens,
		"messages":   messages,
	}
	if strings.TrimSpace(system) != "" {
		reqBody["system"] = system
	}
	if len(tools) > 0 {
		reqBody["tools"] = tools
	}
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/v1/messages", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", c.cfg.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(res.Body, anthropicMaxResponseBytes))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		StopReason string       `json:"stop_reason"`
		Content    []LLMContent `json:"content"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		// A non-2xx with an undecodable body still reports the status, which
		// is the more useful signal than the decode failure.
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, fmt.Errorf("ai_agent: anthropic returned status %d", res.StatusCode)
		}
		return nil, fmt.Errorf("ai_agent: decode anthropic response: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if parsed.Error != nil {
			return nil, fmt.Errorf("ai_agent: anthropic %d: %s", res.StatusCode, parsed.Error.Message)
		}
		return nil, fmt.Errorf("ai_agent: anthropic returned status %d", res.StatusCode)
	}
	return &LLMResponse{
		StopReason: parsed.StopReason,
		Content:    parsed.Content,
		Usage:      TokenUsage{InputTokens: parsed.Usage.InputTokens, OutputTokens: parsed.Usage.OutputTokens},
	}, nil
}
