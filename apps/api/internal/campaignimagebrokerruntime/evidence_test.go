// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type fakeVersionedS3 struct {
	mu          sync.Mutex
	putCalls    int
	putInput    *s3.PutObjectInput
	headInput   *s3.HeadObjectInput
	deleteInput *s3.DeleteObjectInput
	body        []byte
	version     string
	checksum    string
	kmsKeyID    string
	contentType string
	versioned   bool
}

func (f *fakeVersionedS3) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putCalls++
	f.putInput = input
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	f.body = body
	if f.putCalls > 1 {
		return nil, &smithy.GenericAPIError{Code: "PreconditionFailed", Message: "immutable object exists"}
	}
	return &s3.PutObjectOutput{VersionId: aws.String(f.version)}, nil
}

func (f *fakeVersionedS3) HeadObject(_ context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.headInput = input
	return &s3.HeadObjectOutput{
		VersionId: aws.String(f.version), ChecksumSHA256: aws.String(f.checksum),
		ContentLength: aws.Int64(int64(len(f.body))), ContentType: aws.String(f.contentType),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(f.kmsKeyID),
	}, nil
}

func (f *fakeVersionedS3) DeleteObject(_ context.Context, input *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteInput = input
	return &s3.DeleteObjectOutput{VersionId: aws.String(f.version)}, nil
}

func (f *fakeVersionedS3) GetBucketVersioning(_ context.Context, _ *s3.GetBucketVersioningInput, _ ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error) {
	status := s3types.BucketVersioningStatusSuspended
	if f.versioned {
		status = s3types.BucketVersioningStatusEnabled
	}
	return &s3.GetBucketVersioningOutput{Status: status}, nil
}

type fakeEvidenceRepository struct {
	mu       sync.Mutex
	input    EvidenceRecordInput
	record   EvidenceRecord
	deletion DeletionReceiptInput
}

func (r *fakeEvidenceRepository) RecordEvidence(_ context.Context, input EvidenceRecordInput) (EvidenceRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.record.ID == "" {
		r.input = input
		r.record = EvidenceRecord{
			TenantID: input.TenantID, ID: "00000000-0000-4000-8000-000000000099",
			ObjectKey: input.ObjectKey, Bucket: input.Bucket, StorageVersion: input.StorageVersion,
			KMSKeyIDHash: input.KMSKeyIDHash, RasterSHA256: input.RasterSHA256,
			MediaType: input.MediaType, ByteSize: input.ByteSize, ExpiresAt: input.ExpiresAt,
		}
	}
	return r.record, nil
}

func (r *fakeEvidenceRepository) RecordDeletion(_ context.Context, input DeletionReceiptInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletion = input
	return nil
}

func validEvidenceConfiguration() EvidenceConfig {
	return EvidenceConfig{
		Bucket: "postwave-campaign-image-evidence", Prefix: "campaign-assurance/image-evidence/v1",
		KMSKeyID:       "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-4000-8000-000000000001",
		MaxRasterBytes: 1 << 20, Retention: 30 * 24 * time.Hour,
	}
}

func TestS3EvidenceStoreForcesKMSVersioningAndIdempotentContentIdentity(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	body := append([]byte("\x89PNG\r\n\x1a\n"), []byte("canonical-raster")...)
	checksumBytes := sha256.Sum256(body)
	checksum := base64.StdEncoding.EncodeToString(checksumBytes[:])
	objects := &fakeVersionedS3{
		version: "evidence-version-0001", checksum: checksum,
		kmsKeyID: validEvidenceConfiguration().KMSKeyID, contentType: "image/png", versioned: true,
	}
	repository := &fakeEvidenceRepository{}
	store, err := NewS3EvidenceStore(validEvidenceConfiguration(), objects, repository)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return now }
	if err := store.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	tenantID := "00000000-0000-4000-8000-000000000001"
	rasterHash := sha256Hex(body)
	objectKey := "campaign-assurance/ocr/" + strings.Repeat("a", 64) + "/" + strings.Repeat("b", 64) +
		"/" + strings.Repeat("c", 64) + "/" + rasterHash + ".png"
	put := func() string {
		ref, putErr := store.Put(context.Background(), campaignimagebroker.EvidencePutInput{
			TenantID: tenantID, ObjectKey: objectKey, MediaType: "image/png",
			ExpiresAt: now.Add(30 * 24 * time.Hour), Body: bytes.NewReader(body),
		})
		if putErr != nil {
			t.Fatal(putErr)
		}
		return ref
	}
	first, second := put(), put()
	if first != "campaign-image-raster/00000000-0000-4000-8000-000000000099" || second != first {
		t.Fatalf("opaque idempotent refs = %q, %q", first, second)
	}
	objects.mu.Lock()
	putInput, headInput, storedBody, calls := objects.putInput, objects.headInput, append([]byte(nil), objects.body...), objects.putCalls
	objects.mu.Unlock()
	if calls != 2 || !bytes.Equal(storedBody, body) || aws.ToString(putInput.IfNoneMatch) != "*" ||
		putInput.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(putInput.SSEKMSKeyId) != validEvidenceConfiguration().KMSKeyID ||
		aws.ToString(putInput.ChecksumSHA256) != checksum || putInput.ChecksumAlgorithm != s3types.ChecksumAlgorithmSha256 ||
		aws.ToString(headInput.Bucket) != validEvidenceConfiguration().Bucket || headInput.ChecksumMode != s3types.ChecksumModeEnabled {
		t.Fatalf("unsafe S3 evidence contract: put=%+v head=%+v calls=%d", putInput, headInput, calls)
	}
	if rawTenant := putInput.Metadata["postwave-tenant-sha256"]; rawTenant == tenantID || rawTenant != sha256Hex([]byte(tenantID)) {
		t.Fatalf("tenant metadata is not hashed: %q", rawTenant)
	}
	repository.mu.Lock()
	record := repository.record
	repository.mu.Unlock()
	if record.StorageVersion != "evidence-version-0001" || record.RasterSHA256 != rasterHash ||
		record.KMSKeyIDHash != sha256Hex([]byte(validEvidenceConfiguration().KMSKeyID)) ||
		!strings.Contains(record.ObjectKey, "/tenants/"+tenantID+"/") {
		t.Fatalf("evidence ledger is not exact-version and tenant bound: %+v", record)
	}
}

func TestS3EvidenceStoreDeletesOnlyExactRecordedVersion(t *testing.T) {
	objects := &fakeVersionedS3{version: "evidence-version-0001", versioned: true}
	repository := &fakeEvidenceRepository{}
	store, err := NewS3EvidenceStore(validEvidenceConfiguration(), objects, repository)
	if err != nil {
		t.Fatal(err)
	}
	record := EvidenceRecord{
		TenantID:  "00000000-0000-4000-8000-000000000001",
		ID:        "00000000-0000-4000-8000-000000000099",
		ObjectKey: "campaign-assurance/image-evidence/v1/tenants/00000000-0000-4000-8000-000000000001/campaign-assurance/ocr/" + strings.Repeat("a", 64) + "/" + strings.Repeat("b", 64) + "/" + strings.Repeat("c", 64) + "/" + strings.Repeat("d", 64) + ".png",
		Bucket:    validEvidenceConfiguration().Bucket, StorageVersion: "evidence-version-0001",
		KMSKeyIDHash: sha256Hex([]byte(validEvidenceConfiguration().KMSKeyID)), RasterSHA256: strings.Repeat("d", 64),
		MediaType: "image/png", ByteSize: 100, ExpiresAt: time.Now().Add(-time.Hour),
	}
	if err := store.DeleteExact(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	objects.mu.Lock()
	deleted := objects.deleteInput
	objects.mu.Unlock()
	if aws.ToString(deleted.Key) != record.ObjectKey || aws.ToString(deleted.VersionId) != record.StorageVersion {
		t.Fatalf("delete was not exact version: %+v", deleted)
	}
	repository.mu.Lock()
	receipt := repository.deletion
	repository.mu.Unlock()
	if receipt.Evidence.ID != record.ID || receipt.ResponseStorageVersion != record.StorageVersion {
		t.Fatalf("wrong exact-version deletion receipt: %+v", receipt)
	}
}

func TestS3EvidenceReadinessRejectsUnversionedBucket(t *testing.T) {
	store, err := NewS3EvidenceStore(validEvidenceConfiguration(), &fakeVersionedS3{}, &fakeEvidenceRepository{})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(context.Background()); err == nil {
		t.Fatal("unversioned evidence bucket passed readiness")
	}
}
