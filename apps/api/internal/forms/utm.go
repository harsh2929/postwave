// UTM capture for the public form submit endpoint. Lifts the standard
// utm_* (+ ref) keys off the request URL and a body fallback bag, then
// returns a clipped map suitable to JSON-encode into
// form_submissions.metadata.

package forms

import (
	"net/http"
	"net/url"
	"strings"
)

// utmKeys is the closed set of attribution keys we lift off the public
// submit URL (and the optional body fallback) and stash on the
// submission's metadata column. Anything outside this set is ignored on
// purpose so we don't accidentally pull in giant query strings.
var utmKeys = []string{
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"ref",
}

// ExtractUTMs pulls the known attribution keys from a query-style values
// bag (and merges in any matching keys from the body). Empty strings are
// dropped. The result is suitable to be JSON-encoded straight into the
// form_submissions.metadata jsonb column.
func ExtractUTMs(query url.Values, body map[string]string) map[string]string {
	out := map[string]string{}
	for _, k := range utmKeys {
		if v := strings.TrimSpace(query.Get(k)); v != "" {
			out[k] = clipUTM(v)
		}
	}
	if body != nil {
		for _, k := range utmKeys {
			if _, already := out[k]; already {
				continue
			}
			if v := strings.TrimSpace(body[k]); v != "" {
				out[k] = clipUTM(v)
			}
		}
	}
	return out
}

// ExtractUTMsFromRequest is a convenience wrapper that reads from
// r.URL.Query and an optional body-field map.
func ExtractUTMsFromRequest(r *http.Request, body map[string]string) map[string]string {
	if r == nil {
		return ExtractUTMs(nil, body)
	}
	return ExtractUTMs(r.URL.Query(), body)
}

// clipUTM bounds the captured value so a hostile query string cannot
// bloat the submission row. 256 chars is well above legitimate utm_*
// lengths.
func clipUTM(s string) string {
	const max = 256
	if len(s) > max {
		return s[:max]
	}
	return s
}
