// SPDX-License-Identifier: AGPL-3.0-only
//
// platform_adapter.go — SUB-113 ad-platform audience adapter foundations.
//
// Schema, sync ledger, and the consent firewall already exist (migrations
// 0256/0376/0377/0407); the webhook sync_runner ships members in
// HMAC-signed batches. This file adds the platform-adapter layer so a
// non-webhook destination (Meta / Google Ads / TikTok / LinkedIn / Snap)
// routes to provider-shaped Custom-Audience adapters instead of a webhook
// POST. The public destination API stores credential references, not raw
// tokens; the runner hydrates those refs through a trusted resolver immediately
// before delivery. Full availability still depends on platform-specific
// verification and app-review evidence.
//
// Each adapter implements PlatformAdapter. The runner's execute() resolves
// + firewall-filters members exactly as before, then hands the kept rows
// to the adapter for delivery. Adapters that lack resolved credentials report
// a readiness status (mirroring the socialads package) rather than firing a
// half-configured call.
package audience_destinations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
)

// platformHTTPTimeout bounds one Custom-Audience API call.
const platformHTTPTimeout = 15 * time.Second

// defaultPlatformHTTPClient is the fallback transport used by an adapter
// whose HTTPClient field is nil. It is bounded but NOT SSRF-restricted —
// the destination is a known first-party platform host, not a
// tenant-supplied URL, so the outbound-webhook SSRF guard does not apply.
var defaultPlatformHTTPClient = &http.Client{Timeout: platformHTTPTimeout}

type platformHTTPError struct {
	StatusCode int
	Body       string
	RetryAt    *time.Time
}

func (e *platformHTTPError) Error() string {
	if e == nil {
		return ""
	}
	message := fmt.Sprintf("platform returned HTTP %d", e.StatusCode)
	if e.Body != "" {
		message += ": " + e.Body
	}
	if e.RetryAt != nil {
		message += "; retry_after=" + e.RetryAt.UTC().Format(time.RFC3339)
	}
	return message
}

func (e *platformHTTPError) transient() bool {
	if e == nil {
		return false
	}
	return e.StatusCode == http.StatusTooManyRequests || e.StatusCode >= 500
}

// platformPOST is the shared transport every adapter uses to deliver its
// provider-specific Custom-Audience request. It marshals body to JSON,
// POSTs to url with the supplied headers, reads the response, and returns
// an error for any non-2xx (best-effort, including a bounded snippet of
// the platform's error body so an operator can self-diagnose). The
// response body bytes are returned for adapters that parse an external
// job/audience id from the reply.
func platformPOST(ctx context.Context, client *http.Client, url string, headers map[string]string, body any) ([]byte, error) {
	if client == nil {
		client = defaultPlatformHTTPClient
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Moosewave-AudienceSync/1.0")
	for k, v := range headers {
		if strings.TrimSpace(v) != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("deliver: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(respBody))
		if len(snippet) > 500 {
			snippet = snippet[:500] + "…"
		}
		return respBody, &platformHTTPError{
			StatusCode: resp.StatusCode,
			Body:       snippet,
			RetryAt:    parseRetryAfter(resp.Header.Get("Retry-After"), time.Now().UTC()),
		}
	}
	return respBody, nil
}

// platformGET mirrors platformPOST for provider diagnostics/readback calls.
func platformGET(ctx context.Context, client *http.Client, url string, headers map[string]string) ([]byte, error) {
	if client == nil {
		client = defaultPlatformHTTPClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Moosewave-AudienceSync/1.0")
	for k, v := range headers {
		if strings.TrimSpace(v) != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("deliver: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(respBody))
		if len(snippet) > 500 {
			snippet = snippet[:500] + "..."
		}
		if snippet == "" {
			return respBody, fmt.Errorf("platform returned HTTP %d", resp.StatusCode)
		}
		return respBody, fmt.Errorf("platform returned HTTP %d: %s", resp.StatusCode, snippet)
	}
	return respBody, nil
}

func parseRetryAfter(raw string, now time.Time) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds >= 0 {
		t := now.UTC().Add(time.Duration(seconds) * time.Second)
		return &t
	}
	if t, err := http.ParseTime(raw); err == nil {
		out := t.UTC()
		return &out
	}
	return nil
}

// ErrAdapterNotConfigured is returned by an adapter's Sync when the
// destination config lacks the credentials/ids the platform requires.
var ErrAdapterNotConfigured = errors.New("audience_destinations: platform adapter not configured")

// PlatformAdapterStatus mirrors socialads.ProviderStatus: the readiness of
// a platform adapter given the destination's config.
type PlatformAdapterStatus struct {
	Provider string   `json:"provider"`
	Ready    bool     `json:"ready"`
	Status   string   `json:"status"` // "configured" | "missing_credentials" | "credential_resolution_required" | "driver_unattached"
	Detail   string   `json:"detail"`
	Missing  []string `json:"missing,omitempty"`
	Docs     []string `json:"docs,omitempty"`
}

// PlatformSyncResult is what an adapter returns from Sync.
type PlatformSyncResult struct {
	Provider           string `json:"provider"`
	MembersSent        int    `json:"members_sent"`
	BatchesSent        int    `json:"batches_sent,omitempty"`
	ExternalJobID      string `json:"external_job_id,omitempty"`
	ExternalAudienceID string `json:"external_audience_id,omitempty"`
	Message            string `json:"message,omitempty"`
}

// ProviderRunEvidence is the provider-side run evidence safe to persist in
// Moosewave ledgers. It must never carry raw credentials or member payload data.
type ProviderRunEvidence struct {
	ExternalJobID      string `json:"external_job_id,omitempty"`
	ExternalAudienceID string `json:"external_audience_id,omitempty"`
	ProviderMessage    string `json:"provider_message,omitempty"`
}

func (e ProviderRunEvidence) truncated() ProviderRunEvidence {
	e.ExternalJobID = truncateProviderRunEvidence(e.ExternalJobID)
	e.ExternalAudienceID = truncateProviderRunEvidence(e.ExternalAudienceID)
	e.ProviderMessage = truncateProviderRunEvidence(e.ProviderMessage)
	return e
}

func truncateProviderRunEvidence(value string) string {
	const maxProviderEvidenceLen = 1000
	value = strings.TrimSpace(value)
	if len(value) > maxProviderEvidenceLen {
		return value[:maxProviderEvidenceLen] + "..."
	}
	return value
}

// PlatformDiagnosticsResult is provider-side status evidence for a previously
// recorded run/job. ProviderResponse is raw provider JSON that contains no
// credentials or audience member payload rows.
type PlatformDiagnosticsResult struct {
	Provider           string         `json:"provider"`
	ExternalJobID      string         `json:"external_job_id,omitempty"`
	ExternalAudienceID string         `json:"external_audience_id,omitempty"`
	ProviderMessage    string         `json:"provider_message,omitempty"`
	ProviderStatus     string         `json:"provider_status,omitempty"`
	ProviderResponse   map[string]any `json:"provider_response,omitempty"`
}

// PlatformAdapter is the common interface every ad-platform foundation
// implements.
// Members are the consent-filtered, hashed-where-required audience rows.
type PlatformAdapter interface {
	// Provider returns the canonical provider key (meta, google_ads, …).
	Provider() string
	// Readiness reports whether the adapter has the config it needs.
	Readiness(cfg map[string]any) PlatformAdapterStatus
	// Sync validates config and builds the provider-specific request shape.
	// Adapters return Readiness().Status as the error when credentials or
	// platform prerequisites are absent. Providers with an attached transport
	// POST to the configured platform endpoint.
	Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error)
}

// PlatformDiagnosticsAdapter is implemented by providers that can retrieve
// async delivery status from provider-side run evidence.
type PlatformDiagnosticsAdapter interface {
	RetrieveDiagnostics(ctx context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error)
}

// AdapterRegistry maps a destination Type/provider to its adapter.
type AdapterRegistry map[string]PlatformAdapter

// DefaultAdapterRegistry returns the catalog of built-in ad-platform
// adapters. The webhook destination is handled inline by the runner and
// is intentionally absent here.
func DefaultAdapterRegistry() AdapterRegistry {
	reg := AdapterRegistry{}
	for _, a := range []PlatformAdapter{
		&MetaAdapter{},
		&GoogleAdsAdapter{},
		&TikTokAdapter{},
		&LinkedInAdapter{},
		&SnapAdapter{},
	} {
		reg[a.Provider()] = a
	}
	return reg
}

// DestinationSyncOutcome is the result of running one audience_destinations
// (provider-table) sync: the consent partition + the adapter delivery.
type DestinationSyncOutcome struct {
	Provider           string
	TotalMembers       int
	ExcludedCount      int
	MembersSent        int
	ExternalAudienceID string
	ExternalJobID      string
	Message            string
}

// SyncDestinationRow runs one credentialed audience_destinations sync:
//
//  1. apply the consent-safe activation firewall to the resolved members
//     (skip suppressed / non-consented profiles for the destination's
//     consent purpose), then
//  2. route the kept members to the provider's PlatformAdapter, which
//     hashes PII + builds/submits the provider-specific Custom Audience
//     request when resolved credentials and driver prerequisites exist.
//
// members must already be resolved from the destination's list/segment.
// cfg is the destination's platform config (audience id, account id,
// credential ref). The runner hydrates credential refs through its trusted
// resolver before invoking the adapter. The firewall + receipt store are
// optional (nil = ungated / no receipts). Returns the outcome; an adapter error
// is surfaced so the caller can record a failed job.
func (sr *SyncRunner) SyncDestinationRow(
	ctx context.Context,
	tenantID string,
	dest *Destination,
	members []MemberRow,
	cfg map[string]any,
) (DestinationSyncOutcome, error) {
	provider := strings.ToLower(strings.TrimSpace(string(dest.Provider)))
	out := DestinationSyncOutcome{Provider: provider, TotalMembers: len(members)}

	if sr.Adapters == nil || sr.Adapters[provider] == nil {
		return out, fmt.Errorf("%w: provider %q has no registered adapter", ErrAdapterNotConfigured, provider)
	}
	hydrated, err := hydrateAdapterConfig(ctx, sr.CredentialResolver, cfg)
	if err != nil {
		return out, fmt.Errorf("%s sync: %w", provider, err)
	}

	// 1. Consent-aware exclusion (feature #2): withhold suppressed /
	//    non-consented members BEFORE any row leaves for the platform.
	kept := members
	if sr.Firewall != nil {
		purpose := activation_firewall.ResolvePurpose(provider, "")
		emails := make([]string, 0, len(members))
		for _, m := range members {
			emails = append(emails, m.Email)
		}
		dec := sr.Firewall.Decide(ctx, tenantID, purpose, provider, emails)
		out.ExcludedCount = len(dec.Excluded)
		if len(dec.Excluded) > 0 {
			keptSet := make(map[string]struct{}, len(dec.Kept))
			for _, e := range dec.Kept {
				keptSet[e] = struct{}{}
			}
			filtered := members[:0]
			for _, m := range members {
				if _, ok := keptSet[strings.ToLower(strings.TrimSpace(m.Email))]; ok {
					filtered = append(filtered, m)
				}
			}
			kept = filtered
			// Best-effort exclusion receipts (mirrors the audience_syncs path).
			if sr.ReceiptStore != nil {
				if _, werr := sr.ReceiptStore.WriteExclusions(ctx, tenantID, dest.ID, activation_firewall.RunTypeAudienceSync, dec.Excluded, sr.ReceiptSignKey); werr != nil && sr.Logger != nil {
					sr.Logger.Warn("audience_destination_sync: failed to persist exclusion receipts", "tenant_id", tenantID, "destination_id", dest.ID, "err", werr.Error())
				}
			}
		}
	}

	// 2. Route to the provider adapter (hashes PII + POSTs to the platform).
	res, err := sr.Adapters[provider].Sync(ctx, hydrated, kept)
	out.MembersSent = res.MembersSent
	out.ExternalAudienceID = res.ExternalAudienceID
	out.ExternalJobID = res.ExternalJobID
	out.Message = res.Message
	if err != nil {
		return out, err
	}
	return out, nil
}

// hashEmail applies the SHA-256-of-lowercased-trimmed-email normalization
// every major ad platform's Custom Audience / Customer Match API requires
// for PII matching. Returns the lowercase hex digest.
func hashEmail(email string) string {
	norm := strings.ToLower(strings.TrimSpace(email))
	if norm == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

func hashEmailRemovingWhitespace(email string) string {
	norm := strings.ToLower(strings.TrimSpace(email))
	if norm == "" {
		return ""
	}
	norm = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, norm)
	if norm == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// hashedMembers maps member rows to their hashed-email payload rows,
// dropping any with an empty email. This is the shared normalization step
// every adapter uses before building its provider-specific request body.
func hashedMembers(members []MemberRow) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		if h := hashEmail(m.Email); h != "" {
			out = append(out, h)
		}
	}
	return out
}

func hashedMembersRemovingWhitespace(members []MemberRow) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		if h := hashEmailRemovingWhitespace(m.Email); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// firstNonEmpty returns the first trimmed-non-empty argument, or "".
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// configString reads a string field from a destination config map.
func configString(cfg map[string]any, key string) string {
	if cfg == nil {
		return ""
	}
	if v, ok := cfg[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func configBool(cfg map[string]any, key string) bool {
	if cfg == nil {
		return false
	}
	switch v := cfg[key].(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "yes", "1", "approved":
			return true
		}
	}
	return false
}

func credentialReference(cfg map[string]any) string {
	return firstNonEmpty(
		configString(cfg, "credentials_ref"),
		configString(cfg, "credential_ref"),
		configString(cfg, "access_token_ref"),
		configString(cfg, "token_ref"),
		configString(cfg, "developer_token_ref"),
	)
}

func resolvedCredentialMissing(cfg map[string]any, keys ...string) []string {
	missing := []string{}
	for _, key := range keys {
		if configString(cfg, key) == "" {
			missing = append(missing, key)
		}
	}
	return missing
}

func credentialReadinessStatus(provider string, cfg map[string]any, rawKeys []string, missingRef, resolverLabel, detail string, docs []string) (PlatformAdapterStatus, bool) {
	if len(resolvedCredentialMissing(cfg, rawKeys...)) == 0 {
		return PlatformAdapterStatus{}, true
	}
	if credentialReference(cfg) != "" {
		return PlatformAdapterStatus{
			Provider: provider,
			Ready:    false,
			Status:   "credential_resolution_required",
			Detail:   detail,
			Missing:  []string{resolverLabel},
			Docs:     docs,
		}, false
	}
	return PlatformAdapterStatus{
		Provider: provider,
		Ready:    false,
		Status:   "missing_credentials",
		Detail:   detail,
		Missing:  []string{missingRef},
		Docs:     docs,
	}, false
}

func nestedStringRows(values []string) [][]string {
	out := make([][]string, 0, len(values))
	for _, value := range values {
		out = append(out, []string{value})
	}
	return out
}

// missingConfig returns the keys whose config values are empty, sorted.
func missingConfig(cfg map[string]any, required map[string]string) []string {
	missing := []string{}
	for envKey, cfgKey := range required {
		if configString(cfg, cfgKey) == "" {
			missing = append(missing, envKey)
		}
	}
	sort.Strings(missing)
	return missing
}
