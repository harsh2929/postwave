// Package postwave is the official Go client for the Moosewave API.
//
//	client := postwave.New("pw_live_…")
//	res, err := client.Emails.Send(ctx, &postwave.SendEmailInput{
//	    From: "you@yourdomain.com", To: []string{"user@example.com"},
//	    Subject: "Hi", HTML: "<b>Hello</b>",
//	})
package postwave

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	defaultBaseURL = "https://api.moosewave.com"
	defaultRetries = 3
	userAgent      = "postwave-go/0.1.0"
)

// Client is the Moosewave API client. Construct it with New.
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	maxRetries int

	Emails            *EmailsResource
	Subscribers       *SubscribersResource
	Campaigns         *CampaignsResource
	CampaignAssurance *CampaignAssuranceResource
	CampaignPolls     *CampaignPollsResource
	ConversionIngest  *ConversionIngestResource
	// ConversionIngestSecrets manages the private credentials used by
	// ConversionIngest. Issuance is reveal-once and never retried.
	ConversionIngestSecrets *ConversionIngestSecretsResource
	Lists                   *ListsResource
	Segments                *SegmentsResource
	Events                  *EventsResource
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL overrides the API base URL (default https://api.moosewave.com).
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") } }

// WithHTTPClient supplies a custom *http.Client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.httpClient = h } }

// WithMaxRetries sets the retry count for 429/5xx (default 3).
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// New builds a client. apiKey is your pw_live_… key.
func New(apiKey string, opts ...Option) *Client {
	c := &Client{
		apiKey:     apiKey,
		baseURL:    defaultBaseURL,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		maxRetries: defaultRetries,
	}
	for _, o := range opts {
		o(c)
	}
	c.Emails = &EmailsResource{client: c}
	c.Subscribers = &SubscribersResource{client: c}
	c.Campaigns = &CampaignsResource{client: c}
	c.CampaignAssurance = &CampaignAssuranceResource{client: c}
	c.CampaignPolls = &CampaignPollsResource{client: c}
	c.ConversionIngest = &ConversionIngestResource{client: c}
	c.ConversionIngestSecrets = &ConversionIngestSecretsResource{client: c}
	c.Lists = &ListsResource{client: c}
	c.Segments = &SegmentsResource{client: c}
	c.Events = &EventsResource{client: c}
	return c
}

// Error is a typed API error. The HTTP status and the server's error code are
// both available for branching.
type Error struct {
	Status    int    `json:"-"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("postwave: %d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("postwave: http %d", e.Status)
}

type errorEnvelope struct {
	Error *Error `json:"error"`
}

// request performs a JSON request with auth, idempotency (for writes), retry on
// 429/5xx (honoring Retry-After), and typed error mapping. out may be nil.
func (c *Client) request(ctx context.Context, method, path string, body, out any) error {
	return c.requestWithIdempotencyKey(ctx, method, path, body, out, "")
}

// requestWithIdempotencyKey is the request path for APIs that require a key
// and let callers pin it across process boundaries. An empty key retains the
// normal per-call auto-mint behavior.
func (c *Client) requestWithIdempotencyKey(ctx context.Context, method, path string, body, out any, explicitIdempotencyKey string) error {
	return c.requestWithHeadersAndIdempotencyKey(ctx, method, path, body, out, nil, explicitIdempotencyKey)
}

// requestWithHeadersAndIdempotencyKey is reserved for typed SDK operations
// whose public HTTP contract requires a specific conditional header.
func (c *Client) requestWithHeadersAndIdempotencyKey(ctx context.Context, method, path string, body, out any, headers map[string]string, explicitIdempotencyKey string) error {
	return c.requestWithHeadersAndIdempotencyKeyAndResponseHeaders(
		ctx, method, path, body, out, headers, explicitIdempotencyKey, nil,
	)
}

// requestWithHeadersAndIdempotencyKeyAndResponseHeaders preserves the shared
// retry/idempotency path while letting concurrency-aware resources inspect a
// successful response's next ETag. The observer is never invoked on an error.
func (c *Client) requestWithHeadersAndIdempotencyKeyAndResponseHeaders(ctx context.Context, method, path string, body, out any, headers map[string]string, explicitIdempotencyKey string, observe func(http.Header)) error {
	var rawBody []byte
	if body != nil {
		var err error
		if rawBody, err = json.Marshal(body); err != nil {
			return fmt.Errorf("postwave: marshal body: %w", err)
		}
	}
	// One idempotency key, reused across retries, for write verbs.
	idempotencyKey := explicitIdempotencyKey
	if idempotencyKey != "" && !validIdempotencyKey(idempotencyKey) {
		return fmt.Errorf("postwave: Idempotency-Key must be 1-255 UTF-8 bytes without control characters")
	}
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		if idempotencyKey == "" {
			idempotencyKey = newIdempotencyKey()
		}
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			if !sleepCtx(ctx, backoff(attempt)) {
				return ctx.Err()
			}
		}
		var reader io.Reader
		if rawBody != nil {
			reader = bytes.NewReader(rawBody)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", userAgent)
		if rawBody != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue // network error — retry
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if observe != nil {
				observe(resp.Header.Clone())
			}
			if out != nil && len(respBody) > 0 {
				if err := json.Unmarshal(respBody, out); err != nil {
					return fmt.Errorf("postwave: decode response: %w", err)
				}
			}
			return nil
		}

		apiErr := &Error{Status: resp.StatusCode}
		var env errorEnvelope
		if json.Unmarshal(respBody, &env) == nil && env.Error != nil {
			apiErr.Code = env.Error.Code
			apiErr.Message = env.Error.Message
			apiErr.RequestID = env.Error.RequestID
		}
		// Retry 429 + 5xx (except 501).
		if resp.StatusCode == http.StatusTooManyRequests ||
			(resp.StatusCode >= 500 && resp.StatusCode != http.StatusNotImplemented) {
			lastErr = apiErr
			if ra := retryAfter(resp.Header.Get("Retry-After")); ra > 0 && attempt < c.maxRetries {
				if !sleepCtx(ctx, ra) {
					return ctx.Err()
				}
			}
			continue
		}
		return apiErr
	}
	if lastErr == nil {
		lastErr = &Error{Status: 0, Code: "exhausted", Message: "exhausted retries"}
	}
	return lastErr
}

// requestRevealOnce performs exactly one transport attempt and never attaches
// Idempotency-Key. It is intentionally private and narrow: retrying a response
// that contains the only plaintext copy of a credential can mint a second key
// after an ambiguous transport failure.
func (c *Client) requestRevealOnce(
	ctx context.Context,
	path string,
	body, out any,
) error {
	var rawBody []byte
	if body != nil {
		var err error
		rawBody, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("postwave: marshal body: %w", err)
		}
	}
	var reader io.Reader
	if rawBody != nil {
		reader = bytes.NewReader(rawBody)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if rawBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if readErr != nil {
		return fmt.Errorf("postwave: read response: %w", readErr)
	}
	if resp.StatusCode == http.StatusCreated {
		if out != nil && len(respBody) > 0 {
			if err := json.Unmarshal(respBody, out); err != nil {
				return fmt.Errorf("postwave: decode response: %w", err)
			}
		}
		return nil
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return fmt.Errorf("postwave: reveal-once issuance returned unexpected HTTP %d", resp.StatusCode)
	}
	apiErr := &Error{Status: resp.StatusCode}
	var env errorEnvelope
	if json.Unmarshal(respBody, &env) == nil && env.Error != nil {
		apiErr.Code = env.Error.Code
		apiErr.Message = env.Error.Message
		apiErr.RequestID = env.Error.RequestID
	}
	return apiErr
}

func validIdempotencyKey(value string) bool {
	if value == "" || len(value) > 255 || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func validStrongCampaignETag(value string) bool {
	if value != strings.TrimSpace(value) || len(value) < 3 || len(value) > 512 ||
		value == "*" || strings.HasPrefix(value, "W/") || strings.Contains(value, ",") ||
		value[0] != '"' || value[len(value)-1] != '"' || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func newIdempotencyKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "go_" + hex.EncodeToString(b)
}

func backoff(attempt int) time.Duration {
	d := time.Duration(math.Pow(2, float64(attempt-1))) * 200 * time.Millisecond
	if d > 5*time.Second {
		d = 5 * time.Second
	}
	return d
}

func retryAfter(h string) time.Duration {
	if h == "" {
		return 0
	}
	if secs, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	return 0
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
