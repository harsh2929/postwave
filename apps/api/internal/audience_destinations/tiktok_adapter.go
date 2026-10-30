// SPDX-License-Identifier: AGPL-3.0-only
//
// tiktok_adapter.go — SUB-113 TikTok Audience adapter.
//
// Targets the TikTok Marketing API DMP custom audience flow. TikTok requires
// multipart file upload plus audience create/update with returned file paths.
package audience_destinations

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// tiktokAPIBase is the TikTok Marketing API host + version. Internal tests can
// override it through resolved adapter config; public tenant config rejects
// api_base to avoid credential/PII exfiltration.
const tiktokAPIBase = "https://business-api.tiktok.com/open_api/v1.3"

const tiktokMaxAttempts = 3

// TikTokAdapter ships audience membership to TikTok.
type TikTokAdapter struct {
	// HTTPClient is the transport for the live POST. Nil falls back to the
	// shared bounded client.
	HTTPClient *http.Client
}

func (a *TikTokAdapter) Provider() string { return string(ProviderTikTok) }

var tiktokRequired = map[string]string{
	"TIKTOK_ADVERTISER_ID": "advertiser_id",
}

var tiktokDocs = []string{
	"https://business-api.tiktok.com/portal/docs?id=1739940504185857",
	"https://business-api.tiktok.com/portal/docs?id=1739940567842818",
	"https://business-api.tiktok.com/portal/docs?id=1739940507792385",
	"https://ads.tiktok.com/marketing_api/docs?id=1739940570793985",
	"https://business-api.tiktok.com/portal/docs?id=1739940572667906",
}

func (a *TikTokAdapter) Readiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, tiktokRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "TikTok audience sync requires advertiser_id, either audience_id or custom_audience_name, and a credential reference that resolves an access token.",
			Missing:  missing,
			Docs:     tiktokDocs,
		}
	}
	if configString(cfg, "audience_id") == "" && tiktokAudienceName(cfg) == "" {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "TikTok audience sync requires either audience_id for updates or custom_audience_name for first-time Customer File audience creation.",
			Missing:  []string{"TIKTOK_AUDIENCE_ID_OR_NAME"},
			Docs:     tiktokDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token"},
		"TIKTOK_CREDENTIALS_REF",
		"TIKTOK_CREDENTIAL_RESOLVER",
		"TikTok audience sync stores only credential references in public config; live delivery requires the trusted resolver to hydrate an access token.",
		tiktokDocs,
	); !ok {
		return st
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "TikTok custom audience sync is configured for the DMP Customer File flow: multipart file upload plus custom-audience create/update with SHA-256 email hashes.",
		Docs:     tiktokDocs,
	}
}

func (a *TikTokAdapter) Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	st := a.Readiness(cfg)
	hashed := hashedMembers(members)
	audienceID := configString(cfg, "audience_id")
	if !st.Ready {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: audienceID},
			fmt.Errorf("%w: %s", ErrAdapterNotConfigured, st.Detail)
	}
	if len(hashed) == 0 {
		return PlatformSyncResult{
			Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: audienceID,
			Message: "No deliverable members after consent filtering; nothing sent.",
		}, nil
	}
	filePath, uploadRequestID, err := a.uploadCustomerFile(ctx, cfg, hashed, audienceID)
	if err != nil {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: audienceID},
			fmt.Errorf("tiktok audience file upload: %w", err)
	}
	var requestID string
	if audienceID == "" {
		audienceID, requestID, err = a.createCustomerAudience(ctx, cfg, filePath)
	} else {
		requestID, err = a.updateCustomerAudience(ctx, cfg, audienceID, filePath)
	}
	if err != nil {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: audienceID, ExternalJobID: firstNonEmpty(requestID, uploadRequestID)},
			fmt.Errorf("tiktok audience: %w", err)
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        len(hashed),
		ExternalAudienceID: audienceID,
		ExternalJobID:      firstNonEmpty(requestID, uploadRequestID),
		Message:            fmt.Sprintf("Uploaded %d SHA-256 email members to TikTok Customer File audience.", len(hashed)),
	}, nil
}

func (a *TikTokAdapter) uploadCustomerFile(ctx context.Context, cfg map[string]any, hashed []string, audienceID string) (string, string, error) {
	base := configString(cfg, "api_base")
	if base == "" {
		base = tiktokAPIBase
	}
	bodyBytes := []byte(strings.Join(hashed, "\n") + "\n")
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]string{
		"advertiser_id":    configString(cfg, "advertiser_id"),
		"calculate_type":   tiktokCalculateType(cfg),
		"file_name":        tiktokFileName(cfg, audienceID),
		"file_signature":   tiktokFileSignature(bodyBytes),
		"__access_token__": configString(cfg, "access_token"),
	}
	for key, value := range fields {
		if strings.TrimSpace(value) == "" || key == "__access_token__" {
			continue
		}
		if err := writer.WriteField(key, value); err != nil {
			return "", "", fmt.Errorf("write field %s: %w", key, err)
		}
	}
	part, err := writer.CreateFormFile("file", fields["file_name"])
	if err != nil {
		return "", "", fmt.Errorf("create file part: %w", err)
	}
	if _, err := part.Write(bodyBytes); err != nil {
		return "", "", fmt.Errorf("write file part: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", "", fmt.Errorf("close multipart body: %w", err)
	}
	url := strings.TrimRight(base, "/") + "/dmp/custom_audience/file/upload/"
	resp, err := tiktokDoWithRetry(ctx, a.HTTPClient, http.MethodPost, url, map[string]string{
		"Access-Token":   fields["__access_token__"],
		"Content-Type":   writer.FormDataContentType(),
		"Accept":         "application/json",
		"Content-Length": fmt.Sprintf("%d", body.Len()),
	}, body.Bytes())
	if err != nil {
		return "", "", err
	}
	if err := tiktokResponseError(resp); err != nil {
		return "", tiktokRequestID(resp), err
	}
	filePath := tiktokStringFromResponse(resp, "file_path", "filePath")
	if filePath == "" {
		return "", tiktokRequestID(resp), fmt.Errorf("missing file_path in provider response")
	}
	return filePath, tiktokRequestID(resp), nil
}

func (a *TikTokAdapter) createCustomerAudience(ctx context.Context, cfg map[string]any, filePath string) (string, string, error) {
	body := map[string]any{
		"advertiser_id":        configString(cfg, "advertiser_id"),
		"calculate_type":       tiktokCalculateType(cfg),
		"custom_audience_name": tiktokAudienceName(cfg),
		"file_paths":           []string{filePath},
		"audience_enhancement": configBool(cfg, "audience_enhancement"),
		"audience_sub_type":    firstNonEmpty(configString(cfg, "audience_sub_type"), "NORMAL"),
	}
	if retention, ok, err := tiktokOptionalInt(cfg, "retention_in_days"); err != nil {
		return "", "", err
	} else if ok {
		body["retention_in_days"] = retention
	}
	resp, err := tiktokJSONPost(ctx, a.HTTPClient, cfg, "/dmp/custom_audience/create/", body)
	if err != nil {
		return "", "", err
	}
	if err := tiktokResponseError(resp); err != nil {
		return "", tiktokRequestID(resp), err
	}
	audienceID := tiktokStringFromResponse(resp, "custom_audience_id", "audience_id", "customAudienceId")
	if audienceID == "" {
		return "", tiktokRequestID(resp), fmt.Errorf("missing custom_audience_id in provider response")
	}
	return audienceID, tiktokRequestID(resp), nil
}

func (a *TikTokAdapter) updateCustomerAudience(ctx context.Context, cfg map[string]any, audienceID, filePath string) (string, error) {
	body := map[string]any{
		"advertiser_id":      configString(cfg, "advertiser_id"),
		"custom_audience_id": audienceID,
		"file_paths":         []string{filePath},
		"action":             tiktokAudienceAction(cfg),
	}
	if name := tiktokAudienceName(cfg); name != "" {
		body["custom_audience_name"] = name
	}
	resp, err := tiktokJSONPost(ctx, a.HTTPClient, cfg, "/dmp/custom_audience/update/", body)
	if err != nil {
		return "", err
	}
	if err := tiktokResponseError(resp); err != nil {
		return tiktokRequestID(resp), err
	}
	return tiktokRequestID(resp), nil
}

func (a *TikTokAdapter) RetrieveDiagnostics(ctx context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error) {
	audienceID := firstNonEmpty(evidence.ExternalAudienceID, configString(cfg, "audience_id"), configString(cfg, "custom_audience_id"))
	result := PlatformDiagnosticsResult{
		Provider:           a.Provider(),
		ExternalJobID:      evidence.ExternalJobID,
		ExternalAudienceID: audienceID,
		ProviderMessage:    evidence.ProviderMessage,
	}
	if strings.TrimSpace(audienceID) == "" {
		return result, fmt.Errorf("%w: TikTok diagnostics require a custom audience id", ErrAdapterNotConfigured)
	}
	if configString(cfg, "advertiser_id") == "" {
		return result, fmt.Errorf("%w: TikTok diagnostics require advertiser_id", ErrAdapterNotConfigured)
	}
	if configString(cfg, "access_token") == "" {
		return result, fmt.Errorf("%w: TikTok diagnostics require an access token", ErrAdapterNotConfigured)
	}
	base := configString(cfg, "api_base")
	if base == "" {
		base = tiktokAPIBase
	}
	u, err := url.Parse(strings.TrimRight(base, "/") + "/dmp/custom_audience/get/")
	if err != nil {
		return result, fmt.Errorf("build diagnostics URL: %w", err)
	}
	q := u.Query()
	q.Set("advertiser_id", configString(cfg, "advertiser_id"))
	q.Add("custom_audience_ids", audienceID)
	if historySize, ok, err := tiktokOptionalInt(cfg, "history_size"); err != nil {
		return result, err
	} else if ok && historySize > 0 {
		q.Set("history_size", strconv.Itoa(historySize))
	}
	u.RawQuery = q.Encode()
	resp, err := tiktokDoWithRetry(ctx, a.HTTPClient, http.MethodGet, u.String(), map[string]string{
		"Access-Token": configString(cfg, "access_token"),
		"Accept":       "application/json",
	}, nil)
	if err != nil {
		return result, err
	}
	if err := tiktokResponseError(resp); err != nil {
		return result, err
	}
	result.ProviderStatus = tiktokAudienceProviderStatus(resp, audienceID)
	result.ProviderResponse = resp
	return result, nil
}

func tiktokJSONPost(ctx context.Context, client *http.Client, cfg map[string]any, path string, body any) (map[string]any, error) {
	base := configString(cfg, "api_base")
	if base == "" {
		base = tiktokAPIBase
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	return tiktokDoWithRetry(ctx, client, http.MethodPost, strings.TrimRight(base, "/")+path, map[string]string{
		"Access-Token":   configString(cfg, "access_token"),
		"Content-Type":   "application/json",
		"Accept":         "application/json",
		"Content-Length": fmt.Sprintf("%d", len(raw)),
	}, raw)
}

func tiktokDoWithRetry(ctx context.Context, client *http.Client, method, url string, headers map[string]string, body []byte) (map[string]any, error) {
	var lastResp map[string]any
	var lastErr error
	for attempt := 1; attempt <= tiktokMaxAttempts; attempt++ {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		resp, err := tiktokDo(ctx, client, method, url, headers, reader)
		if err == nil {
			return resp, nil
		}
		lastResp = resp
		lastErr = err
		if attempt >= tiktokMaxAttempts || !tiktokRetryableError(err) {
			return resp, err
		}
		if err := tiktokWaitBeforeRetry(ctx, err, attempt); err != nil {
			return resp, err
		}
	}
	return lastResp, lastErr
}

func tiktokDo(ctx context.Context, client *http.Client, method, url string, headers map[string]string, body io.Reader) (map[string]any, error) {
	if client == nil {
		client = defaultPlatformHTTPClient
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Moosewave-AudienceSync/1.0")
	for k, v := range headers {
		if strings.TrimSpace(v) != "" && k != "Content-Length" {
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
		return nil, &platformHTTPError{
			StatusCode: resp.StatusCode,
			Body:       snippet,
			RetryAt:    parseRetryAfter(resp.Header.Get("Retry-After"), time.Now().UTC()),
		}
	}
	var parsed map[string]any
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &parsed); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	return parsed, nil
}

func tiktokRetryableError(err error) bool {
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.transient()
	}
	return err != nil
}

func tiktokWaitBeforeRetry(ctx context.Context, err error, attempt int) error {
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

func tiktokResponseError(resp map[string]any) error {
	code, ok := tiktokResponseCode(resp)
	if !ok || code == 0 {
		return nil
	}
	msg := strings.TrimSpace(firstNonEmpty(tiktokTopLevelString(resp, "message"), tiktokTopLevelString(resp, "msg")))
	if msg == "" {
		msg = "provider returned an error"
	}
	return fmt.Errorf("TikTok code %d: %s", code, msg)
}

func tiktokResponseCode(resp map[string]any) (int, bool) {
	switch v := resp["code"].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case json.Number:
		n, err := v.Int64()
		return int(n), err == nil
	case string:
		var n int
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &n); err == nil {
			return n, true
		}
	}
	return 0, false
}

func tiktokStringFromResponse(resp map[string]any, keys ...string) string {
	if value := tiktokStringFromMap(resp, keys...); value != "" {
		return value
	}
	if data, ok := resp["data"].(map[string]any); ok {
		return tiktokStringFromMap(data, keys...)
	}
	return ""
}

func tiktokStringFromMap(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func tiktokTopLevelString(resp map[string]any, key string) string {
	if value, ok := resp[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func tiktokRequestID(resp map[string]any) string {
	return tiktokStringFromResponse(resp, "request_id", "requestId")
}

func tiktokAudienceProviderStatus(resp map[string]any, audienceID string) string {
	for _, audience := range tiktokAudienceObjects(resp) {
		if !tiktokAudienceObjectMatchesID(audience, audienceID) {
			continue
		}
		if status := tiktokStatusFromMap(audience); status != "" {
			return tiktokNormalizeProviderStatus(status)
		}
	}
	if status := tiktokStatusFromMap(resp); status != "" {
		return tiktokNormalizeProviderStatus(status)
	}
	if data, ok := resp["data"].(map[string]any); ok {
		if status := tiktokStatusFromMap(data); status != "" {
			return tiktokNormalizeProviderStatus(status)
		}
	}
	return ""
}

func tiktokAudienceObjects(resp map[string]any) []map[string]any {
	if len(resp) == 0 {
		return nil
	}
	containers := []map[string]any{resp}
	if data, ok := resp["data"].(map[string]any); ok {
		containers = append(containers, data)
	}
	keys := []string{"custom_audience", "custom_audiences", "custom_audience_list", "audience", "audiences", "list", "items"}
	out := []map[string]any{}
	for _, container := range containers {
		for _, key := range keys {
			switch value := container[key].(type) {
			case []any:
				for _, item := range value {
					if obj, ok := item.(map[string]any); ok {
						out = append(out, obj)
					}
				}
			case map[string]any:
				out = append(out, value)
			}
		}
	}
	if len(out) == 0 {
		out = append(out, containers...)
	}
	return out
}

func tiktokAudienceObjectMatchesID(audience map[string]any, audienceID string) bool {
	audienceID = strings.TrimSpace(audienceID)
	if audienceID == "" {
		return true
	}
	for _, key := range []string{"custom_audience_id", "audience_id", "id", "customAudienceId"} {
		if value := tiktokAnyString(audience[key]); value == audienceID {
			return true
		}
	}
	return false
}

func tiktokStatusFromMap(values map[string]any) string {
	for _, key := range []string{"operation_status", "status", "audience_status", "custom_audience_status", "delivery_status", "state", "sub_status"} {
		if value := tiktokAnyString(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func tiktokAnyString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case json.Number:
		return strings.TrimSpace(v.String())
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	case float64:
		return strconv.FormatInt(int64(v), 10)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return ""
	}
}

func tiktokNormalizeProviderStatus(status string) string {
	status = normalizeProviderDiagnosticsStatus(status)
	switch {
	case status == "":
		return ""
	case strings.Contains(status, "PENDING"), strings.Contains(status, "PROCESS"), strings.Contains(status, "CREAT"), strings.Contains(status, "UPLOAD"), strings.Contains(status, "CALCULAT"), strings.Contains(status, "QUEU"):
		return "PROCESSING"
	case strings.Contains(status, "PARTIAL") && strings.Contains(status, "FAIL"):
		return "PARTIAL_FAILURE"
	case strings.Contains(status, "PARTIAL"):
		return "PARTIAL_SUCCESS"
	case strings.Contains(status, "FAIL"), strings.Contains(status, "ERROR"), strings.Contains(status, "INVALID"), strings.Contains(status, "REJECT"), strings.Contains(status, "EXPIRE"):
		return "FAILED"
	case strings.Contains(status, "READY"), strings.Contains(status, "AVAILABLE"), strings.Contains(status, "SUCCESS"), strings.Contains(status, "ACTIVE"), strings.Contains(status, "VALID"), strings.Contains(status, "APPROVED"):
		return "SUCCESS"
	default:
		return status
	}
}

func tiktokCalculateType(cfg map[string]any) string {
	return firstNonEmpty(configString(cfg, "calculate_type"), configString(cfg, "encryption_type"), "FIRST_SHA256")
}

func tiktokAudienceAction(cfg map[string]any) string {
	action := strings.ToUpper(strings.TrimSpace(firstNonEmpty(configString(cfg, "action"), configString(cfg, "audience_action"), configString(cfg, "sync_action"))))
	switch action {
	case "REMOVE", "REPLACE":
		return action
	default:
		return "APPEND"
	}
}

func tiktokAudienceName(cfg map[string]any) string {
	return firstNonEmpty(configString(cfg, "custom_audience_name"), configString(cfg, "audience_name"), configString(cfg, "name"))
}

func tiktokOptionalInt(cfg map[string]any, key string) (int, bool, error) {
	if cfg == nil {
		return 0, false, nil
	}
	raw, ok := cfg[key]
	if !ok || raw == nil {
		return 0, false, nil
	}
	switch v := raw.(type) {
	case int:
		return v, true, nil
	case int64:
		if v > int64(^uint(0)>>1) || v < -int64(^uint(0)>>1)-1 {
			return 0, false, fmt.Errorf("%s overflows int", key)
		}
		return int(v), true, nil
	case float64:
		n := int(v)
		if float64(n) != v {
			return 0, false, fmt.Errorf("%s must be an integer", key)
		}
		return n, true, nil
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, false, fmt.Errorf("%s must be an integer", key)
		}
		if n > int64(^uint(0)>>1) || n < -int64(^uint(0)>>1)-1 {
			return 0, false, fmt.Errorf("%s overflows int", key)
		}
		return int(n), true, nil
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return 0, false, nil
		}
		n, err := strconv.Atoi(text)
		if err != nil {
			return 0, false, fmt.Errorf("%s must be an integer", key)
		}
		return n, true, nil
	default:
		return 0, false, fmt.Errorf("%s must be an integer", key)
	}
}

func tiktokFileName(cfg map[string]any, audienceID string) string {
	name := firstNonEmpty(configString(cfg, "file_name"), audienceID, tiktokAudienceName(cfg), "postwave-audience")
	name = strings.NewReplacer("/", "-", "\\", "-", " ", "-").Replace(name)
	return strings.Trim(name, "-") + ".txt"
}

func tiktokFileSignature(raw []byte) string {
	sum := md5.Sum(raw)
	return hex.EncodeToString(sum[:])
}
