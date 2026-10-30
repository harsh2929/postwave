package forms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// mockUploadStore satisfies UploadStore without touching the network.
type mockUploadStore struct {
	calls          []mockPresignCall
	headers        map[string]string
	lastHeaderMIME string
}

type mockPresignCall struct {
	key, mime string
	size      int64
	ttl       time.Duration
}

func (m *mockUploadStore) Presign(_ context.Context, key, mime string, size int64, ttl time.Duration) (string, string, error) {
	m.calls = append(m.calls, mockPresignCall{key: key, mime: mime, size: size, ttl: ttl})
	return "https://upload.test/" + key, "", nil
}

func (m *mockUploadStore) Delete(_ context.Context, _ string) error { return nil }

func (m *mockUploadStore) PresignPutHeaders(mime string) map[string]string {
	m.lastHeaderMIME = mime
	return m.headers
}

func TestPresignPutHeadersNormalizesAndCopies(t *testing.T) {
	store := &mockUploadStore{headers: map[string]string{
		"Content-Type":                 "image/png",
		"x-amz-server-side-encryption": "aws:kms",
	}}
	got := presignPutHeaders(store, " IMAGE/PNG ; charset=binary ")
	if got["Content-Type"] != "image/png" {
		t.Fatalf("content type = %q", got["Content-Type"])
	}
	if store.lastHeaderMIME != "image/png" {
		t.Fatalf("provider MIME = %q, want normalized image/png", store.lastHeaderMIME)
	}
	got["Content-Type"] = "text/plain"
	if store.headers["Content-Type"] != "image/png" {
		t.Fatal("response headers must not alias the backend map")
	}
	if headers := presignPutHeaders(&LocalUploadStore{}, "text/plain"); headers != nil {
		t.Fatalf("local store headers = %#v, want nil", headers)
	}
}

// TestMimeAllowed locks down the allowlist. Keep these tight — adding a
// new mime is a deliberate decision, not a drift.
func TestMimeAllowed(t *testing.T) {
	good := []string{
		"image/jpeg",
		"image/png",
		"IMAGE/PNG",
		"image/png; charset=binary",
		"  application/pdf  ",
		"text/plain",
	}
	bad := []string{
		"",
		"image/svg+xml",   // explicitly excluded
		"application/zip", // not on the list
		"text/html",
		"application/octet-stream",
		"image/jpegg",
	}
	for _, m := range good {
		if !MimeAllowed(m) {
			t.Errorf("MimeAllowed(%q) = false, want true", m)
		}
	}
	for _, m := range bad {
		if MimeAllowed(m) {
			t.Errorf("MimeAllowed(%q) = true, want false", m)
		}
	}
}

func TestNormalizeUploadMime(t *testing.T) {
	if got := NormalizeUploadMime(" IMAGE/PNG ; charset=binary "); got != "image/png" {
		t.Fatalf("NormalizeUploadMime() = %q, want image/png", got)
	}
}

func TestMaxUploadBytes_MatchesPublicContract(t *testing.T) {
	if MaxUploadBytes != 25*1024*1024 {
		t.Fatalf("MaxUploadBytes = %d, want 25 MiB", MaxUploadBytes)
	}
}

func TestUploadQuotaAllowsIsOverflowSafe(t *testing.T) {
	quota := int64(100)
	for _, tc := range []struct {
		reserved  int64
		requested int64
		want      bool
	}{
		{0, 100, true},
		{75, 25, true},
		{76, 25, false},
		{0, 101, false},
		{-1, 1, false},
		{0, 0, false},
	} {
		if got := uploadQuotaAllows(tc.reserved, tc.requested, quota); got != tc.want {
			t.Fatalf("reserved=%d requested=%d got=%v want=%v", tc.reserved, tc.requested, got, tc.want)
		}
	}
}

// TestNewUploadID — IDs are unique-ish + canonical-shaped.
func TestNewUploadID(t *testing.T) {
	a, err := newUploadID()
	if err != nil {
		t.Fatal(err)
	}
	if !isUUIDLike(a) {
		t.Errorf("newUploadID() = %q, not uuid-like", a)
	}
	b, _ := newUploadID()
	if a == b {
		t.Errorf("two consecutive ids collided: %q", a)
	}
}

// TestIsUUIDLike — only the canonical 8-4-4-4-12 hex form.
func TestIsUUIDLike(t *testing.T) {
	good := []string{
		"00000000-0000-4000-8000-000000000000",
		"abcdef01-2345-6789-abcd-ef0123456789",
	}
	bad := []string{
		"",
		"not-a-uuid",
		"00000000000040008000000000000000",     // no dashes
		"00000000-0000-4000-8000-00000000000",  // too short
		"zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", // bad hex
	}
	for _, s := range good {
		if !isUUIDLike(s) {
			t.Errorf("isUUIDLike(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if isUUIDLike(s) {
			t.Errorf("isUUIDLike(%q) = true, want false", s)
		}
	}
}

// TestSanitizeFilename — basic safety.
func TestSanitizeFilename(t *testing.T) {
	cases := map[string]string{
		"resume.pdf":         "resume.pdf",
		"../../etc/passwd":   "passwd",
		"my file.png":        "my_file.png",
		"":                   "file",
		"foo\x00bar.txt":     "foo_bar.txt",
		"weird/sub/dir/.bin": "bin",
		"..":                 "file",
		"resume..pdf":        "resume.pdf",
	}
	for in, want := range cases {
		if got := sanitizeFilename(in); got != want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestPresign_ValidatesMime — bad mime is rejected without hitting the store.
func TestPresign_ValidatesMime(t *testing.T) {
	store := &mockUploadStore{}
	u := &Uploads{Store: store}
	_, _, _, err := u.Presign(context.Background(), "t1", "f1", "x.zip", "application/zip", 1024)
	if err == nil {
		t.Fatal("expected mime rejection")
	}
	if !strings.Contains(err.Error(), "mime") {
		t.Errorf("expected mime error, got %v", err)
	}
	if len(store.calls) != 0 {
		t.Errorf("store should not have been called on bad mime, got %d calls", len(store.calls))
	}
}

// TestPresign_ValidatesSize — over-cap is rejected, zero is rejected.
func TestPresign_ValidatesSize(t *testing.T) {
	store := &mockUploadStore{}
	u := &Uploads{Store: store}
	if _, _, _, err := u.Presign(context.Background(), "t1", "f1", "x.pdf", "application/pdf", 0); err == nil {
		t.Error("expected zero-size rejection")
	}
	if _, _, _, err := u.Presign(context.Background(), "t1", "f1", "x.pdf", "application/pdf", MaxUploadBytes+1); err == nil {
		t.Error("expected over-cap rejection")
	}
	if len(store.calls) != 0 {
		t.Errorf("store should not have been called on bad size, got %d calls", len(store.calls))
	}
}

func TestQuarantineStorageKeyBindsTenantFormAndUpload(t *testing.T) {
	got := quarantineStorageKey("T1", "F1", "U1", "resume.pdf")
	if got != "quarantine/tenant/T1/form/F1/U1/resume.pdf" {
		t.Fatalf("quarantine key = %q", got)
	}
	if !strings.HasSuffix(got, "/resume.pdf") {
		t.Fatalf("quarantine key lost filename: %q", got)
	}
}

// TestIPRateLimiter_AllowsThenBlocks — 10 events succeed, 11th blocked.
func TestIPRateLimiter_AllowsThenBlocks(t *testing.T) {
	var l ipRateLimiter
	for i := 0; i < 10; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("call %d unexpectedly blocked", i+1)
		}
	}
	if l.allow("1.2.3.4") {
		t.Error("11th call should be blocked")
	}
	// Different IP unaffected.
	if !l.allow("9.9.9.9") {
		t.Error("different IP should be allowed")
	}
}

func TestFormClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	if err := middleware.SetTrustedProxyCIDRs(nil); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/forms/example/submit", nil)
	req.RemoteAddr = "198.51.100.10:4321"
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	if got := clientIP(req, true); got != "198.51.100.10" {
		t.Fatalf("client IP = %q, want verified TCP peer", got)
	}
}

// TestFilterUUIDs — strips junk values from a free-form custom-fields map.
func TestFilterUUIDs(t *testing.T) {
	in := []string{
		"abcdef01-2345-6789-abcd-ef0123456789",
		"not-a-uuid",
		"",
		"00000000-0000-4000-8000-000000000000",
	}
	got := filterUUIDs(in)
	if len(got) != 2 {
		t.Fatalf("got %v, want 2 entries", got)
	}
}

func TestSafeRelPath(t *testing.T) {
	good := []string{
		"tenant/t/form/f/upload/resume.pdf",
		"tenant/t/form/f/upload/resume..pdf",
	}
	bad := []string{
		"",
		"/absolute",
		`tenant\t`,
		"tenant//double",
		"tenant/./x",
		"tenant/../x",
		"tenant/file name.pdf",
		"tenant/x\x00y",
		"tenant/x\ny",
		strings.Repeat("a", maxLocalUploadKeyBytes+1),
	}
	for _, key := range good {
		if !safeRelPath(key) {
			t.Errorf("safeRelPath(%q) = false, want true", key)
		}
	}
	for _, key := range bad {
		if safeRelPath(key) {
			t.Errorf("safeRelPath(%q) = true, want false", key)
		}
	}
}

func TestSafeLocalUploadPathStaysUnderRoot(t *testing.T) {
	root := t.TempDir()
	full, err := safeLocalUploadPath(root, "tenant/t/form/f/upload/resume.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(full, root) {
		t.Fatalf("path %q does not stay below %q", full, root)
	}
	if _, err := safeLocalUploadPath(root, "../escape"); err == nil {
		t.Fatal("expected escaping path to be rejected")
	}
}

func TestLocalUploadStorePresignRejectsUnsafeKeys(t *testing.T) {
	store := &LocalUploadStore{BaseDir: t.TempDir(), PublicBase: "http://localhost:8080"}
	if _, _, err := store.Presign(context.Background(), "../escape", "text/plain", 1, time.Minute); err == nil {
		t.Fatal("expected traversal key to be rejected")
	}

	putURL, getURL, err := store.Presign(context.Background(), "tenant/t/form/f/upload/resume.pdf", "application/pdf", 7, time.Minute)
	if err != nil {
		t.Fatalf("presign valid key: %v", err)
	}
	if getURL != "" {
		t.Fatalf("getURL = %q; quarantine presign must not mint a read capability", getURL)
	}
	if !strings.Contains(putURL, "/api/internal/uploads/tenant%2Ft%2Fform%2Ff%2Fupload%2Fresume.pdf?size=7") {
		t.Fatalf("unexpected presigned URL: %q", putURL)
	}
}

func TestLocalUploadStoreServePutUsesStructuredErrors(t *testing.T) {
	store := &LocalUploadStore{BaseDir: t.TempDir()}
	req := httptest.NewRequest(http.MethodPut, "/api/internal/uploads/%2e%2e%2fescape?size=1", strings.NewReader("x"))
	rec := httptest.NewRecorder()

	store.ServePut(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want JSON", ct)
	}
	if !strings.Contains(rec.Body.String(), "bad_key") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestLocalUploadStoreServePutRejectsPresignSizeMismatch(t *testing.T) {
	store := &LocalUploadStore{BaseDir: t.TempDir()}
	req := httptest.NewRequest(http.MethodPut, "/api/internal/uploads/tenant/t/file.txt?size=2", strings.NewReader("three"))
	rec := httptest.NewRecorder()
	store.ServePut(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "size_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLocalUploadStoreDeleteIsSafeAndIdempotent(t *testing.T) {
	root := t.TempDir()
	store := &LocalUploadStore{BaseDir: root}
	key := "tenant/t/form/f/upload/resume.pdf"
	full := filepath.Join(root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("resume"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	if _, err := os.Stat(full); !os.IsNotExist(err) {
		t.Fatalf("deleted file still exists or stat failed unexpectedly: %v", err)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if err := store.Delete(context.Background(), "../escape"); err == nil {
		t.Fatal("expected traversal delete key to be rejected")
	}
}

func TestLocalUploadStoreRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "tenant")); err != nil {
		t.Fatalf("create escaping symlink fixture: %v", err)
	}
	store := &LocalUploadStore{BaseDir: root}
	if _, err := store.Open(context.Background(), "tenant/secret.txt"); err == nil {
		t.Fatal("expected open through escaping symlink to fail")
	}

	req := httptest.NewRequest(http.MethodPut, "/api/internal/uploads/tenant/new.txt?size=1", strings.NewReader("x"))
	rec := httptest.NewRecorder()
	store.ServePut(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("symlinked upload status = %d, want 500", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("upload escaped storage root: %v", err)
	}
	if err := store.Delete(context.Background(), "tenant/secret.txt"); err == nil {
		t.Fatal("expected delete through escaping symlink to fail")
	}
}
