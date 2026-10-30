// SPDX-License-Identifier: AGPL-3.0-only
//
// crm_static.go — shared helpers for the static-token CRM pullers (Close,
// Copper, Freshsales). These providers authenticate with a durable API key
// rather than OAuth, so they reuse a common credential-ref lookup, offset/page
// cursor, paging clamp, default tags/lists, and a method-flexible JSON client.
package crm_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func crmStaticCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func crmHTTPClient(c *http.Client, provider string) *http.Client {
	return crmEgressClient(c, provider, 20*time.Second)
}

func crmPageSize(raw string, def, max int) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// crmOffsetCursor decodes a "<prefix><n>" offset/page cursor. Empty starts at 0,
// the complete sentinel short-circuits.
func crmOffsetCursor(cursor, prefix, complete string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == complete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, prefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

// crmPageCursor is crmOffsetCursor for 1-based page numbers (empty starts at 1).
func crmPageCursor(cursor, prefix, complete string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == complete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, prefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func crmListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		settingString(integration.Settings, "list_id"),
		settingString(integration.Settings, "default_list_id"),
	))
}

func crmDefaultTags(integration Integration, provider string) []string {
	tags := append([]string{provider, provider + "-contact"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

type CRMStaticRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e CRMStaticRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("crm REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("crm REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

// crmStaticDoJSON performs a JSON request for a static-token CRM. A non-nil body
// is marshalled and POSTed; otherwise the supplied query is used for the method.
func crmStaticDoJSON(ctx context.Context, client *http.Client, method, baseURL, path string, query url.Values, headers map[string]string, body any, userAgent string, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse CRM API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, mErr := json.Marshal(body)
		if mErr != nil {
			return mErr
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return CRMStaticRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(raw), 500),
		}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode crm response %s: %w", path, err)
	}
	return nil
}
