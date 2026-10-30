// SPDX-License-Identifier: MIT

// Package klaviyo implements the Klaviyo source adapter.
//
// Auth: Private API Key (`Authorization: Klaviyo-API-Key <key>`) or OAuth
// access token (`Authorization: Bearer <token>`).
// Base URL: https://a.klaviyo.com/api/.
// Revision header is required on every request; we pin Klaviyo's current
// GA revision so the JSON:API response shape does not drift mid-migration.
// Documented rate limits vary per endpoint. Profile pulls with predictive
// analytics are the tightest path we use, so the default limiter follows that
// steady quota and relies on Retry-After on 429.
package klaviyo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	defaultBase = "https://a.klaviyo.com/api"
	apiRevision = "2026-07-15"

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 32 << 20
	maxProviderCursorBytes          = 16 << 10
	maxTraversalPages               = 10000
	maxMembershipEvidence           = 1000000

	AccountIDExtraKey          = "klaviyo_account_id"
	AccountFingerprintExtraKey = "klaviyo_account_fingerprint"
)

func init() {
	adapter.Register(canonical.SourceKlaviyo, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for Klaviyo.
type Adapter struct {
	http    *http.Client
	BaseURL string // overridable in tests

	cacheMu   sync.Mutex
	snapshots map[string]*klaviyoSnapshot
}

// New constructs an adapter capped at Klaviyo's conservative profile import
// steady quota, with a small burst for single-page discovery calls.
func New() *Adapter {
	return &Adapter{
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				// Never forward a private key or OAuth bearer token to another
				// origin through an HTTP redirect.
				return http.ErrUseLastResponse
			},
		},
		BaseURL:   defaultBase,
		snapshots: make(map[string]*klaviyoSnapshot),
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceKlaviyo,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = true
	c.Supports.AutomationMode = "rebuild_review"
	c.Supports.CampaignArchive = true
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = true
	c.Supports.Campaigns = true
	c.Supports.Reports = false
	c.Supports.Groups = false
	c.Supports.Forms = true
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	// SMS/push/WhatsApp consent evidence is preserved inside email-addressable
	// profiles, but channel identities and sender continuity are not imported.
	c.Supports.SMS = false
	return c
}

// Authenticate validates the API key or OAuth access token and binds the
// resulting session to the exact Klaviyo account returned by /accounts.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	token := strings.TrimSpace(creds.AccessToken)
	authScheme := "private_api_key"
	if token == "" {
		token = strings.TrimSpace(creds.APIKey)
	} else {
		authScheme = "bearer"
	}
	if strings.EqualFold(creds.Extra["auth_scheme"], "bearer") || strings.EqualFold(creds.Extra["auth_scheme"], "oauth") {
		authScheme = "bearer"
	}
	if token == "" {
		return adapter.Session{}, fmt.Errorf("klaviyo: missing api_key or access_token: %w", adapter.ErrAuth)
	}
	sess := adapter.Session{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		Source:       canonical.SourceKlaviyo,
		Extra:        cloneMap(creds.Extra),
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	sess.Extra["auth_scheme"] = authScheme
	var accounts struct {
		Data []struct {
			Type       string          `json:"type"`
			ID         string          `json:"id"`
			Attributes json.RawMessage `json:"attributes"`
		} `json:"data"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/accounts", nil, &accounts); err != nil {
		return adapter.Session{}, err
	}
	if len(accounts.Data) == 0 {
		return adapter.Session{}, fmt.Errorf("klaviyo accounts returned no account: %w", adapter.ErrAuth)
	}
	desired := strings.TrimSpace(creds.AccountID)
	if desired == "" {
		desired = strings.TrimSpace(sess.Extra[AccountIDExtraKey])
	}
	selected := ""
	for _, account := range accounts.Data {
		id := strings.TrimSpace(account.ID)
		if account.Type != "account" || !validProviderID(id) {
			return adapter.Session{}, fmt.Errorf("klaviyo accounts returned an invalid account identity: %w", adapter.ErrSourceUnavailable)
		}
		if desired == "" || id == desired {
			if selected != "" && desired == "" {
				return adapter.Session{}, fmt.Errorf("klaviyo credential exposes multiple accounts; provide account_id explicitly: %w", adapter.ErrAuth)
			}
			selected = id
		}
	}
	if selected == "" {
		return adapter.Session{}, fmt.Errorf("klaviyo account %q is not available to this credential: %w", desired, adapter.ErrAuth)
	}
	sess.AccountID = selected
	sess.Extra[AccountIDExtraKey] = selected
	sess.Extra[AccountFingerprintExtraKey] = accountFingerprint(selected)
	if err := klaviyoRequestLimiters.chargeIdentifiedAccount(selected); err != nil {
		return adapter.Session{}, fmt.Errorf("klaviyo account rate-limit binding: %w", err)
	}
	return sess, nil
}

// AccountFingerprint returns the opaque stable account binding established by
// Authenticate. It is safe to persist with a migration job.
func AccountFingerprint(sess adapter.Session) string {
	if sess.Source != canonical.SourceKlaviyo || len(sess.Extra) == 0 {
		return ""
	}
	accountID := strings.TrimSpace(sess.AccountID)
	fingerprint := strings.TrimSpace(sess.Extra[AccountFingerprintExtraKey])
	if !validProviderID(accountID) || strings.TrimSpace(sess.Extra[AccountIDExtraKey]) != accountID || fingerprint != accountFingerprint(accountID) {
		return ""
	}
	return fingerprint
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return adapter.DiscoveryReport{}, err
	}
	rep := adapter.DiscoveryReport{
		SubscribersTotal:          snapshot.EmailProfiles,
		ProfilesWithoutEmailTotal: snapshot.ProfilesWithoutEmail,
		SegmentsTotal:             len(snapshot.Lists) + len(snapshot.Segments),
		AutomationsTotal:          len(snapshot.Flows),
		ArchiveTotal:              snapshot.SentCampaigns,
		CampaignsTotal:            snapshot.SentCampaigns + len(snapshot.NonEmailSentCampaigns) + len(snapshot.NonSentCampaigns),
		ReportsTotal:              0,
		TemplatesTotal:            snapshot.Templates,
		FormsTotal:                len(snapshot.Forms),
		SMSCampaignsTotal:         snapshot.SentSMSCampaigns,
		PushCampaignsTotal:        snapshot.SentPushCampaigns,
		CustomFields:              append([]string(nil), snapshot.CustomFields...),
		SnapshotMembershipCounts:  cloneIntMap(snapshot.MembershipCounts),
		Warnings:                  append([]string(nil), snapshot.Warnings...),
		SourceArchiveTotal:        klaviyoStaticArchiveTaskCount + len(snapshot.Flows) + len(snapshot.Forms) + len(snapshot.NonEmailSentCampaigns) + len(snapshot.NonSentCampaigns) + len(snapshot.RebuildTemplates),
	}
	for _, item := range snapshot.Lists {
		tag := listMembershipTag(item.ID)
		name := resourceName(item)
		if name == "" {
			name = listDisplayName(item)
		} else {
			name = "Klaviyo list: " + name
		}
		rep.Audiences = append(rep.Audiences, adapter.DiscoveryAudience{ID: tag, Name: name, SubscribersTotal: snapshot.MembershipCounts[tag]})
	}
	for _, item := range snapshot.Segments {
		tag := segmentMembershipTag(item.ID)
		name := resourceName(item)
		if name == "" {
			name = segmentDisplayName(item)
		} else {
			name = "Klaviyo segment: " + name
		}
		rep.Audiences = append(rep.Audiences, adapter.DiscoveryAudience{ID: tag, Name: name, SubscribersTotal: snapshot.MembershipCounts[tag]})
	}
	if len(snapshot.NonSentCampaigns) > 0 {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("%d draft, scheduled, cancelled, or otherwise non-sent Klaviyo campaigns are preserved as rebuild records and are not materialized as sent history.", len(snapshot.NonSentCampaigns)))
	}
	if snapshot.SentPushCampaigns > 0 {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("%d sent mobile-push campaigns are preserved in the source archive as non-email channel evidence; they are not executable email campaigns.", snapshot.SentPushCampaigns))
	}
	if snapshot.CampaignTagsPresent {
		rep.Warnings = append(rep.Warnings, "Klaviyo campaign tag relationship IDs are retained, but tag display names and groups are not hydrated; review campaign taxonomy against a provider export before rebuild or cutover.")
	}
	return rep, nil
}

// ListSubscribers paginates via Klaviyo's JSON:API cursor links. The cursor is
// the opaque `page[cursor]=...` token returned in `links.next`.
func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	cursor = strings.TrimSpace(cursor)
	if len(cursor) > maxProviderCursorBytes {
		return nil, "", fmt.Errorf("klaviyo profiles cursor is too large: %w", adapter.ErrSourceUnavailable)
	}
	query := url.Values{
		"page[size]":                 {strconv.Itoa(profilePageSize)},
		"additional-fields[profile]": {"subscriptions,predictive_analytics"},
		"sort":                       {"id"},
	}
	if cursor != "" {
		query.Set("page[cursor]", cursor)
	}
	var resp jsonAPIPage[kvProfile]
	if err := a.do(ctx, sess, http.MethodGet, "/profiles?"+query.Encode(), nil, &resp); err != nil {
		return nil, "", err
	}
	if len(resp.Data) > profilePageSize {
		return nil, "", fmt.Errorf("klaviyo profiles returned more than %d rows: %w", profilePageSize, adapter.ErrSourceUnavailable)
	}
	out := make([]canonical.Subscriber, 0, len(resp.Data))
	seen := map[string]struct{}{}
	for _, p := range resp.Data {
		if p.Type != "profile" || !validProviderID(p.ID) {
			return nil, "", fmt.Errorf("klaviyo profiles returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[p.ID]; duplicate {
			return nil, "", fmt.Errorf("klaviyo profiles returned duplicate identity %q on one page: %w", p.ID, adapter.ErrSourceUnavailable)
		}
		seen[p.ID] = struct{}{}
		if _, discovered := snapshot.AllProfileIDs[p.ID]; !discovered {
			return nil, "", fmt.Errorf("klaviyo profile %q appeared after the discovery snapshot: %w", p.ID, adapter.ErrSourceUnavailable)
		}
		email := strings.TrimSpace(p.Attributes.Email)
		if email == "" {
			if _, wasAddressable := snapshot.EmailProfileIDs[p.ID]; wasAddressable {
				return nil, "", fmt.Errorf("klaviyo profile %q lost its email after discovery: %w", p.ID, adapter.ErrSourceUnavailable)
			}
			continue
		}
		if _, wasAddressable := snapshot.EmailProfileIDs[p.ID]; !wasAddressable {
			return nil, "", fmt.Errorf("klaviyo profile %q gained an email after discovery: %w", p.ID, adapter.ErrSourceUnavailable)
		}
		subscriber, mapErr := mapProfile(p, snapshot.TagsByProfile[p.ID])
		if mapErr != nil {
			return nil, "", mapErr
		}
		out = append(out, subscriber)
	}
	next, err := nextCursor(resp.Links.Next, cursor, "profiles")
	if err != nil {
		return nil, "", err
	}
	if next != "" && len(resp.Data) == 0 {
		return nil, "", fmt.Errorf("klaviyo profiles returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
	}
	return out, next, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Segment, 0, len(snapshot.Lists)+len(snapshot.Segments))
	for _, item := range snapshot.Lists {
		out = append(out, translateListAsSegment(item))
	}
	for _, item := range snapshot.Segments {
		out = append(out, translateSegment(item))
	}
	return out, nil
}

func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Automation, 0, len(snapshot.Flows))
	for _, flow := range snapshot.Flows {
		out = append(out, translateFlow(flow))
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	return a.listCampaignArchive(ctx, sess, cursor)
}

func (a *Adapter) ListTemplates(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.EmailTemplate, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	cursor = strings.TrimSpace(cursor)
	if len(cursor) > maxProviderCursorBytes {
		return nil, "", fmt.Errorf("klaviyo templates cursor is too large: %w", adapter.ErrSourceUnavailable)
	}
	query := url.Values{
		"page[size]":                  {strconv.Itoa(templatePageSize)},
		"additional-fields[template]": {"definition"},
		"sort":                        {"id"},
	}
	if cursor != "" {
		query.Set("page[cursor]", cursor)
	}
	var resp jsonAPIPage[kvTemplate]
	if err := a.do(ctx, sess, http.MethodGet, "/templates?"+query.Encode(), nil, &resp); err != nil {
		return nil, "", err
	}
	if len(resp.Data) > templatePageSize {
		return nil, "", fmt.Errorf("klaviyo templates returned more than %d rows: %w", templatePageSize, adapter.ErrSourceUnavailable)
	}
	out := make([]canonical.EmailTemplate, 0, len(resp.Data))
	seen := map[string]struct{}{}
	for _, tmpl := range resp.Data {
		if tmpl.Type != "template" || !validProviderID(tmpl.ID) || strings.TrimSpace(tmpl.Attributes.Name) == "" {
			return nil, "", fmt.Errorf("klaviyo templates returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[tmpl.ID]; duplicate {
			return nil, "", fmt.Errorf("klaviyo templates returned duplicate identity %q: %w", tmpl.ID, adapter.ErrSourceUnavailable)
		}
		seen[tmpl.ID] = struct{}{}
		if strings.TrimSpace(tmpl.Attributes.HTML) == "" {
			// Structured-only templates are preserved by ListSourceArchive as
			// rebuild records; they are not editable destination templates.
			continue
		}
		if _, discovered := snapshot.EditableTemplateIDs[tmpl.ID]; !discovered {
			return nil, "", fmt.Errorf("klaviyo editable template %q appeared after discovery: %w", tmpl.ID, adapter.ErrSourceUnavailable)
		}
		mapped, mapErr := mapTemplate(tmpl)
		if mapErr != nil {
			return nil, "", mapErr
		}
		out = append(out, mapped)
	}
	next, err := nextCursor(resp.Links.Next, cursor, "templates")
	if err != nil {
		return nil, "", err
	}
	if next != "" && len(resp.Data) == 0 {
		return nil, "", fmt.Errorf("klaviyo templates returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
	}
	return out, next, nil
}

// ListPaidSubs is unsupported for Klaviyo (no native subscription model).
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

// --- helpers ---

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if err := klaviyoRequestLimiters.forRequest(sess, path).Wait(ctx); err != nil {
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
	if strings.EqualFold(sess.Extra["auth_scheme"], "bearer") || strings.EqualFold(sess.Extra["auth_scheme"], "oauth") {
		req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	} else {
		req.Header.Set("Authorization", "Klaviyo-API-Key "+sess.AccessToken)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("revision", apiRevision)
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("klaviyo %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return &adapter.ErrRateLimited{RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("klaviyo %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode == http.StatusBadRequest && strings.HasPrefix(path, "/accounts") {
		return fmt.Errorf("klaviyo %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode >= 500 {
		return fmt.Errorf("klaviyo %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
		return fmt.Errorf("klaviyo %s %s status %d: %s", method, path, resp.StatusCode, string(b))
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("klaviyo %s %s: response body: %w", method, path, err)
		}
		return nil
	}
	return adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
}

// extractCursor pulls the `page[cursor]` value out of a JSON:API next URL.
func extractCursor(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Query().Get("page[cursor]"))
}

func encodeArchiveCursor(channel, page string) string {
	if channel == "" {
		return ""
	}
	return channel + ":" + page
}

func decodeArchiveCursor(cursor string) (channel, page string) {
	if cursor == "" {
		return "email", ""
	}
	if i := strings.Index(cursor, ":"); i >= 0 {
		return cursor[:i], cursor[i+1:]
	}
	return cursor, ""
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

func groupFlowActions(items []kvResource) map[string][]kvResource {
	out := map[string][]kvResource{}
	for _, item := range items {
		if item.Type != "" && item.Type != "flow-action" && item.Type != "flow-actions" {
			continue
		}
		flowID := flowIDForAction(item)
		if flowID == "" {
			continue
		}
		out[flowID] = append(out[flowID], item)
	}
	return out
}

func flowIDForAction(item kvResource) string {
	attrs := rawMap(item.Attributes)
	if id := firstString(attrs, "flow_id", "flow", "flowId"); id != "" {
		return id
	}
	for _, key := range []string{"flow", "flows"} {
		raw, ok := item.Relationships[key]
		if !ok || len(raw) == 0 {
			continue
		}
		var rel struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if jsonErr := adapterDecodeRaw(raw, &rel); jsonErr == nil && rel.Data.ID != "" {
			return rel.Data.ID
		}
	}
	return ""
}

func adapterDecodeRaw(raw []byte, out interface{}) error {
	return json.Unmarshal(raw, out)
}

// urlEncode is a tiny URL-component encoder for filter expressions. It only
// escapes characters that would break a query string: spaces, ampersands,
// equals, plus, percent, and quotes (Klaviyo's filter strings use single
// quotes which survive bare in practice, but we encode defensively).
func urlEncode(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == ' ':
			b.WriteString("%20")
		case r == '&':
			b.WriteString("%26")
		case r == '=':
			b.WriteString("%3D")
		case r == '+':
			b.WriteString("%2B")
		case r == '%':
			b.WriteString("%25")
		case r == '\'':
			b.WriteString("%27")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
