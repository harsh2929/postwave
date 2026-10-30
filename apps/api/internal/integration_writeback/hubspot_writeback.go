// SPDX-License-Identifier: AGPL-3.0-only
//
// hubspot_writeback.go — push contact properties + static-list membership to
// HubSpot, keyed by email. PATCH /crm/v3/objects/contacts/{email}?idProperty=email
// is idempotent (updates by the unique email property); list membership uses the
// current v3 lists API (PUT /crm/v3/lists/{listId}/memberships/add, a bare array
// of record-id strings) — the legacy v1 contacts/lists API sunsets 2026-04-30.
// Auth: Bearer (private-app token / OAuth).
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

const hubspotDefaultBase = "https://api.hubapi.com"

// HubSpotWritebackAdapter updates contact properties and (optionally) adds the
// contact to a static list.
type HubSpotWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a HubSpotWritebackAdapter) Provider() string { return ProviderHubSpot }

func (a HubSpotWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

func hubspotBase(settings map[string]any) string {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/")
	}
	return hubspotDefaultBase
}

func (a HubSpotWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"], creds["private_app_token"])
	if token == "" {
		return WriteResult{}, fmt.Errorf("hubspot write-back requires a token")
	}
	base := hubspotBase(settings)
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}
	listID := settingString(settings, "list_id")

	// 1) Update properties by email (idempotent). Always runs (even with no
	//    fields) so we resolve the contact id for list membership and confirm a
	//    match; an empty properties object is a harmless no-op update.
	contactID, matched, err := a.patchContact(ctx, base, token, email, p.Fields)
	if err != nil {
		return WriteResult{}, err
	}
	if !matched {
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true, FieldsWritten: len(p.Fields)}

	// 2) Static-list membership (the HubSpot analogue of a tag/segment).
	if listID != "" && contactID != "" {
		if err := a.addToList(ctx, base, token, listID, contactID); err != nil {
			return res, err
		}
		res.TagsWritten = 1
	}
	return res, nil
}

// hubspotBatchSize is HubSpot's batch endpoint cap (100 inputs / request).
const hubspotBatchSize = 100

// BatchWrite is the bulk path: instead of one PATCH per contact, it (1) batch-reads
// contacts by email (idProperty=email, omitting non-existent ones — preserving the
// no-create rule), (2) batch-updates properties by id, and (3) bulk-adds the matched
// ids to the static list. A 1k-member audience becomes ~3 calls per 100 (~30 calls)
// instead of ~1k. Unmatched emails are silently skipped, never created.
func (a HubSpotWritebackAdapter) BatchWrite(ctx context.Context, creds map[string]string, settings map[string]any, profiles []ProfileWrite) (BatchResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"], creds["private_app_token"])
	if token == "" {
		return BatchResult{}, fmt.Errorf("hubspot write-back requires a token")
	}
	base := hubspotBase(settings)
	listID := settingString(settings, "list_id")

	var agg BatchResult
	var firstErr error
	for start := 0; start < len(profiles); start += hubspotBatchSize {
		end := start + hubspotBatchSize
		if end > len(profiles) {
			end = len(profiles)
		}
		res, err := a.batchChunk(ctx, base, token, listID, profiles[start:end])
		agg.Matched += res.Matched
		agg.TagsWritten += res.TagsWritten
		agg.FieldsWritten += res.FieldsWritten
		agg.RowsFailed += res.RowsFailed
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return agg, firstErr
}

func (a HubSpotWritebackAdapter) batchChunk(ctx context.Context, base, token, listID string, chunk []ProfileWrite) (BatchResult, error) {
	byEmail := make(map[string]ProfileWrite, len(chunk))
	readInputs := make([]map[string]any, 0, len(chunk))
	for _, p := range chunk {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if email == "" {
			continue
		}
		// Merge duplicate emails within a chunk so no profile's fields/tags are
		// silently dropped (an audience normally has unique emails, but be safe).
		if existing, dup := byEmail[email]; dup {
			byEmail[email] = mergeProfileWrites(existing, p)
		} else {
			byEmail[email] = p
			readInputs = append(readInputs, map[string]any{"id": email})
		}
	}
	if len(readInputs) == 0 {
		return BatchResult{}, nil
	}

	// 1) Batch read by email (unmatched are omitted from results — no-create).
	readBody, _ := json.Marshal(map[string]any{
		"idProperty": "email",
		"properties": []string{"email"},
		"inputs":     readInputs,
	})
	resp, body, err := a.do(ctx, http.MethodPost, base+"/crm/v3/objects/contacts/batch/read", token, readBody)
	if err != nil {
		return BatchResult{RowsFailed: len(readInputs)}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return BatchResult{RowsFailed: len(readInputs)}, fmt.Errorf("hubspot batch read http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var read struct {
		Results []struct {
			ID         string            `json:"id"`
			Properties map[string]string `json:"properties"`
		} `json:"results"`
	}
	_ = json.Unmarshal(body, &read)

	matched := make(map[string]string, len(read.Results)) // email -> contact id
	for _, r := range read.Results {
		em := strings.ToLower(strings.TrimSpace(r.Properties["email"]))
		if em == "" || r.ID == "" {
			continue
		}
		if _, asked := byEmail[em]; !asked {
			continue // ignore any record we didn't ask for — no rogue list adds
		}
		matched[em] = r.ID
	}
	out := BatchResult{Matched: len(matched)}

	// 2) Batch update properties for matched contacts that actually have fields.
	updateInputs := make([]map[string]any, 0, len(matched))
	fieldsWritten := 0
	for em, id := range matched {
		p := byEmail[em]
		if len(p.Fields) == 0 {
			continue
		}
		updateInputs = append(updateInputs, map[string]any{"id": id, "properties": p.Fields})
		fieldsWritten += len(p.Fields)
	}
	if len(updateInputs) > 0 {
		upBody, _ := json.Marshal(map[string]any{"inputs": updateInputs})
		resp, body, err := a.do(ctx, http.MethodPost, base+"/crm/v3/objects/contacts/batch/update", token, upBody)
		if err != nil {
			out.RowsFailed = len(updateInputs)
			return out, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			out.RowsFailed = len(updateInputs)
			return out, fmt.Errorf("hubspot batch update http %d: %s", resp.StatusCode, truncate(string(body), 300))
		}
		out.FieldsWritten = fieldsWritten
	}

	// 3) Bulk static-list membership for every matched id.
	if listID != "" && len(matched) > 0 {
		ids := make([]string, 0, len(matched))
		for _, id := range matched {
			ids = append(ids, id)
		}
		addBody, _ := json.Marshal(ids)
		resp, body, err := a.do(ctx, http.MethodPut, base+"/crm/v3/lists/"+url.PathEscape(listID)+"/memberships/add", token, addBody)
		if err != nil {
			out.RowsFailed = len(ids)
			return out, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			out.RowsFailed = len(ids)
			return out, fmt.Errorf("hubspot batch list add http %d: %s", resp.StatusCode, truncate(string(body), 300))
		}
		out.TagsWritten = len(ids)
	}
	return out, nil
}

func (a HubSpotWritebackAdapter) patchContact(ctx context.Context, base, token, email string, fields map[string]string) (string, bool, error) {
	props := map[string]string{}
	for k, v := range fields {
		props[k] = v
	}
	payload, _ := json.Marshal(map[string]any{"properties": props})
	endpoint := base + "/crm/v3/objects/contacts/" + url.PathEscape(email) + "?idProperty=email"
	resp, body, err := a.do(ctx, http.MethodPatch, endpoint, token, payload)
	if err != nil {
		return "", false, err
	}
	if resp.StatusCode == http.StatusNotFound {
		return "", false, nil // contact doesn't exist on HubSpot yet
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", false, fmt.Errorf("hubspot patch contact http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &out)
	return out.ID, true, nil
}

func (a HubSpotWritebackAdapter) addToList(ctx context.Context, base, token, listID, contactID string) error {
	payload, _ := json.Marshal([]string{contactID}) // bare array of record-id strings
	endpoint := base + "/crm/v3/lists/" + url.PathEscape(listID) + "/memberships/add"
	resp, body, err := a.do(ctx, http.MethodPut, endpoint, token, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("hubspot list add http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a HubSpotWritebackAdapter) do(ctx context.Context, method, endpoint, token string, payload []byte) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("hubspot rate limited (429); retry after %s", resp.Header.Get("Retry-After"))
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, body, nil
}
