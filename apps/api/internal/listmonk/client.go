// Package listmonk is a tiny HTTP client for the upstream Listmonk REST API.
//
// IMPORTANT — license boundary: per LICENSE-BOUNDARY.md we MUST NOT import
// any Go package from `github.com/knadh/listmonk` or a downstream
// `github.com/postwave/listmonk` fork from anywhere in `apps/`,
// `services/`, or `packages/`. The whole point of the network boundary is
// that Listmonk runs as a separate process and we talk to it over HTTP.
//
// This file is the only place that knows Listmonk's HTTP shape. Domain
// packages (forms, automation, ...) call methods here and stay free of
// Listmonk-specific URLs.
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
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/packages/runtime/tenantengine"
)

const listmonkClientMaxResponseBodyBytes int64 = 4 << 20 // 4 MiB

// Client wraps the Listmonk HTTP API.
type Client struct {
	baseURL            string
	username           string
	password           string
	hc                 *http.Client
	resolveDestination func(context.Context, string) (Config, error)
	tenantID           string
	destinationGuard   func(context.Context) error
}

// Config carries client construction options.
type Config struct {
	BaseURL  string // e.g. http://listmonk:9000
	Username string // Listmonk admin user
	Password string // Listmonk admin password (or token)
	Timeout  time.Duration
	// ResolveDestination is mandatory for every tenant operation when set.
	// Failure never falls through to the process-global endpoint.
	ResolveDestination func(context.Context, string) (Config, error)
	DestinationGuard   func(context.Context) error
}

// New constructs a Listmonk client. Empty BaseURL falls back to localhost.
func New(cfg Config) *Client {
	base := cfg.BaseURL
	if base == "" {
		base = "http://localhost:9000"
	}
	t := cfg.Timeout
	if t == 0 {
		t = 15 * time.Second
	}
	return &Client{
		baseURL:            base,
		username:           cfg.Username,
		password:           cfg.Password,
		hc:                 &http.Client{Timeout: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		resolveDestination: cfg.ResolveDestination,
		destinationGuard:   cfg.DestinationGuard,
	}
}

func (c *Client) TenantRouted() bool { return c != nil && c.resolveDestination != nil }

// Destination resolves only an authenticated or explicitly worker-bound tenant.
func (c *Client) Destination(ctx context.Context) (Config, error) {
	if c == nil {
		return Config{}, tenantengine.ErrUnavailable
	}
	if c.resolveDestination == nil {
		if c.destinationGuard != nil {
			if err := c.destinationGuard(ctx); err != nil {
				return Config{}, err
			}
		}
		return Config{BaseURL: c.baseURL, Username: c.username, Password: c.password}, nil
	}
	tenantID := tenantengine.Tenant(ctx)
	if c.tenantID != "" {
		if tenantID != "" && tenantID != c.tenantID {
			return Config{}, tenantengine.ErrUnavailable
		}
		tenantID = c.tenantID
	}
	if tenantID == "" {
		return Config{}, tenantengine.ErrUnavailable
	}
	return c.resolveDestination(ctx, tenantID)
}

// ForTenant validates and pins a worker's destination before lending its client.
func (c *Client) ForTenant(ctx context.Context, tenantID string) (*Client, error) {
	if !c.TenantRouted() || strings.TrimSpace(tenantID) == "" {
		return nil, tenantengine.ErrUnavailable
	}
	cp := *c
	cp.tenantID = strings.TrimSpace(tenantID)
	if _, err := cp.Destination(ctx); err != nil {
		return nil, err
	}
	return &cp, nil
}

// Subscriber statuses and list-subscription statuses, spelled as Listmonk
// spells them on the wire.
const (
	SubscriberEnabled     = "enabled"
	SubscriberDisabled    = "disabled"
	SubscriberBlocklisted = "blocklisted"

	SubscriptionUnconfirmed  = "unconfirmed"
	SubscriptionConfirmed    = "confirmed"
	SubscriptionUnsubscribed = "unsubscribed"
)

// Subscriber mirrors the wire shape of Listmonk's subscriber object.
// We hand-pick the fields we use; this is NOT a Go import of Listmonk types.
type Subscriber struct {
	ID     int64  `json:"id,omitempty"`
	Email  string `json:"email"`
	Name   string `json:"name,omitempty"`
	Status string `json:"status,omitempty"` // enabled | disabled | blocklisted
	// Lists is every subscription the subscriber holds. Listmonk returns each
	// one as a list OBJECT (id, name, subscription_status, ...) in every
	// subscriber payload, while requests take bare ids (CreateSubscriberReq).
	// Decoding the objects into []int64 failed every read of a subscriber on
	// at least one list, after Listmonk had already committed the write.
	Lists   []SubscriberList `json:"lists,omitempty"`
	Attribs map[string]any   `json:"attribs,omitempty"`
	Tags    []string         `json:"tags,omitempty"`
}

// SubscriberList is one subscription inside a subscriber payload.
type SubscriberList struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name,omitempty"`
	SubscriptionStatus string `json:"subscription_status,omitempty"` // unconfirmed | confirmed | unsubscribed
}

// Subscription returns the subscriber's subscription to listID, if any.
func (s *Subscriber) Subscription(listID int64) (SubscriberList, bool) {
	if s == nil {
		return SubscriberList{}, false
	}
	for _, list := range s.Lists {
		if list.ID == listID {
			return list, true
		}
	}
	return SubscriberList{}, false
}

// CreateSubscriberReq is the body of POST /api/subscribers.
type CreateSubscriberReq struct {
	Email                   string         `json:"email"`
	Name                    string         `json:"name,omitempty"`
	Status                  string         `json:"status"` // enabled | disabled | blocklisted
	Lists                   []int64        `json:"lists,omitempty"`
	Attribs                 map[string]any `json:"attribs,omitempty"`
	Tags                    []string       `json:"tags,omitempty"`
	PreconfirmSubscriptions bool           `json:"preconfirm_subscriptions,omitempty"`
}

// CreateSubscriber inserts a subscriber. An address Listmonk already holds is
// answered with 409 (HTTPError.IsConflict) and the request's lists are NOT
// added to it; use AddSubscribersToLists for that.
//
// PreconfirmSubscriptions=false leaves the subscriptions unconfirmed, and for
// any list whose optin is "double" Listmonk then mails its OWN opt-in request,
// whose link confirms only inside Listmonk. Callers that run their own double
// opt-in must not create unconfirmed subscriptions to such lists.
func (c *Client) CreateSubscriber(ctx context.Context, req CreateSubscriberReq) (*Subscriber, error) {
	var out struct {
		Data Subscriber `json:"data"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/subscribers", req, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// UpdateSubscriberStatusReq is the body of PATCH /api/subscribers/:id.
//
// PATCH starts from the stored subscriber and changes only what the body
// carries: an empty Name or Status keeps the stored value, attribs present in
// the body are MERGED into the stored attribs, and subscriptions are never
// touched because the body has no `lists` key. Email is always sent: it is
// how a canonical address rotation reaches Listmonk.
type UpdateSubscriberStatusReq struct {
	Email   string         `json:"email"`
	Name    string         `json:"name,omitempty"`
	Status  string         `json:"status"`
	Attribs map[string]any `json:"attribs,omitempty"`
	Tags    []string       `json:"tags,omitempty"`
}

// UpdateSubscriberStatus updates a subscriber's status and profile with
// PATCH. It must never be PUT: Listmonk v6.1.0's PUT replaces every
// subscription with the request's `lists` (absent means none) and resets
// attribs to {} when they are omitted, so a status flip or a profile sync
// silently removed the subscriber from every list it was on.
func (c *Client) UpdateSubscriberStatus(ctx context.Context, id int64, req UpdateSubscriberStatusReq) error {
	path := "/api/subscribers/" + strconv.FormatInt(id, 10)
	return c.do(ctx, http.MethodPatch, path, req, nil)
}

// UpdateSubscriberAttribs merges attribs into a subscriber's stored attribs
// (PATCH), leaving its status, name and subscriptions as they are. email is
// the subscriber's current address; PATCH replaces the stored address with
// whatever the body carries, so it must be the address Listmonk holds.
func (c *Client) UpdateSubscriberAttribs(ctx context.Context, id int64, email string, attribs map[string]any) error {
	if len(attribs) == 0 {
		return nil
	}
	path := "/api/subscribers/" + strconv.FormatInt(id, 10)
	body := struct {
		Email   string         `json:"email"`
		Attribs map[string]any `json:"attribs"`
	}{Email: email, Attribs: attribs}
	return c.do(ctx, http.MethodPatch, path, body, nil)
}

// AddSubscribersToLists subscribes existing subscribers to lists
// (PUT /api/subscribers/lists, action "add"). status is the subscription
// status to write: "unconfirmed" or "confirmed".
//
// Listmonk writes status over whatever subscription already exists, an
// "unsubscribed" one included, so a caller must leave out every list whose
// unsubscribe it is not entitled to reverse.
func (c *Client) AddSubscribersToLists(ctx context.Context, subscriberIDs, listIDs []int64, status string) error {
	if len(subscriberIDs) == 0 || len(listIDs) == 0 {
		return nil
	}
	if status != SubscriptionUnconfirmed && status != SubscriptionConfirmed {
		return fmt.Errorf("listmonk: add to lists: status %q is not unconfirmed or confirmed", status)
	}
	body := struct {
		IDs           []int64 `json:"ids"`
		Action        string  `json:"action"`
		TargetListIDs []int64 `json:"target_list_ids"`
		Status        string  `json:"status"`
	}{IDs: subscriberIDs, Action: "add", TargetListIDs: listIDs, Status: status}
	return c.do(ctx, http.MethodPut, "/api/subscribers/lists", body, nil)
}

// FindSubscriberByEmail returns the first Listmonk subscriber matching email,
// or nil when none exists. Listmonk exposes search as SQL-ish query text; keep
// the escaping local to this boundary package.
func (c *Client) FindSubscriberByEmail(ctx context.Context, email string) (*Subscriber, error) {
	q := "subscribers.email = '" + strings.ReplaceAll(email, "'", "''") + "'"
	path := "/api/subscribers?query=" + url.QueryEscape(q) + "&per_page=1"
	var out struct {
		Data struct {
			Results []Subscriber `json:"results"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if len(out.Data.Results) == 0 {
		return nil, nil
	}
	return &out.Data.Results[0], nil
}

// DeleteSubscriber removes a Listmonk subscriber by numeric id.
func (c *Client) DeleteSubscriber(ctx context.Context, id int64) error {
	path := "/api/subscribers/" + strconv.FormatInt(id, 10)
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

// SendTransactionalReq mirrors POST /api/tx — Listmonk's transactional send.
type SendTransactionalReq struct {
	SubscriberEmail string         `json:"subscriber_email"`
	TemplateID      int64          `json:"template_id,omitempty"`
	Subject         string         `json:"subject,omitempty"`
	Body            string         `json:"body,omitempty"`
	ContentType     string         `json:"content_type,omitempty"` // html | markdown | plain
	Data            map[string]any `json:"data,omitempty"`
	// IdempotencyKey lets the caller stamp a stable identifier on
	// each send so the sendloop's crash-window (Listmonk-accepts →
	// process-crashes-before-commit → row re-claimed) doesn't
	// produce a duplicate at the recipient. Callers (typically
	// sending/sendloop.go) derive this from campaign_recipients.id
	// — same input → same key → Listmonk's HTTP edge dedupes on
	// the Idempotency-Key header. Empty = no dedup (legacy
	// behaviour for paths that haven't been updated yet).
	//
	// Wire format: we attach the value as the `Idempotency-Key`
	// HTTP request header, NOT in the JSON body. Listmonk's edge
	// proxy + reverse-proxy stacks dedupe on this header in front
	// of /api/tx. See D2 in PRODUCTION_READINESS.md.
	IdempotencyKey string `json:"-"`

	// Messenger names the configured Listmonk messenger to route
	// this send through. Listmonk's config.toml registers multiple
	// SMTP backends (typically "email" for the shared pool +
	// per-tenant entries like "dedicated-<pool>" for dedicated-IP
	// customers). Empty = Listmonk default messenger (existing
	// single-pool behaviour). Audit fix (send-pipeline HIGH):
	// dedicated-IP assignments were decorative because the send
	// call never specified a messenger.
	Messenger string `json:"messenger,omitempty"`

	// Headers is a map of additional HTTP request headers attached
	// to the /api/tx POST. Used to carry per-recipient
	// `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post`
	// (RFC 8058) values so the mailbox provider exposes a one-click
	// unsubscribe gesture. Listmonk's transactional path forwards
	// arbitrary inbound headers into the outgoing SMTP message only when
	// the deployed upstream version or an independently operated edge
	// adapter supports that contract. Otherwise the metadata is inert.
	// Empty/nil = no extra headers.
	//
	// Wire format: each non-empty key/value is set as a request
	// header on the underlying HTTP request. Idempotency-Key takes
	// precedence and is NOT overridable through this map (the
	// IdempotencyKey field is the only source of truth for that
	// header).
	Headers map[string]string `json:"-"`
}

// SendTransactional fires a one-off transactional email through Listmonk's
// /api/tx.
//
// Listmonk v6.1.0 renders the message from the template named by TemplateID
// and rejects template 0 with 400 "template 0 not found"; the request's Body
// has no effect on what is sent (the upstream field is json:"-" and is
// overwritten by the rendered template). Anything that must appear in the
// email has to reach the template through Data.
func (c *Client) SendTransactional(ctx context.Context, req SendTransactionalReq) error {
	headers := mergeSendHeaders(req.Headers, req.IdempotencyKey)
	return c.doWithHeaders(ctx, http.MethodPost, "/api/tx", req, nil, headers)
}

// mergeSendHeaders builds the wire-header map for a /api/tx call. The
// caller-supplied req.Headers map is copied (so we don't mutate it) and
// Idempotency-Key is overlaid last so the IdempotencyKey field always
// wins. Empty keys/values are dropped.
//
// Returns nil when both the map and the key are empty — saves an
// allocation on the common path.
func mergeSendHeaders(extra map[string]string, idempotencyKey string) map[string]string {
	idem := strings.TrimSpace(idempotencyKey)
	if len(extra) == 0 && idem == "" {
		return nil
	}
	out := make(map[string]string, len(extra)+1)
	for k, v := range extra {
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k == "" || v == "" {
			continue
		}
		// IdempotencyKey field is the source of truth; never let an
		// extra-map entry stomp on it.
		if strings.EqualFold(k, "Idempotency-Key") {
			continue
		}
		out[k] = v
	}
	if idem != "" {
		out["Idempotency-Key"] = idem
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// CreateCampaignReq mirrors POST /api/campaigns on Listmonk. Only the
// fields Moosewave actually sets are surfaced; Listmonk has many more
// optional knobs that we let default.
type CreateCampaignReq struct {
	Name        string   `json:"name"`
	Subject     string   `json:"subject"`
	FromEmail   string   `json:"from_email"`
	Body        string   `json:"body"`
	ContentType string   `json:"content_type"` // "richtext" | "html" | "plain"
	Lists       []int64  `json:"lists,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	// Type defaults to "regular"; Listmonk also supports "optin".
	Type string `json:"type,omitempty"`
	// SendAt schedules the campaign on Listmonk. We use it ONLY when
	// Moosewave's scheduler hands a campaign off to Listmonk near zero
	// time; for now we always use "send now" and rely on Moosewave's own
	// scheduler to pick the moment.
	SendAt *time.Time `json:"send_at,omitempty"`
}

// CreateCampaignResponse is Listmonk's create-campaign response shape.
type CreateCampaignResponse struct {
	ID     int64  `json:"id"`
	UUID   string `json:"uuid"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// CreateCampaign POSTs /api/campaigns. Returns the Listmonk campaign id
// so the caller can flip status to "running" via UpdateCampaignStatus.
//
// We don't store the Listmonk id on the Moosewave campaigns row in V1 —
// the orchestrator holds it for the lifetime of the send call only. If
// V2 needs cross-restart resume, add a `listmonk_campaign_id` column.
func (c *Client) CreateCampaign(ctx context.Context, req CreateCampaignReq) (*CreateCampaignResponse, error) {
	if req.ContentType == "" {
		req.ContentType = "richtext"
	}
	if req.Type == "" {
		req.Type = "regular"
	}
	var out struct {
		Data CreateCampaignResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/campaigns", req, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// UpdateCampaignStatus flips a Listmonk campaign through its lifecycle.
// Valid statuses: "draft" | "scheduled" | "running" | "paused" |
// "cancelled". For Moosewave's "send now" path we go directly to "running".
func (c *Client) UpdateCampaignStatus(ctx context.Context, listmonkID int64, status string) error {
	body := map[string]string{"status": status}
	return c.do(ctx, http.MethodPut,
		fmt.Sprintf("/api/campaigns/%d/status", listmonkID), body, nil)
}

// HTTPError is returned by Client methods when Listmonk responded with a
// non-2xx status. It carries the HTTP status so handlers can map 4xx
// (user input bad — surface as 4xx to the API caller) vs 5xx (upstream
// unhealthy — surface as 502). Without this distinction, callers
// uniformly returned 502 and a user-typed-bad-email looked like "Bad
// Gateway" to the API consumer.
type HTTPError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string // upstream response body, capped at 2 KiB
}

// Error formats the upstream failure as a single string. The query string is
// left out: subscriber lookups put the address in it, and this message is
// logged.
func (e *HTTPError) Error() string {
	return fmt.Sprintf("listmonk: %s %s: %d %s", e.Method, pathWithoutQuery(e.Path), e.StatusCode, e.Body)
}

// DecodeError reports a 2xx response whose body could not be read into the
// expected shape. Listmonk ACCEPTED the request — a create or update has been
// committed upstream — so it must never be mistaken for "Listmonk is
// unavailable": retrying a create after it would answer 409. It carries
// neither the body nor the query string, both of which can hold an address.
type DecodeError struct {
	Method string
	Path   string // request path without its query string
	Err    error
}

// Error formats the decode failure as a single string.
func (e *DecodeError) Error() string {
	return fmt.Sprintf("listmonk: %s %s: the response was accepted but could not be decoded: %v", e.Method, e.Path, e.Err)
}

// Unwrap exposes the underlying decode error.
func (e *DecodeError) Unwrap() error { return e.Err }

func pathWithoutQuery(path string) string {
	withoutQuery, _, _ := strings.Cut(path, "?")
	return withoutQuery
}

// IsClientError reports whether the upstream returned a 4xx — meaning
// the caller's input is bad and we should NOT treat it as upstream
// unhealthy. Used by gateway handlers to map error codes correctly.
func (e *HTTPError) IsClientError() bool {
	return e.StatusCode >= 400 && e.StatusCode < 500
}

// IsConflict is the common-case helper. Listmonk returns 409 for
// "subscriber already exists" — handlers usually want to surface that
// as 200 idempotent or 409 conflict, never 502.
func (e *HTTPError) IsConflict() bool {
	return e.StatusCode == http.StatusConflict
}

// DefinitelyRejected reports a provider response that proves the request was
// refused before acceptance. Transport errors and 5xx responses remain
// ambiguous: the upstream may have crossed its own send boundary before the
// response was lost or failed.
func DefinitelyRejected(err error) bool {
	var upstream *HTTPError
	if !errors.As(err, &upstream) || !upstream.IsClientError() {
		return false
	}
	// 408/499 can be emitted by a proxy after it forwarded the request, and a
	// 409 for an idempotency key can describe a prior accepted submission.
	// None proves that the provider-side effect is absent.
	return upstream.StatusCode != http.StatusRequestTimeout &&
		upstream.StatusCode != http.StatusConflict && upstream.StatusCode != 499
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	return c.doWithHeaders(ctx, method, path, body, out, nil)
}

// doWithHeaders is do() plus per-request HTTP headers. Used to pass
// Idempotency-Key on /api/tx (D2) without ballooning the do() arg
// list. Empty/nil extra is identical to do().
func (c *Client) doWithHeaders(ctx context.Context, method, path string, body, out any, extra map[string]string) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("listmonk: marshal: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}
	destination, err := c.Destination(ctx)
	if err != nil {
		return err
	}
	endpoint, err := listmonkURL(destination.BaseURL, path)
	if err != nil {
		return fmt.Errorf("listmonk: build URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rdr)
	if err != nil {
		return fmt.Errorf("listmonk: build req: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extra {
		if k != "" && v != "" {
			req.Header.Set(k, v)
		}
	}
	if destination.Username != "" || destination.Password != "" {
		req.SetBasicAuth(destination.Username, destination.Password)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		// Transport-level error (network, timeout) — definitionally 5xx
		// from the caller's perspective. No HTTPError because there's
		// no upstream status to carry.
		return fmt.Errorf("listmonk: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Cap the body at 2 KiB so we don't propagate Listmonk's full
		// HTML 5xx pages back to API consumers.
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &HTTPError{
			Method:     method,
			Path:       path,
			StatusCode: resp.StatusCode,
			Body:       string(buf),
		}
	}
	if out != nil {
		if resp.ContentLength > listmonkClientMaxResponseBodyBytes {
			return &DecodeError{Method: method, Path: pathWithoutQuery(path), Err: errors.New("response body too large")}
		}
		if err := decodeJSONLimited(resp.Body, listmonkClientMaxResponseBodyBytes, out); err != nil {
			return &DecodeError{Method: method, Path: pathWithoutQuery(path), Err: err}
		}
	}
	return nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return errors.New("response body too large")
	}
	return json.NewDecoder(bytes.NewReader(buf)).Decode(out)
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

// Doer is the subscriber surface the form signup path consumes, so tests can
// inject fakes without standing up a Listmonk server.
type Doer interface {
	CreateSubscriber(ctx context.Context, req CreateSubscriberReq) (*Subscriber, error)
	UpdateSubscriberStatus(ctx context.Context, id int64, req UpdateSubscriberStatusReq) error
	UpdateSubscriberAttribs(ctx context.Context, id int64, email string, attribs map[string]any) error
	FindSubscriberByEmail(ctx context.Context, email string) (*Subscriber, error)
	AddSubscribersToLists(ctx context.Context, subscriberIDs, listIDs []int64, status string) error
}

// Compile-time check — *Client satisfies Doer.
var _ Doer = (*Client)(nil)
