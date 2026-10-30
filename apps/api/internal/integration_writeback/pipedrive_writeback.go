// SPDX-License-Identifier: AGPL-3.0-only
//
// pipedrive_writeback.go — update a Person's custom fields + labels, found by
// email. v2 PATCH /api/v2/persons/{id} nests custom fields under `custom_fields`
// (keys are 40-char hashes, discoverable via /v1/personFields) and labels under
// `label_ids` (int array; REPLACE semantics). Find via /v1/persons/search.
// Auth: x-api-token header.
package integration_writeback

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
)

// PipedriveWritebackAdapter updates a person's custom fields + labels.
type PipedriveWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a PipedriveWritebackAdapter) Provider() string { return ProviderPipedrive }

func (a PipedriveWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

func pipedriveBase(settings map[string]any) (string, error) {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/"), nil
	}
	company := settingString(settings, "company_domain")
	if company == "" {
		return "", fmt.Errorf("pipedrive write-back requires company_domain")
	}
	if !strings.Contains(company, ".") {
		company += ".pipedrive.com"
	}
	return "https://" + company, nil
}

func (a PipedriveWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	token := firstNonEmpty(creds["token"], creds["api_token"])
	if token == "" {
		return WriteResult{}, fmt.Errorf("pipedrive write-back requires an api token")
	}
	base, err := pipedriveBase(settings)
	if err != nil {
		return WriteResult{}, err
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}

	id, err := a.findPerson(ctx, base, token, email)
	if err != nil {
		return WriteResult{}, err
	}
	if id == 0 {
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true}

	body := map[string]any{}
	if len(p.Fields) > 0 {
		body["custom_fields"] = p.Fields
	}
	labelIDs := settingInts(settings, "label_ids")
	if len(labelIDs) > 0 {
		body["label_ids"] = labelIDs
	}
	if len(body) == 0 {
		return res, nil // matched, nothing to write
	}
	if err := a.patchPerson(ctx, base, token, id, body); err != nil {
		return res, err
	}
	res.FieldsWritten = len(p.Fields)
	res.TagsWritten = len(labelIDs)
	return res, nil
}

func (a PipedriveWritebackAdapter) findPerson(ctx context.Context, base, token, email string) (int, error) {
	endpoint := base + "/v1/persons/search?exact_match=true&fields=email&term=" + url.QueryEscape(email)
	resp, body, err := a.do(ctx, http.MethodGet, endpoint, token, nil)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("pipedrive search http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var out struct {
		Data struct {
			Items []struct {
				Item struct {
					ID int `json:"id"`
				} `json:"item"`
			} `json:"items"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &out)
	if len(out.Data.Items) == 0 {
		return 0, nil
	}
	return out.Data.Items[0].Item.ID, nil
}

func (a PipedriveWritebackAdapter) patchPerson(ctx context.Context, base, token string, id int, body map[string]any) error {
	payload, _ := json.Marshal(body)
	endpoint := base + "/api/v2/persons/" + strconv.Itoa(id)
	resp, respBody, err := a.do(ctx, http.MethodPatch, endpoint, token, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("pipedrive patch http %d: %s", resp.StatusCode, truncate(string(respBody), 300))
	}
	return nil
}

func (a PipedriveWritebackAdapter) do(ctx context.Context, method, endpoint, token string, payload []byte) (*http.Response, []byte, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("x-api-token", token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("pipedrive rate limited (429); reset %s", resp.Header.Get("x-ratelimit-reset"))
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, body, nil
}

// settingInts reads an int slice setting (JSON number array or comma string).
func settingInts(settings map[string]any, key string) []int {
	if settings == nil {
		return nil
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return nil
	}
	out := []int{}
	switch typed := v.(type) {
	case []int:
		return typed
	case []any:
		for _, e := range typed {
			switch n := e.(type) {
			case float64:
				out = append(out, int(n))
			case int:
				out = append(out, n)
			case string:
				if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
					out = append(out, i)
				}
			}
		}
	case string:
		for _, part := range strings.Split(typed, ",") {
			if i, err := strconv.Atoi(strings.TrimSpace(part)); err == nil {
				out = append(out, i)
			}
		}
	}
	return out
}
