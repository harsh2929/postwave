// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared HTTP helpers for the store adapters: a small JSON request executor
// plus id/email rendering utilities. Kept in one file so each adapter stays a
// thin provider-specific wrapper.

package store_adapters

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// maxRespBytes caps how much of a provider response we read into memory. DSAR
// customer payloads are small; this guards against a misbehaving/huge body.
const maxRespBytes = 1 << 20 // 1 MiB

// doJSON executes req, decodes the JSON body into out (when non-nil), and
// always returns the decoded body as a generic map for the audit receipt. A
// non-2xx response is an error carrying the status so the orchestrator records
// a per-store "error" outcome. out may be nil when the caller only needs the
// generic map (e.g. DELETE responses).
func doJSON(client *http.Client, req *http.Request, out any) (map[string]any, error) {
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes))
	if err != nil {
		return nil, err
	}
	// Always attempt the generic decode for the receipt; ignore errors so a
	// non-JSON 204 still yields a usable (empty) map.
	raw := map[string]any{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &raw)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return raw, fmt.Errorf("provider returned status %d", resp.StatusCode)
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return raw, fmt.Errorf("decode provider response: %w", err)
		}
	}
	return raw, nil
}

// queryEscape URL-encodes a query value (email / filter term).
func queryEscape(s string) string {
	return url.QueryEscape(s)
}

// stringifyID renders a provider id that may arrive as a JSON number or string
// into a stable string. Returns "" for nil.
func stringifyID(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return x.String()
	case int64:
		return strconv.FormatInt(x, 10)
	default:
		return fmt.Sprintf("%v", v)
	}
}
