// SPDX-License-Identifier: AGPL-3.0-only
//
// amplitude.go — native Amplitude outbound puller (async cohort export).
//
// Amplitude has no list-all-users REST endpoint; the supported bulk read is the
// Behavioral Cohort export, which is asynchronous (request -> poll -> download
// CSV). This maps that 3-step flow onto the BackfillPage(cursor) state machine:
//
//	empty            -> request export, return cursor "amplitude:poll:<request_id>"
//	amplitude:poll:.. -> poll status; if not done re-emit the same cursor (the
//	                     scheduler re-invokes), if done download + parse the CSV
//	                     into canonical ProfileInput and return cursor complete.
//
// HTTP Basic (api_key:secret_key); cohort_id is required. The CSV's email column
// is detected by header (skips rows without an email).
package analytics_integrations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	amplitudeDefaultAPIBaseURL = "https://amplitude.com"
	amplitudeCursorPollPrefix  = "amplitude:poll:"
	amplitudeCursorComplete    = "amplitude:complete"
	amplitudeResponseMaxBytes  = 64 << 20
	// amplitudeMaxPollAttempts bounds the request-status poll loop so a stuck or
	// failed cohort export surfaces as an error instead of polling forever.
	amplitudeMaxPollAttempts = 720
)

type AmplitudeCredentials struct {
	APIKey     string
	SecretKey  string
	APIBaseURL string
	UserAgent  string
}

type AmplitudeCredentialResolver interface {
	ResolveAmplitude(ctx context.Context, tenantID string, integration Integration) (AmplitudeCredentials, error)
}

type amplitudeCredentialPayload struct {
	APIKey     string `json:"api_key"`
	SecretKey  string `json:"secret_key"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p amplitudeCredentialPayload) credentials() (AmplitudeCredentials, error) {
	key := strings.TrimSpace(p.APIKey)
	secret := strings.TrimSpace(p.SecretKey)
	if key == "" || secret == "" {
		return AmplitudeCredentials{}, fmt.Errorf("amplitude api_key and secret_key are required")
	}
	return AmplitudeCredentials{APIKey: key, SecretKey: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type AmplitudeSecretsCredentialResolver struct {
	Secrets AnalyticsPullerSecretResolver
}

func (r AmplitudeSecretsCredentialResolver) ResolveAmplitude(ctx context.Context, _ string, integration Integration) (AmplitudeCredentials, error) {
	if r.Secrets == nil {
		return AmplitudeCredentials{}, fmt.Errorf("amplitude credential resolver is not configured")
	}
	ref := analyticsCredentialRef(integration)
	if ref == "" {
		return AmplitudeCredentials{}, fmt.Errorf("amplitude credentials_ref is required")
	}
	var payload amplitudeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withAmplitudeBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AmplitudeCredentials{}, fmt.Errorf("resolve amplitude credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withAmplitudeBaseURL(creds, integration), nil
			}
		}
	}
	return AmplitudeCredentials{}, fmt.Errorf("amplitude requires a JSON {api_key, secret_key} secret")
}

func withAmplitudeBaseURL(creds AmplitudeCredentials, integration Integration) AmplitudeCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type AmplitudeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AmplitudeCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

func (b AmplitudeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAmplitude {
		return SyncRequest{}, fmt.Errorf("amplitude backfill requires an Amplitude integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("amplitude credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == amplitudeCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: amplitudeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveAmplitude(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	cohortID := strings.TrimSpace(settingString(integration.Settings, "cohort_id"))
	if cohortID == "" {
		return SyncRequest{}, fmt.Errorf("amplitude cohort_id is required (the Behavioral Cohort to export)")
	}
	client := analyticsEgressClient(b.HTTPClient, ProviderAmplitude, 60*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), amplitudeDefaultAPIBaseURL)
	userAgent := firstString(b.UserAgent, creds.UserAgent, analyticsDefaultUserAgent)
	headers := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(creds.APIKey+":"+creds.SecretKey))}

	// Phase 1: no cursor -> request an export, hand back a poll cursor.
	if !strings.HasPrefix(cursor, amplitudeCursorPollPrefix) {
		var reqOut struct {
			RequestID string `json:"request_id"`
		}
		if err := analyticsDoJSON(ctx, client, http.MethodGet, baseURL+"/api/5/cohorts/request/"+amplitudePathEscape(cohortID)+"?props=1", headers, nil, userAgent, &reqOut); err != nil {
			return SyncRequest{}, err
		}
		if strings.TrimSpace(reqOut.RequestID) == "" {
			return SyncRequest{}, fmt.Errorf("amplitude cohort export request returned no request_id")
		}
		return SyncRequest{RunMode: "backfill", Cursor: amplitudeCursorPollPrefix + strings.TrimSpace(reqOut.RequestID)}, nil
	}

	// Phase 2: poll status; download + parse when complete. The cursor carries
	// the request id plus an attempt counter (request_id#attempt) so a stuck or
	// failed export is bounded rather than polled forever.
	requestID, attempt := amplitudeDecodePollCursor(cursor)
	var statusOut struct {
		AsyncStatus string `json:"async_status"`
	}
	if err := analyticsDoJSON(ctx, client, http.MethodGet, baseURL+"/api/5/cohorts/request-status/"+amplitudePathEscape(requestID), headers, nil, userAgent, &statusOut); err != nil {
		return SyncRequest{}, err
	}
	status := strings.ToUpper(strings.TrimSpace(statusOut.AsyncStatus))
	if status != "JOB COMPLETED" {
		if status != "JOB INPROGRESS" {
			return SyncRequest{}, fmt.Errorf("amplitude cohort export returned an unsuccessful or missing job status")
		}
		if attempt+1 >= amplitudeMaxPollAttempts {
			return SyncRequest{}, fmt.Errorf("amplitude cohort export %q did not complete after %d polls (last status %q)", requestID, attempt+1, strings.TrimSpace(statusOut.AsyncStatus))
		}
		// Not ready yet — re-emit a poll cursor with the next attempt; the scheduler retries.
		return SyncRequest{RunMode: "backfill", Cursor: amplitudeCursorPollPrefix + requestID + "#" + strconv.Itoa(attempt+1)}, nil
	}
	csvBody, err := amplitudeGetRaw(ctx, client, baseURL+"/api/5/cohorts/request/"+amplitudePathEscape(requestID)+"/file", headers, userAgent)
	if err != nil {
		return SyncRequest{}, err
	}
	profiles, err := parseAmplitudeCohortCSV(csvBody)
	if err != nil {
		return SyncRequest{}, err
	}
	return SyncRequest{RunMode: "backfill", Profiles: profiles, Cursor: amplitudeCursorComplete}, nil
}

func parseAmplitudeCohortCSV(body []byte) ([]ProfileInput, error) {
	reader := csv.NewReader(bytes.NewReader(body))
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("parse amplitude cohort CSV: %w", err)
	}
	// Process one CSV record at a time; keeping ReadAll's complete row matrix
	// and a second string copy of the download needlessly multiplies memory.
	columns := make(map[string]int, len(header))
	for i, h := range header {
		header[i] = strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))
		normalized := strings.ToLower(header[i])
		if normalized == "" {
			return nil, fmt.Errorf("amplitude cohort export has an unnamed column")
		}
		if _, duplicate := columns[normalized]; duplicate {
			return nil, fmt.Errorf("amplitude cohort export has duplicate columns")
		}
		columns[normalized] = i
	}
	column := func(names ...string) int {
		for _, name := range names {
			if index, found := columns[name]; found {
				return index
			}
		}
		return -1
	}
	emailCol := column("email", "gp:email", "$email", "gp:$email", "email_address", "gp:email_address")
	if emailCol < 0 {
		return nil, fmt.Errorf("amplitude cohort export has no email column (include email as a user property)")
	}
	userCol, ampCol := column("user_id"), column("amplitude_id")
	firstCol := column("gp:first_name", "first_name", "gp:$first_name", "$first_name")
	lastCol := column("gp:last_name", "last_name", "gp:$last_name", "$last_name")
	nameCol := column("gp:name", "name", "gp:$name", "$name")
	phoneCol := column("gp:phone", "phone", "gp:$phone", "$phone")
	var out []ProfileInput
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// A malformed later record must not certify a partial download.
			return nil, fmt.Errorf("parse amplitude cohort CSV: %w", err)
		}
		email := strings.ToLower(strings.TrimSpace(row[emailCol]))
		if email == "" {
			continue
		}
		value := func(index int) string {
			if index < 0 {
				return ""
			}
			return strings.TrimSpace(row[index])
		}
		traits := make(map[string]any, len(header))
		for i, name := range header {
			traits[name] = row[i]
		}
		userID, ampID := value(userCol), value(ampCol)
		out = append(out, ProfileInput{
			SourceID:    "amplitude://user/" + firstString(userID, ampID, email),
			Email:       email,
			UserID:      userID,
			AnonymousID: ampID,
			FirstName:   value(firstCol),
			LastName:    value(lastCol),
			FullName:    value(nameCol),
			Phone:       value(phoneCol),
			Traits:      traits,
		})
	}
	return out, nil
}

func amplitudeGetRaw(ctx context.Context, client *http.Client, fullURL string, headers map[string]string, userAgent string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.ContentLength > amplitudeResponseMaxBytes {
		return nil, fmt.Errorf("amplitude cohort download exceeds the %d-byte limit", amplitudeResponseMaxBytes)
	}
	body, err := amplitudeReadBounded(resp.Body, amplitudeResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, AnalyticsRESTError{
			StatusCode: resp.StatusCode,
			RetryAfter: analyticsRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    analyticsTruncate(string(body), 300),
		}
	}
	return body, nil
}

func amplitudeReadBounded(reader io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("amplitude cohort download exceeds the %d-byte limit", limit)
	}
	return body, nil
}

func amplitudePathEscape(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), " ", "%20")
}

// amplitudeDecodePollCursor splits a poll cursor (after the prefix) into the
// request id and its attempt counter, tolerating the legacy form without a
// counter ("request_id" -> attempt 0).
func amplitudeDecodePollCursor(cursor string) (requestID string, attempt int) {
	body := strings.TrimPrefix(strings.TrimSpace(cursor), amplitudeCursorPollPrefix)
	rid, attemptStr, ok := strings.Cut(body, "#")
	requestID = strings.TrimSpace(rid)
	if ok {
		if n, err := strconv.Atoi(strings.TrimSpace(attemptStr)); err == nil && n > 0 {
			attempt = n
		}
	}
	return requestID, attempt
}
