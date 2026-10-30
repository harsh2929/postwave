// SPDX-License-Identifier: MIT

// Package customerio implements the Customer.io source adapter.
//
// Customer.io's App API is the read-side API used by this adapter. It uses a
// Bearer App API key and exposes distinct US and EU origins. The Track and
// Pipelines APIs are write-side ingestion APIs and are intentionally not used
// during an import.
package customerio

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	defaultBaseUS = "https://api.customer.io"
	defaultBaseEU = "https://api-eu.customer.io"

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 32 << 20
	maxProviderCursorBytes          = 16 << 10
	maxTraversalPages               = 10000
	maxSnapshotProfiles             = 1000000
	maxMembershipEvidence           = 2000000
	maxUnpagedResources             = 100000
	maxRetryAfter                   = 24 * time.Hour

	// WorkspaceIDExtraKey is the selected Customer.io workspace ID. It is
	// duplicated in Session.AccountID so old and new callers bind identically.
	WorkspaceIDExtraKey = "customerio_workspace_id"
	// WorkspaceFingerprintExtraKey is a non-secret, opaque binding derived
	// from the region and workspace ID.
	WorkspaceFingerprintExtraKey = "customerio_workspace_fingerprint"
	// RegionExtraKey selects Customer.io's documented US or EU App API origin.
	RegionExtraKey = "region"
)

func init() {
	adapter.Register(canonical.SourceCustomerIO, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for Customer.io's App API.
type Adapter struct {
	http    *http.Client
	limiter *adapter.TokenBucket
	BaseURL string // test override; empty resolves from the bound session region

	cacheMu   sync.Mutex
	snapshots map[string]*customerIOSnapshot
}

// New uses Customer.io's documented general App API quota of 10 requests per
// second. Nine requests/second leaves a small margin for boundary jitter.
func New() *Adapter {
	return &Adapter{
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				// Never forward a bearer credential to a redirect target.
				return http.ErrUseLastResponse
			},
		},
		limiter:   adapter.NewTokenBucket(9, time.Second, 9),
		snapshots: make(map[string]*customerIOSnapshot),
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceCustomerIO,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	// Customer.io's App API exposes campaign/broadcast metadata and message
	// actions, but not a complete executable workflow graph. These definitions
	// are emitted as inert rebuild-review automations and preserved in the
	// source archive; they are never materialized as runtime automations.
	c.Supports.Automations = true
	c.Supports.AutomationMode = "rebuild_review"
	c.Supports.CampaignArchive = true // sent email newsletters only
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = false
	c.Supports.Templates = true // reusable Design Studio email templates
	c.Supports.Campaigns = true
	c.Supports.Reports = false
	c.Supports.Groups = false
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	c.Supports.CRM = false
	c.Supports.CustomObjects = false
	// SMS/WhatsApp opt-outs and non-email definitions are preserved, but
	// channel identities and sender continuity are not imported.
	c.Supports.SMS = false
	return c
}

// Authenticate validates a Bearer App API key and binds the resulting session
// to exactly one workspace returned by /v1/workspaces. If a credential exposes
// more than one workspace, callers must select one explicitly.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		token = strings.TrimSpace(creds.APIKey)
	}
	if token == "" {
		return adapter.Session{}, fmt.Errorf("customerio: missing api_key or access_token: %w", adapter.ErrAuth)
	}
	region, err := normalizeRegion(creds.Extra[RegionExtraKey])
	if err != nil {
		return adapter.Session{}, err
	}
	desired := strings.TrimSpace(creds.AccountID)
	extraDesired := strings.TrimSpace(creds.Extra[WorkspaceIDExtraKey])
	if desired != "" && extraDesired != "" && desired != extraDesired {
		return adapter.Session{}, fmt.Errorf("customerio: conflicting workspace IDs: %w", adapter.ErrAuth)
	}
	if desired == "" {
		desired = extraDesired
	}
	if desired != "" && !validWorkspaceID(desired) {
		return adapter.Session{}, fmt.Errorf("customerio: invalid workspace_id: %w", adapter.ErrAuth)
	}

	// Include an explicitly selected workspace on the validation request. This
	// is required by workspace-spanning service credentials and harmless for a
	// workspace-scoped App API key.
	sess := adapter.Session{
		AccessToken: token,
		AccountID:   desired,
		Source:      canonical.SourceCustomerIO,
		Extra: map[string]string{
			RegionExtraKey: region,
		},
	}
	if desired != "" {
		sess.Extra[WorkspaceIDExtraKey] = desired
	}

	var response struct {
		Workspaces *[]cioWorkspace `json:"workspaces"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/v1/workspaces", nil, &response); err != nil {
		return adapter.Session{}, err
	}
	workspaces, err := requireCollection(response.Workspaces, "workspaces")
	if err != nil {
		return adapter.Session{}, err
	}
	if len(workspaces) == 0 {
		return adapter.Session{}, fmt.Errorf("customerio workspaces returned no workspace: %w", adapter.ErrAuth)
	}
	selected := ""
	seen := make(map[string]struct{}, len(workspaces))
	for _, workspace := range workspaces {
		id := strings.TrimSpace(string(workspace.ID))
		if !validWorkspaceID(id) {
			return adapter.Session{}, fmt.Errorf("customerio workspaces returned an invalid identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[id]; duplicate {
			return adapter.Session{}, fmt.Errorf("customerio workspaces returned duplicate identity %q: %w", id, adapter.ErrSourceUnavailable)
		}
		seen[id] = struct{}{}
		if desired == "" || desired == id {
			if selected != "" && desired == "" {
				return adapter.Session{}, fmt.Errorf("customerio credential exposes multiple workspaces; provide account_id explicitly: %w", adapter.ErrAuth)
			}
			selected = id
		}
	}
	if selected == "" {
		return adapter.Session{}, fmt.Errorf("customerio workspace %q is not available to this credential: %w", desired, adapter.ErrAuth)
	}

	sess.AccountID = selected
	sess.Extra[WorkspaceIDExtraKey] = selected
	sess.Extra[WorkspaceFingerprintExtraKey] = workspaceFingerprint(region, selected)
	return sess, nil
}

// AccountFingerprint returns the stable, opaque workspace binding established
// by Authenticate. A forged or internally inconsistent session returns empty.
func AccountFingerprint(sess adapter.Session) string {
	if sess.Source != canonical.SourceCustomerIO || len(sess.Extra) == 0 {
		return ""
	}
	region, err := normalizeRegion(sess.Extra[RegionExtraKey])
	if err != nil {
		return ""
	}
	workspaceID := strings.TrimSpace(sess.AccountID)
	if !validWorkspaceID(workspaceID) || strings.TrimSpace(sess.Extra[WorkspaceIDExtraKey]) != workspaceID {
		return ""
	}
	want := workspaceFingerprint(region, workspaceID)
	if strings.TrimSpace(sess.Extra[WorkspaceFingerprintExtraKey]) != want {
		return ""
	}
	return want
}

// CustomerIONonEmailIdentityFingerprint returns bounded, non-reversible
// evidence for every profile excluded from the email-subscriber projection.
// Shadow certification uses it to detect same-count cio_id replacement without
// persisting the provider identities in the migration job.
func (a *Adapter) CustomerIONonEmailIdentityFingerprint(ctx context.Context, sess adapter.Session) (int, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return 0, "", err
	}
	digest := strings.TrimSpace(snapshot.ProfilesWithoutEmailIdentityDigest)
	if snapshot.ProfilesWithoutEmail < 0 || len(digest) != sha256.Size*2 {
		return 0, "", fmt.Errorf("customerio non-email profile identity evidence is invalid: %w", adapter.ErrSourceUnavailable)
	}
	return snapshot.ProfilesWithoutEmail, digest, nil
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return adapter.DiscoveryReport{}, err
	}
	report := adapter.DiscoveryReport{
		SubscribersTotal:          len(snapshot.Subscribers),
		ProfilesWithoutEmailTotal: snapshot.ProfilesWithoutEmail,
		SegmentsTotal:             len(snapshot.Segments) + len(snapshot.Topics),
		SubscriptionChannelsTotal: len(snapshot.Channels),
		AutomationsTotal:          len(snapshot.Campaigns) + len(snapshot.Broadcasts),
		ArchiveTotal:              len(snapshot.CampaignArchive),
		TemplatesTotal:            len(snapshot.Templates),
		CampaignsTotal:            len(snapshot.Campaigns) + len(snapshot.Broadcasts) + len(snapshot.Newsletters),
		ReportsTotal:              0,
		CustomObjectsTotal:        len(snapshot.ObjectTypes),
		SMSCampaignsTotal:         snapshot.SMSNewsletters,
		PushCampaignsTotal:        snapshot.PushNewsletters,
		SourceArchiveTotal:        len(snapshot.SourceArchive),
		CustomFields:              append([]string(nil), snapshot.CustomFields...),
		SnapshotMembershipCounts:  cloneIntMap(snapshot.MembershipCounts),
		Warnings:                  append([]string(nil), snapshot.Warnings...),
	}
	for _, segment := range snapshot.Segments {
		tag := segmentMembershipTag(string(segment.ID))
		report.Audiences = append(report.Audiences, adapter.DiscoveryAudience{
			ID:               tag,
			Name:             segmentDisplayName(segment),
			SubscribersTotal: snapshot.MembershipCounts[tag],
		})
	}
	for _, topic := range snapshot.Topics {
		tag := topicMembershipTag(topic.Identifier)
		report.Audiences = append(report.Audiences, adapter.DiscoveryAudience{
			ID:               tag,
			Name:             topicDisplayName(topic),
			SubscribersTotal: snapshot.MembershipCounts[tag],
		})
	}
	return report, nil
}

// ListSubscribers emits the immutable discovery snapshot in cio_id order.
// Cursors bind the offset to the complete snapshot fingerprint so a process
// restart cannot resume into a different same-count source snapshot.
func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	offset, err := decodeSnapshotCursor(cursor, snapshot.Fingerprint, "subscribers", len(snapshot.Subscribers), customerSearchPageSize)
	if err != nil {
		return nil, "", err
	}
	end := offset + customerSearchPageSize
	if end > len(snapshot.Subscribers) {
		end = len(snapshot.Subscribers)
	}
	out := cloneSubscribers(snapshot.Subscribers[offset:end])
	next := ""
	if end < len(snapshot.Subscribers) {
		next = encodeSnapshotCursor(snapshot.Fingerprint, "subscribers", end)
	}
	return out, next, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Segment, 0, len(snapshot.Segments)+len(snapshot.Topics))
	for _, segment := range snapshot.Segments {
		out = append(out, mapSegment(segment))
	}
	for _, topic := range snapshot.Topics {
		out = append(out, mapTopic(topic))
	}
	return out, nil
}

// ListAutomations emits inert rebuild-review definitions. Customer.io does
// not expose enough graph information to construct an executable workflow
// safely; full campaign/broadcast definitions and actions are also retained in
// ListSourceArchive.
func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	out := make([]canonical.Automation, 0, len(snapshot.Campaigns)+len(snapshot.Broadcasts))
	for _, campaign := range snapshot.Campaigns {
		automation, mapErr := mapWorkflowAutomation(campaign, resourceCampaignWorkflow, "customerio:campaign:")
		if mapErr != nil {
			return nil, mapErr
		}
		out = append(out, automation)
	}
	for _, broadcast := range snapshot.Broadcasts {
		automation, mapErr := mapWorkflowAutomation(broadcast, resourceBroadcastWorkflow, "customerio:broadcast:")
		if mapErr != nil {
			return nil, mapErr
		}
		out = append(out, automation)
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	offset, err := decodeSnapshotCursor(cursor, snapshot.Fingerprint, "campaign_archive", len(snapshot.CampaignArchive), archivePageSize)
	if err != nil {
		return nil, "", err
	}
	end := offset + archivePageSize
	if end > len(snapshot.CampaignArchive) {
		end = len(snapshot.CampaignArchive)
	}
	out := cloneCampaignArchive(snapshot.CampaignArchive[offset:end])
	next := ""
	if end < len(snapshot.CampaignArchive) {
		next = encodeSnapshotCursor(snapshot.Fingerprint, "campaign_archive", end)
	}
	return out, next, nil
}

func (a *Adapter) ListTemplates(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.EmailTemplate, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	offset, err := decodeSnapshotCursor(cursor, snapshot.Fingerprint, "templates", len(snapshot.Templates), templateOutputPageSize)
	if err != nil {
		return nil, "", err
	}
	end := offset + templateOutputPageSize
	if end > len(snapshot.Templates) {
		end = len(snapshot.Templates)
	}
	out := cloneTemplates(snapshot.Templates[offset:end])
	next := ""
	if end < len(snapshot.Templates) {
		next = encodeSnapshotCursor(snapshot.Fingerprint, "templates", end)
	}
	return out, next, nil
}

func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	offset, err := decodeSnapshotCursor(cursor, snapshot.Fingerprint, "source_archive", len(snapshot.SourceArchive), sourceArchivePageSize)
	if err != nil {
		return nil, "", err
	}
	end := offset + sourceArchivePageSize
	if end > len(snapshot.SourceArchive) {
		end = len(snapshot.SourceArchive)
	}
	out := cloneSourceArchive(snapshot.SourceArchive[offset:end])
	next := ""
	if end < len(snapshot.SourceArchive) {
		next = encodeSnapshotCursor(snapshot.Fingerprint, "source_archive", end)
	}
	return out, next, nil
}

func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	if err := a.limiter.Wait(ctx); err != nil {
		return err
	}
	base := a.BaseURL
	if base == "" {
		base = resolveBase(sess)
	}
	endpoint, err := adapter.BuildURL(base, path)
	if err != nil {
		return fmt.Errorf("customerio build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("customerio build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if workspaceID := strings.TrimSpace(sess.AccountID); workspaceID != "" {
		req.Header.Set("X-Workspace-Id", workspaceID)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("customerio %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return &adapter.ErrRateLimited{RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("customerio %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode >= 500 || (resp.StatusCode >= 300 && resp.StatusCode < 400) {
		return fmt.Errorf("customerio %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
		message := strings.TrimSpace(strings.Map(func(r rune) rune {
			if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
				return -1
			}
			return r
		}, string(b)))
		return fmt.Errorf("customerio %s %s status %d: %s", method, path, resp.StatusCode, message)
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("customerio %s %s response body: %w", method, path, err)
		}
		return nil
	}
	raw, err := adapter.ReadResponseBodyLimited(resp, maxJSONResponseBodyBytes)
	if err != nil {
		return fmt.Errorf("customerio %s %s decode response: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return fmt.Errorf("customerio %s %s decode response: duplicate or malformed JSON: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("customerio %s %s decode response: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	return nil
}

func validateSession(sess adapter.Session) error {
	if strings.TrimSpace(sess.AccessToken) == "" || AccountFingerprint(sess) == "" {
		return fmt.Errorf("customerio session is not bound to an authenticated workspace: %w", adapter.ErrAuth)
	}
	return nil
}

func normalizeRegion(raw string) (string, error) {
	region := strings.ToLower(strings.TrimSpace(raw))
	if region == "" {
		region = "us"
	}
	if region != "us" && region != "eu" {
		return "", fmt.Errorf("customerio: region must be us or eu: %w", adapter.ErrAuth)
	}
	return region, nil
}

func resolveBase(sess adapter.Session) string {
	if strings.EqualFold(strings.TrimSpace(sess.Extra[RegionExtraKey]), "eu") {
		return defaultBaseEU
	}
	return defaultBaseUS
}

func validWorkspaceID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func workspaceFingerprint(region, workspaceID string) string {
	digest := sha256.Sum256([]byte("customerio|" + region + "|" + workspaceID))
	return hex.EncodeToString(digest[:])
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 5 * time.Second
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds < 0 {
			return 5 * time.Second
		}
		if seconds > int64(maxRetryAfter/time.Second) {
			return maxRetryAfter
		}
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		if delay := at.Sub(now); delay > 0 {
			if delay > maxRetryAfter {
				return maxRetryAfter
			}
			return delay
		}
	}
	return 5 * time.Second
}

func cloneIntMap(in map[string]int) map[string]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]int, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
