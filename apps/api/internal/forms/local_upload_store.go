package forms

// LocalUploadStore — dev / test only. Production MUST use S3UploadStore
// (or another cloud equivalent) so uploaded files don't live on the
// gateway's local disk and survive a deploy.
//
// In dev we want zero-config: the developer runs the gateway and the
// browser PUTs files at a route the gateway itself serves, which writes
// them to os.TempDir()/postwave-uploads/. The same gateway can hand out
// signed-look-alike URLs that point back at itself. Switching to S3
// is a one-line wiring change in main.go (read POSTWAVE_UPLOADS_BUCKET
// and pick the impl).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const maxLocalUploadKeyBytes = 1024

// LocalUploadStore writes uploads under a single base directory and
// returns URLs of the form `<PublicBase>/api/internal/uploads/<key>`.
// The PUT handler at that route is ServePut.
type LocalUploadStore struct {
	// BaseDir is the on-disk root (default os.TempDir()/postwave-uploads).
	BaseDir string
	// PublicBase is the URL prefix the browser uses to PUT — typically
	// "" (same origin) or "http://localhost:8080" in dev.
	PublicBase string
}

// NewLocalUploadStore constructs a store with sensible defaults for a
// dev environment. Returns an error if BaseDir cannot be created.
func NewLocalUploadStore(publicBase string) (*LocalUploadStore, error) {
	dir := filepath.Join(os.TempDir(), "moosewave-uploads")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("local upload store: %w", err)
	}
	return &LocalUploadStore{BaseDir: dir, PublicBase: publicBase}, nil
}

// Presign returns URLs that point back at the same gateway's
// /api/internal/uploads/{key:.+} route. The URLs aren't cryptographic;
// in dev that's fine. Production must not use this store.
func (s *LocalUploadStore) Presign(_ context.Context, key, _ string, size int64, _ time.Duration) (putURL, getURL string, err error) {
	if !safeRelPath(key) {
		return "", "", errors.New("local upload store: invalid key")
	}
	if size <= 0 || size > MaxUploadBytes {
		return "", "", errors.New("local upload store: invalid expected size")
	}
	base := strings.TrimRight(s.PublicBase, "/")
	uploadPath := "/api/internal/uploads/" + url.PathEscape(key)
	// We deliberately url.PathEscape the key as a single component so
	// '/' and other meta-bytes survive the round trip.
	put := base + uploadPath + "?size=" + strconv.FormatInt(size, 10)
	// Never mint a read capability before malware scanning returns clean.
	return put, "", nil
}

// Delete removes a locally stored upload. Missing objects are already clean,
// matching the idempotent UploadStore contract used by the orphan sweeper.
func (s *LocalUploadStore) Delete(_ context.Context, key string) error {
	if !safeRelPath(key) {
		return errors.New("local upload store: invalid key")
	}
	root, err := os.OpenRoot(s.BaseDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("local upload store: open delete root: %w", err)
	}
	defer func() { _ = root.Close() }()
	if err := root.Remove(key); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("local upload store: delete: %w", err)
	}
	return nil
}

func (s *LocalUploadStore) Open(_ context.Context, key string) (io.ReadCloser, error) {
	if !safeRelPath(key) {
		return nil, errors.New("local upload store: invalid key")
	}
	root, err := os.OpenRoot(s.BaseDir)
	if err != nil {
		return nil, fmt.Errorf("local upload store: open root: %w", err)
	}
	body, err := root.Open(key)
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("local upload store: open: %w", err)
	}
	return &rootedLocalUploadFile{File: body, root: root}, nil
}

type rootedLocalUploadFile struct {
	*os.File
	root *os.Root
}

func (f *rootedLocalUploadFile) Close() error {
	fileErr := f.File.Close()
	rootErr := f.root.Close()
	if fileErr != nil {
		return fileErr
	}
	return rootErr
}

// ServePut is the dev-only HTTP handler that writes the request body
// to disk under BaseDir/<key>. Mounted in main.go at:
//
//	router.Put("/api/internal/uploads/{key:.+}", local.ServePut)
//
// We cap the read at MaxUploadBytes+1 so a misbehaving client can't
// fill /tmp.
func (s *LocalUploadStore) ServePut(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", http.MethodPut)
		writeLocalUploadError(w, http.StatusMethodNotAllowed, "method_not_allowed", "PUT required")
		return
	}
	keyParam := chi.URLParam(r, "key")
	if keyParam == "" {
		// Fall back to scanning the path tail when chi isn't used (tests).
		keyParam = strings.TrimPrefix(r.URL.Path, "/api/internal/uploads/")
	}
	key, pathErr := url.PathUnescape(keyParam)
	if pathErr != nil || key == "" {
		writeLocalUploadError(w, http.StatusBadRequest, "bad_key", "invalid upload key")
		return
	}
	if !safeRelPath(key) {
		writeLocalUploadError(w, http.StatusBadRequest, "bad_key", "invalid upload key")
		return
	}
	expectedSize, pathErr := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("size")), 10, 64)
	if pathErr != nil || expectedSize <= 0 || expectedSize > MaxUploadBytes {
		writeLocalUploadError(w, http.StatusBadRequest, "bad_size", "valid signed upload size required")
		return
	}
	if r.ContentLength >= 0 && r.ContentLength != expectedSize {
		writeLocalUploadError(w, http.StatusBadRequest, "size_mismatch", "upload size does not match presign")
		return
	}
	// #nosec G703 -- BaseDir is operator-controlled development configuration;
	// every caller-controlled path below is confined by os.Root.
	if pathErr := os.MkdirAll(s.BaseDir, 0o700); pathErr != nil {
		writeLocalUploadError(w, http.StatusInternalServerError, "storage_unavailable", "upload directory unavailable")
		return
	}
	root, pathErr := os.OpenRoot(s.BaseDir)
	if pathErr != nil {
		writeLocalUploadError(w, http.StatusInternalServerError, "storage_unavailable", "upload directory unavailable")
		return
	}
	defer func() { _ = root.Close() }()
	if pathErr := root.MkdirAll(path.Dir(key), 0o700); pathErr != nil {
		writeLocalUploadError(w, http.StatusInternalServerError, "storage_unavailable", "upload directory unavailable")
		return
	}
	f, pathErr := root.OpenFile(key, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if pathErr != nil {
		writeLocalUploadError(w, http.StatusInternalServerError, "storage_unavailable", "upload file unavailable")
		return
	}
	defer func() { _ = f.Close() }()
	n, pathErr := httpbody.CopyAtMost(f, r.Body, expectedSize)
	if pathErr != nil {
		_ = root.Remove(key)
		if errors.Is(pathErr, httpbody.ErrTooLarge) {
			httpbody.WriteError(w, pathErr)
			return
		}
		writeLocalUploadError(w, http.StatusInternalServerError, "write_failed", "upload write failed")
		return
	}
	if n != expectedSize {
		_ = root.Remove(key)
		writeLocalUploadError(w, http.StatusBadRequest, "size_mismatch", "upload size does not match presign")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// safeRelPath rejects keys that try to escape the base dir or use
// platform-meaningful prefixes. We don't need to be exhaustive — we
// already control the keys we hand out via Presign — but we treat the
// PUT endpoint as an attacker-controllable surface anyway.
func safeRelPath(key string) bool {
	if key == "" || len(key) > maxLocalUploadKeyBytes || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(key)))
	if clean == "." || clean != key {
		return false
	}
	parts := strings.Split(key, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '/' || r == '.' || r == '-' || r == '_':
			continue
		default:
			return false
		}
	}
	return true
}

func safeLocalUploadPath(baseDir, key string) (string, error) {
	base, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	full, err := filepath.Abs(filepath.Join(base, filepath.FromSlash(key)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, full)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." || filepath.IsAbs(rel) {
		return "", errors.New("path escapes upload root")
	}
	return full, nil
}

func writeLocalUploadError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
