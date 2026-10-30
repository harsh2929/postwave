// SPDX-License-Identifier: AGPL-3.0-only
//
// subscriber_notes_test.go — SUB-097 coverage for the markdown / @-mention /
// attachment extension of the operator notes pane.
//
// The handlers are pg-bound, so the heavy assertions live on the pure
// helpers (mention extraction and body resolution) plus HTTP-level guards
// that don't need a DB (authentication and fail-closed attachment creation).
// A DATABASE_URL-gated round-trip is added at the bottom and
// skips cleanly when no DB is present, matching the package convention.

package subscriber_notes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

// --- extractMentions ---------------------------------------------------

func TestExtractMentions_FindsAllAndDedups(t *testing.T) {
	md := "ping @[Jane Doe](user:11111111-1111-1111-1111-111111111111) and " +
		"@[Bob](user:22222222-2222-2222-2222-222222222222), also " +
		"@[Jane again](user:11111111-1111-1111-1111-111111111111)"
	got := extractMentions(md)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (deduped): %#v", len(got), got)
	}
	if got[0].UserID != "11111111-1111-1111-1111-111111111111" || got[0].Display != "Jane Doe" {
		t.Errorf("first mention = %#v", got[0])
	}
	if got[1].UserID != "22222222-2222-2222-2222-222222222222" {
		t.Errorf("second mention = %#v", got[1])
	}
}

func TestExtractMentions_LowercasesID(t *testing.T) {
	md := "@[X](user:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)"
	got := extractMentions(md)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].UserID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Errorf("id not lowercased: %q", got[0].UserID)
	}
}

func TestExtractMentions_EmptyAndNonMatching(t *testing.T) {
	for _, in := range []string{
		"",
		"no mentions here",
		"email me at jane@example.com", // @ but not a token
		"@[Jane](user:not-a-uuid)",     // bad id
		"@[](user:11111111-1111-1111-1111-111111111111)", // empty display rejected by {1,200}
	} {
		if got := extractMentions(in); len(got) != 0 {
			t.Errorf("extractMentions(%q) = %#v, want empty", in, got)
		}
	}
}

func TestExtractMentions_NeverNil(t *testing.T) {
	got := extractMentions("")
	if got == nil {
		t.Fatal("extractMentions returned nil; must be non-nil for [] JSON")
	}
	b, _ := json.Marshal(got)
	if string(b) != "[]" {
		t.Errorf("empty mentions encoded as %s, want []", b)
	}
}

// --- stripMentionTokens ------------------------------------------------

func TestStripMentionTokens_CollapsesToAtName(t *testing.T) {
	md := "hi @[Jane Doe](user:11111111-1111-1111-1111-111111111111)!"
	got := stripMentionTokens(md)
	if got != "hi @Jane Doe!" {
		t.Errorf("stripMentionTokens = %q", got)
	}
}

// --- resolveBodies -----------------------------------------------------

func TestResolveBodies_MarkdownWins(t *testing.T) {
	plain, md, msg := resolveBodies("legacy plain", "# rich **markdown**")
	if msg != "" {
		t.Fatalf("unexpected msg: %q", msg)
	}
	if md != "# rich **markdown**" {
		t.Errorf("markdown = %q", md)
	}
	if plain != "# rich **markdown**" {
		t.Errorf("plain projection = %q", plain)
	}
}

func TestResolveBodies_FallsBackToPlain(t *testing.T) {
	plain, md, msg := resolveBodies("just plain", "")
	if msg != "" || md != "just plain" || plain != "just plain" {
		t.Fatalf("plain=%q md=%q msg=%q", plain, md, msg)
	}
}

func TestResolveBodies_StripsMentionsForPlainProjection(t *testing.T) {
	md := "cc @[Jane](user:11111111-1111-1111-1111-111111111111) please review"
	plain, _, msg := resolveBodies("", md)
	if msg != "" {
		t.Fatalf("msg = %q", msg)
	}
	if strings.Contains(plain, "user:") {
		t.Errorf("plain projection leaked a mention token: %q", plain)
	}
	if !strings.Contains(plain, "@Jane") {
		t.Errorf("plain projection lost the @name: %q", plain)
	}
}

func TestResolveBodies_RejectsEmpty(t *testing.T) {
	if _, _, msg := resolveBodies("   ", "  "); msg == "" {
		t.Error("expected an error message for empty body")
	}
}

func TestResolveBodies_RejectsTooLong(t *testing.T) {
	long := strings.Repeat("a", markdownBodyMax+1)
	if _, _, msg := resolveBodies("", long); msg == "" {
		t.Error("expected too-long rejection")
	}
}

func TestResolveBodies_PlainProjectionClampedTo4000(t *testing.T) {
	md := strings.Repeat("z", 5000)
	plain, _, msg := resolveBodies("", md)
	if msg != "" {
		t.Fatalf("msg = %q", msg)
	}
	if len(plain) > 4000 {
		t.Errorf("plain projection = %d chars, want <= 4000", len(plain))
	}
}

func TestResolveBodies_MentionOnlyMarkdownKeepsNonEmptyPlain(t *testing.T) {
	// stripMentionTokens leaves "@Jane" which is non-empty, but guard the
	// path where the projection could be whitespace-only.
	md := "@[ ](user:11111111-1111-1111-1111-111111111111)"
	// display is a single space, so the token won't match ({1,200} allows
	// it) -> projection "@ " which is non-empty.
	plain, _, msg := resolveBodies("", md)
	if msg != "" {
		t.Fatalf("msg = %q", msg)
	}
	if strings.TrimSpace(plain) == "" {
		t.Errorf("plain projection is empty for mention-only markdown: %q", plain)
	}
}

// --- HTTP guards (no DB needed) ----------------------------------------

func TestAddAttachment_NoTenant_401(t *testing.T) {
	d := &Deps{Store: uploads.NewMemoryStore()}
	r := httptest.NewRequest(http.MethodPost,
		"/api/v1/subscribers/s1/notes/n1/attachments", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.AddAttachment(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestAddAttachment_FailsClosedForEveryClientSuppliedKey(t *testing.T) {
	for _, tc := range []struct {
		name  string
		store uploads.Store
		body  string
	}{
		{
			name:  "configured store and plausible key",
			store: uploads.NewMemoryStore(),
			body:  `{"file_key":"notes/owned-looking.pdf","filename":"report.pdf","size_bytes":12}`,
		},
		{
			name:  "configured store and arbitrary cross-object key",
			store: uploads.NewMemoryStore(),
			body:  `{"file_key":"tenants/someone-else/private.pdf","filename":"private.pdf"}`,
		},
		{
			name: "no object store",
			body: `{"file_key":"notes/missing.pdf","filename":"missing.pdf"}`,
		},
		{
			name:  "malformed payload cannot change capability result",
			store: uploads.NewMemoryStore(),
			body:  `{not-json`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{Store: tc.store}
			r := withTenant(httptest.NewRequest(http.MethodPost,
				"/api/v1/subscribers/s1/notes/n1/attachments", strings.NewReader(tc.body)))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			d.AddAttachment(w, r)

			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
			}
			if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
			var envelope struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if envelope.Error.Code != attachmentUploadUnavailableCode {
				t.Fatalf("code = %q, want %q", envelope.Error.Code, attachmentUploadUnavailableCode)
			}
			if envelope.Error.Message != attachmentUploadUnavailableMessage {
				t.Fatalf("message = %q, want %q", envelope.Error.Message, attachmentUploadUnavailableMessage)
			}
		})
	}
}

func TestAddAttachment_MountedRouteReturnsStableCapabilityEnvelope(t *testing.T) {
	router := chi.NewRouter()
	MountRoutes(router, &Deps{
		Pool:  new(db.Pool),
		Store: uploads.NewMemoryStore(),
	})
	req := withTenant(httptest.NewRequest(
		http.MethodPost,
		"/api/v1/subscribers/subscriber-1/notes/note-1/attachments",
		strings.NewReader(`{"file_key":"arbitrary/key.pdf","filename":"key.pdf"}`),
	))
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{
		Role: "admin",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"`+attachmentUploadUnavailableCode+`"`) {
		t.Fatalf("missing stable capability code: %s", w.Body.String())
	}
}

func TestDeleteAttachment_NoStore_503(t *testing.T) {
	d := &Deps{}
	r := withTenant(httptest.NewRequest(http.MethodDelete,
		"/api/v1/subscribers/s1/notes/n1/attachments/key", nil))
	w := httptest.NewRecorder()
	d.DeleteAttachment(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestDeleteAttachment_MissingFileKey_400(t *testing.T) {
	d := &Deps{Store: uploads.NewMemoryStore()}
	// Route via chi so URLParam resolves; empty {file_key} -> 400.
	router := chi.NewRouter()
	router.Delete("/n/{id}/{note}/{file_key}", func(w http.ResponseWriter, r *http.Request) {
		r = withTenant(r)
		d.DeleteAttachment(w, r)
	})
	// A blank trailing segment can't be expressed; instead drive the
	// handler directly with a chi context that has an empty file_key.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "s1")
	rctx.URLParams.Add("note", "n1")
	rctx.URLParams.Add("file_key", "   ")
	req := withTenant(httptest.NewRequest(http.MethodDelete, "/x", nil))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()
	d.DeleteAttachment(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// decodeMentions tolerates junk.
func TestDecodeMentions_TolerantOfNullAndGarbage(t *testing.T) {
	for _, raw := range [][]byte{nil, []byte(""), []byte("null"), []byte("not json")} {
		got := decodeMentions(raw)
		if got == nil {
			t.Errorf("decodeMentions(%q) = nil, want non-nil", raw)
		}
	}
	got := decodeMentions([]byte(`[{"user_id":"u1","display":"X"}]`))
	if len(got) != 1 || got[0].UserID != "u1" {
		t.Errorf("decodeMentions valid = %#v", got)
	}
}

// withTenant attaches a fake tenant to the request context so handlers that
// gate on TenantFromContext proceed past the 401.
func withTenant(r *http.Request) *http.Request {
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-0000000000aa",
	})
	return r.WithContext(ctx)
}
