// SPDX-License-Identifier: AGPL-3.0-only
//
// salesforce_writeback.go — update a Contact/Lead field + (optionally) add the
// record to a Campaign, found by email. SOQL finds the Id; PATCH /sobjects/{obj}/{id}
// updates fields (204; omitted fields untouched, present fields replaced); a
// CampaignMember insert is the "tag" analogue (dup inserts are tolerated).
// Auth: Bearer + instance_url. NOTE: field-level security can make a PATCH return
// success while silently not writing — grant FLS edit on each written field.
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

const salesforceDefaultAPIVersion = "v60.0"

// SalesforceWritebackAdapter writes sObject fields + campaign membership.
type SalesforceWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a SalesforceWritebackAdapter) Provider() string { return ProviderSalesforce }

func (a SalesforceWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

func salesforceBase(settings map[string]any) (string, error) {
	base := firstNonEmpty(settingString(settings, "api_base_url"), settingString(settings, "instance_url"))
	if base == "" {
		return "", fmt.Errorf("salesforce write-back requires instance_url")
	}
	version := settingString(settings, "api_version")
	if version == "" {
		version = salesforceDefaultAPIVersion
	}
	return fmt.Sprintf("%s/services/data/%s", strings.TrimRight(base, "/"), version), nil
}

func (a SalesforceWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"])
	if token == "" {
		return WriteResult{}, fmt.Errorf("salesforce write-back requires an access token")
	}
	base, err := salesforceBase(settings)
	if err != nil {
		return WriteResult{}, err
	}
	object := settingString(settings, "object")
	if object == "" {
		object = "Contact"
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}

	id, err := a.findRecord(ctx, base, token, object, email)
	if err != nil {
		return WriteResult{}, err
	}
	if id == "" {
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true}

	if len(p.Fields) > 0 {
		if err := a.patchFields(ctx, base, token, object, id, p.Fields); err != nil {
			return res, err
		}
		res.FieldsWritten = len(p.Fields)
	}
	if campaignID := settingString(settings, "campaign_id"); campaignID != "" {
		status := settingString(settings, "campaign_status")
		if status == "" {
			status = "Sent"
		}
		if err := a.addCampaignMember(ctx, base, token, campaignID, object, id, status); err != nil {
			return res, err
		}
		res.TagsWritten = 1
	}
	return res, nil
}

func (a SalesforceWritebackAdapter) findRecord(ctx context.Context, base, token, object, email string) (string, error) {
	// SOQL: single-quote the email; escape embedded quotes defensively.
	safe := strings.ReplaceAll(email, "'", "\\'")
	soql := fmt.Sprintf("SELECT Id FROM %s WHERE Email = '%s' LIMIT 1", object, safe)
	endpoint := base + "/query?q=" + url.QueryEscape(soql)
	resp, body, err := a.do(ctx, http.MethodGet, endpoint, token, nil)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("salesforce query http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var out struct {
		Records []struct {
			ID string `json:"Id"`
		} `json:"records"`
	}
	_ = json.Unmarshal(body, &out)
	if len(out.Records) == 0 {
		return "", nil
	}
	return out.Records[0].ID, nil
}

func (a SalesforceWritebackAdapter) patchFields(ctx context.Context, base, token, object, id string, fields map[string]string) error {
	payload, _ := json.Marshal(fields)
	endpoint := fmt.Sprintf("%s/sobjects/%s/%s", base, object, url.PathEscape(id))
	resp, body, err := a.do(ctx, http.MethodPatch, endpoint, token, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("salesforce patch http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a SalesforceWritebackAdapter) addCampaignMember(ctx context.Context, base, token, campaignID, object, recordID, status string) error {
	member := map[string]any{"CampaignId": campaignID, "Status": status}
	if object == "Lead" {
		member["LeadId"] = recordID
	} else {
		member["ContactId"] = recordID
	}
	payload, _ := json.Marshal(member)
	endpoint := base + "/sobjects/CampaignMember"
	resp, body, err := a.do(ctx, http.MethodPost, endpoint, token, payload)
	if err != nil {
		return err
	}
	// 201 created. A duplicate membership returns 400 DUPLICATE_VALUE — already a
	// member, so treat as success (idempotent).
	if resp.StatusCode == http.StatusBadRequest && strings.Contains(string(body), "DUPLICATE_VALUE") {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("salesforce campaign member http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a SalesforceWritebackAdapter) do(ctx context.Context, method, endpoint, token string, payload []byte) (*http.Response, []byte, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("salesforce rate limited (429)")
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, body, nil
}
