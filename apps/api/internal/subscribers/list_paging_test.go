package subscribers

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// TestListCursorRoundTrip asserts encode→decode is lossless for the
// keyset position, including sub-second precision (a second-granularity
// cursor would let a later row on the same second leak onto the next
// page).
func TestListCursorRoundTrip(t *testing.T) {
	orig := listCursor{
		UpdatedAt: time.Date(2026, 6, 13, 10, 30, 45, 123456000, time.UTC),
		ID:        "9f1c0a4e-1111-2222-3333-444455556666",
	}
	enc := encodeListCursor(orig)
	if enc == "" {
		t.Fatal("encode returned empty for a populated cursor")
	}
	got, err := decodeListCursor(enc)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.UpdatedAt.Equal(orig.UpdatedAt) {
		t.Fatalf("updated_at round-trip: got %v want %v", got.UpdatedAt, orig.UpdatedAt)
	}
	if got.ID != orig.ID {
		t.Fatalf("id round-trip: got %q want %q", got.ID, orig.ID)
	}
}

// TestListCursorEmpty: an empty/zero cursor encodes to "" and decodes
// back to the zero cursor with no error — so the handler can decode
// unconditionally on every request.
func TestListCursorEmpty(t *testing.T) {
	if enc := encodeListCursor(listCursor{}); enc != "" {
		t.Fatalf("zero cursor should encode to empty, got %q", enc)
	}
	got, err := decodeListCursor("")
	if err != nil {
		t.Fatalf("decode empty: unexpected err %v", err)
	}
	if got.ID != "" {
		t.Fatalf("decode empty should yield zero cursor, got id %q", got.ID)
	}
}

// TestListCursorRejectsGarbage: malformed cursors map to errInvalidCursor
// so the handler can 400 instead of paging from a bogus position.
func TestListCursorRejectsGarbage(t *testing.T) {
	cases := []string{
		"!!!not-base64!!!",
		"YWJj",                         // valid base64 of "abc" → not JSON
		"eyJ1IjoiIn0",                  // {"u":""} → missing id
		"eyJpIjoieCJ9",                 // {"i":"x"} → missing updated_at
		"eyJ1IjoiYm9ndXMiLCJpIjoieCJ9", // {"u":"bogus","i":"x"} → bad timestamp
	}
	for _, c := range cases {
		_, err := decodeListCursor(c)
		if err == nil {
			t.Fatalf("decode(%q) should have errored", c)
		}
		if err != errInvalidCursor {
			t.Fatalf("decode(%q) err = %v, want errInvalidCursor", c, err)
		}
	}

	// A well-formed envelope (valid base64, valid JSON, valid timestamp,
	// both fields present) but with a NON-UUID id must still be rejected
	// up front — otherwise it'd reach the keyset query as 'x'::uuid and
	// crash Postgres (22P02) into a 500 instead of the documented 400.
	badID := base64.RawURLEncoding.EncodeToString(
		[]byte(`{"u":"2026-06-13T10:30:45Z","i":"not-a-uuid"}`))
	if _, err := decodeListCursor(badID); err != errInvalidCursor {
		t.Fatalf("decode(non-uuid id) err = %v, want errInvalidCursor", err)
	}
}

// TestUsesKeyset: the keyset path engages ONLY when a cursor is present
// AND the effective sort is the default (updated_at DESC). Every other
// sort — and the no-cursor case — falls back to OFFSET.
func TestUsesKeyset(t *testing.T) {
	withCur := listCursor{UpdatedAt: time.Now(), ID: "abc"}
	cases := []struct {
		name string
		opts ListOptions
		want bool
	}{
		{"no cursor", ListOptions{Sort: "", Order: ""}, false},
		{"cursor + default sort", ListOptions{Cursor: withCur}, true},
		{"cursor + explicit updated_at desc", ListOptions{Cursor: withCur, Sort: "updated_at", Order: "desc"}, true},
		{"cursor + updated_at asc → offset", ListOptions{Cursor: withCur, Sort: "updated_at", Order: "asc"}, false},
		{"cursor + email sort → offset", ListOptions{Cursor: withCur, Sort: "email", Order: "desc"}, false},
		{"cursor + unknown sort falls back to updated_at desc → keyset", ListOptions{Cursor: withCur, Sort: "garbage", Order: ""}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.opts.usesKeyset(); got != tc.want {
				t.Fatalf("usesKeyset = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestSubscriberFreeTextPredicate: the shared free-text predicate splices ONLY
// the integer placeholder (never user input), and List's ?q, /search and the
// CSV export all emit the same one — so they cannot drift into two search
// implementations again, which is how the list ended up with an unindexable
// ten-column ILIKE while /search used the index.
func TestSubscriberFreeTextPredicate(t *testing.T) {
	got := subscriberFreeTextPredicate(2)
	for _, want := range []string{
		"search_tsv @@ websearch_to_tsquery('simple', $2)",
		"lower(email::text) LIKE '%' || lower($2) || '%'",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("predicate missing %q\nfull: %s", want, got)
		}
	}
	// Different placeholder index threads through everywhere.
	if p7 := subscriberFreeTextPredicate(7); !strings.Contains(p7, "$7") || strings.Contains(p7, "$2") {
		t.Fatalf("placeholder not threaded: %s", p7)
	}
	// The free-text arm of the structured search builder must be the same
	// string, or "one implementation" is only a comment.
	structured, _ := buildSearchWhere(ParseSearch("alice"), []any{"tenant"})
	if !strings.Contains(structured, subscriberFreeTextPredicate(2)) {
		t.Fatalf("structured search no longer emits the shared predicate:\n%s", structured)
	}
}

// TestStatusFilterClauseAllowList double-checks (alongside the existing
// TestStatusFilterClause in repo_test.go) that the List handler's
// validation gate accepts exactly the recognised statuses and rejects an
// injection-shaped value — the column for an accepted status is always a
// fixed allow-listed identifier, never the raw input.
func TestStatusFilterClauseAllowList(t *testing.T) {
	// Accepted: returns ok=true and a non-empty fixed column.
	accepted := map[string]string{
		"enabled": "enabled", "blocklisted": "blocklisted",
		"subscribed": "subscribed", "unsubscribed": "unsubscribed",
		"non_subscribed": "non_subscribed", "pending": "pending",
		"transactional": "transactional", "cleaned": "cleaned",
		"archived": "archived", "deleted": "deleted",
		"bounced": "cleaned",
	}
	for s, wantVal := range accepted {
		col, val, ok := statusFilterClause(s)
		if !ok {
			t.Fatalf("status %q should be accepted", s)
		}
		if col != "status" && col != "mailchimp_status" {
			t.Fatalf("status %q mapped to unexpected column %q", s, col)
		}
		if val != wantVal {
			t.Fatalf("status %q value = %q, want %q", s, val, wantVal)
		}
	}
	// Rejected: ok=false, no clause emitted. Includes an injection probe.
	for _, s := range []string{"", "all", "garbage", "enabled; DROP TABLE subscribers", "' OR '1'='1"} {
		if _, _, ok := statusFilterClause(s); ok {
			t.Fatalf("status %q should have been rejected", s)
		}
	}
}

// TestNormalizeSortNeverRawColumn confirms an injection-shaped sort param
// can never surface a raw column: it always collapses to an allow-listed
// identifier (the SQL-injection guard for the ORDER BY splice).
func TestNormalizeSortNeverRawColumn(t *testing.T) {
	allowed := map[string]bool{
		"updated_at": true, "created_at": true, "email": true,
		"mailchimp_status": true, "engagement_score": true,
		"first_name": true, "last_name": true,
		// SUB-038 — churn/rating joined the server-sort allow-list.
		"churn_score": true, "rating": true,
	}
	for _, evil := range []string{
		"email; DROP TABLE subscribers",
		"(SELECT 1)",
		"updated_at--",
		"random()",
		"id",
	} {
		col, dir := normalizeSort(evil, "asc")
		if !allowed[col] {
			t.Fatalf("normalizeSort(%q) leaked column %q", evil, col)
		}
		if dir != "ASC" && dir != "DESC" {
			t.Fatalf("normalizeSort(%q) leaked direction %q", evil, dir)
		}
	}
}

// TestNormalizeCreateNamesAndLocalization covers SUB-004 name trimming and
// SUB-005 localization normalisation/validation on the create path.
func TestNormalizeCreateNamesAndLocalization(t *testing.T) {
	in := CreateInput{
		Email:       "a@b.com",
		FirstName:   "  Ada  ",
		LastName:    " Lovelace ",
		FullName:    "  Ada Lovelace ",
		DisplayName: " Countess ",
		Locale:      " en-US ",
		Language:    " EN ",
		Country:     " us ",
		Region:      " California ",
	}
	if err := normalizeCreate(&in); err != nil {
		t.Fatalf("normalizeCreate: %v", err)
	}
	if in.FirstName != "Ada" || in.LastName != "Lovelace" || in.FullName != "Ada Lovelace" || in.DisplayName != "Countess" {
		t.Fatalf("name trim wrong: %+v", in)
	}
	if in.Locale != "en-US" || in.Language != "en" || in.Country != "US" || in.Region != "California" {
		t.Fatalf("localization normalise wrong: locale=%q lang=%q country=%q region=%q",
			in.Locale, in.Language, in.Country, in.Region)
	}
}

func TestNormalizeCreateRejectsBadLocalization(t *testing.T) {
	cases := []struct {
		name string
		in   CreateInput
	}{
		{"3-letter language", CreateInput{Email: "a@b.com", Language: "eng"}},
		{"numeric country", CreateInput{Email: "a@b.com", Country: "U1"}},
		{"overlong locale", CreateInput{Email: "a@b.com", Locale: strings.Repeat("x", 40)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			if err := normalizeCreate(&in); err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
}

// TestNormalizeUpdateLocalization confirms PATCH-path normalisation casing +
// validation for the localization pointer fields (SUB-005).
func TestNormalizeUpdateLocalization(t *testing.T) {
	lang := " Pt "
	country := " br "
	in := UpdateInput{Language: &lang, Country: &country}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("normalizeUpdate: %v", err)
	}
	if *in.Language != "pt" || *in.Country != "BR" {
		t.Fatalf("update localization normalise wrong: lang=%q country=%q", *in.Language, *in.Country)
	}
	bad := "xyz"
	badIn := UpdateInput{Language: &bad}
	if err := normalizeUpdate(&badIn); err == nil {
		t.Fatal("expected error for 3-letter language on update")
	}
}

// TestValidateLocalization unit-tests the shared ISO sanity checks.
func TestValidateLocalization(t *testing.T) {
	if err := validateLocalization("en-US", "en", "US"); err != nil {
		t.Errorf("valid localization rejected: %v", err)
	}
	if err := validateLocalization("", "", ""); err != nil {
		t.Errorf("all-empty should pass: %v", err)
	}
	if err := validateLocalization("", "eng", ""); err == nil {
		t.Error("3-letter language should be rejected")
	}
	if err := validateLocalization("", "", "USA"); err == nil {
		t.Error("3-letter country should be rejected")
	}
}
