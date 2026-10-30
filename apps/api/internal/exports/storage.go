// SPDX-License-Identifier: AGPL-3.0-only

package exports

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	privateExportPrefix   = "tenant-exports/"
	defaultStorageTimeout = 30 * time.Minute
	maxStorageKeyBytes    = 512
	localChecksumSuffix   = ".sha256"
)

type privateExportS3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

// S3Storage stores exports in a bucket that is deliberately separate from the
// public asset/CDN bucket. The constructor accepts no public base URL and the
// API exposes no presigner, which prevents callers from turning an object key
// into a bearer link accidentally.
type S3Storage struct {
	Bucket      string
	SSEKMSKeyID string
	S3          privateExportS3API
	Timeout     time.Duration
}

func NewS3Storage(client *s3.Client, bucket, kmsKeyID string) (*S3Storage, error) {
	if client == nil {
		return nil, fmt.Errorf("private export S3 storage requires bucket, KMS key, and client")
	}
	store := &S3Storage{
		Bucket:      strings.TrimSpace(bucket),
		SSEKMSKeyID: strings.TrimSpace(kmsKeyID),
		S3:          client,
		Timeout:     defaultStorageTimeout,
	}
	if store.Bucket == "" || store.SSEKMSKeyID == "" || store.S3 == nil {
		return nil, fmt.Errorf("private export S3 storage requires bucket, KMS key, and client")
	}
	return store, nil
}

func (s *S3Storage) Put(
	ctx context.Context,
	key, contentType string,
	body io.Reader,
	size int64,
	sha256Hex string,
) error {
	objectKey, err := s.resolve(key)
	if err != nil {
		return err
	}
	if body == nil || size <= 0 || contentType != "application/zip" || !validSHA256Hex(sha256Hex) {
		return fmt.Errorf("private export S3 put requires a non-empty bounded body")
	}
	checksumSHA256, err := sha256Base64(sha256Hex)
	if err != nil {
		return err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	in := &s3.PutObjectInput{
		Bucket:               aws.String(s.Bucket),
		Key:                  aws.String(objectKey),
		Body:                 body,
		CacheControl:         aws.String("private, no-store, max-age=0"),
		ContentDisposition:   aws.String("attachment"),
		ContentLength:        aws.Int64(size),
		ContentType:          aws.String(contentType),
		ChecksumAlgorithm:    s3types.ChecksumAlgorithmSha256,
		ChecksumSHA256:       aws.String(checksumSHA256),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(s.SSEKMSKeyID),
	}
	if _, err := s.S3.PutObject(ctx, in); err != nil {
		return fmt.Errorf("private export S3 put %q: %w", objectKey, err)
	}
	return nil
}

func (s *S3Storage) Open(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	objectKey, err := s.resolve(key)
	if err != nil {
		return nil, "", 0, "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	out, err := s.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket:       aws.String(s.Bucket),
		Key:          aws.String(objectKey),
		ChecksumMode: s3types.ChecksumModeEnabled,
	})
	if err != nil {
		cancel()
		return nil, "", 0, "", fmt.Errorf("private export S3 get %q: %w", objectKey, err)
	}
	if out == nil || out.Body == nil {
		cancel()
		return nil, "", 0, "", fmt.Errorf("private export S3 get %q: empty response body", objectKey)
	}
	contentType := ""
	if out.ContentType != nil {
		contentType = *out.ContentType
	}
	checksum, checksumErr := s3SHA256Hex(out.ChecksumSHA256)
	if checksumErr != nil {
		_ = out.Body.Close()
		cancel()
		return nil, "", 0, "", fmt.Errorf("private export S3 get %q checksum: %w", objectKey, checksumErr)
	}
	return &exportCancelOnClose{ReadCloser: out.Body, cancel: cancel}, contentType,
		aws.ToInt64(out.ContentLength), checksum, nil
}

func (s *S3Storage) Stat(ctx context.Context, key string) (string, int64, string, error) {
	objectKey, err := s.resolve(key)
	if err != nil {
		return "", 0, "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	out, err := s.S3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket:       aws.String(s.Bucket),
		Key:          aws.String(objectKey),
		ChecksumMode: s3types.ChecksumModeEnabled,
	})
	if err != nil {
		return "", 0, "", fmt.Errorf("private export S3 head %q: %w", objectKey, err)
	}
	if out == nil {
		return "", 0, "", fmt.Errorf("private export S3 head %q: empty response", objectKey)
	}
	checksum, err := s3SHA256Hex(out.ChecksumSHA256)
	if err != nil {
		return "", 0, "", fmt.Errorf("private export S3 head %q checksum: %w", objectKey, err)
	}
	return aws.ToString(out.ContentType), aws.ToInt64(out.ContentLength), checksum, nil
}

func (s *S3Storage) Delete(ctx context.Context, key string) error {
	objectKey, err := s.resolve(key)
	if err != nil {
		return err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	if _, err := s.S3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(objectKey),
	}); err != nil {
		return fmt.Errorf("private export S3 delete %q: %w", objectKey, err)
	}
	return nil
}

func (s *S3Storage) resolve(key string) (string, error) {
	if s == nil || strings.TrimSpace(s.Bucket) == "" || strings.TrimSpace(s.SSEKMSKeyID) == "" || s.S3 == nil {
		return "", fmt.Errorf("private export S3 storage is not configured")
	}
	if err := validateStorageKey(key); err != nil {
		return "", err
	}
	return privateExportPrefix + key, nil
}

func (s *S3Storage) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = defaultStorageTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

type exportCancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r *exportCancelOnClose) Close() error {
	err := r.ReadCloser.Close()
	r.cancel()
	return err
}

// LocalStorage is the development-only equivalent. It keeps export bundles in
// a distinct 0700 tree and writes each file with mode 0600.
type LocalStorage struct {
	Root string
}

func NewLocalStorage(root string) (*LocalStorage, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("private export local storage root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("private export local storage root: %w", err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("create private export local storage root: %w", err)
	}
	if err := os.Chmod(abs, 0o700); err != nil {
		return nil, fmt.Errorf("secure private export local storage root: %w", err)
	}
	return &LocalStorage{Root: abs}, nil
}

func (s *LocalStorage) Put(
	ctx context.Context,
	key, contentType string,
	body io.Reader,
	size int64,
	sha256Hex string,
) error {
	dst, err := s.resolve(key)
	if err != nil {
		return err
	}
	if body == nil || size <= 0 || contentType != "application/zip" || !validSHA256Hex(sha256Hex) {
		return fmt.Errorf("private export local put requires a non-empty bounded body")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".postwave-export-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	hasher := sha256.New()
	written, copyErr := io.CopyN(
		io.MultiWriter(tmp, hasher),
		&contextReader{ctx: ctx, reader: body},
		size,
	)
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if copyErr != nil {
		return fmt.Errorf("private export local write after %d bytes: %w", written, copyErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if syncErr != nil {
		return syncErr
	}
	if written != size {
		return fmt.Errorf("private export local write size %d does not match %d", written, size)
	}
	if actual := hex.EncodeToString(hasher.Sum(nil)); actual != sha256Hex {
		return fmt.Errorf("private export local write SHA-256 does not match expected digest")
	}
	checksumTmp, err := os.CreateTemp(filepath.Dir(dst), ".postwave-export-checksum-*")
	if err != nil {
		return err
	}
	checksumTmpName := checksumTmp.Name()
	defer func() { _ = os.Remove(checksumTmpName) }()
	if err := checksumTmp.Chmod(0o600); err != nil {
		_ = checksumTmp.Close()
		return err
	}
	if _, err := io.WriteString(checksumTmp, sha256Hex+"\n"); err != nil {
		_ = checksumTmp.Close()
		return err
	}
	if err := checksumTmp.Sync(); err != nil {
		_ = checksumTmp.Close()
		return err
	}
	if err := checksumTmp.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return err
	}
	if err := os.Rename(checksumTmpName, dst+localChecksumSuffix); err != nil {
		_ = os.Remove(dst)
		return err
	}
	if err := syncLocalDirectory(filepath.Dir(dst)); err != nil {
		_ = os.Remove(dst)
		_ = os.Remove(dst + localChecksumSuffix)
		return err
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (s *LocalStorage) Open(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", 0, "", err
	}
	dst, err := s.resolve(key)
	if err != nil {
		return nil, "", 0, "", err
	}
	f, info, checksum, err := openVerifiedLocalObject(ctx, dst)
	if err != nil {
		return nil, "", 0, "", err
	}
	return &contextReadCloser{ctx: ctx, ReadCloser: f}, "application/zip", info.Size(), checksum, nil
}

func (s *LocalStorage) Stat(ctx context.Context, key string) (string, int64, string, error) {
	if err := ctx.Err(); err != nil {
		return "", 0, "", err
	}
	dst, err := s.resolve(key)
	if err != nil {
		return "", 0, "", err
	}
	f, info, checksum, err := openVerifiedLocalObject(ctx, dst)
	if err != nil {
		return "", 0, "", err
	}
	if err := f.Close(); err != nil {
		return "", 0, "", err
	}
	return "application/zip", info.Size(), checksum, nil
}

func (s *LocalStorage) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dst, err := s.resolve(key)
	if err != nil {
		return err
	}
	var deleteErrors []error
	if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
		deleteErrors = append(deleteErrors, err)
	}
	if err := os.Remove(dst + localChecksumSuffix); err != nil && !os.IsNotExist(err) {
		deleteErrors = append(deleteErrors, err)
	}
	return errors.Join(deleteErrors...)
}

type contextReadCloser struct {
	ctx context.Context
	io.ReadCloser
}

func (r *contextReadCloser) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadCloser.Read(p)
}

func requireRegularLocalObject(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("private export local object is not a regular file")
	}
	return nil
}

func openVerifiedLocalObject(
	ctx context.Context,
	path string,
) (*os.File, os.FileInfo, string, error) {
	if err := requireRegularLocalObject(path); err != nil {
		return nil, nil, "", err
	}
	checksum, err := readLocalChecksum(path)
	if err != nil {
		return nil, nil, "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, "", err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, "", err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, "", fmt.Errorf("private export local object is not a regular file")
	}
	if checksum != "" {
		hasher := sha256.New()
		if _, err := io.Copy(hasher, &contextReader{ctx: ctx, reader: f}); err != nil {
			_ = f.Close()
			return nil, nil, "", err
		}
		actual := hex.EncodeToString(hasher.Sum(nil))
		if actual != checksum {
			_ = f.Close()
			return nil, nil, "", fmt.Errorf("private export local object SHA-256 does not match metadata")
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			_ = f.Close()
			return nil, nil, "", err
		}
	}
	return f, info, checksum, nil
}

func syncLocalDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}

func readLocalChecksum(path string) (string, error) {
	checksumPath := path + localChecksumSuffix
	info, err := os.Lstat(checksumPath)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 128 {
		return "", fmt.Errorf("private export local checksum metadata is invalid")
	}
	raw, err := os.ReadFile(checksumPath)
	if err != nil {
		return "", err
	}
	checksum := strings.TrimSpace(string(raw))
	if !validSHA256Hex(checksum) {
		return "", fmt.Errorf("private export local checksum metadata is invalid")
	}
	return checksum, nil
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func sha256Base64(value string) (string, error) {
	if !validSHA256Hex(value) {
		return "", fmt.Errorf("private export SHA-256 is invalid")
	}
	raw, err := hex.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("private export SHA-256 decode: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func s3SHA256Hex(value *string) (string, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(*value))
	if err != nil || len(raw) != sha256.Size {
		return "", fmt.Errorf("S3 SHA-256 metadata is invalid")
	}
	return hex.EncodeToString(raw), nil
}

func (s *LocalStorage) resolve(key string) (string, error) {
	if s == nil || strings.TrimSpace(s.Root) == "" {
		return "", fmt.Errorf("private export local storage is not configured")
	}
	if err := validateStorageKey(key); err != nil {
		return "", err
	}
	base, err := filepath.Abs(s.Root)
	if err != nil {
		return "", err
	}
	dst, err := filepath.Abs(filepath.Join(base, filepath.FromSlash(key)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, dst)
	if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("private export storage key escapes root")
	}
	return dst, nil
}

func validateStorageKey(key string) error {
	if key == "" || len(key) > maxStorageKeyBytes || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") {
		return fmt.Errorf("private export storage key is invalid")
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(key)))
	if clean == "." || clean != key {
		return fmt.Errorf("private export storage key is invalid")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("private export storage key is invalid")
		}
	}
	for _, char := range key {
		switch {
		case char >= 'a' && char <= 'z',
			char >= '0' && char <= '9',
			char == '/' || char == '.' || char == '-' || char == '_':
			continue
		default:
			return fmt.Errorf("private export storage key is invalid")
		}
	}
	return nil
}
