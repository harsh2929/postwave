// SPDX-License-Identifier: AGPL-3.0-only
//
// snap_adapter.go — SUB-113 Snapchat Audience adapter.
//
// Targets the Snap Marketing API segment users endpoint, which accepts
// SHA-256-hashed emails. Required config:
//
//	access_token, ad_account_id, segment_id.
package audience_destinations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// snapAPIBase is the Snap Marketing API host + version. Internal tests can
// override it through resolved adapter config; public tenant config rejects
// api_base to avoid credential/PII exfiltration.
const (
	snapAPIBase                 = "https://adsapi.snapchat.com/v1"
	snapSegmentUsersMaxMembers  = 100_000
	snapRequestIDsEvidenceDelim = ","
	snapMaxAttempts             = 3
)

// SnapAdapter ships audience membership to Snapchat.
type SnapAdapter struct {
	// HTTPClient is the transport for the live POST. Nil falls back to the
	// shared bounded client.
	HTTPClient *http.Client
}

func (a *SnapAdapter) Provider() string { return string(ProviderSnap) }

var snapRequired = map[string]string{
	"SNAP_AD_ACCOUNT_ID": "ad_account_id",
	"SNAP_SEGMENT_ID":    "segment_id",
}

var snapDocs = []string{
	"https://developers.snap.com/api/marketing-api/Ads-API/audience-creation/customer-lists",
}

func (a *SnapAdapter) Readiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, snapRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "Snapchat audience sync requires ad_account_id, segment_id, and a credential reference that resolves an access token.",
			Missing:  missing,
			Docs:     snapDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token"},
		"SNAP_CREDENTIALS_REF",
		"SNAP_CREDENTIAL_RESOLVER",
		"Snapchat audience sync stores only credential references in public config; live delivery requires the trusted resolver to hydrate an access token.",
		snapDocs,
	); !ok {
		return st
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "Snapchat audience sync is configured; members ship as SHA-256-hashed emails to the segment users endpoint.",
		Docs:     snapDocs,
	}
}

func (a *SnapAdapter) Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	st := a.Readiness(cfg)
	hashed := hashedMembers(members)
	segmentID := configString(cfg, "segment_id")
	if !st.Ready {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0},
			fmt.Errorf("%w: missing %v", ErrAdapterNotConfigured, st.Missing)
	}
	if len(hashed) == 0 {
		return PlatformSyncResult{
			Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: segmentID,
			Message: "No deliverable members after consent filtering; nothing sent.",
		}, nil
	}
	base := configString(cfg, "api_base")
	if base == "" {
		base = snapAPIBase
	}
	base = strings.TrimRight(base, "/")
	usersURL := fmt.Sprintf("%s/segments/%s/users", base, segmentID)
	headers := map[string]string{"Authorization": "Bearer " + configString(cfg, "access_token")}
	chunks := chunkStrings(hashed, snapSegmentUsersMaxMembers)
	membersSent := 0
	batchesSent := 0
	requestIDs := []string{}
	action := snapAudienceAction(cfg)
	if action == "REPLACE" {
		raw, err := snapJSONRequestWithRetry(ctx, a.HTTPClient, http.MethodDelete, fmt.Sprintf("%s/segments/%s/all_users", base, segmentID), headers, nil)
		if err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					ExternalAudienceID: segmentID,
					Message:            "Snapchat Audience replace failed before clearing existing segment members.",
				},
				fmt.Errorf("snap audience clear: %w", err)
		}
		if requestID := snapResponseRequestID(raw); requestID != "" {
			requestIDs = append(requestIDs, requestID)
		}
	}
	for _, chunk := range chunks {
		method := http.MethodPost
		if action == "REMOVE" {
			method = http.MethodDelete
		}
		raw, err := snapJSONRequestWithRetry(ctx, a.HTTPClient, method, usersURL, headers, snapSegmentUsersPayload(chunk))
		if err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					MembersSent:        membersSent,
					BatchesSent:        batchesSent,
					ExternalJobID:      snapRequestIDEvidence(requestIDs),
					ExternalAudienceID: segmentID,
					Message:            snapSyncMessage(action, membersSent, batchesSent, len(chunks), true),
				},
				fmt.Errorf("snap audience: %w", err)
		}
		if requestID := snapResponseRequestID(raw); requestID != "" {
			requestIDs = append(requestIDs, requestID)
		}
		membersSent += len(chunk)
		batchesSent++
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        membersSent,
		BatchesSent:        batchesSent,
		ExternalJobID:      snapRequestIDEvidence(requestIDs),
		ExternalAudienceID: segmentID,
		Message:            snapSyncMessage(action, membersSent, batchesSent, len(chunks), false),
	}, nil
}

func (a *SnapAdapter) RetrieveDiagnostics(ctx context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error) {
	segmentID := firstNonEmpty(evidence.ExternalAudienceID, configString(cfg, "segment_id"))
	result := PlatformDiagnosticsResult{
		Provider:           a.Provider(),
		ExternalJobID:      evidence.ExternalJobID,
		ExternalAudienceID: segmentID,
		ProviderMessage:    evidence.ProviderMessage,
	}
	if strings.TrimSpace(segmentID) == "" {
		return result, fmt.Errorf("%w: Snap diagnostics require a segment id", ErrAdapterNotConfigured)
	}
	if configString(cfg, "access_token") == "" {
		return result, fmt.Errorf("%w: Snap diagnostics require an access token", ErrAdapterNotConfigured)
	}
	base := configString(cfg, "api_base")
	if base == "" {
		base = snapAPIBase
	}
	raw, err := snapJSONRequestWithRetry(ctx, a.HTTPClient, http.MethodGet, fmt.Sprintf("%s/segments/%s", strings.TrimRight(base, "/"), segmentID), map[string]string{
		"Authorization": "Bearer " + configString(cfg, "access_token"),
	}, nil)
	if err != nil {
		return result, err
	}
	var resp map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &resp); err != nil {
			return result, fmt.Errorf("decode diagnostics response: %w", err)
		}
	}
	if resp == nil {
		resp = map[string]any{}
	}
	result.ProviderStatus = snapProviderStatus(resp, segmentID)
	result.ProviderResponse = resp
	return result, nil
}

func snapSegmentUsersPayload(hashed []string) map[string]any {
	return map[string]any{
		"users": []map[string]any{{
			"schema": []string{"EMAIL_SHA256"},
			"data":   nestedStringRows(hashed),
		}},
	}
}

func snapResponseRequestID(raw []byte) string {
	var body map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &body) != nil {
		return ""
	}
	return firstNonEmpty(configString(body, "request_id"), configString(body, "requestId"))
}

func snapJSONRequestWithRetry(ctx context.Context, client *http.Client, method, url string, headers map[string]string, body any) ([]byte, error) {
	raw, err := snapMarshalBody(body)
	if err != nil {
		return nil, err
	}
	var lastResp []byte
	var lastErr error
	for attempt := 1; attempt <= snapMaxAttempts; attempt++ {
		resp, err := snapJSONRequest(ctx, client, method, url, headers, raw)
		if err == nil {
			return resp, nil
		}
		lastResp = resp
		lastErr = err
		if attempt >= snapMaxAttempts || !snapRetryableError(err) {
			return resp, err
		}
		if err := snapWaitBeforeRetry(ctx, err, attempt); err != nil {
			return resp, err
		}
	}
	return lastResp, lastErr
}

func snapMarshalBody(body any) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	return raw, nil
}

func snapJSONRequest(ctx context.Context, client *http.Client, method, url string, headers map[string]string, raw []byte) ([]byte, error) {
	if client == nil {
		client = defaultPlatformHTTPClient
	}
	var body io.Reader
	if raw != nil {
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Moosewave-AudienceSync/1.0")
	if raw != nil {
		req.Header.Set("Content-Type", "application/json")
	}
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
		return respBody, &platformHTTPError{
			StatusCode: resp.StatusCode,
			Body:       snippet,
			RetryAt:    parseRetryAfter(resp.Header.Get("Retry-After"), time.Now().UTC()),
		}
	}
	return respBody, nil
}

func snapRetryableError(err error) bool {
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.transient()
	}
	return err != nil
}

func snapWaitBeforeRetry(ctx context.Context, err error, attempt int) error {
	delay := time.Duration(attempt) * 100 * time.Millisecond
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) && httpErr.RetryAt != nil {
		if until := time.Until(httpErr.RetryAt.UTC()); until > 0 && until < 2*time.Second {
			delay = until
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func snapRequestIDEvidence(ids []string) string {
	cleaned := make([]string, 0, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			cleaned = append(cleaned, id)
		}
	}
	if len(cleaned) == 0 {
		return ""
	}
	return strings.Join(cleaned, snapRequestIDsEvidenceDelim)
}

func snapAudienceAction(cfg map[string]any) string {
	action := strings.ToUpper(strings.TrimSpace(firstNonEmpty(configString(cfg, "action"), configString(cfg, "audience_action"), configString(cfg, "sync_action"))))
	switch action {
	case "REMOVE", "REPLACE":
		return action
	default:
		return "APPEND"
	}
}

func snapSyncMessage(action string, membersSent, batchesSent, totalBatches int, partial bool) string {
	verb := "Synced"
	switch action {
	case "REMOVE":
		verb = "Removed"
	case "REPLACE":
		verb = "Replaced"
	}
	if partial {
		return fmt.Sprintf("%s %d EMAIL_SHA256 members for Snapchat Audience across %d/%d request(s) before a provider error.", verb, membersSent, batchesSent, totalBatches)
	}
	return fmt.Sprintf("%s %d EMAIL_SHA256 members for Snapchat Audience across %d request(s).", verb, membersSent, batchesSent)
}

func snapProviderStatus(resp map[string]any, segmentID string) string {
	segment, ok := snapSegmentObject(resp, segmentID)
	if !ok {
		return normalizeProviderDiagnosticsStatus(firstNonEmpty(
			configString(resp, "request_status"),
			configString(resp, "status"),
		))
	}
	uploadStatus := normalizeProviderDiagnosticsStatus(configString(segment, "upload_status"))
	targetableStatus := normalizeProviderDiagnosticsStatus(configString(segment, "targetable_status"))
	status := normalizeProviderDiagnosticsStatus(configString(segment, "status"))
	switch {
	case uploadStatus == "PROCESSING" || uploadStatus == "NO_UPLOAD" || status == "PENDING":
		return "PROCESSING"
	case uploadStatus == "COMPLETE" && targetableStatus == "READY":
		return "SUCCESS"
	case uploadStatus == "COMPLETE" && targetableStatus != "":
		return "PARTIAL_FAILURE"
	case uploadStatus == "COMPLETE" && (status == "ACTIVE" || status == "PAUSED"):
		return "SUCCESS"
	case status != "":
		return status
	default:
		return uploadStatus
	}
}

func snapSegmentObject(resp map[string]any, segmentID string) (map[string]any, bool) {
	rawSegments, ok := resp["segments"].([]any)
	if !ok {
		if segment, ok := resp["segment"].(map[string]any); ok {
			return segment, true
		}
		return nil, false
	}
	var first map[string]any
	for _, item := range rawSegments {
		wrapper, ok := item.(map[string]any)
		if !ok {
			continue
		}
		segment, _ := wrapper["segment"].(map[string]any)
		if len(segment) == 0 {
			segment = wrapper
		}
		if first == nil {
			first = segment
		}
		if segmentID == "" || configString(segment, "id") == segmentID {
			return segment, true
		}
	}
	if first != nil && len(rawSegments) == 1 {
		return first, true
	}
	return nil, false
}
