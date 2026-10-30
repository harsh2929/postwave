// SPDX-License-Identifier: AGPL-3.0-only
//
// linkedin_adapter.go — SUB-113 LinkedIn Matched Audiences adapter.
//
// Targets the LinkedIn Marketing API dmpSegments members endpoint, which
// accepts SHA-256-hashed emails. Required config:
//
//	access_token, account_id, segment_id.
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

const (
	linkedInSegmentUsersMaxBatch = 5000
	linkedInMaxAttempts          = 3
)

// linkedInAPIBase is the LinkedIn Marketing API host. Internal tests can
// override it through resolved adapter config; public tenant config rejects
// api_base to avoid credential/PII exfiltration.
const linkedInAPIBase = "https://api.linkedin.com/rest"

// LinkedInAdapter ships Matched Audience membership to LinkedIn.
type LinkedInAdapter struct {
	// HTTPClient is the transport for the live POST. Nil falls back to the
	// shared bounded client.
	HTTPClient *http.Client
}

func (a *LinkedInAdapter) Provider() string { return string(ProviderLinkedIn) }

var linkedInRequired = map[string]string{
	"LINKEDIN_ACCOUNT_ID": "account_id",
	"LINKEDIN_SEGMENT_ID": "segment_id",
}

var linkedInDocs = []string{
	"https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/matched-audiences?view=li-lms-2026-06",
	"https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/create-and-manage-segment-users?view=li-lms-2026-06",
}

func (a *LinkedInAdapter) Readiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, linkedInRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "LinkedIn Matched Audiences requires account_id, segment_id, and a credential reference that resolves an access token.",
			Missing:  missing,
			Docs:     linkedInDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token"},
		"LINKEDIN_CREDENTIALS_REF",
		"LINKEDIN_CREDENTIAL_RESOLVER",
		"LinkedIn Matched Audiences stores only credential references in public config; live delivery requires the trusted resolver to hydrate an access token.",
		linkedInDocs,
	); !ok {
		return st
	}
	if !configBool(cfg, "audiences_program_approved") {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "access_review_required",
			Detail:   "LinkedIn Matched Audiences also requires approved Audiences/DMP Segment access, the rw_dmp_segments permission, and a non-viewer ad-account role.",
			Missing:  []string{"LINKEDIN_AUDIENCES_PROGRAM_APPROVAL"},
			Docs:     linkedInDocs,
		}
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "LinkedIn Matched Audiences is configured; members ship as SHA-256-hashed emails to the dmpSegments endpoint.",
		Docs:     linkedInDocs,
	}
}

func (a *LinkedInAdapter) Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	st := a.Readiness(cfg)
	hashed := hashedMembersRemovingWhitespace(members)
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
		base = linkedInAPIBase
	}
	url := fmt.Sprintf("%s/dmpSegments/%s/users", strings.TrimRight(base, "/"), segmentID)
	headers := map[string]string{
		"Authorization":             "Bearer " + configString(cfg, "access_token"),
		"X-RestLi-Method":           "BATCH_CREATE",
		"X-Restli-Protocol-Version": "2.0.0",
		"LinkedIn-Version":          firstNonEmpty(configString(cfg, "linkedin_version"), "202606"),
	}
	chunks := chunkStrings(hashed, linkedInSegmentUsersMaxBatch)
	membersSent := 0
	batchesSent := 0
	action := linkedInAudienceAction(cfg)
	for _, chunk := range chunks {
		raw, err := linkedInJSONRequestWithRetry(ctx, a.HTTPClient, http.MethodPost, url, headers, linkedInSegmentUsersPayload(action, chunk))
		if err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					MembersSent:        membersSent,
					BatchesSent:        batchesSent,
					ExternalJobID:      linkedInSegmentEvidenceID(segmentID, membersSent > 0),
					ExternalAudienceID: segmentID,
					Message:            linkedInSyncMessage(action, membersSent, batchesSent, len(chunks), true),
				},
				fmt.Errorf("linkedin matched audience: %w", err)
		}
		if err := linkedInBatchResponseError(raw); err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					MembersSent:        membersSent,
					BatchesSent:        batchesSent,
					ExternalJobID:      linkedInSegmentEvidenceID(segmentID, membersSent > 0),
					ExternalAudienceID: segmentID,
					Message:            linkedInSyncMessage(action, membersSent, batchesSent, len(chunks), true),
				},
				fmt.Errorf("linkedin matched audience batch response: %w", err)
		}
		membersSent += len(chunk)
		batchesSent++
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        membersSent,
		BatchesSent:        batchesSent,
		ExternalJobID:      linkedInSegmentEvidenceID(segmentID, true),
		ExternalAudienceID: segmentID,
		Message:            linkedInSyncMessage(action, membersSent, batchesSent, len(chunks), false),
	}, nil
}

func (a *LinkedInAdapter) RetrieveDiagnostics(ctx context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error) {
	segmentID := firstNonEmpty(evidence.ExternalAudienceID, linkedInSegmentIDFromEvidence(evidence.ExternalJobID), configString(cfg, "segment_id"))
	result := PlatformDiagnosticsResult{
		Provider:           a.Provider(),
		ExternalJobID:      firstNonEmpty(evidence.ExternalJobID, linkedInSegmentEvidenceID(segmentID, true)),
		ExternalAudienceID: segmentID,
		ProviderMessage:    evidence.ProviderMessage,
	}
	if strings.TrimSpace(segmentID) == "" {
		return result, fmt.Errorf("%w: LinkedIn diagnostics require a DMP segment id", ErrAdapterNotConfigured)
	}
	if configString(cfg, "access_token") == "" {
		return result, fmt.Errorf("%w: LinkedIn diagnostics require an access token", ErrAdapterNotConfigured)
	}
	base := configString(cfg, "api_base")
	if base == "" {
		base = linkedInAPIBase
	}
	raw, err := linkedInJSONRequestWithRetry(ctx, a.HTTPClient, http.MethodGet, fmt.Sprintf("%s/dmpSegments/%s", strings.TrimRight(base, "/"), segmentID), linkedInHeaders(cfg), nil)
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
	result.ProviderStatus = linkedInProviderStatus(resp)
	result.ProviderResponse = resp
	return result, nil
}

func linkedInHeaders(cfg map[string]any) map[string]string {
	return map[string]string{
		"Authorization":             "Bearer " + configString(cfg, "access_token"),
		"X-Restli-Protocol-Version": "2.0.0",
		"LinkedIn-Version":          firstNonEmpty(configString(cfg, "linkedin_version"), "202606"),
	}
}

func linkedInSegmentUsersPayload(action string, hashed []string) map[string]any {
	elements := make([]map[string]any, 0, len(hashed))
	for _, h := range hashed {
		elements = append(elements, map[string]any{
			"action":  action,
			"userIds": []map[string]any{{"idType": "SHA256_EMAIL", "idValue": h}},
		})
	}
	return map[string]any{"elements": elements}
}

func linkedInJSONRequestWithRetry(ctx context.Context, client *http.Client, method, url string, headers map[string]string, body any) ([]byte, error) {
	raw, err := linkedInMarshalBody(body)
	if err != nil {
		return nil, err
	}
	var lastResp []byte
	var lastErr error
	for attempt := 1; attempt <= linkedInMaxAttempts; attempt++ {
		resp, err := linkedInJSONRequest(ctx, client, method, url, headers, raw)
		if err == nil {
			return resp, nil
		}
		lastResp = resp
		lastErr = err
		if attempt >= linkedInMaxAttempts || !linkedInRetryableError(err) {
			return resp, err
		}
		if err := linkedInWaitBeforeRetry(ctx, err, attempt); err != nil {
			return resp, err
		}
	}
	return lastResp, lastErr
}

func linkedInMarshalBody(body any) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	return raw, nil
}

func linkedInJSONRequest(ctx context.Context, client *http.Client, method, url string, headers map[string]string, raw []byte) ([]byte, error) {
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

func linkedInRetryableError(err error) bool {
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.transient()
	}
	return err != nil
}

func linkedInWaitBeforeRetry(ctx context.Context, err error, attempt int) error {
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

func linkedInBatchResponseError(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	elements, _ := body["elements"].([]any)
	for idx, item := range elements {
		element, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status := linkedInAnyInt(element["status"])
		if status == 0 {
			if errObj, ok := element["error"].(map[string]any); ok {
				status = linkedInAnyInt(errObj["status"])
			}
		}
		if status >= 400 {
			return fmt.Errorf("element %d failed with status %d", idx, status)
		}
	}
	return nil
}

func linkedInAudienceAction(cfg map[string]any) string {
	action := strings.ToUpper(strings.TrimSpace(firstNonEmpty(configString(cfg, "action"), configString(cfg, "audience_action"), configString(cfg, "sync_action"))))
	switch action {
	case "REMOVE":
		return "REMOVE"
	default:
		return "ADD"
	}
}

func linkedInSegmentEvidenceID(segmentID string, ok bool) string {
	segmentID = strings.TrimSpace(segmentID)
	if !ok || segmentID == "" {
		return ""
	}
	return "dmpSegment:" + segmentID
}

func linkedInSegmentIDFromEvidence(value string) string {
	value = strings.TrimSpace(value)
	return strings.TrimPrefix(value, "dmpSegment:")
}

func linkedInProviderStatus(resp map[string]any) string {
	statuses := []string{}
	if status := linkedInStatusFromMap(resp); status != "" {
		statuses = append(statuses, status)
	}
	if destinations, ok := resp["destinations"].([]any); ok {
		for _, item := range destinations {
			if dest, ok := item.(map[string]any); ok {
				if status := linkedInStatusFromMap(dest); status != "" {
					statuses = append(statuses, status)
				}
			}
		}
	}
	return linkedInRollupStatus(statuses)
}

func linkedInStatusFromMap(values map[string]any) string {
	for _, key := range []string{"status", "state", "destinationStatus"} {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.ToUpper(strings.TrimSpace(value))
		}
	}
	return ""
}

func linkedInRollupStatus(statuses []string) string {
	first := ""
	hasSuccess := false
	hasProcessing := false
	hasFailed := false
	for _, status := range statuses {
		status = strings.ToUpper(strings.TrimSpace(status))
		if status == "" {
			continue
		}
		if first == "" {
			first = status
		}
		switch status {
		case "READY", "ACTIVE", "MATCHED":
			hasSuccess = true
		case "BUILDING", "PROCESSING", "PENDING", "WAITING", "QUEUED":
			hasProcessing = true
		case "FAILED", "ERROR", "REJECTED", "EXPIRED", "ARCHIVED":
			hasFailed = true
		}
	}
	switch {
	case hasProcessing:
		return "PROCESSING"
	case hasFailed && hasSuccess:
		return "PARTIAL_FAILURE"
	case hasFailed:
		return "FAILED"
	case hasSuccess:
		return "SUCCESS"
	default:
		return normalizeProviderDiagnosticsStatus(first)
	}
}

func linkedInAnyInt(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0
		}
		return int(n)
	default:
		return 0
	}
}

func linkedInSyncMessage(action string, membersSent, batchesSent, totalBatches int, partial bool) string {
	verb := "Synced"
	if action == "REMOVE" {
		verb = "Removed"
	}
	if partial {
		return fmt.Sprintf("%s %d SHA256_EMAIL members for LinkedIn Matched Audience across %d/%d request(s) before a provider error.", verb, membersSent, batchesSent, totalBatches)
	}
	return fmt.Sprintf("%s %d SHA256_EMAIL members for LinkedIn Matched Audience across %d request(s). LinkedIn returns segment-level readback evidence rather than per-batch request IDs.", verb, membersSent, batchesSent)
}
