// SPDX-License-Identifier: MIT

package brevo

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	defaultBase = "https://api.brevo.com/v3"

	// contactPageSize stays below the documented 1000-row maximum.
	contactPageSize = 500
	// campaignPageSize matches the documented maximum on /v3/emailCampaigns.
	campaignPageSize = 50
	// listPageSize is large enough to drain typical Brevo workspaces in one
	// call; the iterators page anyway when needed.
	listPageSize = 50

	// maxRetries caps exponential backoff on 5xx responses.
	maxRetries = 5
	// initialBackoff is the first wait between retries; subsequent waits
	// double until backoffCap.
	initialBackoff = time.Second
	backoffCap     = 30 * time.Second

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20
)

func init() {
	adapter.Register(canonical.SourceBrevo, NewBrevoAdapter)
}

// NewBrevoAdapter is the registry constructor.
func NewBrevoAdapter() adapter.Adapter {
	return New()
}

// Adapter implements adapter.Adapter for Brevo.
type Adapter struct {
	HTTPClient *http.Client
	limiter    *adapter.TokenBucket
	BaseURL    string // overridable in tests
}

// New constructs a Brevo adapter with the documented 10 req/sec rate limit.
func New() *Adapter {
	return &Adapter{
		HTTPClient: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		limiter:    adapter.NewTokenBucket(10, time.Second, 10),
		BaseURL:    defaultBase,
	}
}

// Capabilities advertises only resources with documented read endpoints.
func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceBrevo,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true // Brevo lists + saved segments both translate
	c.Supports.Automations = false
	c.Supports.CampaignArchive = true
	c.Supports.PaidSubs = false // Brevo has no native paid subs
	c.Supports.ConsentTimestamps = false
	c.Supports.Templates = false
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = false
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

// Authenticate binds the credential to Brevo's immutable organization ID.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	key := strings.TrimSpace(creds.APIKey)
	acct, err := a.validateKey(ctx, key)
	if err != nil {
		return adapter.Session{}, err
	}
	if expected := strings.TrimSpace(creds.AccountID); expected != "" && expected != acct.OrganizationID {
		return adapter.Session{}, fmt.Errorf("brevo: organization does not match expected account: %w", adapter.ErrAuth)
	}
	extra := cloneMap(creds.Extra)
	if extra == nil {
		extra = map[string]string{}
	}
	extra["brevo_organization_id"] = acct.OrganizationID
	extra["brevo_user_id"] = strconv.FormatInt(acct.UserID, 10)
	extra["account_name"] = strings.TrimSpace(acct.CompanyName)
	return adapter.Session{AccessToken: key, AccountID: acct.OrganizationID, Source: canonical.SourceBrevo, Extra: extra}, nil
}

// Discover traverses contacts so SMS-only rows do not inflate email counts.
func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport
	cursor := ""
	excluded := 0
	for {
		rows, next, skipped, err := a.subscriberPage(ctx, sess, cursor)
		if err != nil {
			return rep, fmt.Errorf("brevo: discover contacts: %w", err)
		}
		rep.SubscribersTotal += len(rows)
		excluded += skipped
		if next == "" {
			break
		}
		cursor = next
	}
	segments, err := a.ListSegments(ctx, sess)
	if err != nil {
		return rep, err
	}
	rep.SegmentsTotal = len(segments)
	var campaigns struct {
		Count *int `json:"count"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/emailCampaigns?status=sent&limit=1&offset=0", nil, &campaigns); err != nil {
		return rep, fmt.Errorf("brevo: discover sent campaigns: %w", err)
	}
	if campaigns.Count == nil || *campaigns.Count < 0 {
		return rep, fmt.Errorf("brevo: missing sent campaign count")
	}
	rep.ArchiveTotal = *campaigns.Count
	rep.CampaignsTotal = *campaigns.Count
	rep.ReportsTotal = *campaigns.Count
	rep.ProfilesWithoutEmailTotal = excluded
	rep.Warnings = append(rep.Warnings, "Brevo automation graphs and saved segment rules require separate inventory and rebuilding.", "Contact creation dates are provenance, not consent. Pause source edits and reconcile a final export before cutover; offset reads are not an atomic snapshot.")
	if excluded > 0 {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("Excluded %d contacts without a usable email address; SMS/WhatsApp identities are not email subscribers.", excluded))
	}
	return rep, nil
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	rows, next, _, err := a.subscriberPage(ctx, sess, cursor)
	return rows, next, err
}

func (a *Adapter) subscriberPage(ctx context.Context, sess adapter.Session, raw string) ([]canonical.Subscriber, string, int, error) {
	cursor, err := decodePageCursor(raw, "contacts", sess.AccountID)
	if err != nil {
		return nil, "", 0, err
	}
	var resp struct {
		Contacts []brevoContact `json:"contacts"`
		Count    *int           `json:"count"`
	}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/contacts?limit=%d&offset=%d&sort=asc", contactPageSize, cursor.Offset), nil, &resp); err != nil {
		return nil, "", 0, err
	}
	ids := make([]int64, len(resp.Contacts))
	for i, c := range resp.Contacts {
		ids[i] = c.ID
	}
	next, err := nextPage(cursor, resp.Count, ids, resp.Contacts != nil, contactPageSize)
	if err != nil {
		return nil, "", 0, err
	}
	out := make([]canonical.Subscriber, 0, len(resp.Contacts))
	skipped := 0
	for _, c := range resp.Contacts {
		email := strings.TrimSpace(c.Email)
		parsed, err := mail.ParseAddress(email)
		if err != nil || parsed.Address != email {
			skipped++
			continue
		}
		out = append(out, mapBrevoContactToCanonical(c))
	}
	return out, next, skipped, nil
}

// ListSegments preserves list membership and saved segment metadata. Missing
// pages or duplicate identities fail the whole inventory.
func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	var out []canonical.Segment
	for _, kind := range []string{"lists", "segments"} {
		cursor, _ := decodePageCursor("", kind, sess.AccountID)
		seen := map[int64]bool{}
		for {
			var resp struct {
				Lists    []brevoList    `json:"lists"`
				Segments []brevoSegment `json:"segments"`
				Count    *int           `json:"count"`
			}
			path := fmt.Sprintf("/contacts/%s?limit=%d&offset=%d&sort=asc", kind, listPageSize, cursor.Offset)
			if err := a.do(ctx, sess, http.MethodGet, path, nil, &resp); err != nil {
				return nil, fmt.Errorf("brevo: saved %s incomplete: %w", kind, err)
			}
			ids := []int64{}
			present := resp.Lists != nil
			if kind == "lists" {
				for _, l := range resp.Lists {
					ids = append(ids, l.ID)
				}
			} else {
				present = resp.Segments != nil
				for _, seg := range resp.Segments {
					ids = append(ids, seg.ID)
				}
			}
			next, err := nextPage(cursor, resp.Count, ids, present, listPageSize)
			if err != nil {
				return nil, err
			}
			for _, id := range ids {
				if seen[id] {
					return nil, fmt.Errorf("brevo: repeated %s identity", kind)
				}
				seen[id] = true
			}
			if kind == "lists" {
				for _, l := range resp.Lists {
					out = append(out, mapBrevoListToSegment(l))
				}
			} else {
				for _, seg := range resp.Segments {
					out = append(out, mapBrevoSegmentToCanonical(seg))
				}
			}
			if next == "" {
				break
			}
			cursor, err = decodePageCursor(next, kind, sess.AccountID)
			if err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// ListAutomations cannot claim an inventory from an undocumented endpoint.
func (a *Adapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

// ListCampaignArchive reads each campaign's full report; list statistics are
// limited to six months and cannot certify an older campaign's lifetime totals.
func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, raw string) ([]canonical.CampaignArchive, string, error) {
	cursor, err := decodePageCursor(raw, "campaigns", sess.AccountID)
	if err != nil {
		return nil, "", err
	}
	var resp struct {
		Campaigns []brevoCampaign `json:"campaigns"`
		Count     *int            `json:"count"`
	}
	path := fmt.Sprintf("/emailCampaigns?status=sent&limit=%d&offset=%d&sort=asc&excludeHtmlContent=false", campaignPageSize, cursor.Offset)
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &resp); err != nil {
		return nil, "", err
	}
	ids := make([]int64, len(resp.Campaigns))
	for i, c := range resp.Campaigns {
		ids[i] = c.ID
	}
	next, err := nextPage(cursor, resp.Count, ids, resp.Campaigns != nil, campaignPageSize)
	if err != nil {
		return nil, "", err
	}
	out := make([]canonical.CampaignArchive, 0, len(ids))
	for _, id := range ids {
		var c brevoCampaign
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/emailCampaigns/%d?statistics=globalStats&excludeHtmlContent=false", id), nil, &c); err != nil {
			return nil, "", fmt.Errorf("brevo: campaign report incomplete: %w", err)
		}
		st := c.Statistics.GlobalStats
		if c.ID != id || c.Status != "sent" || parseISO(c.SentDate) == nil || strings.TrimSpace(c.HTMLContent) == "" || st.Sent == nil || st.UniqueViews == nil || st.UniqueClicks == nil || *st.Sent < 0 || *st.UniqueViews < 0 || *st.UniqueClicks < 0 {
			return nil, "", fmt.Errorf("brevo: campaign content or report is incomplete")
		}
		out = append(out, mapBrevoCampaignToCanonical(c))
	}
	return out, next, nil
}

// ListPaidSubs is unsupported for Brevo (no native paid-newsletter product).
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

// --- HTTP plumbing ---

// do issues a single Brevo API request, applying rate-limit gating, exponential
// backoff on 5xx, and Retry-After-aware sleep on 429. The body is decoded into
// `out` when non-nil. Any non-recoverable failure is wrapped with a sentinel
// from the adapter package so callers can errors.Is-switch on the category.
func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if err := a.limiter.Wait(ctx); err != nil {
		return err
	}
	base := a.BaseURL
	if base == "" {
		base = defaultBase
	}

	wait := initialBackoff
	for attempt := 0; attempt <= maxRetries; attempt++ {
		endpoint, err := adapter.BuildURL(base, path)
		if err != nil {
			return fmt.Errorf("brevo: build request URL: %w", err)
		}
		req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
		if err != nil {
			return fmt.Errorf("brevo: build request: %w", err)
		}
		// Brevo uses its own header name, not Authorization: Bearer.
		req.Header.Set("api-key", sess.AccessToken)
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := a.HTTPClient.Do(req)
		if err != nil {
			return fmt.Errorf("brevo %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
		}

		// 429 — respect Retry-After then either retry once internally or
		// surface ErrRateLimited so the orchestrator can park the job.
		if resp.StatusCode == http.StatusTooManyRequests {
			retry := parseRetryAfter(resp.Header.Get("Retry-After"))
			_ = resp.Body.Close()
			if attempt < maxRetries {
				if err := sleepCtx(ctx, retry); err != nil {
					return err
				}
				continue
			}
			return &adapter.ErrRateLimited{RetryAfter: retry}
		}

		// 5xx — exponential backoff.
		if resp.StatusCode >= 500 {
			_ = resp.Body.Close()
			if attempt < maxRetries {
				slog.Warn("brevo: transient server error; retrying",
					"method", method, "path", path,
					"status", resp.StatusCode, "attempt", attempt+1, "wait", wait)
				if err := sleepCtx(ctx, wait); err != nil {
					return err
				}
				wait *= 2
				if wait > backoffCap {
					wait = backoffCap
				}
				continue
			}
			return fmt.Errorf("brevo %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
		}

		// Auth — non-retryable; surface ErrAuth so the UI can prompt for a
		// fresh key.
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			_ = resp.Body.Close()
			return fmt.Errorf("brevo %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrAuth)
		}

		// Other 4xx — bubble up the message so the caller sees the body.
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			_ = resp.Body.Close()
			return fmt.Errorf("brevo %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
		}

		// Success.
		if out == nil {
			if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
				_ = resp.Body.Close()
				return fmt.Errorf("brevo %s %s: response body: %w", method, path, err)
			}
			_ = resp.Body.Close()
			return nil
		}
		err = adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
		_ = resp.Body.Close()
		if err != nil {
			return fmt.Errorf("brevo %s %s: decode: %w", method, path, err)
		}
		return nil
	}
	return fmt.Errorf("brevo %s %s: exhausted retries: %w", method, path, adapter.ErrSourceUnavailable)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 5 * time.Second
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d > 0 {
			return d
		}
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
