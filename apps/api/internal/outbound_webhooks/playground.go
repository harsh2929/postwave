// SPDX-License-Identifier: AGPL-3.0-only
//
// playground.go — webhook testing playground.
//
// The legacy /test endpoint fires a single sentinel `webhook.test`
// event with a fixed payload. The playground extends that with:
//
//   * GET  /api/v1/outbound-webhooks/playground/events
//          → catalog of every event type the operator can fire,
//          with a sample payload per event.
//   * POST /api/v1/outbound-webhooks/{id}/playground/fire
//          → fire a chosen event_type with a custom payload. The
//          response carries a safe request envelope (URL, headers,
//          signature, body) + the upstream response (status, body
//          preview, latency). Long-lived receiver credentials are
//          redacted before the response leaves the API.
//
// Mounted alongside the existing /test endpoint so the dashboard
// can offer both surfaces:
//   - "Send test event" (one-click, sentinel) → existing /test
//   - "Open playground" (rich, copy-paste-able) → these endpoints

package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountPlaygroundRoutes registers the two playground endpoints.
// Caller wires this alongside MountRoutes; we keep them separate so
// a deployment can disable the playground via routing (some
// operators consider arbitrary outbound POSTs from the API a
// security tradeoff worth gating per environment).
func (d *Deps) MountPlaygroundRoutes(r chi.Router) {
	if d == nil {
		return
	}
	// A custom role's additive admin grant is not enough to originate live
	// receiver traffic. This route requires an exact admin API key or the
	// effective (view-as-aware) owner/admin dashboard role promised by OpenAPI.
	requireAdmin := apikeys.RequireExactTenantAdmin
	r.With(ProtectPlaygroundResponses, requireAdmin).
		Get("/api/v1/outbound-webhooks/playground/events", d.PlaygroundEvents)
	r.With(ProtectPlaygroundResponses, requireAdmin).
		Post("/api/v1/outbound-webhooks/{id}/playground/fire", d.governedPlaygroundFire)
	r.With(ProtectPlaygroundResponses, requireAdmin).
		Get("/api/v1/outbound-webhooks/playground/fires/{fire_id}", d.GetPlaygroundFire)
}

const (
	// Every caller shares the tenant budget; API keys also receive a per-key
	// budget in addition to any configured global limit.
	PlaygroundTenantRateLimitPerMinute = 10
	PlaygroundAPIKeyRateLimitPerMinute = 10
	PlaygroundMaxConcurrentPerTenant   = 2
)

func (d *Deps) governedPlaygroundFire(w http.ResponseWriter, r *http.Request) {
	handler := http.Handler(http.HandlerFunc(d.PlaygroundFire))
	if d == nil || d.PlaygroundConcurrencyLimit == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"playground_concurrency_limit_unavailable",
			"webhook simulator concurrency protection is unavailable",
		))
		return
	}
	handler = d.PlaygroundConcurrencyLimit(handler)
	if playgroundRateAdmitted(r.Context()) {
		handler.ServeHTTP(w, r)
		return
	}
	servePlaygroundRateAdmission(
		w, r,
		d.PlaygroundTenantRateLimit,
		d.PlaygroundAPIKeyRateLimit,
		handler,
	)
}

// HandlerOwnedPlaygroundFireReplay selects the exact external-effect route.
// The handler persists an encrypted durable receipt before/after dispatch, so
// the generic plaintext response cache must not own this operation.
func HandlerOwnedPlaygroundFireReplay(r *http.Request, _ []byte) bool {
	if r == nil || r.Method != http.MethodPost || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.EscapedPath(), "/")
	const prefix = "/api/v1/outbound-webhooks/"
	return strings.HasPrefix(path, prefix) &&
		strings.HasSuffix(path, "/playground/fire") &&
		strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/playground/fire") != ""
}

// PlaygroundReplayBodyLimit bounds the exact bytes retained for request
// equivalence before the handler decodes them.
func PlaygroundReplayBodyLimit(r *http.Request) int64 {
	if HandlerOwnedPlaygroundFireReplay(r, nil) {
		return playgroundJSONMaxBodyBytes
	}
	return 0
}

// PlaygroundEvents GET /api/v1/outbound-webhooks/playground/events.
// Returns the catalog of event types + a representative sample
// payload per event so the operator can see what their handler
// will receive without firing.
func (d *Deps) PlaygroundEvents(w http.ResponseWriter, r *http.Request) {
	out := make([]map[string]any, 0, len(AllowedEvents))
	for _, e := range AllowedEvents {
		out = append(out, map[string]any{
			"event_type":     e,
			"sample_payload": SamplePayloadFor(e),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

// playgroundFireInput is the POST body.
type playgroundFireInput struct {
	// FireID is minted once by the caller and retained through cancellation.
	// Every receiver dispatch is fenced by this durable, queryable identity.
	FireID                       string
	EventType                    string
	ExpectedWebhookConfigVersion *int64
	// Payload is the JSON object the operator wants in
	// event.data. When omitted, the sample payload for the event
	// is used.
	Payload         map[string]any
	PayloadProvided bool
}

var (
	errExpectedWebhookConfigVersionRequired = errors.New("outbound_webhooks: expected webhook config version required")
	errExpectedWebhookConfigVersionInvalid  = errors.New("outbound_webhooks: expected webhook config version invalid")
	errPlaygroundWebhookChanged             = errors.New("outbound_webhooks: webhook changed since confirmation")
)

func validateExpectedPlaygroundConfigVersion(expected *int64) (int64, error) {
	if expected == nil {
		return 0, errExpectedWebhookConfigVersionRequired
	}
	if *expected < 1 || *expected > MaxWebhookConfigVersion {
		return 0, errExpectedWebhookConfigVersionInvalid
	}
	return *expected, nil
}

// playgroundFireResponse carries an inspectable request envelope back to the
// dashboard. Receiver-auth credentials are replaced with explicit redaction
// markers; the request-bound Moosewave signature remains available for handler
// verification.
type playgroundFireResponse struct {
	FireID                string            `json:"fire_id"`
	EventID               string            `json:"event_id"`
	DeliveryID            string            `json:"delivery_id"`
	URL                   string            `json:"url"`
	Method                string            `json:"method"`
	Headers               map[string]string `json:"headers"`
	RedactedHeaderCount   int               `json:"redacted_header_count,omitempty"`
	RedactedResponseCount int               `json:"redacted_response_count,omitempty"`
	RedactedURLCount      int               `json:"redacted_url_count,omitempty"`
	RedactedBodyCount     int               `json:"redacted_body_count,omitempty"`
	BodyJSON              json.RawMessage   `json:"body"`
	Signature             string            `json:"signature"`
	RequestedAt           string            `json:"requested_at"`
	StatusCode            int               `json:"status_code"`
	ResponseBody          string            `json:"response_body"`
	LatencyMs             int64             `json:"latency_ms"`
	Error                 string            `json:"error,omitempty"`
	Filtered              bool              `json:"filtered,omitempty"`
	Outcome               string            `json:"outcome"`
	Ambiguous             bool              `json:"ambiguous"`
	ResponseBodyTruncated bool              `json:"response_body_truncated"`
}

const playgroundRedactedValue = "[REDACTED]"

var playgroundCredentialTextPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:bearer|basic|digest|token)\s+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)\b(?:ghp_|github_pat_|xox[bpa]-|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|glpat-|npm_)[A-Za-z0-9._~-]+`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b`),
	regexp.MustCompile(`(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|session[_-]?token|auth(?:orization)?|token|secret|credential|cookie|signature|hmac)\s*[:=]\s*["']?[^\s&"',;}]+`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`),
}

func sensitivePlaygroundHeaderName(name string) bool {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == strings.ToLower(SignatureHeader) || normalized == "postwave-signature" {
		return false
	}
	switch normalized {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "authentication-info", "sig":
		return true
	}
	compact := strings.NewReplacer("_", "-", ".", "-", " ", "-").Replace(normalized)
	if strings.Contains(compact, "api-key") || strings.Contains(compact, "apikey") {
		return true
	}
	joined := strings.ReplaceAll(compact, "-", "")
	for _, marker := range []string{
		"authorization", "authentication", "authtoken", "accesstoken",
		"refreshtoken", "sessiontoken", "clientsecret", "apikey", "password",
		"credential", "cookie", "signature", "hmac",
	} {
		if strings.Contains(joined, marker) {
			return true
		}
	}
	parts := strings.FieldsFunc(compact, func(r rune) bool {
		return r < 'a' || r > 'z'
	})
	for _, part := range parts {
		switch part {
		case "auth", "authorization", "token", "secret", "password", "credential", "cookie", "signature", "hmac":
			return true
		}
	}
	return false
}

func credentialLikePlaygroundValue(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	for _, prefix := range []string{
		"bearer ", "basic ", "digest ", "token ", "ghp_", "github_pat_",
		"xoxb-", "xoxp-", "xoxa-", "sk_live_", "sk_test_", "rk_live_", "rk_test_",
		"whsec_", "glpat-", "npm_", "akia", "asia",
		"-----begin private key-----", "-----begin rsa private key-----",
	} {
		if strings.HasPrefix(normalized, prefix) {
			return true
		}
	}
	for _, marker := range []string{
		"api_key=", "api-key=", "access_token=", "refresh_token=",
		"client_secret=", "password=", "session_token=", "token=", "secret=",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return strings.HasPrefix(normalized, "eyj") && strings.Count(normalized, ".") == 2
}

func redactCredentialLikePlaygroundText(value string) (string, int) {
	redacted := 0
	for _, pattern := range playgroundCredentialTextPatterns {
		value = pattern.ReplaceAllStringFunc(value, func(string) string {
			redacted++
			return playgroundRedactedValue
		})
	}
	return value, redacted
}

func redactInspectablePlaygroundText(value string, auth *AuthConfig) (string, int) {
	value, exactRedactions := redactPlaygroundCredentialText(value, auth)
	value, shapeRedactions := redactCredentialLikePlaygroundText(value)
	return value, exactRedactions + shapeRedactions
}

func inspectablePlaygroundHeaders(base map[string]string, auth *AuthConfig) (map[string]string, int) {
	out := make(map[string]string, len(base)+1)
	redacted := map[string]struct{}{}
	put := func(name, value string, forceRedaction bool) {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" {
			return
		}
		if len(canonical) > playgroundMaxInspectableHeaderNameBytes {
			canonical = "X-Postwave-Oversized-Header"
			forceRedaction = true
		}
		_, valueRedactions := redactInspectablePlaygroundText(value, auth)
		if forceRedaction || valueRedactions > 0 || sensitivePlaygroundHeaderName(canonical) || credentialLikePlaygroundValue(value) {
			out[canonical] = playgroundRedactedValue
			redacted[strings.ToLower(canonical)] = struct{}{}
			return
		}
		out[canonical] = boundPlaygroundInspectableText(value, playgroundMaxInspectableTextBytes)
	}
	for name, value := range base {
		put(name, value, false)
	}
	if auth != nil {
		if auth.BearerToken != "" {
			put("Authorization", "", true)
		}
		// Every configured custom auth header is credential-bearing, even when
		// its name looks innocuous. Never put its live value in this map.
		for name := range auth.Headers {
			put(name, "", true)
		}
	}
	return out, len(redacted)
}

func inspectablePlaygroundURL(raw string, auth *AuthConfig) (string, int) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		if credentialLikePlaygroundValue(raw) {
			return playgroundRedactedValue, 1
		}
		return boundPlaygroundInspectableText(raw, playgroundMaxInspectableURLBytes), 0
	}
	redacted := 0
	if parsed.User != nil {
		parsed.User = url.UserPassword(playgroundRedactedValue, playgroundRedactedValue)
		redacted++
	}
	query := parsed.Query()
	for name, values := range query {
		sensitive := sensitivePlaygroundHeaderName(name)
		if !sensitive {
			for _, value := range values {
				_, valueRedactions := redactInspectablePlaygroundText(value, auth)
				if valueRedactions > 0 || credentialLikePlaygroundValue(value) {
					sensitive = true
					break
				}
			}
		}
		if sensitive {
			query.Set(name, playgroundRedactedValue)
			redacted++
		}
	}
	parsed.RawQuery = query.Encode()
	if parsed.Path != "" {
		if safePath, pathRedactions := redactInspectablePlaygroundText(parsed.Path, auth); pathRedactions > 0 {
			parsed.Path = safePath
			redacted += pathRedactions
		}
	}
	if parsed.Fragment != "" {
		_, valueRedactions := redactInspectablePlaygroundText(parsed.Fragment, auth)
		fragmentName := strings.SplitN(parsed.Fragment, "=", 2)[0]
		if valueRedactions > 0 || credentialLikePlaygroundValue(parsed.Fragment) || sensitivePlaygroundHeaderName(fragmentName) {
			parsed.Fragment = playgroundRedactedValue
			redacted += max(1, valueRedactions)
		}
	}
	return boundPlaygroundInspectableText(parsed.String(), playgroundMaxInspectableURLBytes), redacted
}

func boundPlaygroundInspectableText(value string, maxBytes int) string {
	if maxBytes < 1 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func boundPlaygroundFireResponse(response playgroundFireResponse) playgroundFireResponse {
	response.FireID = boundPlaygroundInspectableText(response.FireID, 64)
	response.EventID = boundPlaygroundInspectableText(response.EventID, 64)
	response.DeliveryID = boundPlaygroundInspectableText(response.DeliveryID, 128)
	response.URL = boundPlaygroundInspectableText(response.URL, playgroundMaxInspectableURLBytes)
	response.Method = boundPlaygroundInspectableText(response.Method, 16)
	response.Signature = boundPlaygroundInspectableText(response.Signature, playgroundMaxInspectableTextBytes)
	response.RequestedAt = boundPlaygroundInspectableText(response.RequestedAt, 64)
	if response.ResponseBodyTruncated || len(response.ResponseBody) > playgroundMaxInspectableTextBytes {
		response.ResponseBodyTruncated = true
		// Never expose a partial receiver body. Besides avoiding misleading
		// inspection output, the discarded suffix could contain a credential
		// that makes the retained prefix unsafe to display in isolation.
		response.ResponseBody = ""
	} else {
		response.ResponseBody = boundPlaygroundInspectableText(
			response.ResponseBody,
			playgroundMaxInspectableTextBytes,
		)
	}
	response.Error = boundPlaygroundInspectableText(response.Error, playgroundMaxInspectableTextBytes)
	response.Outcome = boundPlaygroundInspectableText(response.Outcome, 64)

	if len(response.BodyJSON) > playgroundMaxPreparedBodyBytes {
		response.BodyJSON = json.RawMessage(`{"_postwave_inspection":"withheld: bounded redaction representation exceeded 524288 bytes"}`)
	}
	if len(response.Headers) > 0 {
		names := make([]string, 0, len(response.Headers))
		for name := range response.Headers {
			names = append(names, name)
		}
		sort.Strings(names)
		if len(names) > playgroundMaxInspectableHeaders {
			names = names[:playgroundMaxInspectableHeaders]
		}
		bounded := make(map[string]string, len(names))
		for _, name := range names {
			boundedName := boundPlaygroundInspectableText(name, playgroundMaxInspectableHeaderNameBytes)
			bounded[boundedName] = boundPlaygroundInspectableText(
				response.Headers[name],
				playgroundMaxInspectableTextBytes,
			)
		}
		response.Headers = bounded
	}
	return response
}

func reservedPlaygroundFireSkeleton(response playgroundFireResponse) playgroundFireResponse {
	response = boundPlaygroundFireResponse(response)
	response.StatusCode = 0
	response.ResponseBody = ""
	response.LatencyMs = 0
	response.Error = ""
	response.Filtered = false
	response.Outcome = ""
	response.Ambiguous = false
	response.ResponseBodyTruncated = false
	return response
}

func playgroundCredentialValues(auth *AuthConfig) []string {
	if auth == nil {
		return nil
	}
	credentials := make([]string, 0, len(auth.Headers)+3)
	credentials = append(credentials, auth.BearerToken, auth.MTLSCertPEM, auth.MTLSKeyPEM)
	for _, credential := range auth.Headers {
		credentials = append(credentials, credential)
	}
	sort.Slice(credentials, func(i, j int) bool { return len(credentials[i]) > len(credentials[j]) })
	unique := credentials[:0]
	seen := map[string]struct{}{}
	for _, credential := range credentials {
		if credential == "" {
			continue
		}
		if _, duplicate := seen[credential]; duplicate {
			continue
		}
		seen[credential] = struct{}{}
		unique = append(unique, credential)
	}
	return unique
}

func redactPlaygroundCredentialText(value string, auth *AuthConfig) (string, int) {
	if value == "" || auth == nil {
		return value, 0
	}
	redacted := 0
	for _, credential := range playgroundCredentialValues(auth) {
		if strings.Contains(value, credential) {
			value = strings.ReplaceAll(value, credential, playgroundRedactedValue)
			redacted++
		}
	}
	return value, redacted
}

// playgroundDestinationSensitiveValues returns the exact encrypted-only URL
// fragments a receiver can trivially echo. The origin is intentionally not in
// this set because it is the public destinationDisplay projection; path,
// query, user-info, and fragment values are write-only capabilities.
func playgroundDestinationSensitiveValues(destination string) []string {
	parsed, err := url.Parse(destination)
	if err != nil {
		return []string{destination}
	}
	values := make([]string, 0, 16)
	seen := map[string]struct{}{}
	addExact := func(value string) {
		if value == "" || value == "/" {
			return
		}
		if _, duplicate := seen[value]; duplicate {
			return
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	addToken := func(value string) {
		// Very short standalone URL atoms are too ambiguous to replace inside
		// arbitrary receiver prose. Their complete path/query representation is
		// still included above, while capability-like atoms remain protected.
		if len(value) >= 4 {
			addExact(value)
		}
	}

	addExact(destination)
	addExact(parsed.RequestURI())
	addExact(parsed.EscapedPath())
	addExact(parsed.Path)
	addExact(parsed.RawQuery)
	if parsed.Fragment != "" {
		addExact("#" + parsed.EscapedFragment())
		addToken(parsed.Fragment)
	}
	for _, path := range []string{parsed.EscapedPath(), parsed.Path} {
		for _, segment := range strings.Split(path, "/") {
			addToken(segment)
		}
	}
	if parsed.User != nil {
		addToken(parsed.User.Username())
		if password, ok := parsed.User.Password(); ok {
			addToken(password)
		}
	}
	for key, entries := range parsed.Query() {
		addToken(key)
		for _, entry := range entries {
			addToken(entry)
		}
	}
	for _, pair := range strings.Split(parsed.RawQuery, "&") {
		rawName, rawValue, found := strings.Cut(pair, "=")
		addToken(rawName)
		if decoded, decodeErr := url.QueryUnescape(rawName); decodeErr == nil {
			addToken(decoded)
		}
		if !found {
			continue
		}
		addToken(rawValue)
		if decoded, decodeErr := url.QueryUnescape(rawValue); decodeErr == nil {
			addToken(decoded)
		}
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return values
}

func redactPlaygroundDestinationText(value, destination string) (string, int) {
	redacted := 0
	for _, sensitive := range playgroundDestinationSensitiveValues(destination) {
		if strings.Contains(value, sensitive) {
			value = strings.ReplaceAll(value, sensitive, playgroundRedactedValue)
			redacted++
		}
	}
	return value, redacted
}

func redactPlaygroundSensitiveScalar(
	value any,
	canonical string,
	auth *AuthConfig,
	destination string,
) (any, int) {
	redacted, count := redactInspectablePlaygroundText(canonical, auth)
	_, destinationCount := redactPlaygroundDestinationText(redacted, destination)
	count += destinationCount
	if count > 0 {
		return playgroundRedactedValue, count
	}
	return value, 0
}

func canonicalPlaygroundJSONScalar(value any) (string, bool) {
	if value == nil {
		return "", false
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", false
		}
		return string(encoded), true
	default:
		return "", false
	}
}

func redactPlaygroundSensitiveData(value any, auth *AuthConfig, destination string) (any, int) {
	switch typed := value.(type) {
	case string:
		redacted, count := redactInspectablePlaygroundText(typed, auth)
		redacted, destinationCount := redactPlaygroundDestinationText(redacted, destination)
		count += destinationCount
		if count > 0 {
			return redacted, count
		}
		if credentialLikePlaygroundValue(typed) {
			return playgroundRedactedValue, 1
		}
		return redacted, count
	case json.Number:
		// Preserve the decoder's exact number spelling. Converting through a
		// float would both lose large-integer precision and change exponent
		// forms before the credential/destination comparison.
		return redactPlaygroundSensitiveScalar(typed, typed.String(), auth, destination)
	case nil:
		return redactPlaygroundSensitiveScalar(nil, "null", auth, destination)
	case []any:
		out := make([]any, len(typed))
		count := 0
		for index, item := range typed {
			redactedItem, itemCount := redactPlaygroundSensitiveData(item, auth, destination)
			out[index] = redactedItem
			count += itemCount
		}
		return out, count
	case map[string]any:
		out := make(map[string]any, len(typed))
		count := 0
		for key, item := range typed {
			redactedKey, keyCount := redactInspectablePlaygroundText(key, auth)
			redactedKey, destinationKeyCount := redactPlaygroundDestinationText(redactedKey, destination)
			keyCount += destinationKeyCount
			count += keyCount
			if sensitivePlaygroundHeaderName(key) {
				out[redactedKey] = playgroundRedactedValue
				count++
				continue
			}
			redactedItem, itemCount := redactPlaygroundSensitiveData(item, auth, destination)
			out[redactedKey] = redactedItem
			count += itemCount
		}
		return out, count
	default:
		if canonical, ok := canonicalPlaygroundJSONScalar(value); ok {
			return redactPlaygroundSensitiveScalar(value, canonical, auth, destination)
		}
		return value, 0
	}
}

func redactPlaygroundCredentialData(value any, auth *AuthConfig) (any, int) {
	return redactPlaygroundSensitiveData(value, auth, "")
}

func redactInspectablePlaygroundResponseText(value string, auth *AuthConfig, destination string) (string, int) {
	var decoded any
	if httpbody.DecodeJSONValue(
		[]byte(value),
		&decoded,
		httpbody.Options{UseNumber: true},
	) == nil {
		redactedValue, redactedCount := redactPlaygroundSensitiveData(decoded, auth, destination)
		if redactedCount > 0 {
			encoded, err := json.Marshal(redactedValue)
			if err == nil {
				return string(encoded), redactedCount
			}
		}
	}
	redacted, count := redactInspectablePlaygroundText(value, auth)
	redacted, destinationCount := redactPlaygroundDestinationText(redacted, destination)
	return redacted, count + destinationCount
}

// PlaygroundFire POST /api/v1/outbound-webhooks/{id}/playground/fire.
func (d *Deps) PlaygroundFire(w http.ResponseWriter, r *http.Request) {
	preparePlaygroundResponse(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	ledger := d.playgroundFireRepository()
	if ledger == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	keyValues := r.Header.Values(idempotency.HeaderName)
	if len(keyValues) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"idempotency_key_required",
			"A single Idempotency-Key is required for a live webhook simulator fire.",
		))
		return
	}
	if len(keyValues) != 1 || !idempotency.ValidKey(keyValues[0]) {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_idempotency_key",
			"Idempotency-Key must be supplied once as 1-255 valid UTF-8 bytes without surrounding whitespace or controls.",
		))
		return
	}
	storageKey, keyOK := idempotency.StorageKeyFromContext(r.Context())
	requestHash, hashOK := idempotency.RequestHashFromContext(r.Context())
	if !keyOK || !hashOK || !strings.HasPrefix(storageKey, "scope-v1:") {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"playground_idempotency_unavailable",
			"durable webhook simulator idempotency is unavailable",
		))
		return
	}

	// Recovery precedes route-parameter and JSON parsing as well as every
	// mutable business validation. A same-key request returns its frozen receipt
	// after catalog/config changes; any changed body maps to the ledger's 422
	// mismatch without allowing malformed input to obscure key reuse.
	existing, err := ledger.RecoverPlaygroundFire(
		r.Context(), t.ID, storageKey, requestHash,
	)
	if err == nil {
		writeExistingPlaygroundFire(w, existing)
		return
	}
	if !errors.Is(err, ErrNotFound) {
		if writePlaygroundLedgerError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	store := d.playgroundRepository()
	if store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUID(id) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "webhook not found"))
		return
	}
	in, decodeErr := decodePlaygroundFireInput(r)
	if decodeErr != nil {
		switch {
		case errors.Is(decodeErr, errPlaygroundDuplicateJSONMember):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"duplicate_json_member",
				"JSON object member names must be unique at every depth.",
			))
		case errors.Is(decodeErr, errPlaygroundExplicitNullPayload):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"payload_null",
				"payload must be a JSON object when provided; omit it to use the catalog sample.",
			))
		case errors.Is(decodeErr, errPlaygroundPayloadTooComplex):
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv(
				"payload_too_complex",
				"payload exceeds the depth, field, node, key, or string limits",
			))
		default:
			httpbody.WriteError(w, decodeErr)
		}
		return
	}
	expectedConfigVersion, versionErr := validateExpectedPlaygroundConfigVersion(
		in.ExpectedWebhookConfigVersion,
	)
	if versionErr != nil {
		switch {
		case errors.Is(versionErr, errExpectedWebhookConfigVersionRequired):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"expected_webhook_config_version_required",
				"expected_webhook_config_version is required",
			))
		case errors.Is(versionErr, errExpectedWebhookConfigVersionInvalid):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"invalid_expected_webhook_config_version",
				"expected_webhook_config_version must be a positive safe integer no greater than 9007199254740991",
			))
		}
		return
	}
	if !validCanonicalUUID(in.FireID) {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_fire_id",
			"fire_id must be a canonical lowercase UUID retained for this logical fire",
		))
		return
	}
	if !IsAllowedEvent(in.EventType) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_event_type",
			"event_type must be one of the AllowedEvents catalog"))
		return
	}
	if !in.PayloadProvided {
		in.Payload = SamplePayloadFor(in.EventType)
	}
	if payloadErr := validatePlaygroundPayload(in.Payload); payloadErr != nil {
		code := "payload_too_complex"
		message := "payload exceeds the depth, field, node, key, or string limits"
		if errors.Is(payloadErr, errPlaygroundPayloadTooLarge) {
			code = "payload_too_large"
			message = "payload exceeds the 262144-byte canonical JSON limit"
		}
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv(code, message))
		return
	}

	now := time.Now().UTC()
	target, err := store.PreparePlaygroundFire(
		r.Context(), t.ID, id, expectedConfigVersion, now,
	)
	if err != nil {
		if errors.Is(err, errPlaygroundWebhookChanged) {
			writeJSON(w, http.StatusConflict, errEnv(
				"webhook_changed",
				"webhook configuration changed after confirmation; review and confirm again",
			))
			return
		}
		if writeTestPreparationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	eventID := playgroundEventID(in.FireID)
	deliveryID := "playground-" + in.FireID
	envelope := map[string]any{
		"event": map[string]any{
			"id":          eventID,
			"type":        in.EventType,
			"occurred_at": now.Format(time.RFC3339),
			"data":        in.Payload,
		},
		"webhook":  map[string]any{"id": target.WebhookID},
		"delivery": map[string]any{"id": deliveryID, "attempt": 1},
	}
	prepared, err := prepareDelivery(target.Config, envelope)
	if err != nil {
		if writeTestPreparationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if len(prepared.Body) > playgroundMaxPreparedBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv(
			"prepared_payload_too_large",
			"the active transform expands this event beyond the 524288-byte simulator delivery limit",
		))
		return
	}
	if prepared.Filtered {
		safeURL, redactedURLCount := inspectablePlaygroundURL(target.DisplayURL, target.Config.AuthConfig)
		safeEnvelope, redactedBodyCount := redactPlaygroundCredentialData(envelope, target.Config.AuthConfig)
		safeBody, marshalErr := json.Marshal(safeEnvelope)
		if marshalErr != nil {
			httperror.WriteInternal(w, d.Logger, marshalErr, r.Context())
			return
		}
		skeleton := reservedPlaygroundFireSkeleton(playgroundFireResponse{
			FireID:            in.FireID,
			EventID:           eventID,
			DeliveryID:        deliveryID,
			URL:               safeURL,
			Method:            http.MethodPost,
			Headers:           map[string]string{},
			BodyJSON:          json.RawMessage(safeBody),
			RequestedAt:       now.Format(time.RFC3339Nano),
			RedactedURLCount:  redactedURLCount,
			RedactedBodyCount: redactedBodyCount,
		})
		reservation, reserveErr := ledger.ReservePlaygroundFire(
			r.Context(),
			playgroundFireReservationInput{
				TenantID:      t.ID,
				StorageKey:    storageKey,
				RequestHash:   requestHash,
				FireID:        in.FireID,
				WebhookID:     id,
				EventType:     in.EventType,
				ConfigVersion: target.ConfigVersion,
				Skeleton:      skeleton,
				AuditMeta:     middleware.AuditMetaFromRequest(r),
			},
		)
		if reserveErr != nil {
			if writePlaygroundLedgerError(w, reserveErr) {
				return
			}
			httperror.WriteInternal(w, d.Logger, reserveErr, r.Context())
			return
		}
		if !reservation.Created {
			writeExistingPlaygroundFire(w, &reservation.Record)
			return
		}
		response := playgroundFireResponse{
			FireID:            in.FireID,
			EventID:           eventID,
			DeliveryID:        deliveryID,
			URL:               safeURL,
			Method:            http.MethodPost,
			Headers:           map[string]string{},
			BodyJSON:          json.RawMessage(safeBody),
			RequestedAt:       now.Format(time.RFC3339Nano),
			StatusCode:        http.StatusNoContent,
			RedactedURLCount:  redactedURLCount,
			RedactedBodyCount: redactedBodyCount,
			Filtered:          true,
			Outcome:           "filtered",
			Ambiguous:         false,
		}
		response = boundPlaygroundFireResponse(response)
		if err := d.completePlaygroundFire(r, t.ID, in.FireID, "filtered", http.StatusNoContent, false, response); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	body := prepared.Body
	signed, err := signWithKeys(target.Keys, now, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	baseHeaders := map[string]string{
		"Content-Type":  "application/json",
		"User-Agent":    "Moosewave-Webhooks/1.0",
		SignatureHeader: signed.Signature,
		KeyIDHeader:     signed.KeyIDs,
		EventHeader:     in.EventType,
		EventIDHeader:   eventID,
		DeliveryHeader:  deliveryID,
		TestHeader:      "true",
	}
	authConfig := target.Config.AuthConfig
	headers, redactedHeaderCount := inspectablePlaygroundHeaders(baseHeaders, authConfig)
	safeSignature, redactedSignatureCount := redactInspectablePlaygroundText(signed.Signature, authConfig)
	safeURL, redactedURLCount := inspectablePlaygroundURL(target.DisplayURL, authConfig)
	var deliveredBody any
	if err := httpbody.DecodeJSONValue(
		body,
		&deliveredBody,
		httpbody.Options{UseNumber: true},
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	safeEnvelope, redactedBodyCount := redactPlaygroundCredentialData(deliveredBody, authConfig)
	safeBody, err := json.Marshal(safeEnvelope)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	skeleton := reservedPlaygroundFireSkeleton(playgroundFireResponse{
		FireID:              in.FireID,
		EventID:             eventID,
		DeliveryID:          deliveryID,
		URL:                 safeURL,
		Method:              http.MethodPost,
		Headers:             headers,
		RedactedHeaderCount: redactedHeaderCount,
		RedactedURLCount:    redactedURLCount,
		RedactedBodyCount:   redactedBodyCount,
		BodyJSON:            json.RawMessage(safeBody),
		Signature:           safeSignature,
		RequestedAt:         now.Format(time.RFC3339Nano),
	})
	reservation, err := ledger.ReservePlaygroundFire(
		r.Context(),
		playgroundFireReservationInput{
			TenantID:      t.ID,
			StorageKey:    storageKey,
			RequestHash:   requestHash,
			FireID:        in.FireID,
			WebhookID:     id,
			EventType:     in.EventType,
			ConfigVersion: target.ConfigVersion,
			Skeleton:      skeleton,
			AuditMeta:     middleware.AuditMetaFromRequest(r),
		},
	)
	if err != nil {
		if writePlaygroundLedgerError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !reservation.Created {
		writeExistingPlaygroundFire(w, &reservation.Record)
		return
	}

	start := time.Now()
	statusCode, respBody, responseTruncated, postErr := d.post(
		r.Context(),
		target.Destination,
		signed.Signature,
		signed.KeyIDs,
		in.EventType,
		eventID,
		deliveryID,
		body,
		authConfig,
	)
	latency := time.Since(start)

	safeResponseBody, redactedResponseCount := redactInspectablePlaygroundResponseText(
		respBody,
		authConfig,
		target.Destination,
	)
	redactedResponseCount += redactedSignatureCount
	outcome := "receiver_responded"
	ambiguous := false
	if statusCode == 0 {
		outcome = "transport_ambiguous"
		ambiguous = true
	}
	resp := playgroundFireResponse{
		FireID:                in.FireID,
		EventID:               eventID,
		DeliveryID:            deliveryID,
		URL:                   safeURL,
		Method:                http.MethodPost,
		Headers:               headers,
		RedactedHeaderCount:   redactedHeaderCount,
		RedactedResponseCount: redactedResponseCount,
		RedactedURLCount:      redactedURLCount,
		RedactedBodyCount:     redactedBodyCount,
		BodyJSON:              json.RawMessage(safeBody),
		Signature:             safeSignature,
		RequestedAt:           now.Format(time.RFC3339Nano),
		StatusCode:            statusCode,
		ResponseBody:          safeResponseBody,
		LatencyMs:             latency.Milliseconds(),
		Outcome:               outcome,
		Ambiguous:             ambiguous,
		ResponseBodyTruncated: responseTruncated,
	}
	if postErr != nil {
		var errorRedactions int
		safeError, destinationErrorRedactions := redactPlaygroundDestinationText(
			postErr.Error(),
			target.Destination,
		)
		resp.Error, errorRedactions = redactInspectablePlaygroundText(safeError, authConfig)
		resp.RedactedResponseCount += errorRedactions + destinationErrorRedactions
	}
	resp = boundPlaygroundFireResponse(resp)
	if err := d.completePlaygroundFire(
		r, t.ID, in.FireID, outcome, statusCode, resp.ResponseBodyTruncated, resp,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func playgroundEventID(fireID string) string {
	return uuid.NewSHA1(
		uuid.NameSpaceOID,
		[]byte("postwave:webhook-playground:event:v1\x00"+fireID),
	).String()
}

func (d *Deps) completePlaygroundFire(
	r *http.Request,
	tenantID, fireID, outcome string,
	statusCode int,
	responseTruncated bool,
	response playgroundFireResponse,
) error {
	ledger := d.playgroundFireRepository()
	if ledger == nil {
		return errors.New("outbound_webhooks: playground fire ledger unavailable")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	return ledger.CompletePlaygroundFire(
		ctx, tenantID, fireID, outcome, statusCode, responseTruncated, response,
	)
}

func writeExistingPlaygroundFire(w http.ResponseWriter, record *playgroundFireRecord) {
	if record == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"playground_fire_receipt_unavailable", "webhook simulator receipt is unavailable",
		))
		return
	}
	if record.State == "receipt_expired" {
		writeJSON(w, http.StatusGone, map[string]any{
			"error": map[string]string{
				"code":    "playground_fire_receipt_expired",
				"message": "This fire identity remains consumed, but its private inspection receipt has expired. Do not redispatch it.",
			},
			"fire_id": boundPlaygroundInspectableText(record.FireID, 64),
			"state":   "receipt_expired",
		})
		return
	}
	if record.State == "pending" || record.Response == nil {
		w.Header().Set("Retry-After", "5")
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]string{
				"code":    "playground_fire_outcome_pending",
				"message": "This fire may have crossed the receiver boundary. Reconcile fire_id before creating a new attempt.",
			},
			"fire_id": boundPlaygroundInspectableText(record.FireID, 64),
			"state":   boundPlaygroundInspectableText(record.State, 64),
		})
		return
	}
	w.Header().Set(idempotency.ReplayedHeaderName, "true")
	response := boundPlaygroundFireResponse(*record.Response)
	writeJSON(w, http.StatusOK, response)
}

func writePlaygroundLedgerError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, errPlaygroundIdempotencyConflict):
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"idempotency_key_request_mismatch",
			"Idempotency-Key was reused for a different simulator request body.",
		))
	case errors.Is(err, errPlaygroundFireIDConflict):
		writeJSON(w, http.StatusConflict, errEnv(
			"fire_id_conflict",
			"fire_id is already bound to another simulator request; retain the original key or mint a new fire identity.",
		))
	case errors.Is(err, errPlaygroundWebhookChanged):
		writeJSON(w, http.StatusConflict, errEnv(
			"webhook_changed",
			"webhook configuration changed after confirmation; review and confirm again",
		))
	default:
		return false
	}
	return true
}

// GetPlaygroundFire reconciles a caller-known fire identity without contacting
// the receiver. A 404 is only a point-in-time absence and never authorizes a
// replacement identity: the original POST may still arrive or reserve after a
// cancellation. Pending likewise means do not retry with a new identity;
// terminal states expose only bounded metadata, never the encrypted inspection
// payload.
func (d *Deps) GetPlaygroundFire(w http.ResponseWriter, r *http.Request) {
	preparePlaygroundResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	fireID := chi.URLParam(r, "fire_id")
	if !validCanonicalUUID(fireID) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "fire receipt not found"))
		return
	}
	ledger := d.playgroundFireRepository()
	if ledger == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	record, err := ledger.GetPlaygroundFireRecord(r.Context(), tenant.ID, fireID)
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "fire receipt not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"fire_id":                 boundPlaygroundInspectableText(record.FireID, 64),
		"webhook_id":              boundPlaygroundInspectableText(record.WebhookID, 64),
		"event_type":              boundPlaygroundInspectableText(record.EventType, 200),
		"delivery_id":             boundPlaygroundInspectableText(record.DeliveryID, 128),
		"state":                   boundPlaygroundInspectableText(record.State, 64),
		"outcome":                 boundPlaygroundInspectableText(record.Outcome, 64),
		"receiver_status_code":    record.ReceiverStatusCode,
		"response_body_truncated": record.ResponseBodyTruncated,
		"created_at":              record.CreatedAt.UTC().Format(time.RFC3339Nano),
		"completed_at": func() any {
			if record.CompletedAt == nil {
				return nil
			}
			return record.CompletedAt.UTC().Format(time.RFC3339Nano)
		}(),
	})
}

// SamplePayloadFor returns a representative sample payload for the
// given event type. Used by both /events (catalog) and /fire
// (default-fill).
//
// The samples are designed to look like REAL data a handler would
// receive, so the operator can write their parser against this
// shape and know it'll match production.
func SamplePayloadFor(eventType string) map[string]any {
	switch eventType {
	// D12#5: keyed to AllowedEvents (outbound_webhooks.go). "subscriber.added"
	// is the emitted name; created/updated kept for back-compat with /fire.
	case "subscriber.added", "subscriber.created", "subscriber.updated":
		return map[string]any{
			"id":            "sub_01HXYZ123456789",
			"email":         "alice@example.com",
			"status":        "subscribed",
			"name":          "Alice Example",
			"custom_fields": map[string]any{"plan": "pro", "country": "US"},
			"created_at":    "2026-05-23T10:00:00Z",
		}
	case "subscriber.removed":
		return map[string]any{
			"id":         "sub_01HXYZ123456789",
			"email":      "alice@example.com",
			"removed_at": "2026-05-23T10:05:00Z",
		}
	case "approval.requested":
		return map[string]any{
			"approval_id":  "apr_01HXYZ222222",
			"resource":     "campaign",
			"resource_id":  "cmp_01HXYZ987654321",
			"requested_by": "alice@example.com",
			"status":       "pending",
			"requested_at": "2026-05-23T09:00:00Z",
		}
	case "approval.decided":
		return map[string]any{
			"approval_id": "apr_01HXYZ222222",
			"resource":    "campaign",
			"resource_id": "cmp_01HXYZ987654321",
			"decision":    "approved",
			"decided_by":  "boss@example.com",
			"decided_at":  "2026-05-23T09:05:00Z",
		}
	case "audit.created":
		return map[string]any{
			"id":          "aud_01HXYZ333333",
			"action":      "campaign.sent",
			"actor_email": "alice@example.com",
			"actor_type":  "user",
			"target_type": "campaign",
			"target_id":   "cmp_01HXYZ987654321",
			"created_at":  "2026-05-23T09:00:01Z",
		}
	case "bounce.received":
		return map[string]any{
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"campaign_id":      "cmp_01HXYZ987654321",
			"bounce_class":     "hard_invalid",
			"diagnostic_code":  "5.1.1 The email account that you tried to reach does not exist",
			"received_at":      "2026-05-23T09:02:00Z",
		}
	case "list_health.degraded":
		return map[string]any{
			"tenant_id":        "tenant_01HXYZ111111",
			"account_score":    54,
			"grade":            "D",
			"model_version":    "v2",
			"sample_qualified": true,
			"sample_size":      12481,
			"window_days":      30,
			"breaches": []map[string]any{{
				"metric": "bounce_rate", "observed": 0.061,
				"threshold": 0.05, "severity": "critical",
			}},
			"opens_machine_pct":    0.18,
			"incident_snapshot_id": 7341,
		}
	case EventEmailBounced, EventEmailComplained, EventEmailDelivered:
		// Keyed on email_id, not on a subscriber: a transactional recipient
		// need not be a subscriber at all, and the question this answers is
		// "what happened to THIS message".
		return map[string]any{
			"email_id":            "eml_01HXYZ555555555",
			"provider_message_id": "0100018f2c1a0000-9a1f-4c6f-8f3e-0f0a1b2c3d4e-000000",
			"recipient":           "alice@example.com",
			"outcome":             strings.TrimPrefix(eventType, "email."),
			"reason":              "5.1.1 The email account that you tried to reach does not exist",
			"esp":                 "ses",
			"occurred_at":         "2026-05-23T09:02:00Z",
		}
	case EventListSubscriberAdded:
		return map[string]any{
			"list_id":          "lst_01HXYZ444444",
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"at":               "2026-05-23T10:00:00Z",
		}
	case EventAssuranceRunCompleted, EventAssuranceRunBlocked:
		decision := "allow"
		blockingFindings := 0
		if eventType == EventAssuranceRunBlocked {
			decision = "block"
			blockingFindings = 2
		}
		return map[string]any{
			"run_id":                 "run_01HXYZ666666",
			"campaign_id":            "cmp_01HXYZ987654321",
			"content_revision_id":    "rev_01HXYZ777777",
			"send_plan_id":           "plan_01HXYZ888888",
			"profile":                "full",
			"state":                  "complete",
			"decision":               decision,
			"blocking_finding_count": blockingFindings,
			"finding_count":          4,
		}
	case "subscriber.unsubscribed":
		return map[string]any{
			"id":              "sub_01HXYZ123456789",
			"email":           "alice@example.com",
			"unsubscribed_at": "2026-05-23T10:05:00Z",
			"reason":          "user_request",
		}
	case "campaign.sent":
		return map[string]any{
			"campaign_id":      "cmp_01HXYZ987654321",
			"subject":          "Your Moosewave digest",
			"recipients_total": 1234,
			"sent_at":          "2026-05-23T09:00:00Z",
		}
	case "campaign.opened", "campaign.clicked":
		return map[string]any{
			"campaign_id":      "cmp_01HXYZ987654321",
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"at":               "2026-05-23T10:02:00Z",
			"user_agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		}
	case "campaign.bounced":
		return map[string]any{
			"campaign_id":      "cmp_01HXYZ987654321",
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"bounce_class":     "hard_invalid",
			"diagnostic_code":  "5.1.1 The email account that you tried to reach does not exist",
		}
	case "campaign.complained":
		return map[string]any{
			"campaign_id":      "cmp_01HXYZ987654321",
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"at":               "2026-05-23T10:10:00Z",
		}
	case "form.submitted", "form.confirmed":
		return map[string]any{
			"form_id":          "frm_01HXYZ55555",
			"subscriber_id":    "sub_01HXYZ123456789",
			"subscriber_email": "alice@example.com",
			"fields":           map[string]any{"source": "blog", "utm_campaign": "spring"},
		}
	default:
		return map[string]any{
			"note": "no sample payload registered for " + eventType,
		}
	}
}

// keep imports referenced.
var _ = context.Background
