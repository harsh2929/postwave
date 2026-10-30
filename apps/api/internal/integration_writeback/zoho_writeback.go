// SPDX-License-Identifier: AGPL-3.0-only
//
// zoho_writeback.go — update a Zoho CRM Contact's fields + tags, found by email.
// Fields are keyed by Zoho API name and updated via PUT /crm/v3/Contacts
// ({data:[{id, …}]}); audience tags use Zoho's native record tags
// (POST /crm/v3/Contacts/{id}/actions/add_tags?tag_names=…). Find via
// GET /crm/v3/Contacts/search?email=… (204 = no match). Auth: Zoho-oauthtoken.
// Extends two-way write-back to a 4th CRM (HubSpot/Salesforce/Pipedrive/Zoho).
package integration_writeback

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ZohoWritebackAdapter updates a Contact's fields + tags.
type ZohoWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a ZohoWritebackAdapter) Provider() string { return ProviderZoho }

func (a ZohoWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

// zohoBase derives the CRM v3 base. An explicit api_base_url override (tests /
// staging, already including /crm/v3) wins; otherwise it's api_domain (the
// region host returned at OAuth time) + /crm/v3, defaulting to the US domain.
func zohoBase(settings map[string]any) string {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/")
	}
	domain := settingString(settings, "api_domain")
	if domain == "" {
		domain = "https://www.zohoapis.com"
	}
	return strings.TrimRight(domain, "/") + "/crm/v3"
}

func (a ZohoWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"], creds["oauth_token"])
	if token == "" {
		return WriteResult{}, fmt.Errorf("zoho write-back requires an access token")
	}
	base := zohoBase(settings)
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}

	id, err := a.findContact(ctx, base, token, email)
	if err != nil {
		return WriteResult{}, err
	}
	if id == "" {
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true}

	if len(p.Fields) > 0 {
		if err := a.updateContact(ctx, base, token, id, p.Fields); err != nil {
			return res, err
		}
		res.FieldsWritten = len(p.Fields)
	}
	if len(p.Tags) > 0 {
		// Tags are best-effort: Zoho's add_tags can reject a tag_name that doesn't
		// already exist, and the field update (the primary write-back) already
		// succeeded — don't discard that by failing the whole profile on a tag
		// error (the runner drops the WriteResult when WriteProfile errors).
		if err := a.addTags(ctx, base, token, id, p.Tags); err == nil {
			res.TagsWritten = len(p.Tags)
		}
	}
	return res, nil
}

func (a ZohoWritebackAdapter) findContact(ctx context.Context, base, token, email string) (string, error) {
	endpoint := base + "/Contacts/search?email=" + url.QueryEscape(email)
	resp, body, err := a.do(ctx, http.MethodGet, endpoint, token, nil)
	if err != nil {
		return "", err
	}
	if resp.StatusCode == http.StatusNoContent {
		return "", nil // Zoho returns 204 for an empty search; a 200 with empty data is handled below too
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("zoho contact search http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("zoho contact search parse: %w", err)
	}
	if len(out.Data) == 0 {
		return "", nil
	}
	return out.Data[0].ID, nil
}

func (a ZohoWritebackAdapter) updateContact(ctx context.Context, base, token, id string, fields map[string]string) error {
	record := map[string]any{"id": id}
	for k, v := range fields {
		record[k] = v
	}
	payload, _ := json.Marshal(map[string]any{"data": []any{record}})
	resp, body, err := a.do(ctx, http.MethodPut, base+"/Contacts", token, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("zoho contact update http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a ZohoWritebackAdapter) addTags(ctx context.Context, base, token, id string, tags []string) error {
	endpoint := base + "/Contacts/" + url.PathEscape(id) + "/actions/add_tags?tag_names=" + url.QueryEscape(strings.Join(tags, ","))
	resp, body, err := a.do(ctx, http.MethodPost, endpoint, token, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("zoho add_tags http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a ZohoWritebackAdapter) do(ctx context.Context, method, endpoint, token string, payload []byte) (*http.Response, []byte, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("zoho rate limited (429); retry after %s", resp.Header.Get("Retry-After"))
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, body, nil
}
