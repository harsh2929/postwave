// Package listmonk is a pure-HTTP wrapper around the Listmonk admin +
// transactional API.
//
// LICENSE BOUNDARY: this package MUST NOT import any
// github.com/knadh/listmonk/... or github.com/postwave/listmonk/... package.
// It speaks JSON over HTTP and nothing else. See LICENSE-BOUNDARY.md.
package listmonk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"

	"github.com/postwave/postwave/packages/runtime/tenantengine"
)

const listmonkMaxResponseBodyBytes int64 = 4 << 20

// Client is the typed HTTP wrapper. Construct via New.
type Client struct {
	baseURL            string
	user               string
	pass               string
	hc                 *http.Client
	resolveDestination func(context.Context, string) (Config, error)
}

// Config carries Client construction options.
type Config struct {
	BaseURL            string
	User               string
	Password           string
	Timeout            time.Duration
	ResolveDestination func(context.Context, string) (Config, error)
}

// New constructs a Client. Timeout defaults to 30s if zero.
func New(cfg Config) *Client {
	t := cfg.Timeout
	if t == 0 {
		t = 30 * time.Second
	}
	return &Client{
		baseURL:            cfg.BaseURL,
		user:               cfg.User,
		pass:               cfg.Password,
		hc:                 &http.Client{Timeout: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		resolveDestination: cfg.ResolveDestination,
	}
}

// TransactionalReq is the body of POST /api/tx. Mirrors Listmonk's wire shape.
type TransactionalReq struct {
	SubscriberEmail string                 `json:"subscriber_email"`
	TemplateID      int                    `json:"template_id"`
	Data            map[string]interface{} `json:"data,omitempty"`
	ContentType     string                 `json:"content_type,omitempty"`
	FromEmail       string                 `json:"from_email,omitempty"`
	Headers         map[string]string      `json:"headers,omitempty"`
}

// SendTransactional triggers a transactional send via Listmonk's tx endpoint.
func (c *Client) SendTransactional(ctx context.Context, req TransactionalReq) error {
	return c.do(ctx, http.MethodPost, "/api/tx", req, nil)
}

// AddTagToSubscriber appends a tag to the subscriber identified by email.
//
// Listmonk's data model has tags-as-text on subscribers. We resolve the
// subscriber by email first, then PUT the merged tag set.
func (c *Client) AddTagToSubscriber(ctx context.Context, email, tag string) error {
	sub, err := c.GetSubscriberByEmail(ctx, email)
	if err != nil {
		return err
	}
	for _, existing := range sub.Tags {
		if existing == tag {
			return nil // idempotent
		}
	}
	sub.Tags = append(sub.Tags, tag)
	return c.updateSubscriberTags(ctx, sub.ID, sub.Tags)
}

// RemoveTagFromSubscriber removes a single tag.
func (c *Client) RemoveTagFromSubscriber(ctx context.Context, email, tag string) error {
	sub, err := c.GetSubscriberByEmail(ctx, email)
	if err != nil {
		return err
	}
	out := sub.Tags[:0]
	for _, existing := range sub.Tags {
		if existing != tag {
			out = append(out, existing)
		}
	}
	return c.updateSubscriberTags(ctx, sub.ID, out)
}

// UnsubscribeFromAll marks the subscriber unsubscribed from every list.
func (c *Client) UnsubscribeFromAll(ctx context.Context, email string) error {
	sub, err := c.GetSubscriberByEmail(ctx, email)
	if err != nil {
		return err
	}
	body := map[string]interface{}{
		"status": "blocklisted",
	}
	path := fmt.Sprintf("/api/subscribers/%d/blocklist", sub.ID)
	return c.do(ctx, http.MethodPut, path, body, nil)
}

// Subscriber is the minimal projection we read back from Listmonk.
type Subscriber struct {
	ID      int                    `json:"id"`
	Email   string                 `json:"email"`
	Tags    []string               `json:"tags"`
	Status  string                 `json:"status"`
	Attribs map[string]interface{} `json:"attribs,omitempty"`
}

// UpdateSubscriberProperty sets a single custom attribute (profile property)
// on the subscriber identified by email, merging it into the existing attribs
// map so unrelated properties are preserved. Used by the automation engine's
// update_profile_property action node. Idempotent: writing the same value
// sends nothing.
//
// The write is a PATCH. Listmonk's PUT /api/subscribers/:id rejects a body
// without an email (400 "Invalid email.") and, given one, replaces every list
// subscription with the body's `lists` (absent means none) and resets attribs;
// PATCH changes only what the body carries.
func (c *Client) UpdateSubscriberProperty(ctx context.Context, email, field string, value interface{}) error {
	field = strings.TrimSpace(field)
	if field == "" {
		return fmt.Errorf("update profile property: empty field")
	}
	sub, err := c.GetSubscriberByEmail(ctx, email)
	if err != nil {
		return err
	}
	attribs := sub.Attribs
	if attribs == nil {
		attribs = map[string]interface{}{}
	}
	if existing, ok := attribs[field]; ok && reflect.DeepEqual(existing, value) {
		return nil // idempotent
	}
	attribs[field] = value
	body := map[string]interface{}{"attribs": attribs}
	return c.do(ctx, http.MethodPatch, fmt.Sprintf("/api/subscribers/%d", sub.ID), body, nil)
}

// GetSubscriberByEmail looks up a subscriber by email address.
func (c *Client) GetSubscriberByEmail(ctx context.Context, email string) (*Subscriber, error) {
	q := url.Values{}
	q.Set("query", fmt.Sprintf("subscribers.email = '%s'", email))
	path := "/api/subscribers?" + q.Encode()

	var resp struct {
		Data struct {
			Results []Subscriber `json:"results"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	if len(resp.Data.Results) == 0 {
		return nil, ErrSubscriberNotFound
	}
	return &resp.Data.Results[0], nil
}

// updateSubscriberTags writes the subscriber's tag set with PATCH, for the
// reason UpdateSubscriberProperty gives. Listmonk v6.1.0 stores no subscriber
// tags at all and ignores the field, so on that version this changes nothing.
func (c *Client) updateSubscriberTags(ctx context.Context, id int, tags []string) error {
	body := map[string]interface{}{
		"tags": tags,
	}
	return c.do(ctx, http.MethodPatch, fmt.Sprintf("/api/subscribers/%d", id), body, nil)
}

// ErrSubscriberNotFound is returned when an email lookup yields no results.
var ErrSubscriberNotFound = errors.New("listmonk: subscriber not found")

// HTTPError is returned for non-2xx responses.
type HTTPError struct {
	Status int
	Body   string
	Method string
	Path   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("listmonk: %s %s -> %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func (c *Client) do(ctx context.Context, method, path string, body, out interface{}) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}
	base, user, password := c.baseURL, c.user, c.pass
	if c.resolveDestination != nil {
		destination, err := c.resolveDestination(ctx, tenantengine.Tenant(ctx))
		if err != nil {
			return err
		}
		base, user, password = destination.BaseURL, destination.User, destination.Password
	}
	endpoint, err := listmonkURL(base, path)
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rdr)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if user != "" {
		req.SetBasicAuth(user, password)
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("listmonk %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, listmonkMaxResponseBodyBytes))
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

func listmonkURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(baseRaw, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid base URL")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported base URL scheme")
	}
	rel := strings.TrimLeft(path, "/")
	pathPart, rawQuery, _ := strings.Cut(rel, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + pathPart
	base.RawQuery = rawQuery
	return base.String(), nil
}
