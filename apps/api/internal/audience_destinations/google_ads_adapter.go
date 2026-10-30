// SPDX-License-Identifier: AGPL-3.0-only
//
// google_ads_adapter.go — SUB-113 Google Ads Customer Match adapter.
//
// Supports two explicitly-gated transports:
//   - data_manager: Google's post-2026 Customer Match upload path using
//     Data Manager API audienceMembers:ingest.
//   - offline_user_data_job: legacy Google Ads API upload shape for existing,
//     allowlisted Customer Match integrations.
package audience_destinations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Internal tests can override these through resolved adapter config; public
// tenant config rejects API host overrides to avoid credential/PII exfiltration.
const (
	googleAdsAPIBase             = "https://googleads.googleapis.com/v24"
	googleDataManagerAPIBase     = "https://datamanager.googleapis.com/v1"
	googleAdsTransportDataMgr    = "data_manager"
	googleAdsTransportLegacy     = "offline_user_data_job"
	googleAdsOperationIngest     = "ingest"
	googleAdsOperationRemove     = "remove"
	googleDataManagerMaxMembers  = 10_000
	googleDataManagerMaxAttempts = 3

	googleDataManagerRequestIDsPrefix = "gdm_requests:"
)

// GoogleAdsAdapter ships Customer Match membership to Google Ads.
type GoogleAdsAdapter struct {
	// HTTPClient is the transport for the live POST. Nil falls back to the
	// shared bounded client.
	HTTPClient *http.Client
}

type googleDataManagerRequestIDsEnvelope struct {
	RequestIDs []string `json:"request_ids"`
}

func (a *GoogleAdsAdapter) Provider() string { return string(ProviderGoogleAds) }

var googleAdsOfflineUserDataJobRequired = map[string]string{
	"GOOGLE_ADS_AD_PERSONALIZATION_CONSENT": "ad_personalization_consent",
	"GOOGLE_ADS_AD_USER_DATA_CONSENT":       "ad_user_data_consent",
	"GOOGLE_ADS_CUSTOMER_ID":                "customer_id",
	"GOOGLE_ADS_OFFLINE_USER_DATA_JOB":      "offline_user_data_job",
	"GOOGLE_ADS_USER_LIST_ID":               "user_list_id",
}

var googleAdsDataManagerRequired = map[string]string{
	"GOOGLE_ADS_AD_PERSONALIZATION_CONSENT": "ad_personalization_consent",
	"GOOGLE_ADS_AD_USER_DATA_CONSENT":       "ad_user_data_consent",
	"GOOGLE_ADS_CUSTOMER_ID":                "customer_id",
	"GOOGLE_ADS_USER_LIST_ID":               "user_list_id",
}

var googleAdsDocs = []string{
	"https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/get-started",
	"https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/manage",
	"https://developers.google.com/data-manager/api/devguides/audiences/google-ads/customer-match",
	"https://developers.google.com/data-manager/api/reference/rest/v1/audienceMembers/ingest",
	"https://ads-developers.googleblog.com/2026/03/changes-to-customer-match-support-in.html",
}

func (a *GoogleAdsAdapter) Readiness(cfg map[string]any) PlatformAdapterStatus {
	if googleAdsCustomerMatchTransport(cfg) == googleAdsTransportDataMgr {
		return a.dataManagerReadiness(cfg)
	}
	return a.offlineUserDataJobReadiness(cfg)
}

func (a *GoogleAdsAdapter) dataManagerReadiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, googleAdsDataManagerRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "Google Ads Data Manager Customer Match requires customer_id, user_list_id, explicit ad_user_data/ad_personalization consent values, a credential reference, and customer_match_terms_accepted=true.",
			Missing:  missing,
			Docs:     googleAdsDocs,
		}
	}
	if !googleAdsDataManagerTermsAccepted(cfg) {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "terms_acknowledgement_required",
			Detail:   "Google Ads Data Manager Customer Match requires an operator acknowledgement that the Customer Match terms of service were accepted in the operating account.",
			Missing:  []string{"GOOGLE_ADS_CUSTOMER_MATCH_TERMS_ACCEPTED"},
			Docs:     googleAdsDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token"},
		"GOOGLE_ADS_CREDENTIALS_REF",
		"GOOGLE_ADS_CREDENTIAL_RESOLVER",
		"Google Ads Data Manager Customer Match stores only credential references in public config; live delivery requires the trusted resolver to hydrate an OAuth access token.",
		googleAdsDocs,
	); !ok {
		return st
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "Google Ads Customer Match is configured for Data Manager API audienceMembers:ingest with request-level consent, Customer Match terms acknowledgement, and SHA-256 HEX email identifiers.",
		Docs:     googleAdsDocs,
	}
}

func (a *GoogleAdsAdapter) offlineUserDataJobReadiness(cfg map[string]any) PlatformAdapterStatus {
	missing := missingConfig(cfg, googleAdsOfflineUserDataJobRequired)
	if len(missing) > 0 {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "missing_credentials",
			Detail:   "Legacy Google Ads API Customer Match requires customer_id, user_list_id, an OfflineUserDataJob resource, explicit ad_user_data/ad_personalization consent values, and a credential reference. New Customer Match adopters after 2026-04-01 should set customer_match_transport=data_manager and use Google's Data Manager API.",
			Missing:  missing,
			Docs:     googleAdsDocs,
		}
	}
	if st, ok := credentialReadinessStatus(
		a.Provider(),
		cfg,
		[]string{"access_token", "developer_token"},
		"GOOGLE_ADS_CREDENTIALS_REF",
		"GOOGLE_ADS_CREDENTIAL_RESOLVER",
		"Legacy Google Ads API Customer Match stores only credential references in public config; live delivery requires the trusted resolver to hydrate both OAuth access token and developer token.",
		googleAdsDocs,
	); !ok {
		return st
	}
	if !configBool(cfg, "offline_user_data_job_worker_attached") {
		return PlatformAdapterStatus{
			Provider: a.Provider(),
			Ready:    false,
			Status:   "driver_unattached",
			Detail:   "Legacy Google Ads API Customer Match requires a complete OfflineUserDataJob worker that creates or verifies the job, adds operations, runs the job, and monitors partial failures. Existing allowlisted integrations remain gated until that worker is attached.",
			Missing:  []string{"GOOGLE_ADS_OFFLINE_USER_DATA_JOB_WORKER"},
			Docs:     googleAdsDocs,
		}
	}
	return PlatformAdapterStatus{
		Provider: a.Provider(),
		Ready:    true,
		Status:   "configured",
		Detail:   "Legacy Google Ads API Customer Match is configured for an existing allowlisted integration; members ship as hashed-email user identifiers via OfflineUserDataJobService.",
		Docs:     googleAdsDocs,
	}
}

func (a *GoogleAdsAdapter) Sync(ctx context.Context, cfg map[string]any, members []MemberRow) (PlatformSyncResult, error) {
	st := a.Readiness(cfg)
	hashed := hashedMembers(members)
	userListID := configString(cfg, "user_list_id")
	customerID := strings.NewReplacer("-", "").Replace(configString(cfg, "customer_id"))
	if !st.Ready {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0},
			fmt.Errorf("%w: missing %v", ErrAdapterNotConfigured, st.Missing)
	}
	if len(hashed) == 0 {
		return PlatformSyncResult{
			Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: userListID,
			Message: "No deliverable members after consent filtering; nothing sent.",
		}, nil
	}
	if googleAdsCustomerMatchTransport(cfg) == googleAdsTransportDataMgr {
		return a.syncDataManager(ctx, cfg, hashed, customerID, userListID, googleAdsCustomerMatchOperation(cfg))
	}
	return a.syncOfflineUserDataJob(ctx, cfg, hashed, customerID, userListID)
}

func (a *GoogleAdsAdapter) syncOfflineUserDataJob(ctx context.Context, cfg map[string]any, hashed []string, customerID, userListID string) (PlatformSyncResult, error) {
	base := configString(cfg, "api_base")
	if base == "" {
		base = googleAdsAPIBase
	}
	jobID := normalizeGoogleAdsOfflineUserDataJobID(configString(cfg, "offline_user_data_job"))
	url := fmt.Sprintf("%s/customers/%s/offlineUserDataJobs/%s:addOperations", base, customerID, jobID)
	ops := make([]map[string]any, 0, len(hashed))
	for _, h := range hashed {
		ops = append(ops, map[string]any{
			"create": map[string]any{
				"userIdentifiers": []map[string]any{{"hashedEmail": h}},
			},
		})
	}
	payload := map[string]any{
		"operations":           ops,
		"enablePartialFailure": true,
		"consent": map[string]any{
			"adUserData":        normalizeGoogleAdsConsent(configString(cfg, "ad_user_data_consent")),
			"adPersonalization": normalizeGoogleAdsConsent(configString(cfg, "ad_personalization_consent")),
		},
	}
	headers := map[string]string{
		"Authorization":   "Bearer " + configString(cfg, "access_token"),
		"developer-token": configString(cfg, "developer_token"),
		"login-customer-id": strings.NewReplacer("-", "").Replace(
			firstNonEmpty(configString(cfg, "login_customer_id"), configString(cfg, "customer_id"))),
	}
	if _, err := platformPOST(ctx, a.HTTPClient, url, headers, payload); err != nil {
		return PlatformSyncResult{Provider: a.Provider(), MembersSent: 0, ExternalAudienceID: userListID},
			fmt.Errorf("google ads customer match: %w", err)
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        len(hashed),
		ExternalAudienceID: userListID,
		Message:            fmt.Sprintf("Synced %d hashed-email identifiers to Google Ads Customer Match via OfflineUserDataJobService.", len(hashed)),
	}, nil
}

func (a *GoogleAdsAdapter) syncDataManager(ctx context.Context, cfg map[string]any, hashed []string, customerID, userListID, operation string) (PlatformSyncResult, error) {
	base := configString(cfg, "data_manager_api_base")
	if base == "" {
		base = googleDataManagerAPIBase
	}
	url := strings.TrimRight(base, "/") + "/audienceMembers:" + operation
	destinationReference := firstNonEmpty(configString(cfg, "destination_reference"), "google_ads_customer_match")
	basePayload := map[string]any{
		"destinations": []map[string]any{{
			"reference": destinationReference,
			"operatingAccount": map[string]any{
				"accountId":   customerID,
				"accountType": "GOOGLE_ADS",
			},
			"productDestinationId": normalizeGoogleAdsResourceID(userListID),
		}},
		"encoding": "HEX",
	}
	if operation == googleAdsOperationIngest {
		basePayload["consent"] = map[string]any{
			"adUserData":        normalizeGoogleDataManagerConsent(configString(cfg, "ad_user_data_consent")),
			"adPersonalization": normalizeGoogleDataManagerConsent(configString(cfg, "ad_personalization_consent")),
		}
		basePayload["termsOfService"] = map[string]any{
			"customerMatchTermsOfServiceStatus": "ACCEPTED",
		}
	}
	headers := map[string]string{
		"Authorization": "Bearer " + configString(cfg, "access_token"),
	}
	chunks := chunkStrings(hashed, googleDataManagerMaxMembers)
	requestIDs := make([]string, 0, len(chunks))
	membersSent := 0
	batchesSent := 0
	totalRetryAttempts := 0
	for _, chunk := range chunks {
		payload := clonePayloadMap(basePayload)
		payload["audienceMembers"] = googleDataManagerAudienceMembers(chunk, destinationReference)
		resp, attempts, err := a.postDataManagerIngest(ctx, url, headers, payload)
		totalRetryAttempts += attempts - 1
		if err != nil {
			return PlatformSyncResult{
					Provider:           a.Provider(),
					MembersSent:        membersSent,
					BatchesSent:        batchesSent,
					ExternalJobID:      googleDataManagerEncodeRequestIDs(requestIDs),
					ExternalAudienceID: userListID,
					Message:            googleDataManagerSyncMessage(operation, membersSent, batchesSent, len(chunks), true, totalRetryAttempts),
				},
				fmt.Errorf("google ads data manager customer match: %w", err)
		}
		membersSent += len(chunk)
		batchesSent++
		if requestID := googleDataManagerRequestID(resp); requestID != "" {
			requestIDs = append(requestIDs, requestID)
		}
	}
	return PlatformSyncResult{
		Provider:           a.Provider(),
		MembersSent:        membersSent,
		BatchesSent:        batchesSent,
		ExternalJobID:      googleDataManagerEncodeRequestIDs(requestIDs),
		ExternalAudienceID: userListID,
		Message:            googleDataManagerSyncMessage(operation, membersSent, batchesSent, len(chunks), false, totalRetryAttempts),
	}, nil
}

func (a *GoogleAdsAdapter) postDataManagerIngest(ctx context.Context, url string, headers map[string]string, payload map[string]any) ([]byte, int, error) {
	var lastErr error
	for attempt := 1; attempt <= googleDataManagerMaxAttempts; attempt++ {
		resp, err := platformPOST(ctx, a.HTTPClient, url, headers, payload)
		if err == nil {
			return resp, attempt, nil
		}
		lastErr = err
		if attempt >= googleDataManagerMaxAttempts || !googleDataManagerRetryableError(err) {
			return resp, attempt, err
		}
		if err := googleDataManagerWaitBeforeRetry(ctx, err, attempt); err != nil {
			return resp, attempt, err
		}
	}
	return nil, googleDataManagerMaxAttempts, lastErr
}

func (a *GoogleAdsAdapter) RetrieveDiagnostics(ctx context.Context, cfg map[string]any, evidence ProviderRunEvidence) (PlatformDiagnosticsResult, error) {
	if googleAdsCustomerMatchTransport(cfg) != googleAdsTransportDataMgr {
		return PlatformDiagnosticsResult{Provider: a.Provider(), ExternalJobID: evidence.ExternalJobID, ExternalAudienceID: evidence.ExternalAudienceID},
			fmt.Errorf("%w: Google Ads provider diagnostics require customer_match_transport=data_manager", ErrAdapterNotConfigured)
	}
	requestIDs, err := googleDataManagerDecodeRequestIDs(evidence.ExternalJobID)
	if err != nil {
		return PlatformDiagnosticsResult{Provider: a.Provider(), ExternalJobID: evidence.ExternalJobID, ExternalAudienceID: evidence.ExternalAudienceID},
			fmt.Errorf("google data manager request status: %w", err)
	}
	if len(requestIDs) == 0 {
		return PlatformDiagnosticsResult{Provider: a.Provider()},
			fmt.Errorf("%w: Google Data Manager requestId missing", ErrAdapterNotConfigured)
	}
	if configString(cfg, "access_token") == "" {
		return PlatformDiagnosticsResult{Provider: a.Provider(), ExternalJobID: evidence.ExternalJobID, ExternalAudienceID: evidence.ExternalAudienceID},
			fmt.Errorf("%w: Google Data Manager request status requires an OAuth access token", ErrAdapterNotConfigured)
	}
	base := configString(cfg, "data_manager_api_base")
	if base == "" {
		base = googleDataManagerAPIBase
	}
	responses := make([]any, 0, len(requestIDs))
	statuses := make([]string, 0, len(requestIDs))
	for _, requestID := range requestIDs {
		parsed, err := a.retrieveDataManagerRequestStatus(ctx, cfg, base, requestID)
		if err != nil {
			return PlatformDiagnosticsResult{Provider: a.Provider(), ExternalJobID: evidence.ExternalJobID, ExternalAudienceID: evidence.ExternalAudienceID},
				err
		}
		status := googleDataManagerProviderStatus(parsed)
		if status != "" {
			statuses = append(statuses, status)
		}
		responses = append(responses, map[string]any{
			"requestId":      requestID,
			"providerStatus": status,
			"response":       parsed,
		})
	}
	if len(requestIDs) == 1 {
		parsed, _ := responses[0].(map[string]any)
		resp, _ := parsed["response"].(map[string]any)
		return PlatformDiagnosticsResult{
			Provider:           a.Provider(),
			ExternalJobID:      evidence.ExternalJobID,
			ExternalAudienceID: evidence.ExternalAudienceID,
			ProviderMessage:    evidence.ProviderMessage,
			ProviderStatus:     googleDataManagerProviderStatus(resp),
			ProviderResponse:   resp,
		}, nil
	}
	aggregate := map[string]any{
		"requestIds": requestIDs,
		"requests":   responses,
	}
	return PlatformDiagnosticsResult{
		Provider:           a.Provider(),
		ExternalJobID:      evidence.ExternalJobID,
		ExternalAudienceID: evidence.ExternalAudienceID,
		ProviderMessage:    evidence.ProviderMessage,
		ProviderStatus:     googleDataManagerRollupStatus(statuses),
		ProviderResponse:   aggregate,
	}, nil
}

func (a *GoogleAdsAdapter) retrieveDataManagerRequestStatus(ctx context.Context, cfg map[string]any, base, requestID string) (map[string]any, error) {
	u, err := url.Parse(strings.TrimRight(base, "/") + "/requestStatus:retrieve")
	if err != nil {
		return nil, fmt.Errorf("google data manager request status: build URL: %w", err)
	}
	q := u.Query()
	q.Set("requestId", requestID)
	u.RawQuery = q.Encode()
	headers := map[string]string{
		"Authorization": "Bearer " + configString(cfg, "access_token"),
	}
	resp, err := platformGET(ctx, a.HTTPClient, u.String(), headers)
	if err != nil {
		return nil, fmt.Errorf("google data manager request status: %w", err)
	}
	var parsed map[string]any
	if len(resp) > 0 {
		if err := json.Unmarshal(resp, &parsed); err != nil {
			return nil, fmt.Errorf("google data manager request status: decode response: %w", err)
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	return parsed, nil
}

func normalizeGoogleAdsOfflineUserDataJobID(resource string) string {
	return normalizeGoogleAdsResourceID(resource)
}

func normalizeGoogleAdsResourceID(resource string) string {
	resource = strings.Trim(strings.TrimSpace(resource), "/")
	if resource == "" {
		return ""
	}
	parts := strings.Split(resource, "/")
	return parts[len(parts)-1]
}

func normalizeGoogleAdsConsent(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "granted", "consent_status_granted":
		return "GRANTED"
	case "denied", "consent_status_denied":
		return "DENIED"
	default:
		return strings.ToUpper(strings.TrimSpace(value))
	}
}

func googleAdsCustomerMatchTransport(cfg map[string]any) string {
	raw := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		configString(cfg, "customer_match_transport"),
		configString(cfg, "transport"),
		configString(cfg, "upload_transport"),
	)))
	switch strings.ReplaceAll(raw, "-", "_") {
	case googleAdsTransportDataMgr, "datamanager", "data_manager_api":
		return googleAdsTransportDataMgr
	case googleAdsTransportLegacy, "offlineuserdatajob", "google_ads_api":
		return googleAdsTransportLegacy
	}
	if configBool(cfg, "data_manager_enabled") {
		return googleAdsTransportDataMgr
	}
	if configString(cfg, "offline_user_data_job") != "" || configBool(cfg, "offline_user_data_job_worker_attached") {
		return googleAdsTransportLegacy
	}
	return googleAdsTransportDataMgr
}

func googleAdsCustomerMatchOperation(cfg map[string]any) string {
	raw := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		configString(cfg, "customer_match_operation"),
		configString(cfg, "member_operation"),
		configString(cfg, "operation"),
	)))
	switch strings.ReplaceAll(raw, "-", "_") {
	case googleAdsOperationRemove, "delete", "remove_members", "delete_members":
		return googleAdsOperationRemove
	default:
		return googleAdsOperationIngest
	}
}

func googleAdsDataManagerTermsAccepted(cfg map[string]any) bool {
	if configBool(cfg, "customer_match_terms_accepted") ||
		configBool(cfg, "data_manager_terms_accepted") ||
		configBool(cfg, "terms_accepted") {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(firstNonEmpty(
		configString(cfg, "customer_match_terms_status"),
		configString(cfg, "terms_of_service_status"),
	))) {
	case "accepted", "customer_match_terms_of_service_status_accepted":
		return true
	default:
		return false
	}
}

func googleDataManagerAudienceMembers(hashed []string, destinationReference string) []map[string]any {
	audienceMembers := make([]map[string]any, 0, len(hashed))
	for _, h := range hashed {
		audienceMembers = append(audienceMembers, map[string]any{
			"destinationReferences": []string{destinationReference},
			"compositeData": map[string]any{
				"userData": map[string]any{
					"userIdentifiers": []map[string]any{{"emailAddress": h}},
				},
			},
		})
	}
	return audienceMembers
}

func googleDataManagerRetryableError(err error) bool {
	var httpErr *platformHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.transient()
	}
	return err != nil
}

func googleDataManagerWaitBeforeRetry(ctx context.Context, err error, attempt int) error {
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

func googleDataManagerSyncMessage(operation string, membersSent, batchesSent, totalBatches int, partial bool, retryAttempts int) string {
	retrySuffix := ""
	if retryAttempts > 0 {
		retrySuffix = fmt.Sprintf(" Retried transient provider errors %d time(s).", retryAttempts)
	}
	action := "Sent"
	direction := "to"
	if operation == googleAdsOperationRemove {
		action = "Removed"
		direction = "from"
	}
	switch {
	case partial:
		return fmt.Sprintf("%s %d hashed-email identifiers across %d of %d Google Data Manager API request(s) before provider error.%s", action, membersSent, batchesSent, totalBatches, retrySuffix)
	case totalBatches > 1:
		return fmt.Sprintf("%s %d hashed-email identifiers %s Google Ads Customer Match via Data Manager API across %d requests.%s", action, membersSent, direction, totalBatches, retrySuffix)
	default:
		return fmt.Sprintf("%s %d hashed-email identifiers %s Google Ads Customer Match via Data Manager API.%s", action, membersSent, direction, retrySuffix)
	}
}

func clonePayloadMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func chunkStrings(values []string, size int) [][]string {
	if len(values) == 0 {
		return nil
	}
	if size <= 0 || size >= len(values) {
		return [][]string{values}
	}
	out := make([][]string, 0, (len(values)+size-1)/size)
	for len(values) > 0 {
		n := size
		if len(values) < n {
			n = len(values)
		}
		out = append(out, values[:n])
		values = values[n:]
	}
	return out
}

func googleDataManagerEncodeRequestIDs(ids []string) string {
	ids = cleanGoogleDataManagerRequestIDs(ids)
	if len(ids) == 0 {
		return ""
	}
	if len(ids) == 1 {
		return ids[0]
	}
	raw, err := json.Marshal(googleDataManagerRequestIDsEnvelope{RequestIDs: ids})
	if err != nil {
		return ""
	}
	return googleDataManagerRequestIDsPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func googleDataManagerDecodeRequestIDs(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if !strings.HasPrefix(value, googleDataManagerRequestIDsPrefix) {
		return []string{value}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, googleDataManagerRequestIDsPrefix))
	if err != nil {
		return nil, fmt.Errorf("decode request ids: %w", err)
	}
	var envelope googleDataManagerRequestIDsEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode request ids: %w", err)
	}
	return cleanGoogleDataManagerRequestIDs(envelope.RequestIDs), nil
}

func cleanGoogleDataManagerRequestIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func normalizeGoogleDataManagerConsent(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "granted", "consent_granted", "consent_status_granted":
		return "CONSENT_GRANTED"
	case "denied", "consent_denied", "consent_status_denied":
		return "CONSENT_DENIED"
	default:
		value = strings.ToUpper(strings.TrimSpace(value))
		if strings.HasPrefix(value, "CONSENT_") {
			return value
		}
		return "CONSENT_" + value
	}
}

func googleDataManagerRequestID(resp []byte) string {
	var parsed map[string]any
	if err := json.Unmarshal(resp, &parsed); err != nil {
		return ""
	}
	for _, key := range []string{"requestId", "request_id"} {
		if value, ok := parsed[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func googleDataManagerProviderStatus(resp map[string]any) string {
	if statuses := googleDataManagerDestinationStatuses(resp); len(statuses) > 0 {
		return googleDataManagerRollupStatus(statuses)
	}
	for _, key := range []string{"status", "state"} {
		if value, ok := resp[key].(string); ok && strings.TrimSpace(value) != "" {
			return normalizeProviderDiagnosticsStatus(value)
		}
	}
	if destinations, ok := resp["destinationStatuses"].([]any); ok && len(destinations) > 0 {
		if first, ok := destinations[0].(map[string]any); ok {
			for _, key := range []string{"status", "state"} {
				if value, ok := first[key].(string); ok && strings.TrimSpace(value) != "" {
					return normalizeProviderDiagnosticsStatus(value)
				}
			}
		}
	}
	return ""
}

func googleDataManagerDestinationStatuses(resp map[string]any) []string {
	raw, ok := resp["requestStatusPerDestination"].([]any)
	if !ok {
		return nil
	}
	statuses := make([]string, 0, len(raw))
	for _, item := range raw {
		destination, ok := item.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"requestStatus", "status", "state"} {
			if value, ok := destination[key].(string); ok && strings.TrimSpace(value) != "" {
				statuses = append(statuses, normalizeProviderDiagnosticsStatus(value))
				break
			}
		}
	}
	return statuses
}

func googleDataManagerRollupStatus(statuses []string) string {
	hasProcessing := false
	hasSuccess := false
	hasFailed := false
	hasPartial := false
	first := ""
	for _, status := range statuses {
		status = normalizeProviderDiagnosticsStatus(status)
		if status == "" {
			continue
		}
		if first == "" {
			first = status
		}
		switch status {
		case "PROCESSING", "PENDING", "RUNNING", "QUEUED":
			hasProcessing = true
		case "SUCCESS", "SUCCEEDED":
			hasSuccess = true
		case "FAILED", "FAILURE":
			hasFailed = true
		case "PARTIAL_SUCCESS", "PARTIAL_FAILURE":
			hasPartial = true
		}
	}
	switch {
	case hasProcessing:
		return "PROCESSING"
	case hasPartial || (hasSuccess && hasFailed):
		return "PARTIAL_SUCCESS"
	case hasSuccess:
		return "SUCCESS"
	case hasFailed:
		return "FAILED"
	default:
		return first
	}
}
