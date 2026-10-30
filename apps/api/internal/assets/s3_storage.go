// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// s3AssetAPI is the smallest AWS surface the asset library needs. Keeping the
// interface local makes the production backend testable without credentials or
// a networked S3 emulator.
type s3AssetAPI interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

const (
	assetS3Prefix         = "assets/"
	defaultAssetS3Timeout = 30 * time.Second
)

// S3Storage is the canonical AWS production backend for the asset library.
// Objects use a dedicated assets/ prefix inside the private uploads bucket.
// PublicBase is an explicitly configured HTTPS CDN origin (normally
// CloudFront with private-bucket OAC); the bucket itself remains private.
// Every write explicitly requests SSE-KMS so the bucket policy can reject
// plaintext or wrong-key uploads.
type S3Storage struct {
	Bucket      string
	SSEKMSKeyID string
	PublicBase  string
	S3          s3AssetAPI
	Timeout     time.Duration
}

func NewS3Storage(client *s3.Client, bucket, kmsKeyID, publicBase string) (*S3Storage, error) {
	base, err := normalizePublicAssetBase(publicBase, true)
	if err != nil {
		return nil, fmt.Errorf("POSTWAVE_ASSETS_PUBLIC_BASE_URL: %w", err)
	}
	store := &S3Storage{
		Bucket:      strings.TrimSpace(bucket),
		SSEKMSKeyID: strings.TrimSpace(kmsKeyID),
		PublicBase:  base,
		S3:          client,
		Timeout:     defaultAssetS3Timeout,
	}
	if store.Bucket == "" || store.SSEKMSKeyID == "" || store.S3 == nil {
		return nil, fmt.Errorf("assets s3 storage requires bucket, KMS key, client, and public base")
	}
	return store, nil
}

func (s *S3Storage) Put(ctx context.Context, key, mime string, body []byte) (string, error) {
	objectKey, err := s.resolve(key)
	if err != nil {
		return "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	defer cancel()
	in := &s3.PutObjectInput{
		Bucket:               aws.String(s.Bucket),
		Key:                  aws.String(objectKey),
		Body:                 bytes.NewReader(body),
		CacheControl:         aws.String("public, max-age=31536000, immutable"),
		ContentDisposition:   aws.String("inline"),
		ContentLength:        aws.Int64(int64(len(body))),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
	}
	if mime != "" {
		in.ContentType = aws.String(mime)
	}
	if s.SSEKMSKeyID != "" {
		in.SSEKMSKeyId = aws.String(s.SSEKMSKeyID)
	}
	if _, err := s.S3.PutObject(ctx, in); err != nil {
		return "", fmt.Errorf("assets s3 put %q: %w", objectKey, err)
	}
	return s.PublicBase + "/" + escapeAssetStorageKey(objectKey), nil
}

func (s *S3Storage) Open(ctx context.Context, key string) (io.ReadCloser, string, error) {
	objectKey, err := s.resolve(key)
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := s.withTimeout(ctx)
	out, err := s.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.Bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		cancel()
		return nil, "", fmt.Errorf("assets s3 get %q: %w", objectKey, err)
	}
	if out == nil || out.Body == nil {
		cancel()
		return nil, "", fmt.Errorf("assets s3 get %q: empty response body", objectKey)
	}
	mime := ""
	if out.ContentType != nil {
		mime = *out.ContentType
	}
	return &cancelOnCloseReadCloser{ReadCloser: out.Body, cancel: cancel}, mime, nil
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
		return fmt.Errorf("assets s3 delete %q: %w", objectKey, err)
	}
	return nil
}

func (s *S3Storage) resolve(key string) (string, error) {
	if s == nil || strings.TrimSpace(s.Bucket) == "" || s.S3 == nil || s.PublicBase == "" {
		return "", fmt.Errorf("assets s3 storage is not configured")
	}
	base, err := normalizePublicAssetBase(s.PublicBase, true)
	if err != nil {
		return "", fmt.Errorf("assets s3 public base is invalid: %w", err)
	}
	if base != s.PublicBase {
		return "", fmt.Errorf("assets s3 public base must be canonical")
	}
	if err := validateAssetStorageKey(key); err != nil {
		return "", err
	}
	return assetS3Prefix + key, nil
}

func (s *S3Storage) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = defaultAssetS3Timeout
	}
	return context.WithTimeout(ctx, timeout)
}
