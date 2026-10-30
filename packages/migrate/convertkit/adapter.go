// SPDX-License-Identifier: MIT

package convertkit

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/stripeconnect"
)

const (
	apiBase = "https://api.kit.com/v4"

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20
)

func init() {
	adapter.Register(canonical.SourceConvertKit, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for ConvertKit/Kit.
type Adapter struct {
	// ResolveSession supplies the latest durably persisted credential before
	// each request. Migration workers install it for long-running jobs.
	ResolveSession func(context.Context) (adapter.Session, error)
	http           *http.Client
	limiter        *adapter.TokenBucket
	// BaseURL overrides the v4 production URL. Used only by tests.
	BaseURL string
}

// New constructs an adapter respecting Kit's documented 120 req/min limit.
func New() *Adapter {
	return &Adapter{
		http:    &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		limiter: adapter.NewTokenBucket(120, time.Minute, 120),
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceConvertKit,
		AuthMethod: "oauth2",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = true
	c.Supports.AutomationMode = "rebuild_review"
	c.Supports.CampaignArchive = true
	// PaidSubs is true at the capability level (Kit *can* expose linked Stripe
	// data) but the actual data still comes through the Stripe Connect path —
	// see ListPaidSubs for the V1 caveat.
	c.Supports.PaidSubs = true
	c.Supports.ConsentTimestamps = false
	c.Supports.Templates = false
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = true
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

// Authenticate binds every token to the immutable v4 account ID. Old v3
// API secrets must be replaced rather than being sent as query parameters.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	sess := adapter.Session{Source: canonical.SourceConvertKit, Extra: cloneMap(creds.Extra)}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	if sess.Extra["api_secret"] != "" {
		return sess, fmt.Errorf("kit: v3 API secrets are unsupported; reconnect with OAuth or a v4 API key: %w", adapter.ErrAuth)
	}
	sess.Extra["api_version"] = "4"
	switch {
	case creds.AccessToken != "":
		sess.AccessToken, sess.RefreshToken = creds.AccessToken, creds.RefreshToken
	case creds.APIKey != "":
		sess.Extra["api_key"] = creds.APIKey
	case creds.OAuthCode != "":
		exchanged, err := ExchangeCode(ctx, creds.OAuthCode, sess.Extra["redirect_uri"])
		if err != nil {
			return sess, err
		}
		sess.AccessToken, sess.RefreshToken, sess.ExpiresAt = exchanged.AccessToken, exchanged.RefreshToken, exchanged.ExpiresAt
	default:
		return sess, fmt.Errorf("kit: OAuth or v4 API key required: %w", adapter.ErrAuth)
	}
	id, err := a.accountID(ctx, sess)
	if err != nil {
		return adapter.Session{}, err
	}
	if creds.AccountID != "" && creds.AccountID != id {
		return adapter.Session{}, fmt.Errorf("kit: account does not match requested account: %w", adapter.ErrAuth)
	}
	sess.AccountID = id
	return sess, nil
}

func (a *Adapter) accountID(ctx context.Context, sess adapter.Session) (string, error) {
	var response struct {
		Account struct {
			ID int64 `json:"id"`
		} `json:"account"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/account", nil, &response); err != nil {
		return "", err
	}
	if response.Account.ID <= 0 {
		return "", fmt.Errorf("kit: account response has no immutable ID: %w", adapter.ErrAuth)
	}
	return strconv.FormatInt(response.Account.ID, 10), nil
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport
	id, err := a.accountID(ctx, sess)
	if err != nil {
		return rep, err
	}
	if id != sess.AccountID || id == "" {
		return rep, fmt.Errorf("kit: source account changed: %w", adapter.ErrAuth)
	}
	// Count the actual cursor traversal. v4 defaults to active subscribers;
	// status=all is essential to preserve cancellations, bounces and complaints.
	resources := []struct {
		path, key string
		target    *int
	}{
		{"/subscribers?status=all", "subscribers", &rep.SubscribersTotal},
		{"/tags", "tags", &rep.GroupsTotal},
		{"/segments", "segments", &rep.SegmentsTotal},
		{"/sequences", "sequences", &rep.AutomationsTotal},
		{"/broadcasts?status=completed", "broadcasts", &rep.ArchiveTotal},
		{"/forms?status=all&type=embed", "forms", &rep.FormsTotal},
		{"/forms?status=all&type=hosted", "forms", &rep.LandingPagesTotal},
	}
	for _, resource := range resources {
		if err := a.walk(ctx, sess, resource.path, resource.key, func(rows []json.RawMessage) error { *resource.target += len(rows); return nil }); err != nil {
			return rep, err
		}
	}
	rep.SegmentsTotal += rep.GroupsTotal
	rep.CampaignsTotal, rep.ReportsTotal = rep.ArchiveTotal, rep.ArchiveTotal
	rep.SourceArchiveTotal = rep.AutomationsTotal + 4 // four explicit, non-detected product-area checklists
	rep.Warnings = []string{"Kit sequence emails and schedule settings are retained for rebuild review; visual automations, forms and billing require separate setup.", "Creation timestamps do not establish subscriber opt-in. Freeze source changes and take a final full snapshot before cutover."}
	return rep, nil
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	rows, next, err := a.page(ctx, sess, "/subscribers?status=all&include=tags", "subscribers", cursor)
	if err != nil {
		return nil, "", err
	}
	out := make([]canonical.Subscriber, 0, len(rows))
	for _, raw := range rows {
		var sub ckSubscriber
		if err := json.Unmarshal(raw, &sub); err != nil {
			return nil, "", err
		}
		if sub.ID <= 0 || strings.TrimSpace(sub.EmailAddress) == "" {
			return nil, "", fmt.Errorf("kit: subscriber lacks ID or email")
		}
		// Some account responses omit expansions. Read the documented membership
		// endpoint rather than treating an absent tags property as an empty set.
		if sub.Tags == nil {
			err := a.walk(ctx, sess, fmt.Sprintf("/subscribers/%d/tags", sub.ID), "tags", func(tags []json.RawMessage) error {
				for _, rawTag := range tags {
					var tag ckTag
					if err := json.Unmarshal(rawTag, &tag); err != nil {
						return err
					}
					sub.Tags = append(sub.Tags, tag)
				}
				return nil
			})
			if err != nil {
				return nil, "", fmt.Errorf("kit: subscriber tag membership incomplete: %w", err)
			}
		}
		out = append(out, mapSubscriber(sub))
	}
	return out, next, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	var out []canonical.Segment
	if err := a.walk(ctx, sess, "/tags", "tags", func(rows []json.RawMessage) error {
		for _, raw := range rows {
			var tag ckTag
			if err := json.Unmarshal(raw, &tag); err != nil {
				return err
			}
			if tag.ID <= 0 || strings.TrimSpace(tag.Name) == "" {
				return fmt.Errorf("kit: invalid tag identity")
			}
			out = append(out, canonical.Segment{Name: "Tag: " + tag.Name, QueryAST: canonical.SegmentNode{Op: "condition", Field: "tag", Comparator: "equals", Value: tag.Name}, SourceDefinition: string(raw)})
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := a.walk(ctx, sess, "/segments", "segments", func(rows []json.RawMessage) error {
		for _, raw := range rows {
			var segment ckSegment
			if err := json.Unmarshal(raw, &segment); err != nil {
				return err
			}
			if segment.ID <= 0 || strings.TrimSpace(segment.Name) == "" {
				return fmt.Errorf("kit: invalid segment identity")
			}
			out = append(out, canonical.Segment{Name: segment.Name, QueryAST: canonical.SegmentNode{Op: "and"}, SourceDefinition: string(raw), Description: "Kit does not expose segment predicates; rebuild and review targeting."})
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	items, err := a.sequenceEvidence(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Automation, 0, len(items))
	for _, item := range items {
		raw, err := json.Marshal(item.Payload)
		if err != nil {
			return nil, err
		}
		out = append(out, canonical.Automation{Name: item.Name, Status: "draft", SourceDefinition: string(raw), Nodes: []canonical.AutomationNode{{ID: "source-sequence", Type: "kit_sequence_rebuild", RawSource: item.Payload}}})
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	rows, next, err := a.page(ctx, sess, "/broadcasts?status=completed", "broadcasts", cursor)
	if err != nil {
		return nil, "", err
	}
	out := make([]canonical.CampaignArchive, 0, len(rows))
	for _, raw := range rows {
		var b ckBroadcast
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, "", err
		}
		if b.ID <= 0 || b.Status != "completed" || strings.TrimSpace(b.Content) == "" {
			return nil, "", fmt.Errorf("kit: completed broadcast response has invalid identity, status, or missing content")
		}
		sentAt, ok := parseConvertkitTime(b.SendAt)
		if !ok {
			return nil, "", fmt.Errorf("kit: sent broadcast has no valid send_at")
		}
		var stats struct {
			Broadcast struct {
				ID    int `json:"id"`
				Stats struct {
					Recipients *int `json:"recipients"`
					Opens      *int `json:"emails_opened"`
					Clicks     *int `json:"total_clicks"`
				} `json:"stats"`
			} `json:"broadcast"`
		}
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/broadcasts/%d/stats", b.ID), nil, &stats); err != nil {
			return nil, "", fmt.Errorf("kit: broadcast report incomplete: %w", err)
		}
		if stats.Broadcast.ID != b.ID {
			return nil, "", fmt.Errorf("kit: broadcast report identity mismatch")
		}
		counts := stats.Broadcast.Stats
		if counts.Recipients == nil || counts.Opens == nil || counts.Clicks == nil || *counts.Recipients < 0 || *counts.Opens < 0 || *counts.Clicks < 0 {
			return nil, "", fmt.Errorf("kit: broadcast report has missing or invalid totals")
		}
		out = append(out, canonical.CampaignArchive{SourceID: strconv.Itoa(b.ID), Subject: b.Subject, HTML: b.Content, SentAt: sentAt, RecipientsCount: *counts.Recipients, Opens: *counts.Opens, Clicks: *counts.Clicks, SourcePlatform: canonical.SourceConvertKit})
	}
	return out, next, nil
}

// ConvertKit's Commerce / paid-newsletter offering is implemented as a Stripe
// Connect link from the publisher's Stripe account. The canonical paid-sub
// stream therefore lives on the Stripe side, not behind the Kit API.
func (a *Adapter) ListPaidSubs(ctx context.Context, sess adapter.Session, stripeAccountID string) ([]canonical.PaidSub, error) {
	accountID := stripeAccountID
	if accountID == "" && sess.Extra != nil {
		accountID = sess.Extra["stripe_account_id"]
	}
	if accountID == "" {
		slog.Info("convertkit paid-sub migration skipped; no connected Stripe account id")
		return nil, adapter.ErrUnsupported
	}
	return stripeconnect.ListSubscriptions(ctx, accountID, canonical.SourceConvertKit)
}

// --- internals ---

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if a.ResolveSession != nil {
		updated, err := a.ResolveSession(ctx)
		if err != nil {
			return fmt.Errorf("kit: load durable source credential: %w", err)
		}
		if updated.AccountID != sess.AccountID || updated.Source != sess.Source {
			return fmt.Errorf("kit: source account changed during credential refresh: %w", adapter.ErrAuth)
		}
		sess = updated
	}

	if err := a.limiter.Wait(ctx); err != nil {
		return err
	}
	base := a.BaseURL
	if base == "" {
		base = apiBase
	}
	if path != "/account" && (sess.AccountID == "" || sess.Extra["api_version"] != "4") {
		return fmt.Errorf("kit: reconnect to establish a v4 account-bound session: %w", adapter.ErrAuth)
	}
	if sess.Extra["api_secret"] != "" {
		return fmt.Errorf("kit: v3 secret cannot be used with v4: %w", adapter.ErrAuth)
	}
	endpoint, err := adapter.BuildURL(base, path)
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if sess.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	} else if key := sess.Extra["api_key"]; key != "" {
		req.Header.Set("X-Kit-Api-Key", key)
	} else {
		return fmt.Errorf("kit: missing credential: %w", adapter.ErrAuth)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("convertkit %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return &adapter.ErrRateLimited{RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("convertkit %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode >= 500 {
		return fmt.Errorf("convertkit %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("kit %s request returned status %d", method, resp.StatusCode)
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("convertkit %s %s: response body: %w", method, path, err)
		}
		return nil
	}
	return adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
}

// page validates the v4 cursor envelope. Missing pagination or a stalled
// continuation must fail, otherwise an incomplete account looks complete.
func (a *Adapter) page(ctx context.Context, sess adapter.Session, path, key, cursor string) ([]json.RawMessage, string, error) {
	u, err := url.Parse(path)
	if err != nil {
		return nil, "", err
	}
	query := u.Query()
	query.Set("per_page", "500")
	if cursor != "" {
		query.Set("after", cursor)
	}
	u.RawQuery = query.Encode()
	var response map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, u.String(), nil, &response); err != nil {
		return nil, "", err
	}
	var rows []json.RawMessage
	if len(response[key]) == 0 || string(response[key]) == "null" {
		return nil, "", fmt.Errorf("kit: %s collection is absent", key)
	}
	if err := json.Unmarshal(response[key], &rows); err != nil {
		return nil, "", err
	}
	var pagination struct {
		HasNext *bool  `json:"has_next_page"`
		End     string `json:"end_cursor"`
	}
	if err := json.Unmarshal(response["pagination"], &pagination); err != nil || pagination.HasNext == nil {
		return nil, "", fmt.Errorf("kit: missing or invalid pagination for %s", key)
	}
	if *pagination.HasNext {
		if len(rows) == 0 || pagination.End == "" || pagination.End == cursor {
			return nil, "", fmt.Errorf("kit: stalled pagination for %s", key)
		}
		return rows, pagination.End, nil
	}
	return rows, "", nil
}

func (a *Adapter) walk(ctx context.Context, sess adapter.Session, path, key string, consume func([]json.RawMessage) error) error {
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 10000; page++ {
		rows, next, err := a.page(ctx, sess, path, key, cursor)
		if err != nil {
			return err
		}
		if err := consume(rows); err != nil {
			return err
		}
		if next == "" {
			return nil
		}
		if seen[next] {
			return fmt.Errorf("kit: repeated pagination cursor for %s", key)
		}
		seen[next] = true
		cursor = next
	}
	return fmt.Errorf("kit: %s exceeded page traversal limit", key)
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
