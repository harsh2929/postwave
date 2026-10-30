package uploads

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// fakeS3 is a tiny in-memory s3API + uploaderAPI + presignAPI used to
// exercise S3UploadStore round-trips without hitting AWS.
type fakeS3 struct {
	mu          sync.Mutex
	objects     map[string]fakeObj
	lastSSEKMS  string
	lastSSEMode s3types.ServerSideEncryption
}

type fakeObj struct {
	body        []byte
	contentType string
}

type contextAwareS3 struct{ *fakeS3 }

func (f *contextAwareS3) GetObject(ctx context.Context, _ *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	return &s3.GetObjectOutput{Body: &contextAwareBody{ctx: ctx, Reader: strings.NewReader("streamed")}}, nil
}

type contextAwareBody struct {
	ctx context.Context
	*strings.Reader
}

func (b *contextAwareBody) Read(p []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	return b.Reader.Read(p)
}

func (b *contextAwareBody) Close() error { return nil }

func newFakeS3() *fakeS3 { return &fakeS3{objects: map[string]fakeObj{}} }

// UploadObject implements uploaderAPI.
func (f *fakeS3) UploadObject(_ context.Context, in *transfermanager.UploadObjectInput, _ ...func(*transfermanager.Options)) (*transfermanager.UploadObjectOutput, error) {
	body, err := io.ReadAll(io.LimitReader(in.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	row := fakeObj{body: body}
	if in.ContentType != nil {
		row.contentType = *in.ContentType
	}
	f.objects[*in.Key] = row
	f.lastSSEMode = s3types.ServerSideEncryption(in.ServerSideEncryption)
	if in.SSEKMSKeyID != nil {
		f.lastSSEKMS = *in.SSEKMSKeyID
	}
	return &transfermanager.UploadObjectOutput{}, nil
}

// PutObject is required by s3API but unused in our flow (Upload covers
// it via the transfer manager). Implemented for completeness.
func (f *fakeS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	body, err := io.ReadAll(io.LimitReader(in.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[*in.Key] = fakeObj{body: body}
	return &s3.PutObjectOutput{}, nil
}

func (f *fakeS3) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.objects[*in.Key]
	if !ok {
		return nil, &s3types.NoSuchKey{}
	}
	out := &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(row.body))}
	if row.contentType != "" {
		out.ContentType = aws.String(row.contentType)
	}
	return out, nil
}

func (f *fakeS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, *in.Key)
	return &s3.DeleteObjectOutput{}, nil
}

func (f *fakeS3) ListObjectsV2(_ context.Context, in *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	prefix := ""
	if in.Prefix != nil {
		prefix = *in.Prefix
	}
	startAfter := ""
	if in.StartAfter != nil {
		startAfter = *in.StartAfter
	}
	limit := 1000
	if in.MaxKeys != nil && *in.MaxKeys > 0 && int(*in.MaxKeys) < limit {
		limit = int(*in.MaxKeys)
	}
	keys := make([]string, 0, len(f.objects))
	for k := range f.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sortStringsInPlace(keys)
	out := &s3.ListObjectsV2Output{}
	for _, k := range keys {
		if startAfter != "" && k <= startAfter {
			continue
		}
		key := k
		out.Contents = append(out.Contents, s3types.Object{Key: aws.String(key)})
		if len(out.Contents) >= limit {
			break
		}
	}
	return out, nil
}

func sortStringsInPlace(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

func (f *fakeS3) PresignGetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.PresignOptions)) (*PresignedURL, error) {
	return &PresignedURL{URL: "https://fake.s3/" + *in.Key + "?presigned=1"}, nil
}

func newStoreWithFake(fk *fakeS3, kmsKeyID string) *S3UploadStore {
	return &S3UploadStore{
		Bucket:      "test-bucket",
		SSEKMSKeyID: kmsKeyID,
		Uploader:    fk,
		S3:          fk,
		Presign:     fk,
		Timeout:     2 * time.Second,
	}
}

func TestS3UploadStorePutGet(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "alias/uploads")

	ctx := context.Background()
	key, err := store.Put(ctx, "tenant-A", "forms/file.pdf", "application/pdf",
		bytes.NewReader([]byte("hello-world")))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if !strings.HasPrefix(key, "tenants/tenant-A/") {
		t.Fatalf("key not tenant-prefixed: %q", key)
	}
	// SSE-KMS must be on every Put.
	if fk.lastSSEMode != s3types.ServerSideEncryptionAwsKms {
		t.Fatalf("SSE mode: got %q want aws:kms", fk.lastSSEMode)
	}
	if fk.lastSSEKMS != "alias/uploads" {
		t.Fatalf("SSE key: got %q want alias/uploads", fk.lastSSEKMS)
	}

	body, ct, err := store.Get(ctx, "tenant-A", "forms/file.pdf")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, err := readAll(body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello-world" {
		t.Fatalf("body mismatch: %q", got)
	}
	if ct != "application/pdf" {
		t.Fatalf("content type: %q", ct)
	}
}

func TestS3UploadStoreGetKeepsStreamContextAliveUntilClose(t *testing.T) {
	backend := &contextAwareS3{fakeS3: newFakeS3()}
	store := newStoreWithFake(backend.fakeS3, "")
	store.S3 = backend
	body, _, err := store.Get(context.Background(), "tenant-A", "forms/file.pdf")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read streaming body: %v", err)
	}
	if string(got) != "streamed" {
		t.Fatalf("body = %q", got)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestS3UploadStoreDeleteIdempotent(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "")

	ctx := context.Background()
	if _, err := store.Put(ctx, "t", "k", "text/plain", bytes.NewReader([]byte("x"))); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "t", "k"); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	// Second delete must succeed.
	if err := store.Delete(ctx, "t", "k"); err != nil {
		t.Fatalf("second delete: %v", err)
	}
}

func TestS3UploadStoreGetNotFound(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "")
	if _, _, err := store.Get(context.Background(), "t", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestS3UploadStoreRejectsCrossTenantKey(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "")
	if _, err := store.Put(context.Background(), "t", "../other/file", "text/plain", bytes.NewReader(nil)); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
	if _, err := store.Put(context.Background(), "", "k", "text/plain", bytes.NewReader(nil)); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey for empty tenantID, got %v", err)
	}
}

func TestS3UploadStorePresign(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "")
	url, err := store.PresignGet(context.Background(), "t", "f", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://fake.s3/tenants/t/f") {
		t.Fatalf("presign URL: %q", url)
	}
}

func TestS3UploadStoreAdminBypass(t *testing.T) {
	fk := newFakeS3()
	store := newStoreWithFake(fk, "")
	store.AdminBypass = true
	if _, err := store.Put(context.Background(), "", "system/backup/x.tar", "application/octet-stream",
		bytes.NewReader([]byte{0x00})); err != nil {
		t.Fatalf("admin put: %v", err)
	}
	// Outside system/ → still rejected even in admin mode.
	if _, err := store.Put(context.Background(), "", "tenants/x/y", "text/plain", bytes.NewReader(nil)); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
}

func TestMemoryStoreRoundTrip(t *testing.T) {
	m := NewMemoryStore()
	ctx := context.Background()
	if _, err := m.Put(ctx, "t", "f.txt", "text/plain", bytes.NewReader([]byte("a"))); err != nil {
		t.Fatal(err)
	}
	body, ct, err := m.Get(ctx, "t", "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := readAll(body); string(got) != "a" || ct != "text/plain" {
		t.Fatalf("got=%q ct=%q", got, ct)
	}
	if _, _, err := m.Get(ctx, "t", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestMemoryStoreRejectsOversizedObject(t *testing.T) {
	m := NewMemoryStore()
	body := io.LimitReader(zeroReader{}, maxMemoryStoreObjectBytes+1)
	if _, err := m.Put(context.Background(), "t", "huge.bin", "application/octet-stream", body); err == nil {
		t.Fatal("expected oversized memory upload error")
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

// TestS3UploadStoreIntegration round-trips against a real bucket. Skipped
// unless S3_TEST_BUCKET is set. AWS_REGION default is us-east-1; the
// principal must be allowed s3:PutObject / GetObject / DeleteObject on
// the bucket and (if SSE-KMS is required) kms:GenerateDataKey on the
// configured key alias.
func TestS3UploadStoreIntegration(t *testing.T) {
	bucket := os.Getenv("S3_TEST_BUCKET")
	if bucket == "" {
		t.Skip("S3_TEST_BUCKET not set; skipping integration test")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cfg, configErr := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if configErr != nil {
		t.Fatalf("aws cfg: %v", configErr)
	}
	client := s3.NewFromConfig(cfg)
	store := NewS3Store(client, bucket, os.Getenv("AWS_KMS_TEST_KEY_ID"))
	tenant := "integration-test"
	rest := "smoke-" + time.Now().UTC().Format("20060102T150405") + ".txt"
	defer func() { _ = store.Delete(context.Background(), tenant, rest) }()

	if _, err := store.Put(ctx, tenant, rest, "text/plain", bytes.NewReader([]byte("integration"))); err != nil {
		t.Fatalf("put: %v", err)
	}
	body, _, configErr := store.Get(ctx, tenant, rest)
	if configErr != nil {
		t.Fatalf("get: %v", configErr)
	}
	got, _ := readAll(body)
	if string(got) != "integration" {
		t.Fatalf("body mismatch: %q", got)
	}
	url, configErr := store.PresignGet(ctx, tenant, rest, 5*time.Minute)
	if configErr != nil {
		t.Fatalf("presign: %v", configErr)
	}
	if !strings.HasPrefix(url, "https://") {
		t.Fatalf("presign URL: %q", url)
	}
}
