// SPDX-License-Identifier: AGPL-3.0-only

package exports

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type fakePrivateExportS3 struct {
	putInput    *s3.PutObjectInput
	putBody     []byte
	getInput    *s3.GetObjectInput
	getContext  context.Context
	headInput   *s3.HeadObjectInput
	deleteInput *s3.DeleteObjectInput
	body        []byte
	emptyGet    bool
	checksum    string
}

func (f *fakePrivateExportS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.putInput = in
	f.putBody, _ = io.ReadAll(in.Body)
	return &s3.PutObjectOutput{}, nil
}

func (f *fakePrivateExportS3) GetObject(ctx context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.getContext = ctx
	f.getInput = in
	if f.emptyGet {
		return &s3.GetObjectOutput{}, nil
	}
	return &s3.GetObjectOutput{
		Body:           io.NopCloser(bytes.NewReader(f.body)),
		ContentType:    aws.String("application/zip"),
		ContentLength:  aws.Int64(int64(len(f.body))),
		ChecksumSHA256: aws.String(f.checksum),
	}, nil
}

func (f *fakePrivateExportS3) HeadObject(_ context.Context, in *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	f.headInput = in
	return &s3.HeadObjectOutput{
		ContentType:    aws.String("application/zip"),
		ContentLength:  aws.Int64(int64(len(f.body))),
		ChecksumSHA256: aws.String(f.checksum),
	}, nil
}

func (f *fakePrivateExportS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.deleteInput = in
	return &s3.DeleteObjectOutput{}, nil
}

func TestPrivateS3StorageNeverProducesPublicDeliveryMetadata(t *testing.T) {
	t.Parallel()
	digest := testSHA256("zip")
	checksum, err := sha256Base64(digest)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakePrivateExportS3{body: []byte("zip"), checksum: checksum}
	store := &S3Storage{
		Bucket:      "postwave-private-exports-prod",
		SSEKMSKeyID: "arn:aws:kms:us-east-1:123456789012:key/test",
		S3:          fake,
		Timeout:     time.Minute,
	}
	key := "exports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.zip"
	if err := store.Put(context.Background(), key, "application/zip", strings.NewReader("zip"), 3, digest); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got := aws.ToString(fake.putInput.Key); got != privateExportPrefix+key {
		t.Fatalf("object key = %q", got)
	}
	if got := aws.ToString(fake.putInput.CacheControl); got != "private, no-store, max-age=0" {
		t.Fatalf("cache control = %q", got)
	}
	if got := aws.ToString(fake.putInput.ContentDisposition); got != "attachment" {
		t.Fatalf("content disposition = %q", got)
	}
	if fake.putInput.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(fake.putInput.SSEKMSKeyId) != store.SSEKMSKeyID {
		t.Fatal("private export was not explicitly SSE-KMS encrypted")
	}
	if string(fake.putBody) != "zip" || aws.ToInt64(fake.putInput.ContentLength) != 3 {
		t.Fatalf("uploaded body/length = %q/%d", fake.putBody, aws.ToInt64(fake.putInput.ContentLength))
	}
	if fake.putInput.ChecksumAlgorithm != s3types.ChecksumAlgorithmSha256 ||
		aws.ToString(fake.putInput.ChecksumSHA256) != checksum {
		t.Fatal("private export upload did not bind the complete bundle SHA-256")
	}

	rc, contentType, size, openedDigest, err := store.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if contentType != "application/zip" || size != 3 || openedDigest != digest || aws.ToString(fake.getInput.Key) != privateExportPrefix+key {
		t.Fatalf("open content type/size/digest/key = %q/%d/%q/%q", contentType, size, openedDigest, aws.ToString(fake.getInput.Key))
	}
	if fake.getInput.ChecksumMode != s3types.ChecksumModeEnabled {
		t.Fatal("S3 GET did not request stored checksum metadata")
	}
	if err := fake.getContext.Err(); err != nil {
		t.Fatalf("get context ended before body close: %v", err)
	}
	if err := rc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := fake.getContext.Err(); err != context.Canceled {
		t.Fatalf("get context after close = %v", err)
	}
	if contentType, size, statDigest, err := store.Stat(context.Background(), key); err != nil || contentType != "application/zip" || size != 3 || statDigest != digest {
		t.Fatalf("Stat = %q/%d/%q/%v", contentType, size, statDigest, err)
	}
	if got := aws.ToString(fake.headInput.Key); got != privateExportPrefix+key {
		t.Fatalf("head key = %q", got)
	}
	if fake.headInput.ChecksumMode != s3types.ChecksumModeEnabled {
		t.Fatal("S3 HEAD did not request stored checksum metadata")
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := aws.ToString(fake.deleteInput.Key); got != privateExportPrefix+key {
		t.Fatalf("delete key = %q", got)
	}
}

func TestPrivateS3StorageFailsClosed(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"", "../escape.zip", "/absolute.zip", "exports//x.zip", "exports/X.zip"} {
		store := &S3Storage{Bucket: "bucket", SSEKMSKeyID: "kms", S3: &fakePrivateExportS3{}}
		if err := store.Put(context.Background(), key, "application/zip", strings.NewReader("x"), 1, testSHA256("x")); err == nil {
			t.Errorf("Put(%q) accepted unsafe key", key)
		}
	}
	if _, err := NewS3Storage(nil, "bucket", "kms"); err == nil {
		t.Fatal("nil S3 client was accepted")
	}
	if err := (&S3Storage{Bucket: "bucket", SSEKMSKeyID: "kms", S3: &fakePrivateExportS3{}}).
		Put(context.Background(), "exports/a.zip", "application/zip", strings.NewReader(""), 0, testSHA256("")); err == nil {
		t.Fatal("empty export body was accepted")
	}
	if _, _, _, _, err := (&S3Storage{Bucket: "bucket", SSEKMSKeyID: "kms", S3: &fakePrivateExportS3{emptyGet: true}}).
		Open(context.Background(), "exports/a.zip"); err == nil {
		t.Fatal("empty S3 response body was accepted")
	}
	invalidChecksum := &S3Storage{
		Bucket: "bucket", SSEKMSKeyID: "kms",
		S3: &fakePrivateExportS3{body: []byte("zip"), checksum: "not-base64"},
	}
	if _, _, _, _, err := invalidChecksum.Open(context.Background(), "exports/a.zip"); err == nil {
		t.Fatal("malformed S3 object checksum was accepted by Open")
	}
	if _, _, _, err := invalidChecksum.Stat(context.Background(), "exports/a.zip"); err == nil {
		t.Fatal("malformed S3 object checksum was accepted by Stat")
	}
}

func TestLocalStorageUsesPrivateModesAndRejectsTraversal(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	store, err := NewLocalStorage(filepath.Join(root, "private"))
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	key := "exports/tenant/export.zip"
	digest := testSHA256("zip")
	if err := store.Put(context.Background(), key, "application/zip", strings.NewReader("zip"), 3, digest); err != nil {
		t.Fatalf("Put: %v", err)
	}
	path := filepath.Join(store.Root, filepath.FromSlash(key))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("file mode = %o, want 600", got)
	}
	rootInfo, err := os.Stat(store.Root)
	if err != nil {
		t.Fatalf("root stat: %v", err)
	}
	if got := rootInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("root mode = %o, want 700", got)
	}
	checksumInfo, err := os.Stat(path + localChecksumSuffix)
	if err != nil {
		t.Fatalf("checksum stat: %v", err)
	}
	if got := checksumInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("checksum mode = %o, want 600", got)
	}
	rc, contentType, size, openedDigest, err := store.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	body, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(body) != "zip" || contentType != "application/zip" || size != 3 || openedDigest != digest {
		t.Fatalf("read body/type/size/digest = %q/%q/%d/%q", body, contentType, size, openedDigest)
	}
	if statType, statSize, statDigest, err := store.Stat(context.Background(), key); err != nil || statType != "application/zip" || statSize != 3 || statDigest != digest {
		t.Fatalf("Stat = %q/%d/%q/%v", statType, statSize, statDigest, err)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("deleted path stat err = %v", err)
	}
	if _, err := os.Stat(path + localChecksumSuffix); !os.IsNotExist(err) {
		t.Fatalf("deleted checksum stat err = %v", err)
	}
	if err := store.Put(context.Background(), "../escape.zip", "application/zip", strings.NewReader("x"), 1, testSHA256("x")); err == nil {
		t.Fatal("local storage accepted traversal")
	}
}

func TestLocalStorageRejectsWrongDigestAndSameLengthTampering(t *testing.T) {
	t.Parallel()
	store, err := NewLocalStorage(filepath.Join(t.TempDir(), "private"))
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	key := "exports/tenant/integrity.zip"
	if err := store.Put(
		context.Background(), key, "application/zip", strings.NewReader("zip"), 3, testSHA256("bad"),
	); err == nil {
		t.Fatal("Put accepted a body whose SHA-256 did not match")
	}
	path, err := store.resolve(key)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("failed integrity check left final object: %v", err)
	}

	if err := store.Put(
		context.Background(), key, "application/zip", strings.NewReader("zip"), 3, testSHA256("zip"),
	); err != nil {
		t.Fatalf("Put valid object: %v", err)
	}
	if err := os.WriteFile(path, []byte("zap"), 0o600); err != nil {
		t.Fatalf("tamper object: %v", err)
	}
	if _, _, _, _, err := store.Open(context.Background(), key); err == nil {
		t.Fatal("Open accepted same-length object tampering")
	}
	if _, _, _, err := store.Stat(context.Background(), key); err == nil {
		t.Fatal("Stat accepted same-length object tampering")
	}
}

func TestLocalStoragePutHonorsCancellation(t *testing.T) {
	t.Parallel()
	store, err := NewLocalStorage(filepath.Join(t.TempDir(), "private"))
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	key := "exports/tenant/canceled.zip"
	if err := store.Put(ctx, key, "application/zip", strings.NewReader("zip"), 3, testSHA256("zip")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put error = %v, want context canceled", err)
	}
	path, err := store.resolve(key)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("canceled put left a final object: %v", err)
	}
}

func TestLocalStorageReadsAndMetadataHonorCancellation(t *testing.T) {
	t.Parallel()
	store, err := NewLocalStorage(filepath.Join(t.TempDir(), "private"))
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	key := "exports/tenant/canceled-read.zip"
	if err := store.Put(context.Background(), key, "application/zip", strings.NewReader("zip"), 3, testSHA256("zip")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, _, err := store.Open(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("Open error = %v, want context canceled", err)
	}
	if _, _, _, err := store.Stat(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("Stat error = %v, want context canceled", err)
	}
	if err := store.Delete(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("Delete error = %v, want context canceled", err)
	}
}

func TestExportDownloadPathRequiresReadyPrivateUnexpiredObject(t *testing.T) {
	t.Parallel()
	tenantID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	id := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	key := "exports/" + tenantID + "/" + id + ".zip"
	future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if got := exportDownloadPath(tenantID, id, "ready", &key, &future); got != "/api/v1/exports/"+id+"/download" {
		t.Fatalf("download path = %q", got)
	}
	for name, got := range map[string]string{
		"running":   exportDownloadPath(tenantID, id, "running", &key, &future),
		"expired":   exportDownloadPath(tenantID, id, "ready", &key, &past),
		"no key":    exportDownloadPath(tenantID, id, "ready", nil, &future),
		"no date":   exportDownloadPath(tenantID, id, "ready", &key, nil),
		"wrong key": exportDownloadPath(tenantID, id, "ready", stringPointer("exports/other/job.zip"), &future),
	} {
		if got != "" {
			t.Errorf("%s returned %q", name, got)
		}
	}
}

func stringPointer(value string) *string { return &value }

func testSHA256(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func TestExportObjectKeysAreTenantJobAndAttemptBound(t *testing.T) {
	t.Parallel()
	tenantID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	exportID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	leaseID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	for name, key := range map[string]string{
		"legacy":  "exports/" + tenantID + "/" + exportID + ".zip",
		"attempt": "exports/" + tenantID + "/" + exportID + "/" + leaseID + ".zip",
	} {
		if !validExportObjectKey(key, tenantID, exportID) {
			t.Fatalf("%s key was rejected: %q", name, key)
		}
	}
	for name, key := range map[string]string{
		"other tenant":  "exports/dddddddd-dddd-4ddd-8ddd-dddddddddddd/" + exportID + ".zip",
		"other export":  "exports/" + tenantID + "/dddddddd-dddd-4ddd-8ddd-dddddddddddd.zip",
		"missing lease": "exports/" + tenantID + "/" + exportID + "/.zip",
		"bad lease":     "exports/" + tenantID + "/" + exportID + "/not-a-uuid.zip",
		"nested":        "exports/" + tenantID + "/" + exportID + "/" + leaseID + "/bundle.zip",
		"wrong suffix":  "exports/" + tenantID + "/" + exportID + "/" + leaseID + ".json",
	} {
		if validExportObjectKey(key, tenantID, exportID) {
			t.Fatalf("%s key was accepted: %q", name, key)
		}
	}
}

func TestExportBundleDigestIsDatabaseAndAttemptBound(t *testing.T) {
	t.Parallel()
	tenantID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	exportID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	leaseID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	attemptKey := "exports/" + tenantID + "/" + exportID + "/" + leaseID + ".zip"
	legacyKey := "exports/" + tenantID + "/" + exportID + ".zip"
	digest := testSHA256("zip")
	if err := validateExportBundleDigest(attemptKey, tenantID, exportID, &digest, digest); err != nil {
		t.Fatalf("matching attempt digest: %v", err)
	}
	if err := validateExportBundleDigest(legacyKey, tenantID, exportID, nil, ""); err != nil {
		t.Fatalf("legacy object without historical digest: %v", err)
	}
	upperDigest := strings.ToUpper(digest)
	for name, err := range map[string]error{
		"attempt missing database digest": validateExportBundleDigest(attemptKey, tenantID, exportID, nil, digest),
		"storage digest mismatch":         validateExportBundleDigest(attemptKey, tenantID, exportID, &digest, testSHA256("zap")),
		"noncanonical database digest":    validateExportBundleDigest(attemptKey, tenantID, exportID, &upperDigest, upperDigest),
		"legacy recorded mismatch":        validateExportBundleDigest(legacyKey, tenantID, exportID, &digest, testSHA256("zap")),
	} {
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestPersistedExportSelectionsFailClosed(t *testing.T) {
	t.Parallel()
	got, err := decodePersistedResourceSelection([]byte(`["subscribers","consent"]`))
	if err != nil || len(got) != 2 || got[0] != "subscribers" || got[1] != "consent" {
		t.Fatalf("valid selection = %#v, %v", got, err)
	}
	for name, raw := range map[string]string{
		"malformed":  `{`,
		"null":       `null`,
		"empty":      `[]`,
		"duplicate":  `["consent","consent"]`,
		"unknown":    `["private_credentials"]`,
		"wrong type": `{"consent":true}`,
	} {
		if got, err := decodePersistedResourceSelection([]byte(raw)); err == nil {
			t.Fatalf("%s selection was accepted: %#v", name, got)
		}
	}
}

func TestMaxBytesWriterRefusesOverflowBeforeWritingIt(t *testing.T) {
	t.Parallel()
	var dst bytes.Buffer
	w := &maxBytesWriter{Writer: &dst, Max: 3}
	if n, err := w.Write([]byte("zip")); err != nil || n != 3 {
		t.Fatalf("first write = %d, %v", n, err)
	}
	if n, err := w.Write([]byte("!")); !errors.Is(err, errExportBundleTooLarge) || n != 0 {
		t.Fatalf("overflow write = %d, %v", n, err)
	}
	if dst.String() != "zip" {
		t.Fatalf("overflow changed destination to %q", dst.String())
	}
}
