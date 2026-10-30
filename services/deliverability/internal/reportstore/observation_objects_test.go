package reportstore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/google/uuid"
)

type observationS3Fake struct {
	putInput    *s3.PutObjectInput
	deleteInput *s3.DeleteObjectInput
	putError    error
	deleteError error
	versionID   string
}

func (f *observationS3Fake) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.putInput = input
	if f.putError != nil {
		return nil, f.putError
	}
	return &s3.PutObjectOutput{VersionId: aws.String(f.versionID), ETag: aws.String(`"etag-1"`)}, nil
}

func (f *observationS3Fake) DeleteObject(_ context.Context, input *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.deleteInput = input
	return &s3.DeleteObjectOutput{}, f.deleteError
}

func TestS3ObservationObjectStoreWritesVersionedTenantBoundKMSObject(t *testing.T) {
	fake := &observationS3Fake{versionID: "version-1"}
	store, err := NewS3ObservationObjectStore(fake, "private-seed-evidence", "alias/seed-evidence", "seed-prefix", "123456789012")
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("From: sender@example.test\r\nTo: seed@example.test\r\n\r\nhello\r\n")
	tenantID := uuid.NewString()
	receipt, err := store.PutRawMIME(context.Background(), RawMIMEObject{
		TenantID: tenantID, ObservationKey: strings.Repeat("a", 64),
		SHA256: digestBytes(raw), Raw: raw, ExpiresAt: time.Now().Add(30 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if fake.putInput == nil {
		t.Fatal("S3 PutObject was not called")
	}
	if fake.putInput.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(fake.putInput.SSEKMSKeyId) != "alias/seed-evidence" ||
		!aws.ToBool(fake.putInput.BucketKeyEnabled) {
		t.Fatalf("encryption fields = %#v", fake.putInput)
	}
	if fake.putInput.ChecksumAlgorithm != s3types.ChecksumAlgorithmSha256 || aws.ToString(fake.putInput.ChecksumSHA256) == "" {
		t.Fatal("SHA-256 transport checksum missing")
	}
	contextJSON, err := base64.StdEncoding.DecodeString(aws.ToString(fake.putInput.SSEKMSEncryptionContext))
	if err != nil {
		t.Fatal(err)
	}
	var encryptionContext map[string]string
	if err := json.Unmarshal(contextJSON, &encryptionContext); err != nil {
		t.Fatal(err)
	}
	if encryptionContext["tenant_id"] != tenantID || encryptionContext["purpose"] != "controlled_seed_received_mime" {
		t.Fatalf("encryption context = %#v", encryptionContext)
	}
	stored, err := io.ReadAll(fake.putInput.Body)
	if err != nil || string(stored) != string(raw) {
		t.Fatalf("stored body mismatch: %v", err)
	}
	if !strings.Contains(receipt.ObjectRef, "?versionId=version-1") || receipt.VersionID != "version-1" {
		t.Fatalf("receipt = %#v", receipt)
	}
	if err := store.DeleteRawMIME(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	if fake.deleteInput == nil || aws.ToString(fake.deleteInput.VersionId) != "version-1" ||
		aws.ToString(fake.deleteInput.ExpectedBucketOwner) != "123456789012" {
		t.Fatalf("delete input = %#v", fake.deleteInput)
	}
}

func TestS3ObservationObjectStoreRejectsDigestMismatchAndUnversionedBucket(t *testing.T) {
	fake := &observationS3Fake{versionID: "version-1"}
	store, err := NewS3ObservationObjectStore(fake, "private-seed-evidence", "kms-key", "seed", "")
	if err != nil {
		t.Fatal(err)
	}
	object := RawMIMEObject{
		TenantID: uuid.NewString(), ObservationKey: strings.Repeat("b", 64),
		SHA256: strings.Repeat("c", 64), Raw: []byte("message"), ExpiresAt: time.Now().Add(time.Hour),
	}
	if _, err := store.PutRawMIME(context.Background(), object); err == nil || fake.putInput != nil {
		t.Fatalf("digest mismatch should fail before S3, err=%v", err)
	}
	object.SHA256 = digestBytes(object.Raw)
	fake.versionID = ""
	if _, err := store.PutRawMIME(context.Background(), object); err == nil || !strings.Contains(err.Error(), "versioning") {
		t.Fatalf("unversioned bucket err = %v", err)
	}
}

func TestVerifyObservationObjectStoreRequiresSuccessfulPutAndDelete(t *testing.T) {
	fake := &observationS3Fake{versionID: "readiness-v1", deleteError: errors.New("delete denied")}
	store, err := NewS3ObservationObjectStore(fake, "private-seed-evidence", "kms-key", "seed", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyObservationObjectStore(context.Background(), store); err == nil || !strings.Contains(err.Error(), "cleanup") {
		t.Fatalf("readiness err = %v", err)
	}
}
