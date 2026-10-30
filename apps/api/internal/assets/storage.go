// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Storage is the abstract upload sink.
type Storage interface {
	Put(ctx context.Context, key, mime string, body []byte) (publicURL string, err error)
	Open(ctx context.Context, key string) (io.ReadCloser, string, error)
	// Delete removes the object identified by key. Idempotent —
	// missing keys are not an error. Used by the retention sweeper
	// to purge tenant_exports ZIPs past their grace window without
	// orphaning the underlying blob in object storage.
	Delete(ctx context.Context, key string) error
}

const maxAssetStorageKeyBytes = 1024

// SelectStorage retains R2 as an optional non-AWS backend. The canonical AWS
// path is injected as S3Storage by main after it loads the task-role AWS
// configuration. Production fails closed when neither backend is configured;
// the local filesystem fallback is dev-only.
func SelectStorage() (Storage, error) {
	return selectStorage(isProductionEnv())
}

func selectStorage(production bool) (Storage, error) {
	if bucket := os.Getenv("R2_BUCKET"); bucket != "" &&
		os.Getenv("R2_ENDPOINT") != "" &&
		os.Getenv("R2_ACCESS_KEY_ID") != "" &&
		os.Getenv("R2_SECRET_ACCESS_KEY") != "" {
		endpoint, err := normalizePublicAssetBase(os.Getenv("R2_ENDPOINT"), production)
		if err != nil {
			return nil, fmt.Errorf("R2_ENDPOINT: %w", err)
		}
		base := strings.TrimSpace(os.Getenv("R2_PUBLIC_BASE"))
		if base == "" && production {
			return nil, fmt.Errorf("R2_PUBLIC_BASE is required in production and must name the HTTPS public delivery hostname, not the private R2 S3 API endpoint")
		}
		if base == "" {
			base = endpoint + "/" + bucket
		}
		publicBase, err := normalizePublicAssetBase(base, production)
		if err != nil {
			return nil, fmt.Errorf("R2_PUBLIC_BASE: %w", err)
		}
		if production {
			publicURL, _ := url.Parse(publicBase)
			publicHost := strings.ToLower(publicURL.Hostname())
			if publicBase == endpoint || publicHost == "r2.cloudflarestorage.com" || strings.HasSuffix(publicHost, ".r2.cloudflarestorage.com") {
				return nil, fmt.Errorf("R2_PUBLIC_BASE must name a public custom domain or r2.dev delivery origin, not the private R2 S3 API endpoint")
			}
		}
		return &R2Storage{
			Endpoint:   endpoint,
			Bucket:     bucket,
			AccessKey:  os.Getenv("R2_ACCESS_KEY_ID"),
			SecretKey:  os.Getenv("R2_SECRET_ACCESS_KEY"),
			PublicBase: publicBase,
			HTTPClient: &http.Client{Timeout: 30 * time.Second},
		}, nil
	}
	if production {
		return nil, fmt.Errorf("durable asset storage is required in production: configure POSTWAVE_ASSETS_BUCKET for the canonical AWS S3 backend or all R2_* settings for the optional alternative")
	}
	root := os.Getenv("POSTWAVE_DATA_DIR")
	if root == "" {
		root = "./data"
	}
	return &FSStorage{Root: filepath.Join(root, "assets")}, nil
}

func isProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

// FSStorage writes blobs to the local filesystem and returns the
// gateway-served blob URL.
type FSStorage struct{ Root string }

func (s *FSStorage) Put(_ context.Context, key, _ string, body []byte) (string, error) {
	if err := validateAssetStorageKey(key); err != nil {
		return "", err
	}
	// #nosec G703 -- Root is operator-controlled development configuration;
	// every caller-controlled path below is confined by os.Root.
	if err := os.MkdirAll(s.Root, 0o700); err != nil {
		return "", err
	}
	root, err := os.OpenRoot(s.Root)
	if err != nil {
		return "", err
	}
	defer func() { _ = root.Close() }()
	if err := root.MkdirAll(path.Dir(key), 0o700); err != nil {
		return "", err
	}
	if err := root.WriteFile(key, body, 0o600); err != nil {
		return "", err
	}
	// The id-of-the-asset is the directory part of the key; the blob URL
	// lives at /api/v1/assets/{id}/blob and is rewired by the handler.
	return "/api/v1/assets/" + strings.SplitN(key, "/", 2)[0] + "/blob", nil
}

// Delete removes the object on disk. Idempotent — a missing file is
// not an error so retried purges (retention sweep) don't fail noisily.
// os.Root enforces the boundary at every filesystem traversal, including when
// an attacker races or pre-creates a symlink below the development data root.
func (s *FSStorage) Delete(_ context.Context, key string) error {
	if err := validateAssetStorageKey(key); err != nil {
		return err
	}
	root, err := os.OpenRoot(s.Root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := root.Remove(key); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *FSStorage) Open(_ context.Context, key string) (io.ReadCloser, string, error) {
	if err := validateAssetStorageKey(key); err != nil {
		return nil, "", err
	}
	root, err := os.OpenRoot(s.Root)
	if err != nil {
		return nil, "", err
	}
	f, err := root.Open(key)
	if err != nil {
		_ = root.Close()
		return nil, "", err
	}
	return &rootedAssetFile{File: f, root: root}, "", nil
}

type rootedAssetFile struct {
	*os.File
	root *os.Root
}

func (f *rootedAssetFile) Close() error {
	fileErr := f.File.Close()
	rootErr := f.root.Close()
	if fileErr != nil {
		return fileErr
	}
	return rootErr
}

// R2Storage is a hand-rolled S3 SigV4 PutObject client. We don't pull in
// aws-sdk-go-v2 because none of the surrounding packages need it; the surface
// we actually exercise is one verb (PUT) against one resource shape.
type R2Storage struct {
	Endpoint   string
	Bucket     string
	AccessKey  string
	SecretKey  string
	PublicBase string
	HTTPClient *http.Client
}

func (s *R2Storage) Put(ctx context.Context, key, mime string, body []byte) (string, error) {
	if err := validateAssetStorageKey(key); err != nil {
		return "", err
	}
	publicBase, err := normalizePublicAssetBase(s.PublicBase, false)
	if err != nil || publicBase != s.PublicBase {
		return "", fmt.Errorf("r2 storage public base is not configured canonically")
	}
	if s.HTTPClient == nil {
		return "", fmt.Errorf("r2 storage HTTP client is not configured")
	}
	endpoint, err := normalizePublicAssetBase(s.Endpoint, false)
	if err != nil || endpoint != s.Endpoint {
		return "", fmt.Errorf("r2 storage endpoint is not configured canonically")
	}
	escapedKey := escapeAssetStorageKey(key)
	rawURL := endpoint + "/" + url.PathEscape(s.Bucket) + "/" + escapedKey
	// #nosec G704 -- endpoint is deploy-time configuration normalized above;
	// the only request-derived component is a strict allowlisted object key.
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mime)
	req.Header.Set("Cache-Control", "public, max-age=31536000, immutable")
	req.Header.Set("Content-Disposition", "inline")
	req.ContentLength = int64(len(body))
	if err := signSigV4(req, body, s.AccessKey, s.SecretKey, "auto", "s3", time.Now().UTC()); err != nil {
		return "", err
	}
	// #nosec G704 -- the signed request target is the validated configured R2
	// endpoint, never a URL supplied by the upload caller.
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("r2 put: status %d: %s", resp.StatusCode, string(errBody))
	}
	return publicBase + "/" + escapedKey, nil
}

func (s *R2Storage) Open(_ context.Context, _ string) (io.ReadCloser, string, error) {
	return nil, "", fmt.Errorf("r2 storage: blobs are served by the public CDN")
}

// Delete sends a SigV4-signed HTTP DELETE for the object. S3-compatible
// endpoints (R2 included) treat DELETE as idempotent — a missing key
// returns 204 — so we don't synthesise an error on not-found. Used by
// the retention sweep for tenant_exports past their grace window.
func (s *R2Storage) Delete(ctx context.Context, key string) error {
	if err := validateAssetStorageKey(key); err != nil {
		return err
	}
	endpoint, err := normalizePublicAssetBase(s.Endpoint, false)
	if err != nil || endpoint != s.Endpoint {
		return fmt.Errorf("r2 storage endpoint is not configured canonically")
	}
	if s.HTTPClient == nil {
		return fmt.Errorf("r2 storage HTTP client is not configured")
	}
	escapedKey := escapeAssetStorageKey(key)
	rawURL := endpoint + "/" + url.PathEscape(s.Bucket) + "/" + escapedKey
	// #nosec G704 -- endpoint is deploy-time configuration normalized above;
	// the only caller-controlled component is a strict allowlisted object key.
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, rawURL, http.NoBody)
	if err != nil {
		return err
	}
	if err := signSigV4(req, nil, s.AccessKey, s.SecretKey, "auto", "s3", time.Now().UTC()); err != nil {
		return err
	}
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	// 2xx → deleted (or already absent). 404 is also success per S3 semantics.
	if resp.StatusCode/100 == 2 || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return fmt.Errorf("r2 delete %q: status %d: %s", key, resp.StatusCode, string(errBody))
}

// signSigV4 attaches an AWS Signature V4 Authorization header. Implements
// the subset of the spec needed for one-shot PutObject with SHA-256 content.
func signSigV4(r *http.Request, body []byte, ak, sk, region, service string, now time.Time) error {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	hostHdr := r.URL.Host
	bodyHashBytes := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(bodyHashBytes[:])
	r.Header.Set("Host", hostHdr)
	r.Header.Set("X-Amz-Date", amzDate)
	r.Header.Set("X-Amz-Content-Sha256", bodyHash)

	canonURI := r.URL.Path
	if canonURI == "" {
		canonURI = "/"
	}
	canonQuery := r.URL.RawQuery

	signed := []string{"content-type", "host", "x-amz-content-sha256", "x-amz-date"}
	canonHeaders := strings.Builder{}
	for _, h := range signed {
		canonHeaders.WriteString(h)
		canonHeaders.WriteString(":")
		canonHeaders.WriteString(strings.TrimSpace(r.Header.Get(h)))
		canonHeaders.WriteString("\n")
	}
	signedHeaders := strings.Join(signed, ";")

	canonReq := strings.Join([]string{
		r.Method, canonURI, canonQuery,
		canonHeaders.String(), signedHeaders, bodyHash,
	}, "\n")
	canonReqHashB := sha256.Sum256([]byte(canonReq))
	canonReqHash := hex.EncodeToString(canonReqHashB[:])

	scope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, canonReqHash}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+sk), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))

	auth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		ak, scope, signedHeaders, signature)
	r.Header.Set("Authorization", auth)
	return nil
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func validateAssetStorageKey(key string) error {
	if key == "" || len(key) > maxAssetStorageKeyBytes || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") {
		return fmt.Errorf("assets: invalid storage key")
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(key)))
	if clean == "." || clean != key {
		return fmt.Errorf("assets: invalid storage key")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("assets: invalid storage key")
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
			return fmt.Errorf("assets: invalid storage key")
		}
	}
	return nil
}

func escapeAssetStorageKey(key string) string {
	parts := strings.Split(key, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

// normalizePublicAssetBase validates the externally rendered asset origin.
// It deliberately rejects credentials, query strings, fragments, traversal,
// and private/loopback IP literals. Production delivery is HTTPS-only; local
// development may use an HTTP emulator when explicitly configured.
func normalizePublicAssetBase(raw string, requireHTTPS bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("public base URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" {
		return "", fmt.Errorf("must be an absolute URL with a hostname")
	}
	if requireHTTPS && !strings.EqualFold(u.Scheme, "https") {
		return "", fmt.Errorf("must use https")
	}
	if !strings.EqualFold(u.Scheme, "https") && !strings.EqualFold(u.Scheme, "http") {
		if requireHTTPS {
			return "", fmt.Errorf("scheme must be https")
		}
		return "", fmt.Errorf("scheme must be https or http")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("credentials, query strings, and fragments are not allowed")
	}
	hostname := strings.ToLower(u.Hostname())
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") {
		if requireHTTPS {
			return "", fmt.Errorf("production public base cannot use localhost")
		}
	}
	if ip := net.ParseIP(hostname); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified()) {
		if requireHTTPS {
			return "", fmt.Errorf("production public base cannot use a private or loopback IP")
		}
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return "", fmt.Errorf("path traversal is not allowed")
		}
	}
	cleanPath := path.Clean("/" + strings.TrimPrefix(u.Path, "/"))
	if cleanPath == "/" {
		cleanPath = ""
	}
	u.Path = strings.TrimRight(cleanPath, "/")
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/"), nil
}
