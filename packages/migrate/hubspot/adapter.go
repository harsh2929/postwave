// SPDX-License-Identifier: MIT

// Package hubspot implements a HubSpot contact/list bridge source adapter.
//
// Auth: HubSpot Service Key or existing private app access token (Bearer).
package hubspot

import (
	"bytes"
	"context"
	"crypto/sha256"
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
	defaultBase           = "https://api.hubapi.com"
	contactSearchPageSize = 100
	maxContactProperties  = 120
	maxRetries            = 4
	initialBackoff        = time.Second
	backoffCap            = 20 * time.Second

	sourceEventReplayOverlap = time.Second

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20
	defaultSnapshotByteLimit  int64 = 64 << 20
)

const (
	// These keys bind an authenticated private-app session to the
	// provider-verified HubSpot portal. Callers must not derive account identity
	// or hosting location from user-supplied credential metadata.
	HubIDExtraKey               = "hub_id"
	DataHostingLocationExtraKey = "data_hosting_location"
	AccountFingerprintExtraKey  = "account_fingerprint"
)

func init() {
	adapter.Register(canonical.SourceHubSpot, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for HubSpot.
type Adapter struct {
	HTTPClient *http.Client
	limiter    *adapter.TokenBucket
	BaseURL    string

	cacheMu   sync.Mutex
	snapshots map[string]*hubSpotSnapshot

	snapshotByteLimit int64
}

// New constructs a HubSpot adapter with the documented CRM search limit in
// mind. HubSpot private apps are generally higher, but search is capped at
// 5 requests/sec, so the adapter uses the stricter limit.
func New() *Adapter {
	return &Adapter{
		HTTPClient:        &http.Client{Timeout: 30 * time.Second},
		limiter:           adapter.NewTokenBucket(5, time.Second, 5),
		BaseURL:           defaultBase,
		snapshots:         make(map[string]*hubSpotSnapshot),
		snapshotByteLimit: defaultSnapshotByteLimit,
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceHubSpot,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = false
	c.Supports.CampaignArchive = false
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = false
	c.Supports.Campaigns = false
	c.Supports.Reports = false
	c.Supports.Groups = true
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	c.Supports.CRM = true
	c.Supports.CustomObjects = false
	c.Supports.SMS = false
	return c
}

func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	token := strings.TrimSpace(creds.APIKey)
	if token == "" {
		return adapter.Session{}, fmt.Errorf("hubspot: missing Service Key or access token: %w", adapter.ErrAuth)
	}
	expectedHubID, err := expectedHubSpotPortalID(creds)
	if err != nil {
		return adapter.Session{}, err
	}
	extra := cloneMap(creds.Extra)
	if extra == nil {
		extra = map[string]string{}
	}
	sess := adapter.Session{
		AccessToken: token,
		Source:      canonical.SourceHubSpot,
		Extra:       extra,
	}
	var out hsObjectPage
	if err := a.do(ctx, sess, http.MethodGet, "/crm/objects/"+hubSpotAPIVersion+"/contacts?limit=1&properties=email", nil, &out); err != nil {
		return adapter.Session{}, err
	}
	hubID, dataHostingLocation, err := a.lookupAccountIdentity(ctx, sess)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("hubspot: verify portal identity: %w", err)
	}
	if expectedHubID != "" && expectedHubID != hubID {
		// Do not echo either numeric selector: portal IDs are account
		// identifiers and the migration error sanitizer does not redact
		// arbitrary numbers.
		return adapter.Session{}, fmt.Errorf("hubspot: authenticated portal does not match the requested portal: %w", adapter.ErrAuth)
	}
	sess.AccountID = hubID
	sess.Extra[HubIDExtraKey] = hubID
	sess.Extra[DataHostingLocationExtraKey] = dataHostingLocation
	sess.Extra[AccountFingerprintExtraKey] = accountFingerprintForHubID(hubID)
	return sess, nil
}

func expectedHubSpotPortalID(creds adapter.Credentials) (string, error) {
	selectors := []string{
		strings.TrimSpace(creds.AccountID),
		strings.TrimSpace(creds.Extra["portal_id"]),
		strings.TrimSpace(creds.Extra[HubIDExtraKey]),
	}
	expected := ""
	for _, selector := range selectors {
		if selector == "" {
			continue
		}
		if !validHubSpotObjectID(selector) {
			return "", fmt.Errorf("hubspot: requested portal selector is invalid: %w", adapter.ErrAuth)
		}
		if expected != "" && selector != expected {
			return "", fmt.Errorf("hubspot: requested portal selectors disagree: %w", adapter.ErrAuth)
		}
		expected = selector
	}
	return expected, nil
}

// AccountFingerprint returns the provider-verified, opaque portal identity
// bound to sess. It fails closed when session metadata is incomplete, forged,
// or inconsistent with AccountID.
func AccountFingerprint(sess adapter.Session) string {
	hubID := strings.TrimSpace(sess.AccountID)
	extraHubID := strings.TrimSpace(sess.Extra[HubIDExtraKey])
	dataHostingLocation := strings.ToLower(strings.TrimSpace(sess.Extra[DataHostingLocationExtraKey]))
	stored := strings.ToLower(strings.TrimSpace(sess.Extra[AccountFingerprintExtraKey]))
	if hubID == "" || extraHubID == "" || hubID != extraHubID || dataHostingLocation == "" || stored == "" {
		return ""
	}
	if expected := accountFingerprintForHubID(hubID); stored != expected {
		return ""
	}
	return stored
}

func accountFingerprintForHubID(hubID string) string {
	hubID = strings.TrimSpace(hubID)
	if hubID == "" {
		return ""
	}
	digest := sha256.Sum256([]byte("hubspot-account-v1\x00" + hubID))
	return fmt.Sprintf("%x", digest[:])
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return adapter.DiscoveryReport{}, err
	}
	membershipCounts := make(map[string]int)
	for tag, count := range snapshot.MembershipCounts {
		if strings.HasPrefix(tag, "hubspot:list:") || strings.HasPrefix(tag, "hubspot:subscription:") {
			membershipCounts[tag] = count
		}
	}
	activeSubscriptionDefinitions := 0
	for _, definition := range snapshot.SubscriptionDefinitions {
		if definition.IsActive != nil && *definition.IsActive && hubSpotSubscriptionDefinitionIsEmail(definition) {
			activeSubscriptionDefinitions++
		}
	}
	return adapter.DiscoveryReport{
		SubscribersTotal:               len(snapshot.Subscribers),
		ProfilesWithoutEmailTotal:      len(snapshot.ProfilesWithoutEmailIDs),
		AdditionalEmailIdentitiesTotal: snapshot.AdditionalEmailIdentities,
		SegmentsTotal:                  len(snapshot.Segments),
		SubscriptionChannelsTotal:      activeSubscriptionDefinitions,
		GroupsTotal:                    len(snapshot.ContactProperties),
		CRMTotal:                       len(snapshot.Subscribers) + len(snapshot.ProfilesWithoutEmailIDs),
		CustomFields:                   append([]string(nil), snapshot.CustomFields...),
		SnapshotMembershipCounts:       membershipCounts,
		Warnings:                       append([]string(nil), snapshot.Warnings...),
	}, nil
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	offset, err := decodeHubSpotSnapshotCursor(cursor, snapshot.Fingerprint, "subscribers", len(snapshot.Subscribers))
	if err != nil {
		return nil, "", err
	}
	if offset == len(snapshot.Subscribers) {
		return nil, "", nil
	}
	end := offset + hubSpotSnapshotPageSize
	if end > len(snapshot.Subscribers) {
		end = len(snapshot.Subscribers)
	}
	out := append([]canonical.Subscriber(nil), snapshot.Subscribers[offset:end]...)
	next := ""
	if end < len(snapshot.Subscribers) {
		next = encodeHubSpotSnapshotCursor(snapshot.Fingerprint, "subscribers", end)
	}
	return out, next, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	snapshot, err := a.ensureSnapshot(ctx, sess)
	if err != nil {
		return nil, err
	}
	return append([]canonical.Segment(nil), snapshot.Segments...), nil
}

func (a *Adapter) ListAutomations(_ context.Context, _ adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListCampaignArchive(_ context.Context, _ adapter.Session, _ string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}

func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListSourceEvents(ctx context.Context, sess adapter.Session, since time.Time, cursor string, limit int) (canonical.SourceEventBatch, error) {
	limit = requirePositiveLimit(limit)
	pageStart := 0
	cursor = strings.TrimSpace(cursor)
	if cursor != "" {
		if !validHubSpotPagingCursor(cursor) {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event cursor is not a positive numeric offset: %w", adapter.ErrSourceUnavailable)
		}
		parsed, _ := strconv.ParseUint(cursor, 10, 64)
		if parsed > 10_000 {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event cursor exceeds the provider search bound: %w", adapter.ErrSourceUnavailable)
		}
		pageStart = int(parsed)
	}
	props, err := a.loadContactProperties(ctx, sess)
	if err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot: load contact properties for source events: %w", err)
	}
	definitions, err := a.fetchSubscriptionDefinitions(ctx, sess)
	if err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot: load subscription definitions for source events: %w", err)
	}
	body := map[string]any{
		"limit":      limit,
		"properties": coreContactPropertyNames(),
		"sorts": []map[string]string{{
			"propertyName": "lastmodifieddate",
			"direction":    "ASCENDING",
		}},
	}
	if cursor != "" {
		body["after"] = cursor
	}
	if !since.IsZero() {
		body["filterGroups"] = []map[string]any{
			{
				"filters": []map[string]string{
					{
						"propertyName": "lastmodifieddate",
						"operator":     "GT",
						"value":        strconv.FormatInt(hubspotSourceEventUpdatedAfter(since).UnixMilli(), 10),
					},
				},
			},
		}
	}
	var resp hsStrictSearchPage
	if err := a.do(ctx, sess, http.MethodPost, "/crm/objects/"+hubSpotAPIVersion+"/contacts/search", body, &resp); err != nil {
		return canonical.SourceEventBatch{}, err
	}
	if resp.Results == nil || resp.Total == nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search omitted required results or total: %w", adapter.ErrSourceUnavailable)
	}
	if *resp.Total < 0 || *resp.Total > 10_000 {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search matched %d contacts and cannot prove completeness within the provider's 10,000-result query bound; use a narrower time partition: %w", *resp.Total, adapter.ErrSourceUnavailable)
	}
	if len(*resp.Results) > limit {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search returned %d contacts above requested limit %d: %w", len(*resp.Results), limit, adapter.ErrSourceUnavailable)
	}
	pageEnd := pageStart + len(*resp.Results)
	if pageStart > *resp.Total || pageEnd > *resp.Total {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search page offsets exceed reported total %d: %w", *resp.Total, adapter.ErrSourceUnavailable)
	}
	next := ""
	if resp.Paging != nil && resp.Paging.Next != nil {
		next = strings.TrimSpace(resp.Paging.Next.After)
		if !validHubSpotPagingCursor(next) {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search returned an invalid next cursor: %w", adapter.ErrSourceUnavailable)
		}
		nextValue, _ := strconv.ParseUint(next, 10, 64)
		if nextValue > 10_000 || int(nextValue) != pageEnd || int(nextValue) > *resp.Total {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search returned a non-contiguous next cursor: %w", adapter.ErrSourceUnavailable)
		}
	}
	if pageEnd < *resp.Total && next == "" {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search omitted paging before its reported total: %w", adapter.ErrSourceUnavailable)
	}
	if pageEnd == *resp.Total && next != "" {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search returned paging after its reported total: %w", adapter.ErrSourceUnavailable)
	}
	hydrated, err := a.hydrateContactProperties(ctx, sess, *resp.Results, allContactPropertyNames(props))
	if err != nil {
		return canonical.SourceEventBatch{}, err
	}
	memberships, err := a.contactListMemberships(ctx, sess, hydrated)
	if err != nil {
		return canonical.SourceEventBatch{}, err
	}
	addressable := 0
	for _, item := range hydrated {
		if validHubSpotEmail(strings.ToLower(strings.TrimSpace(item.Properties["email"]))) {
			addressable++
		}
	}
	if err := a.ensureDailyRequestBudget(ctx, sess, int64(2*addressable)); err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("hubspot: source-event communication-preference API budget: %w", err)
	}
	batch := canonical.SourceEventBatch{Events: make([]canonical.SourceEvent, 0, len(hydrated))}
	seenIDs := map[string]struct{}{}
	var lastOccurredAt time.Time
	for _, item := range hydrated {
		sourceID := firstNonEmpty(item.ID, item.Properties["hs_object_id"])
		if !validHubSpotObjectID(sourceID) {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search returned invalid contact identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenIDs[sourceID]; duplicate {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search duplicated a contact identity: %w", adapter.ErrSourceUnavailable)
		}
		seenIDs[sourceID] = struct{}{}
		event := mapContactToSourceEvent(item, props)
		if event.OccurredAt.IsZero() {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot contact is missing a stable timestamp for source event: %w", adapter.ErrSourceUnavailable)
		}
		if !since.IsZero() && event.OccurredAt.UTC().Before(hubspotSourceEventUpdatedAfter(since)) {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot contact source-event timestamp %s is older than requested replay window %s: %w", event.OccurredAt.UTC().Format(time.RFC3339), hubspotSourceEventUpdatedAfter(since).Format(time.RFC3339), adapter.ErrSourceUnavailable)
		}
		if !lastOccurredAt.IsZero() && event.OccurredAt.Before(lastOccurredAt) {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event search violated the requested ascending lastmodifieddate order: %w", adapter.ErrSourceUnavailable)
		}
		lastOccurredAt = event.OccurredAt
		if event.OccurredAt.After(batch.HighWatermark) {
			batch.HighWatermark = event.OccurredAt
		}
		if event.Subscriber == nil || strings.TrimSpace(event.Subscriber.Email) == "" {
			continue
		}
		sub := addHubSpotListTags(*event.Subscriber, memberships[sourceID])
		statuses, wideStatuses, preferenceErr := a.fetchContactSubscriptionPreferences(ctx, sess, sub.Email, definitions)
		if preferenceErr != nil {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event communication preferences: %w", preferenceErr)
		}
		sub, preferenceErr = applyHubSpotPreferences(sub, statuses, wideStatuses, definitions)
		if preferenceErr != nil {
			return canonical.SourceEventBatch{}, fmt.Errorf("hubspot source-event communication preferences: %w", preferenceErr)
		}
		hash := hubspotSourceEventProjectionHash(sub)
		event.Subscriber = &sub
		event.SourceID = "hubspot:contact:" + sourceID + ":" + event.OccurredAt.UTC().Format(time.RFC3339Nano) + ":" + hash
		event.Payload["projection_hash"] = hash
		batch.Events = append(batch.Events, event)
	}
	batch.NextCursor = next
	return batch, nil
}

func (a *Adapter) contactListMemberships(ctx context.Context, sess adapter.Session, contacts []hsObject) (map[string][]hsMembership, error) {
	return a.fetchContactMemberships(ctx, sess, contacts)
}

func (a *Adapter) loadContactProperties(ctx context.Context, sess adapter.Session) (map[string]hsProperty, error) {
	if AccountFingerprint(sess) == "" || strings.TrimSpace(sess.AccessToken) == "" {
		return nil, fmt.Errorf("hubspot session is not bound to a verified portal: %w", adapter.ErrAuth)
	}
	key := AccountFingerprint(sess)
	a.cacheMu.Lock()
	snapshot := a.snapshots[key]
	a.cacheMu.Unlock()
	if snapshot != nil {
		return snapshot.ContactProperties, nil
	}
	return a.fetchContactProperties(ctx, sess)
}

func hubspotSourceEventUpdatedAfter(since time.Time) time.Time {
	if since.IsZero() {
		return time.Time{}
	}
	return since.UTC().Add(-sourceEventReplayOverlap)
}

func hubspotSourceEventProjectionHash(sub canonical.Subscriber) string {
	raw, err := json.Marshal(sub)
	if err != nil {
		raw = []byte(fmt.Sprintf("%s:%s", sub.SourceID, sub.Email))
	}
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum[:8])
}

func (a *Adapter) lookupAccountIdentity(ctx context.Context, sess adapter.Session) (string, string, error) {
	var resp struct {
		PortalID            int64  `json:"portalId"`
		DataHostingLocation string `json:"dataHostingLocation"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/account-info/2026-03/details", nil, &resp); err != nil {
		return "", "", err
	}
	if resp.PortalID <= 0 {
		return "", "", fmt.Errorf("account details did not include a stable portal id: %w", adapter.ErrAuth)
	}
	location := strings.ToLower(strings.TrimSpace(resp.DataHostingLocation))
	if location == "" {
		return "", "", fmt.Errorf("account details did not include a data hosting location: %w", adapter.ErrAuth)
	}
	return fmt.Sprintf("%d", resp.PortalID), location, nil
}

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body any, out interface{}) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("hubspot: encode provider request: %w: %w", adapter.ErrSourceUnavailable, err)
		}
	}

	base := strings.TrimRight(a.BaseURL, "/")
	wait := initialBackoff
	for attempt := 0; attempt <= maxRetries; attempt++ {
		// Retries consume HubSpot quota too. Acquire a limiter token for every
		// HTTP attempt, not only for the first logical request.
		if err := a.limiter.Wait(ctx); err != nil {
			return err
		}
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		endpoint, err := adapter.BuildURL(base, path)
		if err != nil {
			return fmt.Errorf("hubspot: build provider request URL: %w", adapter.ErrSourceUnavailable)
		}
		req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
		if err != nil {
			return fmt.Errorf("hubspot: build provider request: %w", adapter.ErrSourceUnavailable)
		}
		req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
		req.Header.Set("Accept", "application/json")
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := a.HTTPClient.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if attempt < maxRetries {
				if err := sleepCtx(ctx, wait); err != nil {
					return err
				}
				wait = nextHubSpotBackoff(wait)
				continue
			}
			return fmt.Errorf("hubspot %s provider request failed: %w", method, adapter.ErrSourceUnavailable)
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == 477 {
			retry := parseRetryAfter(resp.Header.Get("Retry-After"))
			_ = resp.Body.Close()
			// Migration-in-progress (477) responses can ask clients to wait for
			// hours. Return the retry signal to the durable job scheduler rather
			// than pinning a worker and its source lease.
			if attempt < maxRetries && retry <= backoffCap {
				if err := sleepCtx(ctx, retry); err != nil {
					return err
				}
				continue
			}
			return &adapter.ErrRateLimited{RetryAfter: retry}
		}
		if resp.StatusCode == http.StatusLocked {
			_ = resp.Body.Close()
			retry := 2 * time.Second
			if attempt < maxRetries {
				if err := sleepCtx(ctx, retry); err != nil {
					return err
				}
				continue
			}
			return &adapter.ErrRateLimited{RetryAfter: retry}
		}
		if resp.StatusCode >= 500 {
			_ = resp.Body.Close()
			if attempt < maxRetries {
				if err := sleepCtx(ctx, wait); err != nil {
					return err
				}
				wait = nextHubSpotBackoff(wait)
				continue
			}
			return fmt.Errorf("hubspot %s provider request status %d: %w", method, resp.StatusCode, adapter.ErrSourceUnavailable)
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
			_ = resp.Body.Close()
			return fmt.Errorf("hubspot %s provider request status %d: %w", method, resp.StatusCode, adapter.ErrAuth)
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			_ = resp.Body.Close()
			return fmt.Errorf("hubspot %s provider request status %d: %w", method, resp.StatusCode, adapter.ErrSourceUnavailable)
		}
		if resp.StatusCode >= 400 {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
			_ = resp.Body.Close()
			return hubspotErr(resp.StatusCode)
		}
		if out == nil {
			if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
				_ = resp.Body.Close()
				return fmt.Errorf("hubspot %s provider response body: %w: %w", method, adapter.ErrSourceUnavailable, err)
			}
			_ = resp.Body.Close()
			return nil
		}
		raw, readErr := adapter.ReadResponseBodyLimited(resp, maxJSONResponseBodyBytes)
		_ = resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("hubspot %s provider response decode: %w: %w", method, adapter.ErrSourceUnavailable, readErr)
		}
		if err := rejectDuplicateJSONKeys(raw); err != nil {
			return fmt.Errorf("hubspot %s provider response duplicate or malformed JSON: %w: %w", method, adapter.ErrSourceUnavailable, err)
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		// Provider payloads embed untyped values in identifiers and metadata.
		// Preserve their exact decimal spelling instead of coercing JSON numbers
		// through float64. Unsupported list predicates are discarded before
		// canonical materialization.
		decoder.UseNumber()
		if err := decoder.Decode(out); err != nil {
			return fmt.Errorf("hubspot %s provider response decode: %w: %w", method, adapter.ErrSourceUnavailable, err)
		}
		var trailing interface{}
		if err := decoder.Decode(&trailing); err != io.EOF {
			if err == nil {
				err = fmt.Errorf("multiple JSON values")
			}
			return fmt.Errorf("hubspot %s provider response decode: %w: %w", method, adapter.ErrSourceUnavailable, err)
		}
		return nil
	}
	return fmt.Errorf("hubspot %s provider request exhausted retries: %w", method, adapter.ErrSourceUnavailable)
}

func nextHubSpotBackoff(current time.Duration) time.Duration {
	current *= 2
	if current > backoffCap {
		return backoffCap
	}
	return current
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("object key is not a string")
				}
				if _, duplicate := seen[key]; duplicate {
					return fmt.Errorf("duplicate object key")
				}
				seen[key] = struct{}{}
				if err := visit(); err != nil {
					return err
				}
			}
			closeToken, closeErr := decoder.Token()
			if closeErr != nil || closeToken != json.Delim('}') {
				return fmt.Errorf("unterminated object")
			}
		case '[':
			for decoder.More() {
				if err := visit(); err != nil {
					return err
				}
			}
			closeToken, closeErr := decoder.Token()
			if closeErr != nil || closeToken != json.Delim(']') {
				return fmt.Errorf("unterminated array")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delim)
		}
		return nil
	}
	if err := visit(); err != nil {
		return err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}
