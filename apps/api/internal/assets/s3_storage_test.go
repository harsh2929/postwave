// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type fakeAssetS3 struct {
	putInput    *s3.PutObjectInput
	putBody     []byte
	getInput    *s3.GetObjectInput
	getContext  context.Context
	deleteInput *s3.DeleteObjectInput
	body        []byte
	contentType string
	emptyGet    bool
}

func (f *fakeAssetS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.putInput = in
	f.putBody, _ = io.ReadAll(in.Body)
	return &s3.PutObjectOutput{}, nil
}

func (f *fakeAssetS3) GetObject(ctx context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.getContext = ctx
	f.getInput = in
	if f.emptyGet {
		return &s3.GetObjectOutput{}, nil
	}
	return &s3.GetObjectOutput{
		Body:        io.NopCloser(bytes.NewReader(f.body)),
		ContentType: aws.String(f.contentType),
	}, nil
}

func (f *fakeAssetS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.deleteInput = in
	return &s3.DeleteObjectOutput{}, nil
}

func TestS3StorageContract(t *testing.T) {
	fake := &fakeAssetS3{body: []byte("png"), contentType: "image/png"}
	store := &S3Storage{
		Bucket:      "postwave-uploads-prod",
		SSEKMSKeyID: "arn:aws:kms:us-east-1:123456789012:key/test",
		PublicBase:  "https://assets.example.com/content",
		S3:          fake,
		Timeout:     time.Minute,
	}

	publicURL, err := store.Put(context.Background(), "asset123/logo.png", "image/png", []byte("png"))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if publicURL != "https://assets.example.com/content/assets/asset123/logo.png" {
		t.Fatalf("public URL = %q", publicURL)
	}
	if got := aws.ToString(fake.putInput.Bucket); got != store.Bucket {
		t.Fatalf("put bucket = %q", got)
	}
	if got := aws.ToString(fake.putInput.Key); got != "assets/asset123/logo.png" {
		t.Fatalf("put key = %q", got)
	}
	if got := aws.ToString(fake.putInput.ContentType); got != "image/png" {
		t.Fatalf("put content type = %q", got)
	}
	if got := aws.ToString(fake.putInput.CacheControl); got != "public, max-age=31536000, immutable" {
		t.Fatalf("put cache control = %q", got)
	}
	if got := aws.ToString(fake.putInput.ContentDisposition); got != "inline" {
		t.Fatalf("put content disposition = %q", got)
	}
	if fake.putInput.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms {
		t.Fatalf("put encryption = %q", fake.putInput.ServerSideEncryption)
	}
	if got := aws.ToString(fake.putInput.SSEKMSKeyId); got != store.SSEKMSKeyID {
		t.Fatalf("put KMS key = %q", got)
	}
	if string(fake.putBody) != "png" {
		t.Fatalf("put body = %q", fake.putBody)
	}

	rc, mime, err := store.Open(context.Background(), "asset123/logo.png")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if mime != "image/png" {
		t.Fatalf("open content type = %q", mime)
	}
	if got := aws.ToString(fake.getInput.Key); got != "assets/asset123/logo.png" {
		t.Fatalf("get key = %q", got)
	}
	body, err := io.ReadAll(rc)
	if err != nil || string(body) != "png" {
		t.Fatalf("read body = %q, err=%v", body, err)
	}
	if err := fake.getContext.Err(); err != nil {
		t.Fatalf("get context was cancelled before body close: %v", err)
	}
	if err := rc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := fake.getContext.Err(); err != context.Canceled {
		t.Fatalf("get context after close = %v, want context.Canceled", err)
	}

	if err := store.Delete(context.Background(), "asset123/logo.png"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := aws.ToString(fake.deleteInput.Key); got != "assets/asset123/logo.png" {
		t.Fatalf("delete key = %q", got)
	}
}

func TestS3StorageRejectsUnsafeOrUnconfiguredKeys(t *testing.T) {
	store := &S3Storage{Bucket: "bucket", PublicBase: "https://assets.example.com", S3: &fakeAssetS3{}}
	for _, key := range []string{"", "../escape.png", "/absolute.png", "asset//logo.png", "asset/logo?.png"} {
		if _, err := store.Put(context.Background(), key, "image/png", nil); err == nil {
			t.Errorf("Put(%q) accepted unsafe key", key)
		}
	}

	var unconfigured *S3Storage
	if _, err := unconfigured.Put(context.Background(), "asset/logo.png", "image/png", nil); err == nil {
		t.Fatal("nil storage should fail closed")
	}
	if _, _, err := (&S3Storage{Bucket: "bucket"}).Open(context.Background(), "asset/logo.png"); err == nil {
		t.Fatal("storage without an S3 client should fail closed")
	}
	if _, _, err := (&S3Storage{Bucket: "bucket", PublicBase: "https://assets.example.com", S3: &fakeAssetS3{emptyGet: true}}).Open(context.Background(), "asset/logo.png"); err == nil {
		t.Fatal("empty S3 response body should fail closed")
	}
}

func TestNewS3StorageRequiresSafePublicDeliveryBase(t *testing.T) {
	client := &s3.Client{}
	for _, raw := range []string{"", "http://assets.example.com", "https://user:pass@assets.example.com", "https://127.0.0.1", "https://assets.example.com/path?token=secret"} {
		if _, err := NewS3Storage(client, "bucket", "kms-key", raw); err == nil {
			t.Errorf("NewS3Storage accepted unsafe public base %q", raw)
		}
	}
	store, err := NewS3Storage(client, "bucket", "kms-key", "https://assets.example.com/content/")
	if err != nil {
		t.Fatalf("NewS3Storage valid config: %v", err)
	}
	if store.PublicBase != "https://assets.example.com/content" {
		t.Fatalf("canonical public base = %q", store.PublicBase)
	}
}
