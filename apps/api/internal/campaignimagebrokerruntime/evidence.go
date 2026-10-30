// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type VersionedS3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error)
}

type EvidenceRepository interface {
	RecordEvidence(context.Context, EvidenceRecordInput) (EvidenceRecord, error)
	RecordDeletion(context.Context, DeletionReceiptInput) error
}

type S3EvidenceStore struct {
	configuration EvidenceConfig
	objects       VersionedS3API
	repository    EvidenceRepository
	now           func() time.Time
}

var _ campaignimagebroker.EvidenceStore = (*S3EvidenceStore)(nil)

func NewS3EvidenceStore(configuration EvidenceConfig, objects VersionedS3API, repository EvidenceRepository) (*S3EvidenceStore, error) {
	candidate := Configuration{
		Enabled:      true,
		AllowedHosts: []string{"config-validation.invalid"},
		OCR: OCRConfig{SocketPath: "/run/postwave/ocr.sock", Engine: "ocr", Version: "v1",
			Timeout: time.Second, MaxRequestBytes: defaultMaxRasterBytes, MaxResponseBytes: defaultMaxWireHeader},
		Scanner: ScannerConfig{SocketPath: "/run/postwave/scanner.sock", Engine: "scanner", Version: "v1",
			Timeout: time.Second, MaxRequestBytes: defaultMaxRasterBytes, MaxResponseBytes: defaultMaxWireHeader},
		Evidence: configuration, CacheRetention: defaultCacheTTL,
		Broker: campaignimagebroker.Configuration{AllowedHosts: []string{"config-validation.invalid"},
			EvidenceRetention: configuration.Retention, RequireContentScan: true},
	}
	if err := candidate.Validate(); err != nil || objects == nil || repository == nil {
		return nil, ErrInvalidConfiguration
	}
	return &S3EvidenceStore{configuration: configuration, objects: objects, repository: repository, now: time.Now}, nil
}

func (s *S3EvidenceStore) Ready(ctx context.Context) error {
	if s == nil || s.objects == nil || s.repository == nil {
		return ErrInvalidConfiguration
	}
	output, err := s.objects.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{
		Bucket: aws.String(s.configuration.Bucket),
	})
	if err != nil || output == nil || output.Status != s3types.BucketVersioningStatusEnabled {
		return fmt.Errorf("%w: evidence bucket versioning is not enabled", ErrNotReady)
	}
	return nil
}

func (s *S3EvidenceStore) Put(ctx context.Context, input campaignimagebroker.EvidencePutInput) (string, error) {
	tenantID, objectKey, rasterSHA256, body, err := s.normalizePut(input)
	if err != nil {
		return "", err
	}
	fullKey := path.Join(s.configuration.Prefix, "tenants", tenantID, objectKey)
	checksumBytes := sha256.Sum256(body)
	checksumBase64 := base64.StdEncoding.EncodeToString(checksumBytes[:])
	putOutput, putErr := s.objects.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.configuration.Bucket), Key: aws.String(fullKey), Body: bytes.NewReader(body),
		ContentLength: aws.Int64(int64(len(body))), ContentType: aws.String("image/png"),
		ChecksumAlgorithm: s3types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksumBase64),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(s.configuration.KMSKeyID),
		BucketKeyEnabled:     aws.Bool(true), IfNoneMatch: aws.String("*"),
		Metadata: map[string]string{
			"postwave-tenant-sha256": sha256Hex([]byte(tenantID)),
			"postwave-raster-sha256": rasterSHA256,
		},
	})
	var versionID string
	switch {
	case putErr == nil && putOutput != nil:
		versionID = aws.ToString(putOutput.VersionId)
	case isS3PreconditionFailure(putErr):
		// The key is tenant/content addressed and all writes use If-None-Match.
		// A concurrent/retried write must prove the immutable existing object
		// below instead of creating another storage version.
	default:
		return "", fmt.Errorf("persist encrypted raster evidence: %w", putErr)
	}
	headInput := &s3.HeadObjectInput{
		Bucket: aws.String(s.configuration.Bucket), Key: aws.String(fullKey),
		ChecksumMode: s3types.ChecksumModeEnabled,
	}
	if versionID != "" {
		headInput.VersionId = aws.String(versionID)
	}
	head, err := s.objects.HeadObject(ctx, headInput)
	if err != nil || head == nil {
		return "", fmt.Errorf("verify encrypted raster evidence: %w", err)
	}
	if versionID == "" {
		versionID = aws.ToString(head.VersionId)
	}
	if versionID == "" || aws.ToString(head.VersionId) != versionID ||
		aws.ToString(head.ChecksumSHA256) != checksumBase64 || aws.ToInt64(head.ContentLength) != int64(len(body)) ||
		aws.ToString(head.ContentType) != "image/png" || head.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(head.SSEKMSKeyId) != s.configuration.KMSKeyID || aws.ToBool(head.DeleteMarker) {
		return "", ErrEvidenceConflict
	}
	record, err := s.repository.RecordEvidence(ctx, EvidenceRecordInput{
		TenantID: tenantID, ObjectKey: fullKey, Bucket: s.configuration.Bucket,
		StorageVersion: versionID, KMSKeyIDHash: sha256Hex([]byte(s.configuration.KMSKeyID)),
		RasterSHA256: rasterSHA256, MediaType: "image/png", ByteSize: int64(len(body)),
		ExpiresAt: input.ExpiresAt.UTC(),
	})
	if err != nil {
		return "", err
	}
	return "campaign-image-raster/" + record.ID, nil
}

func (s *S3EvidenceStore) normalizePut(input campaignimagebroker.EvidencePutInput) (string, string, string, []byte, error) {
	if s == nil || s.objects == nil || s.repository == nil || input.Body == nil || input.MediaType != "image/png" {
		return "", "", "", nil, ErrInvalidConfiguration
	}
	tenantID, err := uuid.Parse(input.TenantID)
	if err != nil || tenantID.String() != input.TenantID || input.ObjectKey == "" ||
		strings.TrimSpace(input.ObjectKey) != input.ObjectKey || path.Clean(input.ObjectKey) != input.ObjectKey ||
		path.IsAbs(input.ObjectKey) || strings.HasPrefix(input.ObjectKey, ".") || strings.Contains(input.ObjectKey, `\`) {
		return "", "", "", nil, fmt.Errorf("%w: invalid tenant-bound evidence key", ErrInvalidConfiguration)
	}
	base := path.Base(input.ObjectKey)
	if !strings.HasSuffix(base, ".png") {
		return "", "", "", nil, fmt.Errorf("%w: evidence key is not a PNG content identity", ErrInvalidConfiguration)
	}
	rasterSHA256 := strings.TrimSuffix(base, ".png")
	if !validSHA256(rasterSHA256) {
		return "", "", "", nil, fmt.Errorf("%w: evidence key lacks raster hash", ErrInvalidConfiguration)
	}
	now := s.now().UTC()
	if input.ExpiresAt.Before(now.Add(s.configuration.Retention-time.Minute)) ||
		input.ExpiresAt.After(now.Add(s.configuration.Retention+time.Minute)) {
		return "", "", "", nil, fmt.Errorf("%w: evidence expiration differs from retention policy", ErrInvalidConfiguration)
	}
	body, err := io.ReadAll(io.LimitReader(input.Body, s.configuration.MaxRasterBytes+1))
	if err != nil || len(body) == 0 || int64(len(body)) > s.configuration.MaxRasterBytes ||
		!bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n")) || sha256Hex(body) != rasterSHA256 {
		return "", "", "", nil, fmt.Errorf("%w: raster evidence body violates content identity or byte bound", ErrInvalidConfiguration)
	}
	return tenantID.String(), input.ObjectKey, rasterSHA256, body, nil
}

// DeleteExact deletes one immutable S3 version and durably records that exact
// requested version. A replay after S3 has already removed the version is
// successful only for an explicit NoSuchVersion/NoSuchKey response.
func (s *S3EvidenceStore) DeleteExact(ctx context.Context, record EvidenceRecord) error {
	if s == nil || s.objects == nil || s.repository == nil {
		return ErrInvalidConfiguration
	}
	if _, err := normalizeEvidenceInput(EvidenceRecordInput{
		TenantID: record.TenantID, ObjectKey: record.ObjectKey, Bucket: record.Bucket,
		StorageVersion: record.StorageVersion, KMSKeyIDHash: record.KMSKeyIDHash,
		RasterSHA256: record.RasterSHA256, MediaType: record.MediaType,
		ByteSize: record.ByteSize, ExpiresAt: record.ExpiresAt,
	}); err != nil || record.Bucket != s.configuration.Bucket ||
		record.KMSKeyIDHash != sha256Hex([]byte(s.configuration.KMSKeyID)) ||
		!strings.HasPrefix(record.ObjectKey, s.configuration.Prefix+"/tenants/"+record.TenantID+"/") ||
		record.StorageVersion == "" {
		return ErrInvalidConfiguration
	}
	output, err := s.objects.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(record.Bucket), Key: aws.String(record.ObjectKey),
		VersionId: aws.String(record.StorageVersion),
	})
	if err != nil && !isS3AlreadyMissing(err) {
		return fmt.Errorf("delete exact raster storage version: %w", err)
	}
	responseVersion, deleteMarker, requestIDHash := "", false, ""
	if output != nil {
		responseVersion = aws.ToString(output.VersionId)
		deleteMarker = aws.ToBool(output.DeleteMarker)
		if responseVersion != "" && responseVersion != record.StorageVersion {
			return ErrEvidenceConflict
		}
		if requestID, ok := awsmiddleware.GetRequestIDMetadata(output.ResultMetadata); ok && requestID != "" {
			requestIDHash = sha256Hex([]byte(requestID))
		}
	}
	return s.repository.RecordDeletion(ctx, DeletionReceiptInput{
		Evidence: record, ResponseStorageVersion: responseVersion,
		DeleteMarker: deleteMarker, ProviderRequestIDHash: requestIDHash,
	})
}

func isS3PreconditionFailure(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}
	return apiError.ErrorCode() == "PreconditionFailed" || apiError.ErrorCode() == "ConditionalRequestConflict"
}

func isS3AlreadyMissing(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}
	return apiError.ErrorCode() == "NoSuchVersion" || apiError.ErrorCode() == "NoSuchKey"
}
