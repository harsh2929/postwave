// SPDX-License-Identifier: AGPL-3.0-only

package service_suite

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Optional preserves the distinction PATCH needs between an omitted member,
// an explicit JSON null, and a concrete value. Pointer fields do not preserve
// that distinction when encoding/json decodes null.
type Optional[T any] struct {
	Present bool
	Null    bool
	Value   T
}

func (o *Optional[T]) UnmarshalJSON(raw []byte) error {
	o.Present = true
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		o.Null = true
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&o.Value); err != nil {
		return err
	}
	return nil
}

// HubConfigPut is deliberately separate from the response shape. PUT is a
// complete replacement: every editable member is required, while server-owned
// tenant/timestamp members are rejected by strict JSON decoding.
type HubConfigPut struct {
	Status                 *string         `json:"status"`
	Storefronts            *[]any          `json:"storefronts"`
	ContentBlocks          *[]any          `json:"content_blocks"`
	PersonalizationRules   *map[string]any `json:"personalization_rules"`
	SupportSettings        *map[string]any `json:"support_settings"`
	OrderHistoryEnabled    *bool           `json:"order_history_enabled"`
	FavoritesEnabled       *bool           `json:"favorites_enabled"`
	CouponsEnabled         *bool           `json:"coupons_enabled"`
	RecommendationsEnabled *bool           `json:"recommendations_enabled"`
	CustomerAgentEnabled   *bool           `json:"customer_agent_enabled"`
	Styling                *map[string]any `json:"styling"`
	Metadata               *map[string]any `json:"metadata"`
}

type ChannelCreate struct {
	Name          string         `json:"name"`
	ChannelType   string         `json:"channel_type"`
	Status        string         `json:"status"`
	ExternalRef   string         `json:"external_ref"`
	RoutingRules  map[string]any `json:"routing_rules"`
	AgentSettings map[string]any `json:"agent_settings"`
	Metadata      map[string]any `json:"metadata"`
}

type ConversationCreate struct {
	ChannelID      string   `json:"channel_id,omitempty"`
	ChannelType    string   `json:"channel_type"`
	SubscriberID   string   `json:"subscriber_id,omitempty"`
	RequesterEmail string   `json:"requester_email,omitempty"`
	RequesterPhone string   `json:"requester_phone,omitempty"`
	RequesterName  string   `json:"requester_name,omitempty"`
	Subject        string   `json:"subject,omitempty"`
	Priority       string   `json:"priority"`
	Tags           []string `json:"tags"`
}

type TicketCreate struct {
	ConversationID string         `json:"conversation_id,omitempty"`
	Title          string         `json:"title"`
	Status         string         `json:"status"`
	Priority       string         `json:"priority"`
	SourceChannel  string         `json:"source_channel"`
	DueAt          *time.Time     `json:"due_at,omitempty"`
	Metadata       map[string]any `json:"metadata"`
}

type ViewCreate struct {
	Name       string         `json:"name"`
	Visibility string         `json:"visibility"`
	Filters    map[string]any `json:"filters"`
	Sort       map[string]any `json:"sort"`
	Status     string         `json:"status"`
}

type MacroCreate struct {
	Name         string         `json:"name"`
	Body         string         `json:"body"`
	ChannelTypes []string       `json:"channel_types"`
	Tags         []string       `json:"tags"`
	Status       string         `json:"status"`
	Metadata     map[string]any `json:"metadata"`
}

func (in HubConfigPut) ValidateAndBuild() (HubConfig, ValidationResult) {
	missing := make([]string, 0, 12)
	if in.Status == nil {
		missing = append(missing, "status")
	}
	if in.Storefronts == nil {
		missing = append(missing, "storefronts")
	}
	if in.ContentBlocks == nil {
		missing = append(missing, "content_blocks")
	}
	if in.PersonalizationRules == nil {
		missing = append(missing, "personalization_rules")
	}
	if in.SupportSettings == nil {
		missing = append(missing, "support_settings")
	}
	if in.OrderHistoryEnabled == nil {
		missing = append(missing, "order_history_enabled")
	}
	if in.FavoritesEnabled == nil {
		missing = append(missing, "favorites_enabled")
	}
	if in.CouponsEnabled == nil {
		missing = append(missing, "coupons_enabled")
	}
	if in.RecommendationsEnabled == nil {
		missing = append(missing, "recommendations_enabled")
	}
	if in.CustomerAgentEnabled == nil {
		missing = append(missing, "customer_agent_enabled")
	}
	if in.Styling == nil {
		missing = append(missing, "styling")
	}
	if in.Metadata == nil {
		missing = append(missing, "metadata")
	}
	if len(missing) != 0 {
		return HubConfig{}, ValidationResult{Valid: false, Errors: []string{
			"PUT requires a complete replacement; missing: " + strings.Join(missing, ", "),
		}}
	}
	out := HubConfig{
		Status: *in.Status, Storefronts: *in.Storefronts, ContentBlocks: *in.ContentBlocks,
		PersonalizationRules: *in.PersonalizationRules, SupportSettings: *in.SupportSettings,
		OrderHistoryEnabled: *in.OrderHistoryEnabled, FavoritesEnabled: *in.FavoritesEnabled,
		CouponsEnabled: *in.CouponsEnabled, RecommendationsEnabled: *in.RecommendationsEnabled,
		CustomerAgentEnabled: *in.CustomerAgentEnabled, Styling: *in.Styling, Metadata: *in.Metadata,
	}
	return out, ValidateConfig(out)
}

type ChannelPatch struct {
	Name          Optional[string]         `json:"name"`
	ChannelType   Optional[string]         `json:"channel_type"`
	Status        Optional[string]         `json:"status"`
	ExternalRef   Optional[string]         `json:"external_ref"`
	RoutingRules  Optional[map[string]any] `json:"routing_rules"`
	AgentSettings Optional[map[string]any] `json:"agent_settings"`
	Metadata      Optional[map[string]any] `json:"metadata"`
}

func (in ChannelPatch) empty() bool {
	return !in.Name.Present && !in.ChannelType.Present && !in.Status.Present && !in.ExternalRef.Present &&
		!in.RoutingRules.Present && !in.AgentSettings.Present && !in.Metadata.Present
}

type TicketPatch struct {
	ConversationID Optional[string]         `json:"conversation_id"`
	Title          Optional[string]         `json:"title"`
	Status         Optional[string]         `json:"status"`
	Priority       Optional[string]         `json:"priority"`
	Assignee       Optional[string]         `json:"assignee"`
	SourceChannel  Optional[string]         `json:"source_channel"`
	DueAt          Optional[time.Time]      `json:"due_at"`
	ResolvedAt     Optional[time.Time]      `json:"resolved_at"`
	Metadata       Optional[map[string]any] `json:"metadata"`
}

func (in TicketPatch) empty() bool {
	return !in.ConversationID.Present && !in.Title.Present && !in.Status.Present && !in.Priority.Present &&
		!in.Assignee.Present && !in.SourceChannel.Present && !in.DueAt.Present && !in.ResolvedAt.Present && !in.Metadata.Present
}

type ViewPatch struct {
	Name       Optional[string]         `json:"name"`
	Visibility Optional[string]         `json:"visibility"`
	Filters    Optional[map[string]any] `json:"filters"`
	Sort       Optional[map[string]any] `json:"sort"`
	Status     Optional[string]         `json:"status"`
}

func (in ViewPatch) empty() bool {
	return !in.Name.Present && !in.Visibility.Present && !in.Filters.Present && !in.Sort.Present && !in.Status.Present
}

type MacroPatch struct {
	Name         Optional[string]         `json:"name"`
	Body         Optional[string]         `json:"body"`
	ChannelTypes Optional[[]string]       `json:"channel_types"`
	Tags         Optional[[]string]       `json:"tags"`
	Status       Optional[string]         `json:"status"`
	Metadata     Optional[map[string]any] `json:"metadata"`
}

func (in MacroPatch) empty() bool {
	return !in.Name.Present && !in.Body.Present && !in.ChannelTypes.Present && !in.Tags.Present && !in.Status.Present && !in.Metadata.Present
}

// InternalNoteRequest is the only accepted write on the messages endpoint.
// Legacy delivery-shaped fields are decoded solely so the handler can return
// a stable release-hold response instead of a misleading generic JSON error.
type InternalNoteRequest struct {
	BodyText    string                   `json:"body_text"`
	Direction   Optional[string]         `json:"direction"`
	SenderType  Optional[string]         `json:"sender_type"`
	Sender      Optional[string]         `json:"sender"`
	BodyHTML    Optional[string]         `json:"body_html"`
	Attachments Optional[[]any]          `json:"attachments"`
	SourceType  Optional[string]         `json:"source_type"`
	SourceID    Optional[string]         `json:"source_id"`
	SentAt      Optional[time.Time]      `json:"sent_at"`
	Metadata    Optional[map[string]any] `json:"metadata"`
}

func (in InternalNoteRequest) hasLegacyEnvelope() bool {
	return in.Direction.Present || in.SenderType.Present || in.Sender.Present ||
		in.BodyHTML.Present || in.Attachments.Present || in.SourceType.Present ||
		in.SourceID.Present || in.SentAt.Present || in.Metadata.Present
}

func (in InternalNoteRequest) requestsDelivery() bool {
	if !in.Direction.Present || in.Direction.Null {
		return false
	}
	direction := strings.ToLower(strings.TrimSpace(in.Direction.Value))
	return direction == "outbound" || direction == "inbound"
}

type listCursor struct {
	Version    int       `json:"v"`
	Kind       string    `json:"k"`
	Filter     string    `json:"f"`
	TenantID   string    `json:"w"`
	Limit      int       `json:"l"`
	SnapshotAt time.Time `json:"s"`
	ExpiresAt  time.Time `json:"x"`
	At         time.Time `json:"at,omitempty"`
	ID         string    `json:"id,omitempty"`
}

type PageInfo struct {
	HasMore     bool      `json:"has_more"`
	NextCursor  *string   `json:"next_cursor"`
	AsOf        time.Time `json:"as_of"`
	Consistency string    `json:"consistency"`
	MayReorder  bool      `json:"may_reorder"`
}

type ConversationPage struct {
	TenantID string         `json:"tenantId"`
	Items    []Conversation `json:"items"`
	Page     PageInfo       `json:"page"`
}

type MessagePage struct {
	TenantID string    `json:"tenantId"`
	Items    []Message `json:"items"`
	Page     PageInfo  `json:"page"`
}

type TenantPage[T any] struct {
	TenantID string   `json:"tenantId"`
	Items    []T      `json:"items"`
	Page     PageInfo `json:"page"`
}

const listCursorTTL = 15 * time.Minute

const absentResourceVersion = "absent"

const (
	helpdeskRequesterNameMaxBytes  = 200
	helpdeskRequesterEmailMaxBytes = 320
	helpdeskRequesterPhoneMaxBytes = 64
	helpdeskSubjectMaxBytes        = 500
	helpdeskTagMaxItems            = 32
	helpdeskTagMaxBytes            = 100
	helpdeskNameMaxBytes           = 200
	helpdeskTitleMaxBytes          = 500
	helpdeskMacroBodyMaxBytes      = 16 << 10
	helpdeskMetadataMaxBytes       = 64 << 10
	helpdeskSmallJSONMaxBytes      = 32 << 10
	helpdeskSmallArrayMaxItems     = 128
)

var (
	helpdeskProjectionMinTime = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	helpdeskProjectionMaxTime = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
)

// validHelpdeskDisplayText is the canonical server/client-safe text contract.
// Ordinary tabs and line breaks remain valid; NUL, other C0/C1 controls,
// bidi overrides/isolates, and zero-width formatting controls do not.
func validHelpdeskDisplayText(value string, maxBytes int, allowEmpty bool) bool {
	if !utf8.ValidString(value) || len([]byte(value)) > maxBytes || (!allowEmpty && strings.TrimSpace(value) == "") {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
		switch {
		case r == '\u061c',
			r >= '\u200b' && r <= '\u200f',
			r == '\u2028', r == '\u2029',
			r >= '\u202a' && r <= '\u202e',
			r >= '\u2060' && r <= '\u206f',
			r == '\ufeff':
			return false
		}
	}
	return true
}

func validHelpdeskSafeToken(value string, maxBytes int, allowEmpty bool) bool {
	if value == "" {
		return allowEmpty
	}
	if len(value) > maxBytes || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func validHelpdeskOpaqueID(value string, maxBytes int, allowEmpty bool) bool {
	return (value != "" || allowEmpty) && validHelpdeskDisplayText(value, maxBytes, true)
}

func validHelpdeskProjectionTime(value time.Time, allowZero bool) bool {
	if value.IsZero() {
		return allowZero
	}
	return !value.Before(helpdeskProjectionMinTime) && value.Before(helpdeskProjectionMaxTime)
}

func validHelpdeskEmail(value string, allowEmpty bool) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return allowEmpty
	}
	if !validHelpdeskDisplayText(value, helpdeskRequesterEmailMaxBytes, false) {
		return false
	}
	if strings.Count(value, "@") != 1 {
		return false
	}
	parts := strings.SplitN(value, "@", 2)
	local, domain := parts[0], parts[1]
	if len(local) < 1 || len(local) > 64 || len(domain) < 3 || len(domain) > 253 ||
		strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") ||
		!strings.Contains(domain, ".") {
		return false
	}
	for _, r := range local {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._%+-", r)) {
			return false
		}
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) < 1 || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-') {
				return false
			}
		}
	}
	return true
}

func validHelpdeskStringList(values []string, maxItems, maxBytes int, allowedValues []string) bool {
	if len(values) > maxItems {
		return false
	}
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if raw != value || !validHelpdeskDisplayText(value, maxBytes, false) {
			return false
		}
		if len(allowedValues) != 0 && !allowed(value, allowedValues) {
			return false
		}
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

// validHelpdeskJSON provides one bounded, display-safe contract for JSON that
// can cross an admin projection. It limits logical serialized bytes, nesting,
// and aggregate map/array fan-out; strings and object keys use the same
// control/bidi-safe text grammar as first-class display fields.
func validHelpdeskJSON(value any, maxBytes, maxDepth, maxItems int) bool {
	raw, err := marshalHelpdeskJSON(value)
	if err != nil || len(raw) > maxBytes {
		return false
	}
	remaining := maxItems
	var walk func(any, int) bool
	walk = func(current any, depth int) bool {
		if depth > maxDepth || remaining < 0 {
			return false
		}
		switch typed := current.(type) {
		case nil, bool:
			return true
		case json.Number:
			return validHelpdeskJSONNumber(typed)
		case float64:
			absolute := math.Abs(typed)
			return !math.IsInf(typed, 0) && !math.IsNaN(typed) && absolute <= 9007199254740991 &&
				(absolute == 0 || absolute >= math.SmallestNonzeroFloat64)
		case float32:
			value := float64(typed)
			absolute := math.Abs(value)
			return !math.IsInf(value, 0) && !math.IsNaN(value) && absolute <= 9007199254740991 &&
				(absolute == 0 || absolute >= math.SmallestNonzeroFloat64)
		case int8, int16, int32, uint8, uint16, uint32:
			return true
		case int:
			return int64(typed) >= -9007199254740991 && int64(typed) <= 9007199254740991
		case uint:
			return uint64(typed) <= 9007199254740991
		case int64:
			return typed >= -9007199254740991 && typed <= 9007199254740991
		case uint64:
			return typed <= 9007199254740991
		case string:
			return validHelpdeskDisplayText(typed, maxBytes, true)
		case []any:
			remaining -= len(typed)
			for _, item := range typed {
				if !walk(item, depth+1) {
					return false
				}
			}
			return true
		case []string:
			remaining -= len(typed)
			for _, item := range typed {
				if !validHelpdeskDisplayText(item, maxBytes, true) {
					return false
				}
			}
			return true
		case map[string]any:
			remaining -= len(typed)
			for key, item := range typed {
				if !validHelpdeskDisplayText(key, 256, false) || !walk(item, depth+1) {
					return false
				}
			}
			return true
		case map[string]string:
			remaining -= len(typed)
			for key, item := range typed {
				if !validHelpdeskDisplayText(key, 256, false) || !validHelpdeskDisplayText(item, maxBytes, true) {
					return false
				}
			}
			return true
		default:
			// Request and scanner projections use only JSON-compatible Go
			// values. Reject typed or custom values so no alternate encoder
			// semantics can bypass this predicate.
			return false
		}
	}
	return walk(value, 0)
}

func validHelpdeskJSONNumber(value json.Number) bool {
	// Compare the caller's decimal exactly before converting to binary64. A
	// float-only check would accept values that underflow to zero (1e-400) or
	// round down across the safe-integer ceiling (9007199254740991.1), while
	// PostgreSQL numeric correctly rejects them.
	exact, ok := new(big.Rat).SetString(value.String())
	if !ok {
		return false
	}
	absolute := new(big.Rat).Abs(exact)
	maximum := new(big.Rat).SetInt64(9007199254740991)
	minimum, ok := new(big.Rat).SetString("4.9406564584124654e-324")
	if !ok || absolute.Cmp(maximum) > 0 || (absolute.Sign() != 0 && absolute.Cmp(minimum) < 0) {
		return false
	}
	parsed, err := strconv.ParseFloat(value.String(), 64)
	return err == nil && !math.IsInf(parsed, 0) && !math.IsNaN(parsed)
}

// marshalHelpdeskJSON measures the non-HTML-escaped logical JSON bytes. The
// database stores jsonb values rather than an HTML script literal, so escaping
// every '<', '>', and '&' would create a scanner-only byte limit. U+2028 and
// U+2029 are rejected by the shared display grammar above.
func marshalHelpdeskJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

var errCursorUnavailable = errors.New("helpdesk cursor key unavailable")

func listCursorAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) < 32 {
		return nil, errCursorUnavailable
	}
	digest := sha256.Sum256(append([]byte("postwave/helpdesk/cursor/aes-gcm/v1\x00"), key...))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, errCursorUnavailable
	}
	return cipher.NewGCM(block)
}

func cursorAAD(tenantID, kind string) []byte {
	return []byte("postwave/helpdesk/cursor/v1\x00" + tenantID + "\x00" + kind)
}

func encodeListCursor(key []byte, tenantID, kind, filter string, limit int, snapshotAt, at time.Time, id string) (string, error) {
	aead, err := listCursorAEAD(key)
	if err != nil {
		return "", err
	}
	env := listCursor{Version: 1, Kind: kind, Filter: filter, TenantID: tenantID,
		Limit: limit, SnapshotAt: snapshotAt.UTC(), ExpiresAt: snapshotAt.UTC().Add(listCursorTTL),
		At: at.UTC(), ID: id}
	raw, err := json.Marshal(env)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, raw, cursorAAD(tenantID, kind))
	return "v1." + base64.RawURLEncoding.EncodeToString(append(nonce, sealed...)), nil
}

func decodeListCursor(key []byte, raw, tenantID, kind, filter string, limit int, now time.Time) (listCursor, error) {
	aead, err := listCursorAEAD(key)
	if err != nil {
		return listCursor{}, err
	}
	if raw == "" {
		return listCursor{Version: 1, Kind: kind, Filter: filter, TenantID: tenantID,
			Limit: limit, SnapshotAt: now.UTC(), ExpiresAt: now.UTC().Add(listCursorTTL)}, nil
	}
	if len(raw) > 4096 || !strings.HasPrefix(raw, "v1.") {
		return listCursor{}, errors.New("malformed cursor")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, "v1."))
	if err != nil || len(decoded) <= aead.NonceSize() || len(decoded) > 4096 {
		return listCursor{}, errors.New("malformed cursor")
	}
	plain, err := aead.Open(nil, decoded[:aead.NonceSize()], decoded[aead.NonceSize():], cursorAAD(tenantID, kind))
	if err != nil {
		return listCursor{}, errors.New("malformed cursor")
	}
	var out listCursor
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&out); err != nil || out.Version != 1 || out.Kind != kind || out.Filter != filter ||
		out.TenantID != tenantID || out.Limit != limit || out.SnapshotAt.IsZero() || out.ExpiresAt.IsZero() ||
		!out.ExpiresAt.Equal(out.SnapshotAt.Add(listCursorTTL)) || !now.Before(out.ExpiresAt) || out.SnapshotAt.After(now.Add(time.Minute)) {
		return listCursor{}, errors.New("cursor does not match this query")
	}
	parsed, err := uuid.Parse(out.ID)
	if out.ID == "" || out.At.IsZero() || err != nil || parsed.String() != out.ID {
		return listCursor{}, errors.New("cursor id is invalid")
	}
	return out, nil
}

func parseListLimit(values url.Values) (int, error) {
	rawValues, present := values["limit"]
	if !present {
		return 50, nil
	}
	if len(rawValues) != 1 || !exactUnsignedListDecimal(rawValues[0]) {
		return 0, fmt.Errorf("limit must be an integer from 1 through 100")
	}
	raw := rawValues[0]
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 100 {
		return 0, fmt.Errorf("limit must be an integer from 1 through 100")
	}
	return n, nil
}

func exactUnsignedListDecimal(raw string) bool {
	if raw == "" || len(raw) > 3 || raw[0] == '0' {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return false
		}
	}
	return true
}

func listCursorQueryValue(values url.Values) (string, error) {
	rawValues, present := values["cursor"]
	if !present {
		return "", nil
	}
	if len(rawValues) != 1 || rawValues[0] == "" {
		return "", errors.New("cursor must be non-empty when present")
	}
	return rawValues[0], nil
}

func validateQuery(r *http.Request, names ...string) (url.Values, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("query string is malformed")
	}
	allowedNames := make(map[string]bool, len(names))
	for _, name := range names {
		allowedNames[name] = true
	}
	for name, entries := range values {
		if !allowedNames[name] {
			return nil, fmt.Errorf("unknown query parameter %q", name)
		}
		if len(entries) != 1 {
			return nil, fmt.Errorf("query parameter %q must appear exactly once", name)
		}
	}
	return values, nil
}

func validateUUID(raw string) bool {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return false
	}
	parsed, err := uuid.Parse(raw)
	return err == nil && parsed.String() == raw
}

func resourceVersion(updatedAt time.Time) string {
	if updatedAt.IsZero() {
		return absentResourceVersion
	}
	return updatedAt.UTC().Format(time.RFC3339Nano)
}

// requireIfMatch accepts only the exact strong ETag shape emitted by this
// service. Wildcards and weak validators would turn a review-before-overwrite
// contract back into last-writer-wins.
func requireIfMatch(r *http.Request) (string, error) {
	if r == nil || len(r.Header.Values("If-Match")) != 1 {
		return "", errors.New("one If-Match header is required")
	}
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if len(raw) < 3 || raw[0] != '"' || raw[len(raw)-1] != '"' || strings.Contains(raw[1:len(raw)-1], "\"") {
		return "", errors.New("If-Match must be the exact quoted resource version")
	}
	version := raw[1 : len(raw)-1]
	if version == absentResourceVersion {
		return version, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, version)
	if err != nil || resourceVersion(parsed) != version {
		return "", errors.New("If-Match resource version is invalid")
	}
	return version, nil
}

func expectedUpdatedAt(version string) (time.Time, bool, error) {
	if version == absentResourceVersion {
		return time.Time{}, true, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, version)
	if err != nil || resourceVersion(parsed) != version {
		return time.Time{}, false, errors.New("resource version is invalid")
	}
	return parsed.UTC(), false, nil
}

func setEntityTag(w http.ResponseWriter, version string) {
	if w != nil && version != "" {
		w.Header().Set("ETag", strconv.Quote(version))
	}
}

func routeIsConversationAction(r *http.Request, action string) bool {
	if r == nil || r.Method != http.MethodPost {
		return false
	}
	const prefix = "/api/v1/service-suite/conversations/"
	path := strings.TrimSuffix(r.URL.EscapedPath(), "/")
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	return len(parts) == 2 && parts[0] != "" && parts[1] == action
}

// LegacyMessageReplayBypass prevents any cached pre-hold 2xx for the old
// delivery-shaped endpoint from bypassing its permanent release hold.
func LegacyMessageReplayBypass(r *http.Request, _ []byte) bool {
	return routeIsConversationAction(r, "messages")
}

// MutationReplayBypass makes exact-admin authorization run on every Helpdesk
// mutation attempt. The generic replay middleware is intentionally outside
// route-local authorization; replaying a cached 2xx there after a user/API-key
// demotion would disclose the old sensitive response and falsely report a new
// mutation. Internal notes are excluded because their handler-owned durable
// ledger reauthorizes first and resolves same-key state transactionally.
func MutationReplayBypass(r *http.Request, _ []byte) bool {
	if r == nil || r.URL == nil {
		return false
	}
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	path := strings.TrimSuffix(r.URL.EscapedPath(), "/")
	if !strings.HasPrefix(path, "/api/v1/service-suite/") {
		return false
	}
	return !routeIsConversationAction(r, "internal-notes")
}

// HandlerOwnedInternalNoteReplay selects the distinct note-only route whose
// durable intent and equivalence checks live in the service-suite transaction.
func HandlerOwnedInternalNoteReplay(r *http.Request, _ []byte) bool {
	return routeIsConversationAction(r, "internal-notes")
}

func InternalNoteReplayBodyLimit(r *http.Request) int64 {
	if LegacyMessageReplayBypass(r, nil) || HandlerOwnedInternalNoteReplay(r, nil) {
		return 64 << 10
	}
	return 0
}
