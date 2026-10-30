package uploads

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	transfertypes "github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// s3API is the narrow surface S3UploadStore consumes. *s3.Client satisfies
// it; tests inject a fake.
type s3API interface {
	PutObject(ctx context.Context, in *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(ctx context.Context, in *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(ctx context.Context, in *s3.DeleteObjectInput, optFns ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	ListObjectsV2(ctx context.Context, in *s3.ListObjectsV2Input, optFns ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
}

// presignAPI is the narrow surface for s3.PresignClient. Lets us inject
// a fake that just returns canned URLs without signing.
type presignAPI interface {
	PresignGetObject(ctx context.Context, in *s3.GetObjectInput, optFns ...func(*s3.PresignOptions)) (*PresignedURL, error)
}

// PresignedURL mirrors the v4.PresignedHTTPRequest fields we actually
// use. Decoupled so the test fake doesn't need to construct one of those.
type PresignedURL struct {
	URL string
}

// realPresignClient adapts the real *s3.PresignClient into presignAPI.
type realPresignClient struct{ pc *s3.PresignClient }

func (r *realPresignClient) PresignGetObject(ctx context.Context, in *s3.GetObjectInput, optFns ...func(*s3.PresignOptions)) (*PresignedURL, error) {
	signed, err := r.pc.PresignGetObject(ctx, in, optFns...)
	if err != nil {
		return nil, err
	}
	return &PresignedURL{URL: signed.URL}, nil
}

// uploaderAPI matches transfermanager.Client.UploadObject — keeps S3UploadStore
// testable without spinning up the real multipart machinery.
type uploaderAPI interface {
	UploadObject(ctx context.Context, in *transfermanager.UploadObjectInput, optFns ...func(*transfermanager.Options)) (*transfermanager.UploadObjectOutput, error)
}

// S3UploadStore is the production object store. Wires:
//   - transfermanager.Client for multipart-aware Put
//   - s3.GetObject / DeleteObject for direct calls
//   - s3.PresignClient for time-limited GET URLs
//
// SSE-KMS is forced on every Put; SSEKMSKeyID is the alias/ARN of the
// CMK to encrypt the object with at rest. If empty, the bucket's default
// SSE-KMS is used (which still requires the bucket policy to allow it).
type S3UploadStore struct {
	Bucket      string
	SSEKMSKeyID string
	Uploader    uploaderAPI
	S3          s3API
	Presign     presignAPI
	Timeout     time.Duration

	// AdminBypass disables the tenant-prefix check. Set by main.go for
	// internal backup / cross-tenant routes; default-false everywhere
	// else so a missing tenant context fails closed.
	AdminBypass bool
}

// DefaultS3Timeout caps every S3 operation so a flaky control plane
// doesn't stall request handlers indefinitely.
const DefaultS3Timeout = 30 * time.Second

// NewS3Store wires an S3UploadStore from an *s3.Client. The transfer manager
// transparently switches to multipart for larger bodies.
func NewS3Store(client *s3.Client, bucket, kmsKeyID string) *S3UploadStore {
	return &S3UploadStore{
		Bucket:      bucket,
		SSEKMSKeyID: kmsKeyID,
		Uploader:    transfermanager.New(client),
		S3:          client,
		Presign:     &realPresignClient{pc: s3.NewPresignClient(client)},
		Timeout:     DefaultS3Timeout,
	}
}

// Put implements Store. Joins tenant prefix, then PUTs through the
// multipart-aware uploader with SSE-KMS forced on.
func (s *S3UploadStore) Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (string, error) {
	key, err := s.resolve(tenantID, rest)
	if err != nil {
		return "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	in := &transfermanager.UploadObjectInput{
		Bucket:               aws.String(s.Bucket),
		Key:                  aws.String(key),
		Body:                 body,
		ServerSideEncryption: transfertypes.ServerSideEncryptionAwsKms,
	}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
	}
	if s.SSEKMSKeyID != "" {
		in.SSEKMSKeyID = aws.String(s.SSEKMSKeyID)
	}
	if _, err := s.Uploader.UploadObject(ctx, in); err != nil {
		return "", fmt.Errorf("uploads s3 put %q: %w", key, err)
	}
	return key, nil
}

// Get implements Store.
func (s *S3UploadStore) Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error) {
	key, err := s.resolve(tenantID, rest)
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	out, err := s.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		cancel()
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, "", ErrNotFound
		}
		// Some endpoints return 404 wrapped in a generic api error.
		if isNotFound(err) {
			return nil, "", ErrNotFound
		}
		return nil, "", fmt.Errorf("uploads s3 get %q: %w", key, err)
	}
	ct := ""
	if out.ContentType != nil {
		ct = *out.ContentType
	}
	// GetObject returns before the streaming body is consumed. Keep the
	// operation context alive until the caller closes the body; canceling it at
	// function return truncates real S3 streams and made quarantine scanning
	// fail closed forever in production.
	return &cancelOnCloseReadCloser{ReadCloser: out.Body, cancel: cancel}, ct, nil
}

type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r *cancelOnCloseReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.cancel()
	return err
}

// Delete implements Store. S3 DeleteObject is already idempotent — a
// missing key returns 204, not 404 — so we can return its err directly.
func (s *S3UploadStore) Delete(ctx context.Context, tenantID, rest string) error {
	key, err := s.resolve(tenantID, rest)
	if err != nil {
		return err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	if _, err := s.S3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(key),
	}); err != nil {
		// Treat 404-ish as success for parity with Store contract.
		if isNotFound(err) {
			return nil
		}
		return fmt.Errorf("uploads s3 delete %q: %w", key, err)
	}
	return nil
}

// List implements Store using ListObjectsV2 with Prefix + StartAfter so
// cursored polling is cheap and lexicographically stable. Keys are returned
// tenant-relative (the tenants/{tenantID}/ prefix is stripped) so callers
// can pass them straight back into Get / Delete.
func (s *S3UploadStore) List(ctx context.Context, tenantID, prefix, cursor string, limit int) ([]string, string, error) {
	tenantPrefix, err := joinKey(tenantID, "")
	if err != nil {
		return nil, "", err
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	fullPrefix := tenantPrefix + strings.TrimLeft(prefix, "/")
	in := &s3.ListObjectsV2Input{
		Bucket:  aws.String(s.Bucket),
		Prefix:  aws.String(fullPrefix),
		MaxKeys: aws.Int32(int32(limit)),
	}
	if c := strings.TrimLeft(cursor, "/"); c != "" {
		in.StartAfter = aws.String(tenantPrefix + c)
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	out, err := s.S3.ListObjectsV2(ctx, in)
	if err != nil {
		return nil, "", fmt.Errorf("uploads s3 list %q: %w", fullPrefix, err)
	}
	keys := make([]string, 0, len(out.Contents))
	last := ""
	for _, obj := range out.Contents {
		if obj.Key == nil {
			continue
		}
		rel := strings.TrimPrefix(*obj.Key, tenantPrefix)
		keys = append(keys, rel)
		last = rel
	}
	return keys, last, nil
}

// PresignGet implements Store. Returns a time-limited URL the browser
// hits directly (no gateway middleware in the path).
func (s *S3UploadStore) PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (string, error) {
	key, err := s.resolve(tenantID, rest)
	if err != nil {
		return "", err
	}
	if ttl <= 0 {
		ttl = DefaultPresignTTL
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	signed, err := s.Presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(key),
	}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", fmt.Errorf("uploads s3 presign %q: %w", key, err)
	}
	return signed.URL, nil
}

func (s *S3UploadStore) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = DefaultS3Timeout
	}
	return context.WithTimeout(ctx, timeout)
}

// resolve performs tenant-prefix join unless AdminBypass is on, in which
// case it accepts an already-system-prefixed key.
func (s *S3UploadStore) resolve(tenantID, rest string) (string, error) {
	if s.AdminBypass {
		// In admin mode the caller passes a system-style key directly
		// in `rest`; tenantID is ignored.
		if err := validateAdminKey(rest); err != nil {
			return "", err
		}
		return rest, nil
	}
	return joinKey(tenantID, rest)
}

// isNotFound matches S3 not-found errors that don't deserialize cleanly
// into NoSuchKey (some operations return generic 404s with code "NotFound").
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "NoSuchKey") ||
		strings.Contains(msg, "status code: 404") ||
		strings.Contains(msg, "NotFound")
}

// readAll is a tiny helper the tests use to compare GetObject body bytes
// without dragging io/ioutil into store callers. (Defined here so the
// fake test client and the real Store both share buffer semantics.)
func readAll(rc io.ReadCloser) ([]byte, error) {
	defer func() { _ = rc.Close() }()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, rc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
