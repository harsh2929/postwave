// SPDX-License-Identifier: AGPL-3.0-only
//
// meta_adapter.go — SUB-113 Meta Custom Audiences adapter.
//
// Targets the Meta Marketing API Custom Audience "users" endpoint for an
// existing audience (/{audience-id}/users), which accepts SHA-256-hashed
// emails in the schema=["EMAIL_SHA256"] payload shape. Required resolved
// config:
//
//	access_token, audience_id (external_audience_id can fill audience_id via
//	the destination column before adapter delivery).
package audience_destinations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// metaGraphAPIBase is the Meta Marketing API host + version. Internal tests can
// override it through resolved adapter config; public tenant config rejects
// api_base to avoid credential/PII exfiltration.
const (
	metaGraphAPIBase     = "https://graph.facebook.com/v25.0"
	metaUsersMaxMembers  = 10_000
	metaMaxChunkAttempts = 3
)

// MetaAdapter ships Custom Audience membership to Meta.
type MetaAdapter struct {
	// HTTPClient is the transport for the live POST. Nil falls back to the
	// shared bounded client (defaultPlatformHTTPClient).
	HTTPClient *http.Client
}

func (a *MetaAdapter) Provider() string { return string(ProviderMeta) }

var metaRequired = map[string]string{
	"META_AUDIENCE_ID": "audience_id",
}

var metaDocs = []string{
	"https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences/",
}

func (a *MetaAdapter) Readiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, metaRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "Meta Custom Audience sync requires a target audience_id and a credential reference that resolves an ads access token.",
			Missing:  missing,
			Docs:     metaDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token"},
		"META_CREDENTIALS_REF",
		"META_CREDENTIAL_RESOLVER",
		"Meta Custom Audience sync stores only credential references in public config; live delivery requires the trusted resolver to hydrate an ads access token.",
		metaDocs,
	); !ok {
		return st
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "Meta Custom Audience sync is configured; members ship as EMAIL_SHA256 to the audience users endpoint.",
		Docs:     metaDocs,
	}
}

func (a *MetaAdapter) Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	st := a.Readiness(cfg)
	hashed := hashedMembers(members)
	audienceID := configString(cfg, "audience_id")
	if !st.Ready {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0},
			fmt.Errorf("%w: missing %v", ErrAdapterNotConfigured, st.Missing)
	}
	if len(hashed) == 0 {
		return PlatformSyncResult{
			Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: audienceID,
			Message: "No deliverable members after consent filtering; nothing sent.",
		}, nil
	}
	// Meta Custom Audience "users" endpoint: POST /{audience-id}/users with
	// schema=["EMAIL_SHA256"] and one [hash] row per member. The access
	// token is sent as a Bearer header.
	base := configString(cfg, "api_base")
	if base == "" {
		base = metaGraphAPIBase
	}
	url := fmt.Sprintf("%s/%s/users", base, audienceID)
	headers := map[string]string{"Authorization": "Bearer " + configString(cfg, "access_token")}
	chunks := chunkStrings(hashed, metaUsersMaxMembers)
	membersSent := 0
	batchesSent := 0
	var responseEvidence metaUsersResponseEvidence
	totalRetryAttempts := 0
	for _, chunk := range chunks {
		respBody, attempts, err := a.postUsersChunk(ctx, url, headers, chunk)
		totalRetryAttempts += attempts - 1
		if err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					MembersSent:        membersSent,
					BatchesSent:        batchesSent,
					ExternalAudienceID: audienceID,
					Message:            metaSyncMessage(membersSent, batchesSent, len(chunks), true, responseEvidence, totalRetryAttempts),
				},
				fmt.Errorf("meta custom audience: %w", err)
		}
		responseEvidence.add(respBody)
		membersSent += len(chunk)
		batchesSent++
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        membersSent,
		BatchesSent:        batchesSent,
		ExternalAudienceID: audienceID,
		Message:            metaSyncMessage(membersSent, batchesSent, len(chunks), false, responseEvidence, totalRetryAttempts),
	}, nil
}

func (a *MetaAdapter) postUsersChunk(ctx context.Context, url string, headers map[string]string, chunk []string) ([]byte, int, error) {
	var lastErr error
	for attempt := 1; attempt <= metaMaxChunkAttempts; attempt++ {
		respBody, err := platformPOST(ctx, a.HTTPClient, url, headers, metaUsersPayload(chunk))
		if err == nil {
			return respBody, attempt, nil
		}
		lastErr = err
		if attempt >= metaMaxChunkAttempts || !metaRetryableError(err) {
			return respBody, attempt, err
		}
		if err := metaWaitBeforeRetry(ctx, err, attempt); err != nil {
			return respBody, attempt, err
		}
	}
	return nil, metaMaxChunkAttempts, lastErr
}

func metaUsersPayload(hashed []string) map[string]any {
	data := make([][]string, 0, len(hashed))
	for _, h := range hashed {
		data = append(data, []string{h})
	}
	return map[string]any{
		"payload": map[string]any{
			"schema": []string{"EMAIL_SHA256"},
			"data":   data,
		},
	}
}

type metaUsersResponseEvidence struct {
	responsesSeen       int
	successResponses    int
	numReceived         int
	numInvalidEntries   int
	sawNumReceived      bool
	sawNumInvalidEntry  bool
	invalidSampleCount  int
	sawInvalidSampleSet bool
}

func (e *metaUsersResponseEvidence) add(raw []byte) {
	if e == nil || len(raw) == 0 {
		return
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return
	}
	e.responsesSeen++
	if success, ok := body["success"].(bool); ok && success {
		e.successResponses++
	}
	if n, ok := metaResponseInt(body["num_received"]); ok {
		e.numReceived += n
		e.sawNumReceived = true
	}
	if n, ok := metaResponseInt(body["num_invalid_entries"]); ok {
		e.numInvalidEntries += n
		e.sawNumInvalidEntry = true
	}
	if samples, ok := body["invalid_entry_samples"].([]any); ok {
		e.invalidSampleCount += len(samples)
		e.sawInvalidSampleSet = true
	}
}

func (e metaUsersResponseEvidence) messageSuffix() string {
	parts := []string{}
	if e.sawNumReceived {
		parts = append(parts, fmt.Sprintf("provider num_received=%d", e.numReceived))
	}
	if e.sawNumInvalidEntry {
		parts = append(parts, fmt.Sprintf("provider num_invalid_entries=%d", e.numInvalidEntries))
	}
	if e.sawInvalidSampleSet {
		parts = append(parts, fmt.Sprintf("provider invalid_entry_sample_count=%d", e.invalidSampleCount))
	}
	if len(parts) == 0 && e.successResponses > 0 {
		parts = append(parts, fmt.Sprintf("provider success_responses=%d", e.successResponses))
	}
	if len(parts) == 0 {
		return ""
	}
	return " Meta response: " + strings.Join(parts, ", ") + "."
}

func metaResponseInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case json.Number:
		out, err := strconv.Atoi(v.String())
		return out, err == nil
	case string:
		out, err := strconv.Atoi(strings.TrimSpace(v))
		return out, err == nil
	default:
		return 0, false
	}
}

func metaRetryableError(err error) bool {
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.transient()
	}
	return err != nil
}

func metaWaitBeforeRetry(ctx context.Context, err error, attempt int) error {
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

func metaSyncMessage(membersSent, batchesSent, totalBatches int, partial bool, evidence metaUsersResponseEvidence, retryAttempts int) string {
	retrySuffix := ""
	if retryAttempts > 0 {
		retrySuffix = fmt.Sprintf(" Retried transient provider errors %d time(s).", retryAttempts)
	}
	if partial {
		return fmt.Sprintf("Synced %d EMAIL_SHA256 members to Meta Custom Audience across %d/%d request(s) before a provider error.%s%s", membersSent, batchesSent, totalBatches, evidence.messageSuffix(), retrySuffix)
	}
	return fmt.Sprintf("Synced %d EMAIL_SHA256 members to Meta Custom Audience across %d request(s).%s%s", membersSent, batchesSent, evidence.messageSuffix(), retrySuffix)
}
