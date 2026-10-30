// Package sending owns the per-tenant Postmark Streams provisioning, IP
// warmup, and dedicated-IP allocation that the Sending+ tiers depend on.
//
// Postmark is the upstream MTA for managed-tier customers. Each Sending+
// tenant gets a Postmark "Server" (which they call sub-account) with one
// "Message Stream"; Pro tenants additionally get a dedicated IP attached
// to that server.
//
// The clients here use net/http only — no Postmark Go SDK. We need exact
// control over headers, retries, and idempotency keys.
package sending

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
)

const postmarkMaxResponseBodyBytes int64 = 1 << 20 // 1 MiB

// PostmarkClient is the typed wrapper around api.postmarkapp.com.
type PostmarkClient struct {
	baseURL      string
	accountToken string
	hc           *http.Client
}

// PostmarkConfig carries client construction options.
type PostmarkConfig struct {
	BaseURL      string // defaults to https://api.postmarkapp.com
	AccountToken string // X-Postmark-Account-Token
	Timeout      time.Duration
}

// NewPostmarkClient constructs a PostmarkClient.
func NewPostmarkClient(cfg PostmarkConfig) *PostmarkClient {
	base := cfg.BaseURL
	if base == "" {
		base = "https://api.postmarkapp.com"
	}
	t := cfg.Timeout
	if t == 0 {
		t = 30 * time.Second
	}
	return &PostmarkClient{
		baseURL:      base,
		accountToken: cfg.AccountToken,
		hc:           &http.Client{Timeout: t},
	}
}

// Server is Postmark's per-tenant sub-account.
type Server struct {
	ID           int      `json:"ID"`
	Name         string   `json:"Name"`
	APITokens    []string `json:"ApiTokens"`
	ServerLink   string   `json:"ServerLink"`
	Color        string   `json:"Color"`
	DeliveryType string   `json:"DeliveryType"`
}

// CreateServerReq is the body of POST /servers.
type CreateServerReq struct {
	Name  string `json:"Name"`
	Color string `json:"Color,omitempty"`
}

// CreateServer provisions a new Postmark server (sub-account) for a tenant.
// The response includes ApiTokens — index 0 is the per-tenant SMTP token
// we encrypt and persist in sending_state.
func (c *PostmarkClient) CreateServer(ctx context.Context, name, color string) (*Server, error) {
	var out Server
	body := CreateServerReq{Name: name, Color: color}
	if err := c.do(ctx, http.MethodPost, "/servers", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MessageStream is one "stream" within a server — broadcasts vs transactional.
type MessageStream struct {
	ID                string `json:"ID"`
	ServerID          int    `json:"ServerID"`
	Name              string `json:"Name"`
	MessageStreamType string `json:"MessageStreamType"` // Transactional|Broadcasts|Inbound
}

// CreateMessageStream creates a stream under serverID. streamID is the
// stable user-visible identifier (Postmark calls it "ID"); we use it in URLs.
func (c *PostmarkClient) CreateMessageStream(ctx context.Context, serverID int, streamID string) (*MessageStream, error) {
	body := map[string]interface{}{
		"ID":                streamID,
		"Name":              streamID,
		"MessageStreamType": "Broadcasts",
	}
	var out MessageStream
	path := fmt.Sprintf("/servers/%d/message-streams", serverID)
	if err := c.do(ctx, http.MethodPost, path, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateInboundDomain provisions an inbound MX domain (used for unsubscribe
// reply detection + bounce processing on dedicated streams).
func (c *PostmarkClient) CreateInboundDomain(ctx context.Context, serverID int, domain string) error {
	body := map[string]interface{}{
		"InboundDomain": domain,
	}
	path := fmt.Sprintf("/servers/%d", serverID)
	return c.do(ctx, http.MethodPut, path, body, nil)
}

// RotateToken asks Postmark for a fresh server-token. Used during incident
// response.
func (c *PostmarkClient) RotateToken(ctx context.Context, serverID int) (string, error) {
	var out struct {
		ApiTokens []string `json:"ApiTokens"`
	}
	path := fmt.Sprintf("/servers/%d/rotate", serverID)
	if err := c.do(ctx, http.MethodPost, path, map[string]interface{}{}, &out); err != nil {
		return "", err
	}
	if len(out.ApiTokens) == 0 {
		return "", fmt.Errorf("postmark: rotate returned no tokens")
	}
	return out.ApiTokens[0], nil
}

// DeleteServer permanently deletes a Postmark server after the configured
// deprovisioning grace window. Callers should schedule this, not run it inline
// with a customer downgrade/cancel webhook.
func (c *PostmarkClient) DeleteServer(ctx context.Context, serverID int) error {
	return c.do(ctx, http.MethodDelete, fmt.Sprintf("/servers/%d", serverID), nil, nil)
}

// DedicatedIPRequest is the body of /dedicated-ips.
type DedicatedIPRequest struct {
	ServerID int    `json:"ServerID"`
	Region   string `json:"Region,omitempty"`
}

// DedicatedIP is the response shape from Postmark's dedicated-IP rental API.
type DedicatedIP struct {
	IP       string `json:"IP"`
	ServerID int    `json:"ServerID"`
	Status   string `json:"Status"`
}

// RentDedicatedIP is the unqualified candidate adapter for a dedicated-IP
// contract. Postmark's current public API catalogue does not document
// /dedicated-ips; its public product page describes an eligibility-gated,
// support-requested, billable assignment instead. The managed provisioning
// release lock prevents this method from being reached by production flows.
// It must not be released until Postmark certifies the endpoint, payload,
// response, eligibility, billing, idempotency, and reconciliation semantics.
func (c *PostmarkClient) RentDedicatedIP(ctx context.Context, serverID int, region string) (*DedicatedIP, error) {
	body := DedicatedIPRequest{ServerID: serverID, Region: region}
	var out DedicatedIP
	if err := c.do(ctx, http.MethodPost, "/dedicated-ips", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// HTTPError is returned for non-2xx responses from Postmark.
type HTTPError struct {
	Status int
	Body   string
	Method string
	Path   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("postmark: %s %s -> %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func (c *PostmarkClient) do(ctx context.Context, method, path string, body, out interface{}) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}
	endpoint, err := postmarkURL(c.baseURL, path)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rdr)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Postmark-Account-Token", c.accountToken)

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("postmark %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, postmarkMaxResponseBodyBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{
			Status: resp.StatusCode,
			Body:   string(respBody),
			Method: method,
			Path:   path,
		}
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func postmarkURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid postmark base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported postmark base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe postmark base URL")
	}
	cleanPath := strings.TrimLeft(path, "/")
	for _, segment := range strings.Split(cleanPath, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe postmark request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe postmark request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + cleanPath
	return base.String(), nil
}
