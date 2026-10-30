// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceretention"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
)

type S3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error)
	GetBucketEncryption(context.Context, *s3.GetBucketEncryptionInput, ...func(*s3.Options)) (*s3.GetBucketEncryptionOutput, error)
}

type S3Store struct {
	configuration Configuration
	objects       S3API
	repository    Repository
}

var (
	_ campaignassuranceworker.RawOutputStore       = (*S3Store)(nil)
	_ campaignassuranceretention.ExactVersionStore = (*S3Store)(nil)
)

func NewS3Store(configuration Configuration, objects S3API, repository Repository) (*S3Store, error) {
	configuration, err := normalizeConfiguration(configuration)
	if err != nil || objects == nil || repository == nil {
		return nil, ErrInvalidConfiguration
	}
	return &S3Store{configuration: configuration, objects: objects, repository: repository}, nil
}

// CampaignAssuranceRawOutputStore prevents a generic key-only uploads.Store
// from accidentally satisfying the worker's security-sensitive write surface.
func (*S3Store) CampaignAssuranceRawOutputStore() {}

// Ready proves both database receipt enforcement and the S3 controls relied on
// by every write. KMS aliases are intentionally rejected: HeadObject must echo
// the same immutable key ARN configured here.
func (s *S3Store) Ready(ctx context.Context) error {
	if s == nil || s.objects == nil || s.repository == nil {
		return ErrInvalidConfiguration
	}
	if !strings.HasPrefix(s.configuration.KMSKeyID, "arn:") || !strings.Contains(s.configuration.KMSKeyID, ":kms:") {
		return fmt.Errorf("%w: KMSKeyID must be an exact key ARN", ErrNotReady)
	}
	if err := s.repository.Ready(ctx); err != nil {
		return fmt.Errorf("%w: durable write receipt repository: %v", ErrNotReady, err)
	}
	call, cancel := s.operationContext(ctx)
	versioning, err := s.objects.GetBucketVersioning(call, &s3.GetBucketVersioningInput{
		Bucket: aws.String(s.configuration.Bucket),
	})
	cancel()
	if err != nil || versioning == nil || versioning.Status != s3types.BucketVersioningStatusEnabled {
		return fmt.Errorf("%w: S3 bucket versioning is not enabled", ErrNotReady)
	}
	call, cancel = s.operationContext(ctx)
	encryption, err := s.objects.GetBucketEncryption(call, &s3.GetBucketEncryptionInput{
		Bucket: aws.String(s.configuration.Bucket),
	})
	cancel()
	if err != nil || encryption == nil || encryption.ServerSideEncryptionConfiguration == nil {
		return fmt.Errorf("%w: S3 bucket encryption cannot be proven", ErrNotReady)
	}
	for _, rule := range encryption.ServerSideEncryptionConfiguration.Rules {
		defaults := rule.ApplyServerSideEncryptionByDefault
		if defaults != nil && defaults.SSEAlgorithm == s3types.ServerSideEncryptionAwsKms &&
			aws.ToString(defaults.KMSMasterKeyID) == s.configuration.KMSKeyID {
			return nil
		}
	}
	return fmt.Errorf("%w: bucket default does not use the configured exact KMS key", ErrNotReady)
}

func (s *S3Store) Put(
	ctx context.Context,
	tenantID, rest, contentType string,
	body io.Reader,
) (string, error) {
	if s == nil || body == nil || contentType != ContentTypeJSON {
		return "", ErrInvalidIdentity
	}
	objectKey, objectRef, intentID, err := canonicalRest(tenantID, rest)
	if err != nil {
		return "", err
	}
	raw, err := io.ReadAll(io.LimitReader(body, int64(campaigncomprehension.MaxExtractionBytes)+1))
	if err != nil || len(raw) == 0 || len(raw) > campaigncomprehension.MaxExtractionBytes {
		return "", ErrInvalidIdentity
	}
	digest := sha256.Sum256(raw)
	contentHash := sha256Hex(raw)
	checksum := base64.StdEncoding.EncodeToString(digest[:])
	identity := WriteIntentInput{
		TenantID: tenantID, IntentID: intentID, ObjectRest: rest, ObjectKey: objectKey,
		ObjectRef: objectRef, ContentSHA256: contentHash, ChecksumBase64: checksum,
		ContentType: contentType, ByteSize: int64(len(raw)), Bucket: s.configuration.Bucket,
		KMSKeyIDHash: sha256Hex([]byte(s.configuration.KMSKeyID)),
	}
	intent, err := s.repository.BeginWrite(ctx, identity)
	if err != nil {
		return "", fmt.Errorf("create durable raw-output write intent: %w", err)
	}
	if _, err := normalizeIntent(intent.WriteIntentInput); err != nil || intent.WriteIntentInput != identity {
		return "", ErrObjectConflict
	}

	call, cancel := s.operationContext(ctx)
	put, putErr := s.objects.PutObject(call, &s3.PutObjectInput{
		Bucket: aws.String(identity.Bucket), Key: aws.String(identity.ObjectKey),
		Body: bytes.NewReader(raw), ContentLength: aws.Int64(identity.ByteSize),
		ContentType:          aws.String(identity.ContentType),
		ChecksumAlgorithm:    s3types.ChecksumAlgorithmSha256,
		ChecksumSHA256:       aws.String(identity.ChecksumBase64),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(s.configuration.KMSKeyID),
		BucketKeyEnabled:     aws.Bool(true), IfNoneMatch: aws.String("*"),
		Metadata: map[string]string{
			"postwave-tenant-sha256":     sha256Hex([]byte(identity.TenantID)),
			"postwave-raw-output-sha256": identity.ContentSHA256,
			"postwave-write-intent-id":   identity.IntentID,
			"postwave-kms-key-sha256":    identity.KMSKeyIDHash,
		},
	})
	cancel()
	if putErr != nil && !isPreconditionFailure(putErr) {
		return "", fmt.Errorf("write immutable raw-output object: %w", putErr)
	}
	versionID := ""
	if put != nil {
		versionID = aws.ToString(put.VersionId)
	}
	receipt, err := s.verifyHead(ctx, intent, versionID)
	if err != nil {
		return "", err
	}
	stored, err := s.repository.RecordVersion(ctx, intent, receipt)
	if err != nil {
		// A commit response can be ambiguous. A matching durable receipt means
		// the write is complete; only a proven absence authorizes compensation.
		existing, loadErr := s.repository.LoadVersion(ctx, tenantID, rest, contentHash)
		if loadErr == nil && sameVersion(existing, receipt) {
			return objectKey, nil
		}
		if errors.Is(loadErr, ErrReceiptUnavailable) {
			cleanupErr := s.compensateUnreceipted(ctx, intent, receipt)
			return "", errors.Join(fmt.Errorf("record exact raw-output version: %w", err), cleanupErr)
		}
		return "", errors.Join(fmt.Errorf("record exact raw-output version: %w", err), loadErr)
	}
	if !sameVersion(stored, receipt) || !hashPattern.MatchString(stored.ReceiptHash) {
		return "", ErrObjectConflict
	}
	return objectKey, nil
}

// Get reads only the immutable version named by the durable write receipt. It
// buffers the bounded body so callers never observe bytes before all provider
// and content proofs have passed.
func (s *S3Store) Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error) {
	if s == nil {
		return nil, "", ErrInvalidConfiguration
	}
	if _, _, _, err := canonicalRest(tenantID, rest); err != nil {
		return nil, "", err
	}
	receipt, err := s.repository.LoadVersion(ctx, tenantID, rest, "")
	if err != nil {
		return nil, "", err
	}
	if _, err := normalizeReceipt(intentFromReceipt(receipt), receipt); err != nil ||
		receipt.ReceiptHash == "" || providerProof(receipt) != receipt.ProviderProofHash {
		return nil, "", ErrObjectConflict
	}
	call, cancel := s.operationContext(ctx)
	out, err := s.objects.GetObject(call, &s3.GetObjectInput{
		Bucket: aws.String(receipt.Bucket), Key: aws.String(receipt.ObjectKey),
		VersionId: aws.String(receipt.VersionID), ChecksumMode: s3types.ChecksumModeEnabled,
	})
	if err != nil {
		cancel()
		if isExplicitlyMissing(err) {
			return nil, "", ErrExactVersionMissing
		}
		return nil, "", fmt.Errorf("read exact raw-output version: %w", err)
	}
	if out == nil || out.Body == nil {
		cancel()
		return nil, "", ErrObjectConflict
	}
	raw, readErr := io.ReadAll(io.LimitReader(out.Body, int64(campaigncomprehension.MaxExtractionBytes)+1))
	closeErr := out.Body.Close()
	cancel()
	if readErr != nil || closeErr != nil {
		return nil, "", errors.Join(readErr, closeErr)
	}
	if err := s.verifyGetOutput(receipt, out, raw); err != nil {
		return nil, "", err
	}
	return io.NopCloser(bytes.NewReader(raw)), receipt.ContentType, nil
}

// Delete is the compensating RawOutputStore operation. It claims the durable
// intent only if no extraction references it, then deletes its exact version.
func (s *S3Store) Delete(ctx context.Context, tenantID, rest string) error {
	if s == nil {
		return ErrInvalidConfiguration
	}
	intent, err := s.repository.ClaimCleanup(ctx, tenantID, rest, s.configuration.WorkerID, s.configuration.CleanupLeaseTTL)
	if err != nil {
		return err
	}
	return s.cleanupClaim(ctx, intent)
}

func (s *S3Store) ResolveExactVersion(
	ctx context.Context,
	tenantID, objectRest, expectedContentSHA256 string,
) (campaignassuranceretention.VersionIdentity, error) {
	if s == nil || !hashPattern.MatchString(expectedContentSHA256) {
		return campaignassuranceretention.VersionIdentity{}, campaignassuranceretention.ErrExactVersionUnavailable
	}
	receipt, err := s.repository.LoadVersion(ctx, tenantID, objectRest, expectedContentSHA256)
	if err != nil || !hashPattern.MatchString(receipt.ReceiptHash) {
		return campaignassuranceretention.VersionIdentity{}, campaignassuranceretention.ErrExactVersionUnavailable
	}
	intent := intentFromReceipt(receipt)
	verified, err := s.verifyHead(ctx, intent, receipt.VersionID)
	if err != nil || !sameVersion(receipt, verified) || receipt.ProviderProofHash != verified.ProviderProofHash {
		return campaignassuranceretention.VersionIdentity{}, campaignassuranceretention.ErrExactVersionUnavailable
	}
	return campaignassuranceretention.VersionIdentity{
		Backend: "s3", Bucket: receipt.Bucket, ObjectKey: objectRest,
		VersionID: receipt.VersionID, ContentSHA256: receipt.ContentSHA256,
		ByteSize: receipt.ByteSize, ProviderProofSHA256: receipt.ProviderProofHash,
	}, nil
}

func (s *S3Store) DeleteExactVersion(
	ctx context.Context,
	tenantID string,
	version campaignassuranceretention.VersionIdentity,
) (campaignassuranceretention.DeleteResult, error) {
	if s == nil || version.Backend != "s3" || version.Bucket != s.configuration.Bucket ||
		version.VersionID == "" || !hashPattern.MatchString(version.ContentSHA256) {
		return campaignassuranceretention.DeleteResult{}, campaignassuranceretention.ErrExactVersionUnavailable
	}
	receipt, err := s.repository.LoadVersion(ctx, tenantID, version.ObjectKey, version.ContentSHA256)
	if err != nil || !hashPattern.MatchString(receipt.ReceiptHash) ||
		receipt.Bucket != version.Bucket || receipt.VersionID != version.VersionID ||
		receipt.ByteSize != version.ByteSize || receipt.ProviderProofHash != version.ProviderProofSHA256 {
		return campaignassuranceretention.DeleteResult{}, campaignassuranceretention.ErrExactVersionUnavailable
	}
	result, err := s.deleteExact(ctx, receipt)
	if err != nil {
		return campaignassuranceretention.DeleteResult{}, err
	}
	disposition := campaignassuranceretention.DispositionDeleted
	if result.Disposition == CleanupAlreadyMissing {
		disposition = campaignassuranceretention.DispositionAlreadyMissing
	}
	return campaignassuranceretention.DeleteResult{
		Disposition: disposition, ResponseVersion: result.ResponseVersion,
		DeleteMarker: result.DeleteMarker, ProviderRequestIDHash: result.ProviderRequestIDHash,
	}, nil
}

func (s *S3Store) verifyHead(ctx context.Context, intent WriteIntent, versionID string) (VersionReceipt, error) {
	input, err := normalizeIntent(intent.WriteIntentInput)
	if err != nil {
		return VersionReceipt{}, err
	}
	headInput := &s3.HeadObjectInput{
		Bucket: aws.String(input.Bucket), Key: aws.String(input.ObjectKey),
		ChecksumMode: s3types.ChecksumModeEnabled,
	}
	if versionID != "" {
		headInput.VersionId = aws.String(versionID)
	}
	call, cancel := s.operationContext(ctx)
	head, err := s.objects.HeadObject(call, headInput)
	cancel()
	if err != nil {
		if isExplicitlyMissing(err) {
			return VersionReceipt{}, ErrExactVersionMissing
		}
		return VersionReceipt{}, fmt.Errorf("verify exact raw-output version: %w", err)
	}
	if head == nil {
		return VersionReceipt{}, ErrObjectConflict
	}
	observedVersion := aws.ToString(head.VersionId)
	if versionID != "" && observedVersion != versionID {
		return VersionReceipt{}, ErrObjectConflict
	}
	receipt := VersionReceipt{
		TenantID: input.TenantID, IntentID: input.IntentID, ObjectRest: input.ObjectRest,
		ObjectKey: input.ObjectKey, ObjectRef: input.ObjectRef, Bucket: input.Bucket,
		VersionID: observedVersion, ContentSHA256: input.ContentSHA256,
		ChecksumBase64: input.ChecksumBase64, ContentType: input.ContentType,
		ByteSize: input.ByteSize, KMSKeyIDHash: input.KMSKeyIDHash,
	}
	if observedVersion == "" || aws.ToString(head.ChecksumSHA256) != input.ChecksumBase64 ||
		aws.ToInt64(head.ContentLength) != input.ByteSize || aws.ToString(head.ContentType) != input.ContentType ||
		head.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(head.SSEKMSKeyId) != s.configuration.KMSKeyID || aws.ToBool(head.DeleteMarker) ||
		head.Metadata["postwave-tenant-sha256"] != sha256Hex([]byte(input.TenantID)) ||
		head.Metadata["postwave-raw-output-sha256"] != input.ContentSHA256 ||
		head.Metadata["postwave-write-intent-id"] != input.IntentID ||
		head.Metadata["postwave-kms-key-sha256"] != input.KMSKeyIDHash {
		return VersionReceipt{}, ErrObjectConflict
	}
	receipt.ProviderProofHash = providerProof(receipt)
	return receipt, nil
}

func (s *S3Store) verifyGetOutput(receipt VersionReceipt, output *s3.GetObjectOutput, raw []byte) error {
	if len(raw) == 0 || int64(len(raw)) != receipt.ByteSize || len(raw) > campaigncomprehension.MaxExtractionBytes ||
		sha256Hex(raw) != receipt.ContentSHA256 || aws.ToString(output.VersionId) != receipt.VersionID ||
		aws.ToString(output.ChecksumSHA256) != receipt.ChecksumBase64 ||
		aws.ToInt64(output.ContentLength) != receipt.ByteSize || aws.ToString(output.ContentType) != receipt.ContentType ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(output.SSEKMSKeyId) != s.configuration.KMSKeyID || aws.ToBool(output.DeleteMarker) ||
		output.Metadata["postwave-tenant-sha256"] != sha256Hex([]byte(receipt.TenantID)) ||
		output.Metadata["postwave-raw-output-sha256"] != receipt.ContentSHA256 ||
		output.Metadata["postwave-write-intent-id"] != receipt.IntentID ||
		output.Metadata["postwave-kms-key-sha256"] != receipt.KMSKeyIDHash ||
		providerProof(receipt) != receipt.ProviderProofHash {
		return ErrObjectConflict
	}
	return nil
}

func (s *S3Store) operationContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, s.configuration.OperationTimeout)
}

func sameVersion(left, right VersionReceipt) bool {
	return left.TenantID == right.TenantID && left.IntentID == right.IntentID &&
		left.ObjectRest == right.ObjectRest && left.ObjectKey == right.ObjectKey &&
		left.ObjectRef == right.ObjectRef && left.Bucket == right.Bucket &&
		left.VersionID == right.VersionID && left.ContentSHA256 == right.ContentSHA256 &&
		left.ChecksumBase64 == right.ChecksumBase64 && left.ContentType == right.ContentType &&
		left.ByteSize == right.ByteSize && left.KMSKeyIDHash == right.KMSKeyIDHash &&
		left.ProviderProofHash == right.ProviderProofHash
}

func intentFromReceipt(receipt VersionReceipt) WriteIntent {
	return WriteIntent{WriteIntentInput: WriteIntentInput{
		TenantID: receipt.TenantID, IntentID: receipt.IntentID, ObjectRest: receipt.ObjectRest,
		ObjectKey: receipt.ObjectKey, ObjectRef: receipt.ObjectRef, ContentSHA256: receipt.ContentSHA256,
		ChecksumBase64: receipt.ChecksumBase64, ContentType: receipt.ContentType,
		ByteSize: receipt.ByteSize, Bucket: receipt.Bucket, KMSKeyIDHash: receipt.KMSKeyIDHash,
	}}
}

func (s *S3Store) compensateUnreceipted(ctx context.Context, intent WriteIntent, receipt VersionReceipt) error {
	claim, err := s.repository.ClaimCleanup(ctx, intent.TenantID, intent.ObjectRest,
		s.configuration.WorkerID, s.configuration.CleanupLeaseTTL)
	if err != nil {
		return fmt.Errorf("claim unreceipted raw-output cleanup: %w", err)
	}
	result, deleteErr := s.deleteExact(ctx, receipt)
	if deleteErr != nil {
		recordErr := s.repository.RecordCleanupFailure(ctx, claim, nil, "exact_cleanup_failed", deleteErr,
			s.configuration.RetryBackoff(claim.Attempt))
		return errors.Join(deleteErr, recordErr)
	}
	if err := s.repository.RecordCleanup(ctx, claim, receipt, result); err != nil {
		return fmt.Errorf("record unreceipted raw-output cleanup: %w", err)
	}
	return nil
}

func isPreconditionFailure(err error) bool {
	var apiError smithy.APIError
	return errors.As(err, &apiError) &&
		(apiError.ErrorCode() == "PreconditionFailed" || apiError.ErrorCode() == "ConditionalRequestConflict")
}

func isExplicitlyMissing(err error) bool {
	var apiError smithy.APIError
	return errors.As(err, &apiError) &&
		(apiError.ErrorCode() == "NoSuchVersion" || apiError.ErrorCode() == "NoSuchKey" || apiError.ErrorCode() == "NotFound")
}
