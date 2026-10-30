// SPDX-License-Identifier: AGPL-3.0-only
//
// klaviyo_writeback.go — push Moosewave traits back to existing Klaviyo
// profiles. The adapter deliberately looks profiles up by email first and only
// updates the returned profile IDs, preserving the write-back layer's no-create
// contract even though Klaviyo's Events API can create profiles when addressed
// only by email.
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

const (
	klaviyoDefaultBase     = "https://a.klaviyo.com/api"
	klaviyoDefaultRevision = "2026-04-15"
	klaviyoBatchSize       = 100
	klaviyoListBatchSize   = 1000
)

// KlaviyoWritebackAdapter updates custom profile properties, optionally adds
// matched profiles to a Klaviyo list, and optionally records a custom event.
type KlaviyoWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a KlaviyoWritebackAdapter) Provider() string { return ProviderKlaviyo }

func (a KlaviyoWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

func klaviyoBase(settings map[string]any) string {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/")
	}
	if override := settingString(settings, "klaviyo_api_base_url"); override != "" {
		return strings.TrimRight(override, "/")
	}
	return klaviyoDefaultBase
}

func klaviyoRevision(settings map[string]any) string {
	if revision := settingString(settings, "revision"); revision != "" {
		return revision
	}
	if revision := settingString(settings, "klaviyo_revision"); revision != "" {
		return revision
	}
	return klaviyoDefaultRevision
}

func klaviyoAuthHeader(creds map[string]string) (string, error) {
	if token := firstNonEmpty(creds["oauth_access_token"], creds["access_token"], creds["bearer_token"]); token != "" {
		if strings.HasPrefix(token, "Bearer ") || strings.HasPrefix(token, "Klaviyo-API-Key ") {
			return token, nil
		}
		return "Bearer " + token, nil
	}
	if key := firstNonEmpty(creds["api_key"], creds["private_api_key"], creds["klaviyo_api_key"], creds["token"]); key != "" {
		if strings.HasPrefix(key, "Bearer ") || strings.HasPrefix(key, "Klaviyo-API-Key ") {
			return key, nil
		}
		return "Klaviyo-API-Key " + key, nil
	}
	return "", fmt.Errorf("klaviyo write-back requires an API key or OAuth access token")
}

func klaviyoListID(settings map[string]any) string {
	return firstNonEmpty(settingString(settings, "list_id"), settingString(settings, "klaviyo_list_id"))
}

func klaviyoEventName(settings map[string]any) string {
	return firstNonEmpty(settingString(settings, "event_name"), settingString(settings, "klaviyo_event_name"))
}

func klaviyoTagsProperty(settings map[string]any) string {
	return firstNonEmpty(settingString(settings, "tags_property"), settingString(settings, "klaviyo_tags_property"))
}

func (a KlaviyoWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	auth, err := klaviyoAuthHeader(creds)
	if err != nil {
		return WriteResult{}, err
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}
	base := klaviyoBase(settings)
	revision := klaviyoRevision(settings)
	profiles, err := a.findProfilesByEmail(ctx, base, revision, auth, []string{email})
	if err != nil {
		return WriteResult{}, err
	}
	profileID := profiles[email]
	if profileID == "" {
		return WriteResult{Matched: false}, nil
	}
	return a.writeMatchedProfile(ctx, base, revision, auth, settings, profileID, p)
}

func (a KlaviyoWritebackAdapter) BatchWrite(ctx context.Context, creds map[string]string, settings map[string]any, profiles []ProfileWrite) (BatchResult, error) {
	auth, err := klaviyoAuthHeader(creds)
	if err != nil {
		return BatchResult{}, err
	}
	base := klaviyoBase(settings)
	revision := klaviyoRevision(settings)
	var agg BatchResult
	var firstErr error
	for start := 0; start < len(profiles); start += klaviyoBatchSize {
		end := start + klaviyoBatchSize
		if end > len(profiles) {
			end = len(profiles)
		}
		res, err := a.batchChunk(ctx, base, revision, auth, settings, profiles[start:end])
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

func (a KlaviyoWritebackAdapter) batchChunk(ctx context.Context, base, revision, auth string, settings map[string]any, chunk []ProfileWrite) (BatchResult, error) {
	byEmail := make(map[string]ProfileWrite, len(chunk))
	emails := make([]string, 0, len(chunk))
	for _, p := range chunk {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if email == "" {
			continue
		}
		p.Email = email
		if existing, dup := byEmail[email]; dup {
			byEmail[email] = mergeProfileWrites(existing, p)
		} else {
			byEmail[email] = p
			emails = append(emails, email)
		}
	}
	if len(emails) == 0 {
		return BatchResult{}, nil
	}
	found, err := a.findProfilesByEmail(ctx, base, revision, auth, emails)
	if err != nil {
		return BatchResult{RowsFailed: len(emails)}, err
	}
	var agg BatchResult
	var firstErr error
	matchedIDs := make([]string, 0, len(found))
	for email, profileID := range found {
		p := byEmail[email]
		res, err := a.writeProfilePropertiesAndEvent(ctx, base, revision, auth, settings, profileID, p)
		if err != nil {
			agg.RowsFailed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if res.Matched {
			agg.Matched++
			matchedIDs = append(matchedIDs, profileID)
		}
		agg.TagsWritten += res.TagsWritten
		agg.FieldsWritten += res.FieldsWritten
	}
	if listID := klaviyoListID(settings); listID != "" && len(matchedIDs) > 0 {
		written, err := a.addProfilesToList(ctx, base, revision, auth, listID, matchedIDs)
		if err != nil {
			agg.RowsFailed += len(matchedIDs)
			if firstErr == nil {
				firstErr = err
			}
		} else {
			agg.TagsWritten += written
		}
	}
	return agg, firstErr
}

func (a KlaviyoWritebackAdapter) writeMatchedProfile(ctx context.Context, base, revision, auth string, settings map[string]any, profileID string, p ProfileWrite) (WriteResult, error) {
	res, err := a.writeProfilePropertiesAndEvent(ctx, base, revision, auth, settings, profileID, p)
	if err != nil {
		return res, err
	}
	if listID := klaviyoListID(settings); listID != "" {
		written, err := a.addProfilesToList(ctx, base, revision, auth, listID, []string{profileID})
		if err != nil {
			return res, err
		}
		res.TagsWritten += written
	}
	return res, nil
}

func (a KlaviyoWritebackAdapter) writeProfilePropertiesAndEvent(ctx context.Context, base, revision, auth string, settings map[string]any, profileID string, p ProfileWrite) (WriteResult, error) {
	res := WriteResult{Matched: true}
	props := klaviyoProfileProperties(settings, p)
	if len(props) > 0 {
		if err := a.updateProfileProperties(ctx, base, revision, auth, profileID, props); err != nil {
			return res, err
		}
		res.FieldsWritten += len(p.Fields)
		if klaviyoTagsProperty(settings) != "" {
			res.TagsWritten += len(p.Tags)
		}
	}
	if eventName := klaviyoEventName(settings); eventName != "" {
		if err := a.createEvent(ctx, base, revision, auth, profileID, eventName, settings, p); err != nil {
			return res, err
		}
	}
	return res, nil
}

func klaviyoProfileProperties(settings map[string]any, p ProfileWrite) map[string]any {
	props := make(map[string]any, len(p.Fields)+1)
	for k, v := range p.Fields {
		if key := strings.TrimSpace(k); key != "" {
			props[key] = v
		}
	}
	if tagsProperty := klaviyoTagsProperty(settings); tagsProperty != "" && len(p.Tags) > 0 {
		props[tagsProperty] = cleanStrings(p.Tags)
	}
	return props
}

func (a KlaviyoWritebackAdapter) findProfilesByEmail(ctx context.Context, base, revision, auth string, emails []string) (map[string]string, error) {
	out := map[string]string{}
	clean := cleanStrings(emails)
	if len(clean) == 0 {
		return out, nil
	}
	u, err := url.Parse(base + "/profiles")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if len(clean) == 1 {
		q.Set("filter", `equals(email,"`+klaviyoFilterString(clean[0])+`")`)
	} else {
		parts := make([]string, 0, len(clean))
		for _, email := range clean {
			parts = append(parts, `"`+klaviyoFilterString(email)+`"`)
		}
		q.Set("filter", "any(email,["+strings.Join(parts, ",")+"])")
	}
	q.Set("fields[profile]", "email")
	q.Set("page[size]", fmt.Sprint(klaviyoBatchSize))
	u.RawQuery = q.Encode()

	resp, body, err := a.do(ctx, http.MethodGet, u.String(), revision, auth, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("klaviyo get profiles http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var parsed struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Email string `json:"email"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("klaviyo get profiles decode: %w", err)
	}
	for _, item := range parsed.Data {
		email := strings.ToLower(strings.TrimSpace(item.Attributes.Email))
		if email == "" || item.ID == "" {
			continue
		}
		out[email] = item.ID
	}
	return out, nil
}

func klaviyoFilterString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, `"`, `\"`)
}

func (a KlaviyoWritebackAdapter) updateProfileProperties(ctx context.Context, base, revision, auth, profileID string, props map[string]any) error {
	payload, _ := json.Marshal(map[string]any{
		"data": map[string]any{
			"type": "profile",
			"id":   profileID,
			"attributes": map[string]any{
				"properties": props,
			},
		},
	})
	endpoint := base + "/profiles/" + url.PathEscape(profileID)
	resp, body, err := a.do(ctx, http.MethodPatch, endpoint, revision, auth, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("klaviyo update profile http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a KlaviyoWritebackAdapter) addProfilesToList(ctx context.Context, base, revision, auth, listID string, profileIDs []string) (int, error) {
	total := 0
	for start := 0; start < len(profileIDs); start += klaviyoListBatchSize {
		end := start + klaviyoListBatchSize
		if end > len(profileIDs) {
			end = len(profileIDs)
		}
		data := make([]map[string]any, 0, end-start)
		for _, id := range profileIDs[start:end] {
			if id = strings.TrimSpace(id); id != "" {
				data = append(data, map[string]any{"type": "profile", "id": id})
			}
		}
		if len(data) == 0 {
			continue
		}
		payload, _ := json.Marshal(map[string]any{"data": data})
		endpoint := base + "/lists/" + url.PathEscape(listID) + "/relationships/profiles"
		resp, body, err := a.do(ctx, http.MethodPost, endpoint, revision, auth, payload)
		if err != nil {
			return total, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return total, fmt.Errorf("klaviyo list add http %d: %s", resp.StatusCode, truncate(string(body), 300))
		}
		total += len(data)
	}
	return total, nil
}

func (a KlaviyoWritebackAdapter) createEvent(ctx context.Context, base, revision, auth, profileID, eventName string, settings map[string]any, p ProfileWrite) error {
	properties := klaviyoEventProperties(settings, p)
	payload, _ := json.Marshal(map[string]any{
		"data": map[string]any{
			"type": "event",
			"attributes": map[string]any{
				"properties": properties,
				"metric": map[string]any{
					"data": map[string]any{
						"type": "metric",
						"attributes": map[string]any{
							"name": eventName,
						},
					},
				},
				"profile": map[string]any{
					"data": map[string]any{
						"type": "profile",
						"id":   profileID,
					},
				},
			},
		},
	})
	resp, body, err := a.do(ctx, http.MethodPost, base+"/events", revision, auth, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("klaviyo create event http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func klaviyoEventProperties(settings map[string]any, p ProfileWrite) map[string]any {
	props := map[string]any{
		"postwave_source": "integration_writeback",
	}
	if static, ok := settingAnyMap(settings, "event_properties"); ok {
		for k, v := range static {
			if key := strings.TrimSpace(k); key != "" {
				props[key] = v
			}
		}
	}
	if static, ok := settingAnyMap(settings, "klaviyo_event_properties"); ok {
		for k, v := range static {
			if key := strings.TrimSpace(k); key != "" {
				props[key] = v
			}
		}
	}
	if len(p.Tags) > 0 {
		props["postwave_tags"] = cleanStrings(p.Tags)
	}
	if len(p.Fields) > 0 {
		fields := map[string]string{}
		for k, v := range p.Fields {
			fields[k] = v
		}
		props["postwave_fields"] = fields
	}
	return props
}

func settingAnyMap(settings map[string]any, key string) (map[string]any, bool) {
	if settings == nil {
		return nil, false
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return nil, false
	}
	switch typed := v.(type) {
	case map[string]any:
		return typed, true
	case map[string]string:
		out := make(map[string]any, len(typed))
		for k, val := range typed {
			out[k] = val
		}
		return out, true
	default:
		return nil, false
	}
}

func (a KlaviyoWritebackAdapter) do(ctx context.Context, method, endpoint, revision, auth string, payload []byte) (*http.Response, []byte, error) {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Accept", "application/vnd.api+json")
	req.Header.Set("revision", revision)
	if payload != nil {
		req.Header.Set("Content-Type", "application/vnd.api+json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("klaviyo rate limited (429); retry after %s", resp.Header.Get("Retry-After"))
	}
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, bodyBytes, nil
}
