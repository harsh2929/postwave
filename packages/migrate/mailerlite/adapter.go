// SPDX-License-Identifier: MIT

// Package mailerlite implements the MailerLite source adapter.
//
// Auth: API key (Bearer). Base URL: https://connect.mailerlite.com/api/.
// Documented rate limit: ~120 req/min.
package mailerlite

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	defaultBase = "https://connect.mailerlite.com/api"

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20

	listPageSize     = 100
	maxPageTraversal = 10000
)

func init() {
	adapter.Register(canonical.SourceMailerLite, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for MailerLite.
type Adapter struct {
	http    *http.Client
	limiter *adapter.TokenBucket
	BaseURL string // overridable in tests
}

// New constructs an adapter capped at the documented 120 req/min.
func New() *Adapter {
	return &Adapter{
		http:    &http.Client{Timeout: 30 * time.Second},
		limiter: adapter.NewTokenBucket(120, time.Minute, 120),
		BaseURL: defaultBase,
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceMailerLite,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = true
	c.Supports.AutomationMode = "rebuild_review"
	c.Supports.CampaignArchive = true
	c.Supports.PaidSubs = false // MailerLite has no native paid-sub product
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = false
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = true
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

// Authenticate validates the API key with MailerLite's documented zero-row
// subscriber count endpoint. MailerLite does not document an account or /me
// endpoint for API-token authentication.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.APIKey == "" {
		return adapter.Session{}, fmt.Errorf("mailerlite: missing api_key: %w", adapter.ErrAuth)
	}
	sess := adapter.Session{
		AccessToken: creds.APIKey,
		Source:      canonical.SourceMailerLite,
		Extra:       cloneMap(creds.Extra),
	}
	if err := a.do(ctx, sess, http.MethodGet, "/subscribers?limit=0", nil, nil); err != nil {
		return adapter.Session{}, err
	}
	return sess, nil
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport

	var subscriberCount struct {
		Total int `json:"total"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/subscribers?limit=0", nil, &subscriberCount); err != nil {
		return rep, fmt.Errorf("discover subscribers: %w", err)
	}
	rep.SubscribersTotal = subscriberCount.Total

	var err error
	if rep.GroupsTotal, err = a.countPaginatedTotal(ctx, sess, "/groups"); err != nil {
		return rep, fmt.Errorf("discover groups: %w", err)
	}
	if rep.SegmentsTotal, err = a.countPaginatedTotal(ctx, sess, "/segments"); err != nil {
		return rep, fmt.Errorf("discover segments: %w", err)
	}
	rep.SegmentsTotal += rep.GroupsTotal
	if rep.AutomationsTotal, err = a.countPaginatedTotal(ctx, sess, "/automations"); err != nil {
		return rep, fmt.Errorf("discover automations: %w", err)
	}
	if rep.ArchiveTotal, err = a.countPaginatedTotal(ctx, sess, "/campaigns", "filter[status]", "sent"); err != nil {
		return rep, fmt.Errorf("discover sent campaigns: %w", err)
	}
	draftCampaigns, err := a.countPaginatedTotal(ctx, sess, "/campaigns", "filter[status]", "draft")
	if err != nil {
		return rep, fmt.Errorf("discover draft campaigns: %w", err)
	}
	readyCampaigns, err := a.countPaginatedTotal(ctx, sess, "/campaigns", "filter[status]", "ready")
	if err != nil {
		return rep, fmt.Errorf("discover ready campaigns: %w", err)
	}
	rep.CampaignsTotal = rep.ArchiveTotal + draftCampaigns + readyCampaigns
	rep.ReportsTotal = rep.ArchiveTotal

	fields, err := a.listFields(ctx, sess)
	if err != nil {
		return rep, fmt.Errorf("discover custom fields: %w", err)
	}
	for _, field := range fields {
		key := field.Key
		if key == "" {
			key = field.Name
		}
		if key != "" {
			rep.CustomFields = append(rep.CustomFields, key)
		}
	}

	for _, formType := range []string{"popup", "embedded", "promotion"} {
		total, formErr := a.countPaginatedTotal(ctx, sess, "/forms/"+formType)
		if formErr != nil {
			return rep, fmt.Errorf("discover %s forms: %w", formType, formErr)
		}
		rep.FormsTotal += total
	}
	if rep.EcommerceTotal, err = a.countPaginatedTotal(ctx, sess, "/ecommerce/shops"); err != nil {
		return rep, fmt.Errorf("discover ecommerce shops: %w", err)
	}
	// MailerLite does not expose sites/landing pages or reusable templates
	// through the documented Connect API. One durable checklist item makes
	// that unobservable surface explicit without inventing a provider count.
	rep.SourceArchiveTotal = rep.FormsTotal + rep.EcommerceTotal + len(fields) + draftCampaigns + readyCampaigns + 1

	return rep, nil
}

// ListSubscribers paginates via MailerLite's cursor model.
// Cursor format: an opaque string returned in `meta.next_cursor`.
func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	values := url.Values{"limit": {strconv.Itoa(listPageSize)}, "include": {"groups"}}
	if cursor != "" {
		values.Set("cursor", cursor)
	}
	path := withQuery("/subscribers", values)
	var resp struct {
		Data []mlSubscriber `json:"data"`
		Meta struct {
			NextCursor string `json:"next_cursor"`
		} `json:"meta"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &resp); err != nil {
		return nil, "", err
	}
	out := make([]canonical.Subscriber, 0, len(resp.Data))
	for _, s := range resp.Data {
		out = append(out, mapSubscriber(s))
	}
	return out, resp.Meta.NextCursor, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	var out []canonical.Segment

	for page := 1; page <= maxPageTraversal; page++ {
		var groups struct {
			Data []mlGroup      `json:"data"`
			Meta paginationMeta `json:"meta"`
		}
		path := pagedPath("/groups", page)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &groups); err != nil {
			return nil, err
		}
		for _, g := range groups.Data {
			out = append(out, translateGroupAsSegment(g))
		}
		if !hasNextPage(page, groups.Meta, len(groups.Data)) {
			break
		}
		if page == maxPageTraversal {
			return nil, fmt.Errorf("mailerlite groups exceeded %d pages: %w", maxPageTraversal, adapter.ErrSourceUnavailable)
		}
	}

	for page := 1; page <= maxPageTraversal; page++ {
		var segs struct {
			Data []mlSegment    `json:"data"`
			Meta paginationMeta `json:"meta"`
		}
		path := pagedPath("/segments", page)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &segs); err != nil {
			return nil, err
		}
		for _, s := range segs.Data {
			out = append(out, translateSegment(s))
		}
		if !hasNextPage(page, segs.Meta, len(segs.Data)) {
			break
		}
		if page == maxPageTraversal {
			return nil, fmt.Errorf("mailerlite segments exceeded %d pages: %w", maxPageTraversal, adapter.ErrSourceUnavailable)
		}
	}
	return out, nil
}

func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	var out []canonical.Automation
	for page := 1; page <= maxPageTraversal; page++ {
		var list struct {
			Data []json.RawMessage `json:"data"`
			Meta paginationMeta    `json:"meta"`
		}
		path := pagedPath("/automations", page)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &list); err != nil {
			return nil, err
		}
		for _, raw := range list.Data {
			var au mlAutomation
			if err := json.Unmarshal(raw, &au); err != nil {
				return nil, fmt.Errorf("decode MailerLite automation: %w", err)
			}
			au.Raw = append(json.RawMessage(nil), raw...)
			out = append(out, translateAutomation(au))
		}
		if !hasNextPage(page, list.Meta, len(list.Data)) {
			break
		}
		if page == maxPageTraversal {
			return nil, fmt.Errorf("mailerlite automations exceeded %d pages: %w", maxPageTraversal, adapter.ErrSourceUnavailable)
		}
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	page := 1
	if cursor != "" {
		parsed, err := strconv.Atoi(cursor)
		if err != nil || parsed < 1 || parsed > maxPageTraversal {
			return nil, "", fmt.Errorf("mailerlite: invalid campaign cursor %q", cursor)
		}
		page = parsed
	}
	const pageSize = 100
	path := withQuery("/campaigns", url.Values{
		"filter[status]": {"sent"},
		"limit":          {strconv.Itoa(pageSize)},
		"page":           {strconv.Itoa(page)},
	})

	var resp struct {
		Data []mlCampaign `json:"data"`
		Meta struct {
			CurrentPage int `json:"current_page"`
			LastPage    int `json:"last_page"`
		} `json:"meta"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &resp); err != nil {
		return nil, "", err
	}
	out := make([]canonical.CampaignArchive, 0, len(resp.Data))
	for _, c := range resp.Data {
		// Optional per-campaign expand for content.
		detailWarning := ""
		if len(c.Emails) == 0 {
			var detail struct {
				Data mlCampaign `json:"data"`
			}
			if err := a.do(ctx, sess, http.MethodGet, "/campaigns/"+c.ID, nil, &detail); err == nil {
				c = detail.Data
			} else {
				detailWarning = "MailerLite campaign detail could not be read; the list-level metadata and aggregate report were preserved."
			}
		}
		mapped := mapCampaign(c)
		if detailWarning != "" {
			mapped.Warnings = append(mapped.Warnings, detailWarning)
		}
		out = append(out, mapped)
	}
	// Use the requested page as the floor — protects against APIs that omit
	// current_page (or return 0) from creating an infinite loop.
	current := resp.Meta.CurrentPage
	if current < page {
		current = page
	}
	next := ""
	if resp.Meta.LastPage > current {
		next = strconv.Itoa(current + 1)
	} else if len(resp.Data) == pageSize {
		next = strconv.Itoa(page + 1)
	}
	return out, next, nil
}

// ListPaidSubs is unsupported for MailerLite.
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

// --- helpers ---

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if err := a.limiter.Wait(ctx); err != nil {
		return err
	}
	base := a.BaseURL
	if base == "" {
		base = defaultBase
	}
	endpoint, err := adapter.BuildURL(base, path)
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("mailerlite %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return &adapter.ErrRateLimited{RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("mailerlite %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode >= 500 {
		return fmt.Errorf("mailerlite %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
		return fmt.Errorf("mailerlite %s %s status %d: %s", method, path, resp.StatusCode, string(b))
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("mailerlite %s %s: response body: %w", method, path, err)
		}
		return nil
	}
	return adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
}

type paginationMeta struct {
	CurrentPage int `json:"current_page"`
	LastPage    int `json:"last_page"`
	Total       int `json:"total"`
}

func (a *Adapter) countPaginatedTotal(ctx context.Context, sess adapter.Session, path string, filters ...string) (int, error) {
	var resp struct {
		Meta paginationMeta `json:"meta"`
	}
	values := url.Values{"limit": {"1"}, "page": {"1"}}
	for i := 0; i+1 < len(filters); i += 2 {
		values.Set(filters[i], filters[i+1])
	}
	if err := a.do(ctx, sess, http.MethodGet, withQuery(path, values), nil, &resp); err != nil {
		return 0, err
	}
	return resp.Meta.Total, nil
}

func (a *Adapter) listFields(ctx context.Context, sess adapter.Session) ([]mlField, error) {
	var out []mlField
	for page := 1; page <= maxPageTraversal; page++ {
		var response struct {
			Data []mlField      `json:"data"`
			Meta paginationMeta `json:"meta"`
		}
		if err := a.do(ctx, sess, http.MethodGet, pagedPath("/fields", page), nil, &response); err != nil {
			return nil, err
		}
		out = append(out, response.Data...)
		if !hasNextPage(page, response.Meta, len(response.Data)) {
			return out, nil
		}
	}
	return nil, fmt.Errorf("mailerlite fields exceeded %d pages: %w", maxPageTraversal, adapter.ErrSourceUnavailable)
}

func pagedPath(path string, page int) string {
	return withQuery(path, url.Values{
		"limit": {strconv.Itoa(listPageSize)},
		"page":  {strconv.Itoa(page)},
	})
}

func withQuery(path string, values url.Values) string {
	if len(values) == 0 {
		return path
	}
	return path + "?" + values.Encode()
}

func hasNextPage(requestedPage int, meta paginationMeta, rows int) bool {
	current := meta.CurrentPage
	if current < requestedPage {
		current = requestedPage
	}
	if meta.LastPage > 0 {
		return current < meta.LastPage
	}
	return rows == listPageSize
}

func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 5 * time.Second
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	return 5 * time.Second
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
