// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var testConsentCursorSigningKey = []byte("0123456789abcdef0123456789abcdef")

func signTestConsentCursorPayload(decoded string) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(decoded))
	signature := base64.RawURLEncoding.EncodeToString(
		consentCursorMAC(testConsentCursorSigningKey, "cursor-envelope", payload),
	)
	return payload + "." + signature
}

func TestConsentReadParamsRejectUnknownDuplicateAndNonCanonicalValues(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		values  url.Values
		events  bool
		byEmail bool
		code    string
	}{
		{name: "unknown receipt", values: url.Values{"unknown": {"1"}}, code: "invalid_query"},
		{name: "duplicate receipt", values: url.Values{"limit": {"1", "2"}}, code: "invalid_query"},
		{name: "empty known", values: url.Values{"source": {""}}, code: "invalid_query"},
		{name: "whitespace known", values: url.Values{"source": {" form"}}, code: "invalid_query"},
		{name: "source forbidden by email", values: url.Values{"source": {"form"}}, byEmail: true, code: "invalid_query"},
		{name: "zero limit", values: url.Values{"limit": {"0"}}, code: "invalid_limit"},
		{name: "clamped limit forbidden", values: url.Values{"limit": {"1001"}}, code: "invalid_limit"},
		{name: "signed limit forbidden", values: url.Values{"limit": {"+1"}}, code: "invalid_limit"},
		{name: "invalid timestamp", values: url.Values{"since": {"yesterday"}}, code: "invalid_since"},
		{name: "unknown event", values: url.Values{"source": {"gpc"}}, events: true, code: "invalid_query"},
		{name: "duplicate event", values: url.Values{"category": {"analytics", "marketing"}}, events: true, code: "invalid_query"},
		{name: "invalid event enum", values: url.Values{"action": {"deleted"}}, events: true, code: "invalid_action"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var got *consentInputError
			if test.events {
				_, _, _, got = readEventParams(test.values)
			} else {
				_, _, _, got = readReceiptParams(test.values, test.byEmail)
			}
			if got == nil || got.code != test.code {
				t.Fatalf("error = %#v, want code %q", got, test.code)
			}
		})
	}
}

func TestConsentReadParamsAcceptCanonicalBoundedFilters(t *testing.T) {
	t.Parallel()
	limit, receiptFilter, cursor, err := readReceiptParams(url.Values{
		"limit":  {"1000"},
		"source": {"form"},
		"since":  {"2026-08-20T01:02:03.123456789Z"},
		"cursor": {"opaque"},
	}, false)
	if err != nil {
		t.Fatalf("receipt params: %v", err)
	}
	if limit != 1000 || receiptFilter.Source != "form" || receiptFilter.Since == nil || cursor != "opaque" {
		t.Fatalf("unexpected receipt params: limit=%d filter=%+v cursor=%q", limit, receiptFilter, cursor)
	}

	limit, eventFilter, cursor, err := readEventParams(url.Values{
		"subject_type": {"visitor"},
		"category":     {"analytics"},
		"action":       {"denied"},
		"since":        {"2026-08-20T01:02:03Z"},
	})
	if err != nil {
		t.Fatalf("event params: %v", err)
	}
	if limit != defaultConsentReadLimit || eventFilter.SubjectType != "visitor" ||
		eventFilter.Category != "analytics" || eventFilter.Action != "denied" ||
		eventFilter.Since == nil || cursor != "" {
		t.Fatalf("unexpected event params: limit=%d filter=%+v cursor=%q", limit, eventFilter, cursor)
	}
}

func TestValidateEventRowRequiresSubjectIdentity(t *testing.T) {
	t.Parallel()
	snapshot := time.Date(2026, time.August, 20, 9, 0, 0, 0, time.UTC)
	event := Event{
		ID:            "44444444-4444-4444-8444-444444444444",
		SubjectType:   "visitor",
		SubjectID:     "visitor_0123456789",
		Channel:       "web",
		Category:      "analytics",
		Action:        "denied",
		Source:        "cookie_banner",
		PolicyVersion: "v1",
		Preferences:   map[string]any{},
		CreatedAt:     snapshot.Add(-2 * time.Second),
		RecordedAt:    snapshot.Add(-time.Second),
	}
	if err := validateEventRow(event, snapshot); err != nil {
		t.Fatalf("valid subject identity rejected: %v", err)
	}
	event.SubjectID = ""
	if err := validateEventRow(event, snapshot); err == nil ||
		!strings.Contains(err.Error(), "subject identity") {
		t.Fatalf("subjectless event error = %v, want subject identity violation", err)
	}
}

func TestParseConsentQueryRejectsMalformedOrPartiallyParsedInput(t *testing.T) {
	t.Parallel()
	for _, rawQuery := range []string{
		"limit=1;source=form",
		"source=%zz",
		"limit=1&cursor=%",
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/consent/receipts?"+rawQuery, nil)
		values, err := parseConsentQuery(request)
		if err == nil || err.code != "invalid_query" {
			t.Errorf("raw query %q: values=%v error=%v, want invalid_query", rawQuery, values, err)
		}
		if values != nil {
			t.Errorf("raw query %q returned a partial map: %v", rawQuery, values)
		}
	}
}

func TestConsentCursorIsSnapshotWorkspaceScopeAndFilterBound(t *testing.T) {
	t.Parallel()
	const workspaceID = "4d4d1d18-529d-4be0-885e-9f45ef04e807"
	snapshot := time.Date(2026, 8, 20, 10, 0, 0, 123000000, time.UTC)
	recorded := snapshot.Add(-time.Second)
	binding := receiptFilterBinding("receipts", receiptReadFilter{Source: "form"})
	raw, err := encodeConsentCursor(testConsentCursorSigningKey, workspaceID, "receipts", binding, consentPagePosition{
		SnapshotAt: snapshot, VisibilitySnapshot: "10:20:10,15", RecordedAt: recorded,
		Kind: "proof", ID: "90da3d56-34bf-4425-b137-4bb7a18af598",
	})
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	got, inputErr := decodeConsentCursor(testConsentCursorSigningKey, raw, workspaceID, "receipts", binding, true)
	if inputErr != nil {
		t.Fatalf("decode cursor: %v", inputErr)
	}
	if !got.SnapshotAt.Equal(snapshot) || !got.RecordedAt.Equal(recorded) || got.Kind != "proof" || got.ID == "" {
		t.Fatalf("decoded position = %+v", got)
	}
	for _, mutation := range []struct {
		workspace, scope, binding string
	}{
		{"b72d84e1-37a4-473a-826b-461ae90ddab5", "receipts", binding},
		{workspaceID, "subject_history", binding},
		{workspaceID, "receipts", receiptFilterBinding("receipts", receiptReadFilter{Source: "api"})},
	} {
		if _, err := decodeConsentCursor(testConsentCursorSigningKey, raw, mutation.workspace, mutation.scope, mutation.binding, true); err == nil || err.code != "invalid_cursor" {
			t.Fatalf("mutated cursor accepted: %+v err=%v", mutation, err)
		}
	}
}

func TestConsentCursorRejectsUnknownFieldsAndWrongIdentityPlane(t *testing.T) {
	t.Parallel()
	raw := signTestConsentCursorPayload(`{
      "v":1,
      "workspace_id":"4d4d1d18-529d-4be0-885e-9f45ef04e807",
      "scope":"events",
		"filter_hash":"binding",
		"snapshot_at":"2026-08-20T10:00:00Z",
		"visibility":"10:20:10,15",
      "recorded_at":"2026-08-20T09:59:00Z",
      "kind":"receipt",
      "id":"1",
      "unexpected":true
	    }`)
	if _, err := decodeConsentCursor(testConsentCursorSigningKey, raw, "4d4d1d18-529d-4be0-885e-9f45ef04e807", "events", "binding", false); err == nil {
		t.Fatal("cursor with unknown field unexpectedly accepted")
	}
}

func TestConsentCursorRejectsDuplicateOrNonCanonicalEnvelopeMembers(t *testing.T) {
	t.Parallel()
	const workspaceID = "4d4d1d18-529d-4be0-885e-9f45ef04e807"
	for _, decoded := range []string{
		`{"v":1,"v":1,"workspace_id":"4d4d1d18-529d-4be0-885e-9f45ef04e807","scope":"events","filter_hash":"binding","snapshot_at":"2026-08-20T10:00:00Z","visibility":"10:20:","recorded_at":"2026-08-20T09:59:00Z","id":"77d03631-d91f-4aee-bd72-ab23a52fb387"}`,
		`{ "v":1,"workspace_id":"4d4d1d18-529d-4be0-885e-9f45ef04e807","scope":"events","filter_hash":"binding","snapshot_at":"2026-08-20T10:00:00Z","visibility":"10:20:","recorded_at":"2026-08-20T09:59:00Z","id":"77d03631-d91f-4aee-bd72-ab23a52fb387"}`,
	} {
		raw := signTestConsentCursorPayload(decoded)
		if _, err := decodeConsentCursor(testConsentCursorSigningKey, raw, workspaceID, "events", "binding", false); err == nil || err.code != "invalid_cursor" {
			t.Fatalf("noncanonical cursor accepted: %s", decoded)
		}
	}
}

func TestConsentCursorRejectsTamperingWrongKeyAndDoesNotExposeSubjectDigest(t *testing.T) {
	t.Parallel()
	const workspaceID = "4d4d1d18-529d-4be0-885e-9f45ef04e807"
	const email = "sensitive.person@example.test"
	binding := receiptFilterBinding("subject_history", receiptReadFilter{Email: email})
	raw, err := encodeConsentCursor(testConsentCursorSigningKey, workspaceID, "subject_history", binding, consentPagePosition{
		SnapshotAt:         time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC),
		VisibilitySnapshot: "10:20:10,15",
		RecordedAt:         time.Date(2026, 8, 20, 9, 59, 0, 0, time.UTC),
		Kind:               "receipt",
		ID:                 "1",
	})
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	if strings.Contains(raw, email) {
		t.Fatal("cursor exposed subject email")
	}
	parts := strings.Split(raw, ".")
	payload, decodeErr := base64.RawURLEncoding.DecodeString(parts[0])
	if decodeErr != nil {
		t.Fatalf("decode payload: %v", decodeErr)
	}
	var envelope consentCursorEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	unsalted := sha256.Sum256([]byte(binding))
	if envelope.FilterHash == base64.RawURLEncoding.EncodeToString(unsalted[:]) || strings.Contains(string(payload), email) {
		t.Fatal("cursor used an offline-testable or plaintext subject binding")
	}

	tampered := raw[:len(raw)-1] + map[bool]string{true: "A", false: "B"}[raw[len(raw)-1] != 'A']
	if _, got := decodeConsentCursor(testConsentCursorSigningKey, tampered, workspaceID, "subject_history", binding, true); got == nil {
		t.Fatal("tampered cursor was accepted")
	}
	wrongKey := []byte("fedcba9876543210fedcba9876543210")
	if _, got := decodeConsentCursor(wrongKey, raw, workspaceID, "subject_history", binding, true); got == nil {
		t.Fatal("cursor signed by another key was accepted")
	}
}

type fakeConsentRows struct {
	scans   []func(...any) error
	next    int
	current int
	err     error
	closed  bool
}

func (r *fakeConsentRows) Next() bool {
	if r.next >= len(r.scans) {
		return false
	}
	r.current = r.next
	r.next++
	return true
}

func (r *fakeConsentRows) Scan(dest ...any) error { return r.scans[r.current](dest...) }
func (r *fakeConsentRows) Err() error             { return r.err }
func (r *fakeConsentRows) Close()                 { r.closed = true }

func receiptScan(id, kind string, recordedAt time.Time) func(...any) error {
	return func(dest ...any) error {
		*dest[0].(*string) = id
		*dest[1].(*string) = "person@example.test"
		*dest[2].(*string) = "pending"
		if kind == "receipt" {
			*dest[3].(*string) = "subscribed"
		} else {
			*dest[3].(*string) = "granted"
		}
		*dest[4].(*string) = "form"
		*dest[5].(*string) = ""
		*dest[6].(*string) = "192.0.2.1"
		*dest[7].(*string) = "test-agent"
		*dest[8].(*string) = "v1"
		*dest[9].(*string) = ""
		*dest[10].(*time.Time) = recordedAt.Add(-time.Hour)
		*dest[11].(*time.Time) = recordedAt
		*dest[12].(*string) = kind
		return nil
	}
}

func eventScan(preferences string, recordedAt time.Time) func(...any) error {
	return func(dest ...any) error {
		*dest[0].(*string) = "77d03631-d91f-4aee-bd72-ab23a52fb387"
		*dest[1].(*string) = ""
		*dest[2].(*string) = "visitor"
		*dest[3].(*string) = "opaque_visitor_1234"
		*dest[4].(*string) = ""
		*dest[5].(*string) = "web"
		*dest[6].(*string) = "analytics"
		*dest[7].(*string) = "denied"
		*dest[8].(*string) = "cookie_banner"
		*dest[9].(*string) = "v1"
		*dest[10].(*[]byte) = []byte(preferences)
		*dest[11].(*string) = ""
		*dest[12].(*string) = ""
		*dest[13].(*string) = "test-agent"
		*dest[14].(*time.Time) = recordedAt.Add(-time.Second)
		*dest[15].(*time.Time) = recordedAt
		return nil
	}
}

func TestMaterializeReceiptPageFailsClosedOnScanAndRowsErrors(t *testing.T) {
	t.Parallel()
	snapshot := time.Now().UTC()
	for _, rows := range []*fakeConsentRows{
		{scans: []func(...any) error{func(...any) error { return errors.New("scan failed") }}},
		{err: errors.New("stream failed")},
	} {
		if _, _, err := materializeReceiptPage(rows, 10, snapshot); err == nil {
			t.Fatal("materializer unexpectedly returned a partial success")
		}
		if !rows.closed {
			t.Fatal("rows were not closed on failure")
		}
	}
}

func TestMaterializePagesUseLimitPlusOneAndRejectMalformedJSON(t *testing.T) {
	t.Parallel()
	snapshot := time.Now().UTC()
	receiptRows := &fakeConsentRows{scans: []func(...any) error{
		receiptScan("2", "receipt", snapshot.Add(-time.Second)),
		receiptScan("1", "receipt", snapshot.Add(-2*time.Second)),
	}}
	receipts, hasMore, err := materializeReceiptPage(receiptRows, 1, snapshot)
	if err != nil {
		t.Fatalf("materialize receipt page: %v", err)
	}
	if !hasMore || len(receipts) != 1 || receipts[0].ID != "2" {
		t.Fatalf("receipt page = %+v hasMore=%t", receipts, hasMore)
	}

	eventRows := &fakeConsentRows{scans: []func(...any) error{eventScan(`{"choice":`, snapshot.Add(-time.Second))}}
	if _, _, err := materializeEventPage(eventRows, 10, snapshot); err == nil {
		t.Fatal("malformed preferences unexpectedly produced a page")
	}
}

func TestMaterializeReceiptPageContinuesBeforeResponseByteBudget(t *testing.T) {
	t.Parallel()
	snapshot := time.Now().UTC()
	largeNarrative := strings.Repeat("<", 64<<10)
	rows := &fakeConsentRows{scans: make([]func(...any) error, 100)}
	for index := range rows.scans {
		id := strconv.Itoa(1000 - index)
		recordedAt := snapshot.Add(-time.Duration(index+1) * time.Microsecond)
		rows.scans[index] = func(dest ...any) error {
			if err := receiptScan(id, "receipt", recordedAt)(dest...); err != nil {
				return err
			}
			*dest[9].(*string) = largeNarrative
			return nil
		}
	}
	receipts, hasMore, err := materializeReceiptPage(rows, 1000, snapshot)
	if err != nil {
		t.Fatalf("materialize byte-bounded page: %v", err)
	}
	if !hasMore || len(receipts) == 0 || len(receipts) >= len(rows.scans) {
		t.Fatalf("budget continuation: rows=%d has_more=%t", len(receipts), hasMore)
	}
	payload, err := marshalConsentPage(consentReceiptPage{
		SchemaVersion: 1,
		WorkspaceID:   "4d4d1d18-529d-4be0-885e-9f45ef04e807",
		SnapshotAt:    snapshot,
		SourcePlanes:  receiptSourcePlanes,
		Receipts:      receipts,
		Count:         len(receipts),
		HasMore:       true,
		NextCursor:    "opaque",
	})
	if err != nil {
		t.Fatalf("marshal bounded page: %v", err)
	}
	if len(payload) > maxConsentResponseBytes {
		t.Fatalf("payload bytes=%d exceeds budget=%d", len(payload), maxConsentResponseBytes)
	}
}

func TestConsentResponseEnvelopeReserveCoversMaximumCursorAndEscapedSubject(t *testing.T) {
	t.Parallel()
	snapshot := time.Date(2026, 8, 20, 10, 0, 0, 123456789, time.UTC)
	// '<' and '>' are permitted non-control email bytes but encoding/json HTML-
	// escapes them to six bytes each, making this more expensive than a normal
	// 320-byte address while preserving the runtime's one-@ shape rule.
	email := strings.Repeat("<", 159) + "@" + strings.Repeat(">", 160)
	if len(email) != 320 || !validConsentEmailShape(email) {
		t.Fatalf("test email does not exercise the runtime boundary: bytes=%d", len(email))
	}
	payload, err := json.Marshal(consentReceiptPage{
		SchemaVersion: consentReadSchemaVersion,
		WorkspaceID:   "4d4d1d18-529d-4be0-885e-9f45ef04e807",
		SnapshotAt:    snapshot,
		SourcePlanes:  receiptSourcePlanes,
		Receipts:      []Receipt{},
		Email:         email,
		Count:         0,
		HasMore:       true,
		NextCursor:    strings.Repeat("A", maxConsentCursorBytes),
	})
	if err != nil {
		t.Fatalf("marshal worst-case envelope: %v", err)
	}
	if got := len(payload) + 1; got > consentResponseEnvelopeReserveBytes {
		t.Fatalf("worst-case envelope bytes=%d exceeds reserve=%d", got, consentResponseEnvelopeReserveBytes)
	}
}

func TestConsentReadIdentityAndTextValidatorsMatchStrictClients(t *testing.T) {
	t.Parallel()

	for value, want := range map[string]bool{
		"4d4d1d18-529d-4be0-885e-9f45ef04e807": true,
		"018f2f7d-2c84-7cc8-8f4f-0ca121de12ee": true,
		"00000000-0000-8000-8000-000000000001": true,
		"00000000-0000-0000-0000-000000000000": false,
		"00000000-0000-9000-8000-000000000001": false,
		"00000000-0000-4000-7000-000000000001": false,
		"FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF": false,
	} {
		if got := validUUID(value); got != want {
			t.Errorf("validUUID(%q)=%t want=%t", value, got, want)
		}
	}
	if validConsentEmailShape("\ufeffperson@example.test") {
		t.Error("byte-order-mark wrapped email passed the strict client contract")
	}
	if optionalConsentNarrative("\ufeff", maxConsentNarrativeBytes) {
		t.Error("byte-order-mark-only narrative passed the strict client contract")
	}
}

func TestProtectSensitiveResponsesReassertsNoStoreOnEveryConsentFamily(t *testing.T) {
	t.Parallel()
	handler := ProtectSensitiveResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=600")
		w.Header().Set("ETag", `"pii"`)
		w.Header().Add("Vary", "Accept-Encoding")
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	paths := []string{
		"/api/public/consent",
		"/api/public/preferences/recipient-capability",
		"/api/public/preferences/recipient-capability/one-click",
		"/api/public/preferences/recipient-capability/frequency",
		"/api/v1/consent/receipts",
		"/api/v1/consent/receipts/by-email/person%40example.test",
		"/api/v1/consent/events",
		"/api/v1/consent/subscribers/person%40example.test/tracking",
		"/api/v1/subscribers/77d03631-d91f-4aee-bd72-ab23a52fb387/tracking-consent",
		"/api/v1/subscribers/77d03631-d91f-4aee-bd72-ab23a52fb387/consent-receipt.json",
		"/api/v1/subscribers/77d03631-d91f-4aee-bd72-ab23a52fb387/consent-receipt.zip",
		"/api/v1/sms/conversations",
		"/api/v1/sms/conversations/%2B14155551212/messages",
		"/api/v1/sms/conversations/search",
		"/api/v1/sms/conversations.csv",
		"/api/v1/sms/quick-replies/77d03631-d91f-4aee-bd72-ab23a52fb387",
		"/api/v1/sms/broadcasts/77d03631-d91f-4aee-bd72-ab23a52fb387/progress",
		"/api/v1/sms/suppressions",
		"/api/v1/sms/consent",
		"/api/v1/sms/senders",
	}
	for _, path := range paths {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Errorf("%s Cache-Control=%q", path, got)
		}
		if recorder.Header().Get("ETag") != "" || recorder.Header().Get("Pragma") != "no-cache" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s missing sensitive response hardening: %v", path, recorder.Header())
		}
		vary := strings.ToLower(strings.Join(recorder.Header().Values("Vary"), ","))
		for _, dimension := range []string{"authorization", "cookie", "x-postwave-site-key", "sec-gpc", "idempotency-key", "accept-encoding"} {
			if !strings.Contains(vary, dimension) {
				t.Errorf("%s Vary=%q missing %q", path, vary, dimension)
			}
			if strings.Count(vary, dimension) != 1 {
				t.Errorf("%s Vary=%q duplicates %q", path, vary, dimension)
			}
		}
	}
}

func TestHostedPreferenceSensitivePathMatcherIsExactAndMethodIndependent(t *testing.T) {
	t.Parallel()
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, path := range []string{
			"/api/public/preferences/recipient-capability",
			"/api/public/preferences/recipient-capability/one-click",
			"/api/public/preferences/recipient-capability/frequency",
		} {
			request := httptest.NewRequest(method, path, nil)
			if !isSensitiveConsentRoute(request) {
				t.Errorf("%s %s was not protected", method, path)
			}
		}
	}
	for _, path := range []string{
		"/api/public/preferences",
		"/api/public/preferences/",
		"/api/public/preferences/token/unknown",
		"/api/public/preferences/token/one-click/extra",
		"/api/public/preference/token",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if isSensitiveConsentRoute(request) {
			t.Errorf("unrelated path was protected: %s", path)
		}
	}
}

func TestProtectSensitiveResponsesLeavesUnrelatedRoutesUntouched(t *testing.T) {
	t.Parallel()
	handler := ProtectSensitiveResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.WriteHeader(http.StatusTeapot)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil))
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("unrelated Cache-Control=%q", got)
	}
	if got := recorder.Header().Values("Vary"); len(got) != 0 {
		t.Fatalf("unrelated Vary=%v", got)
	}
}

func TestPortableReceiptSensitivePathMatcherIsExact(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/api/v1/subscribers/id/consent-receipt.json",
		"/api/v1/subscribers/id/consent-receipt.zip",
	} {
		if !isSubscriberConsentReceiptExportPath(path) {
			t.Fatalf("expected protected portable-receipt path: %s", path)
		}
	}
	for _, path := range []string{
		"/api/v1/subscribers/consent-receipt.json",
		"/api/v1/subscribers/id/other/consent-receipt.json",
		"/api/v1/subscribers/id/consent-receipt.csv",
		"/api/v1/subscribers/id",
		"/api/v1/subscribers/id/events",
	} {
		if isSubscriberConsentReceiptExportPath(path) {
			t.Fatalf("unrelated subscriber path was protected: %s", path)
		}
	}
}

func TestProtectAdminConsentReadRequiresExactSessionRoleOrAdminAPIKey(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		apiKey     bool
		scopes     []apikeys.Scope
		role       string
		effective  string
		wantStatus int
	}{
		{name: "admin api key", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeAdmin}, wantStatus: http.StatusNoContent},
		{name: "report api key", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeReadReports}, wantStatus: http.StatusForbidden},
		{name: "owner session", role: "owner", wantStatus: http.StatusNoContent},
		{name: "admin session", role: "admin", wantStatus: http.StatusNoContent},
		{name: "viewer session", role: "viewer", wantStatus: http.StatusForbidden},
		{name: "editor session", role: "editor", wantStatus: http.StatusForbidden},
		{name: "custom session", role: "compliance-reviewer", wantStatus: http.StatusForbidden},
		{name: "admin in viewer mode", role: "admin", effective: "viewer", wantStatus: http.StatusForbidden},
		{name: "missing principal", wantStatus: http.StatusUnauthorized},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			called := false
			handler := protectAdminConsentRead(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/api/v1/consent/receipts", nil)
			ctx := request.Context()
			if test.apiKey {
				ctx = middleware.WithAPIKeyAuth(ctx)
				ctx = apikeys.WithScopes(ctx, test.scopes)
			} else if test.role != "" {
				ctx = middleware.WithUser(ctx, &middleware.User{
					ID: "user-1", Role: test.role, EffectiveRole: test.effective,
				})
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request.WithContext(ctx))
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if called != (test.wantStatus == http.StatusNoContent) {
				t.Fatalf("called=%t status=%d", called, recorder.Code)
			}
			if recorder.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("denial/success lost no-store: %v", recorder.Header())
			}
		})
	}
}

func TestProtectAdminConsentReadRejectsStoredAdminGrantForEffectiveCustomRole(t *testing.T) {
	original := apikeys.StoredScopeResolver
	t.Cleanup(func() { apikeys.StoredScopeResolver = original })
	apikeys.StoredScopeResolver = func(_ context.Context, tenantID, role string) ([]apikeys.Scope, error) {
		if tenantID != "tenant-1" || role != "compliance-reviewer" {
			t.Fatalf("stored grant lookup tenant/role=(%q,%q)", tenantID, role)
		}
		return []apikeys.Scope{apikeys.ScopeAdmin}, nil
	}

	called := false
	handler := protectAdminConsentRead(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/consent/receipts", nil)
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "user-1", Role: "admin", EffectiveRole: "compliance-reviewer",
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request.WithContext(ctx))
	if recorder.Code != http.StatusForbidden || called {
		t.Fatalf("status=%d called=%t body=%s", recorder.Code, called, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("stored-grant denial lost no-store: %v", recorder.Header())
	}
}
