package assets

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func clearR2Env(t *testing.T) {
	t.Helper()
	t.Setenv("R2_BUCKET", "")
	t.Setenv("R2_ENDPOINT", "")
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	t.Setenv("R2_PUBLIC_BASE", "")
}

func TestSelectStorageProductionRequiresDurableBackend(t *testing.T) {
	clearR2Env(t)

	store, err := selectStorage(true)
	if err == nil {
		t.Fatalf("expected production storage config error, got %T", store)
	}
	if !strings.Contains(err.Error(), "POSTWAVE_ASSETS_BUCKET") || !strings.Contains(err.Error(), "R2_") {
		t.Fatalf("expected S3 and optional R2 guidance, got %v", err)
	}
}

func TestSelectStorageDevUsesFilesystemFallback(t *testing.T) {
	clearR2Env(t)
	t.Setenv("POSTWAVE_DATA_DIR", "/tmp/postwave-assets-test")

	store, err := selectStorage(false)
	if err != nil {
		t.Fatalf("dev storage fallback: %v", err)
	}
	fs, ok := store.(*FSStorage)
	if !ok {
		t.Fatalf("expected FSStorage fallback, got %T", store)
	}
	if !strings.HasSuffix(fs.Root, "/tmp/postwave-assets-test/assets") {
		t.Fatalf("unexpected filesystem root: %q", fs.Root)
	}
}

func TestSelectStorageUsesR2WhenConfigured(t *testing.T) {
	t.Setenv("R2_BUCKET", "postwave-assets")
	t.Setenv("R2_ENDPOINT", "https://example.r2.cloudflarestorage.com/")
	t.Setenv("R2_ACCESS_KEY_ID", "access")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("R2_PUBLIC_BASE", "https://assets.example.com/")

	store, err := selectStorage(true)
	if err != nil {
		t.Fatalf("configured R2 storage: %v", err)
	}
	r2, ok := store.(*R2Storage)
	if !ok {
		t.Fatalf("expected R2Storage, got %T", store)
	}
	if r2.Bucket != "postwave-assets" || r2.PublicBase != "https://assets.example.com" {
		t.Fatalf("unexpected R2 config: %+v", r2)
	}
}

func TestSelectStorageProductionR2RequiresExplicitSafePublicBase(t *testing.T) {
	t.Setenv("R2_BUCKET", "postwave-assets")
	t.Setenv("R2_ENDPOINT", "https://account.r2.cloudflarestorage.com")
	t.Setenv("R2_ACCESS_KEY_ID", "access")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	for _, publicBase := range []string{"", "http://assets.example.com", "https://localhost/assets", "https://assets.example.com/?token=secret", "https://account.r2.cloudflarestorage.com/postwave-assets"} {
		t.Setenv("R2_PUBLIC_BASE", publicBase)
		if store, err := selectStorage(true); err == nil {
			t.Errorf("public base %q accepted in production as %T", publicBase, store)
		}
	}
	t.Setenv("R2_ENDPOINT", "http://account.r2.cloudflarestorage.com")
	t.Setenv("R2_PUBLIC_BASE", "https://assets.example.com")
	if store, err := selectStorage(true); err == nil {
		t.Errorf("insecure R2 API endpoint accepted in production as %T", store)
	}
}

func TestR2PutSetsImmutableDeliveryMetadata(t *testing.T) {
	var cacheControl, disposition string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cacheControl = r.Header.Get("Cache-Control")
		disposition = r.Header.Get("Content-Disposition")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	store := &R2Storage{
		Endpoint: upstream.URL, Bucket: "bucket", AccessKey: "access", SecretKey: "secret",
		PublicBase: "https://assets.example.com", HTTPClient: upstream.Client(),
	}
	got, err := store.Put(context.Background(), "asset/logo.png", "image/png", []byte("png"))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if got != "https://assets.example.com/asset/logo.png" {
		t.Fatalf("public URL = %q", got)
	}
	if cacheControl != "public, max-age=31536000, immutable" || disposition != "inline" {
		t.Fatalf("delivery metadata cache=%q disposition=%q", cacheControl, disposition)
	}
}

func TestR2PutRejectsMissingPublicDeliveryConfigWithoutNetwork(t *testing.T) {
	store := &R2Storage{Endpoint: "https://account.r2.cloudflarestorage.com", Bucket: "bucket"}
	if _, err := store.Put(context.Background(), "asset/logo.png", "image/png", []byte("png")); err == nil {
		t.Fatal("R2 Put accepted missing public base and HTTP client")
	}
}

func TestR2PutErrorBodyIsCapped(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", 8192)))
	}))
	defer upstream.Close()

	store := &R2Storage{
		Endpoint:   upstream.URL,
		Bucket:     "bucket",
		AccessKey:  "access",
		SecretKey:  "secret",
		PublicBase: "https://assets.example.test",
		HTTPClient: upstream.Client(),
	}
	_, err := store.Put(context.Background(), "k.png", "image/png", []byte("body"))
	if err == nil {
		t.Fatal("expected r2 error")
	}
	if strings.Count(err.Error(), "x") != 4096 {
		t.Fatalf("error body was not capped: %d x bytes in %q", strings.Count(err.Error(), "x"), err.Error())
	}
}

func TestFSStorageRejectsEscapingKeys(t *testing.T) {
	root := t.TempDir()
	store := &FSStorage{Root: root}

	if _, err := store.Put(context.Background(), "../escape.png", "image/png", []byte("x")); err == nil {
		t.Fatal("expected traversal key to be rejected")
	}
	if _, err := os.Stat(filepath.Join(root, "..", "escape.png")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("escape file should not exist, stat err=%v", err)
	}
	if _, _, err := store.Open(context.Background(), "../escape.png"); err == nil {
		t.Fatal("expected traversal open to be rejected")
	}
}

func TestFSStorageRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	store := &FSStorage{Root: root}
	if _, err := store.Put(context.Background(), "escape/upload.png", "image/png", []byte("private")); err == nil {
		t.Fatal("expected symlink escape to be rejected")
	}
	if _, err := os.Stat(filepath.Join(outside, "upload.png")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("symlink escape wrote outside the root: %v", err)
	}
}

func TestFSStorageRoundTripsSafeKey(t *testing.T) {
	root := t.TempDir()
	store := &FSStorage{Root: root}

	publicURL, err := store.Put(context.Background(), "asset123/logo.png", "image/png", []byte("png"))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if publicURL != "/api/v1/assets/asset123/blob" {
		t.Fatalf("publicURL = %q", publicURL)
	}
	rc, _, err := store.Open(context.Background(), "asset123/logo.png")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = rc.Close() }()
}

func TestSanitizeAssetFilenameForStorageKey(t *testing.T) {
	cases := map[string]string{
		"hello world.png":       "hello_world.png",
		"../evil.svg":           "evil.png",
		"...":                   "upload.png",
		"team/logo\r\n.png":     "logo__.png",
		"ümlaut and space.webp": "_mlaut_and_space.png",
	}
	for in, want := range cases {
		if got := sanitizeAssetFilename(in, "image/png"); got != want {
			t.Fatalf("sanitizeAssetFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
