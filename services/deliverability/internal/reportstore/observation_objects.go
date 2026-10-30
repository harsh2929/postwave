package reportstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/google/uuid"
)

const (
	seedMIMEObjectSchemaVersion = "postwave.seed-mime-object.v1"
	maxObservationObjectBytes   = 50 << 20
)

// ObservationObjectStore is the private encrypted-object boundary used before
// an append-only database observation is committed. Implementations must not
// expose public URLs; ObjectRef is an opaque durable locator for authorized
// service-side retrieval and retention deletion.
type ObservationObjectStore interface {
	PutRawMIME(context.Context, RawMIMEObject) (ObjectReceipt, error)
	DeleteRawMIME(context.Context, ObjectReceipt) error
}

type RawMIMEObject struct {
	TenantID       string
	ObservationKey string
	SHA256         string
	Raw            []byte
	ExpiresAt      time.Time
}

type ObjectReceipt struct {
	ObjectRef string
	VersionID string
	ETag      string
}

// S3PutObjectAPI is the exact AWS surface needed by the observation writer.
type S3PutObjectAPI interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

// S3ObservationObjectStore writes raw RFC-822 bytes to a private bucket using
// SSE-KMS and tenant-bound encryption context. Bucket policy should additionally
// deny non-TLS and non-KMS writes. The object key contains only UUID/digests.
type S3ObservationObjectStore struct {
	Client              S3PutObjectAPI
	Bucket              string
	KMSKeyID            string
	Prefix              string
	ExpectedBucketOwner string
}

func NewS3ObservationObjectStore(client S3PutObjectAPI, bucket, kmsKeyID, prefix, expectedOwner string) (*S3ObservationObjectStore, error) {
	store := &S3ObservationObjectStore{
		Client:              client,
		Bucket:              strings.TrimSpace(bucket),
		KMSKeyID:            strings.TrimSpace(kmsKeyID),
		Prefix:              strings.Trim(strings.TrimSpace(prefix), "/"),
		ExpectedBucketOwner: strings.TrimSpace(expectedOwner),
	}
	if store.Client == nil {
		return nil, errors.New("seed observation objects: S3 client is required")
	}
	if store.Bucket == "" {
		return nil, errors.New("seed observation objects: bucket is required")
	}
	if strings.ContainsAny(store.Bucket, "/\\ \t\r\n") {
		return nil, errors.New("seed observation objects: invalid bucket")
	}
	if store.KMSKeyID == "" || len(store.KMSKeyID) > 2048 || strings.ContainsAny(store.KMSKeyID, "\x00\r\n") {
		return nil, errors.New("seed observation objects: KMS key id is required")
	}
	if !validObjectPrefix(store.Prefix) {
		return nil, errors.New("seed observation objects: invalid prefix")
	}
	if store.ExpectedBucketOwner != "" {
		if len(store.ExpectedBucketOwner) != 12 {
			return nil, errors.New("seed observation objects: expected bucket owner must be a 12-digit account id")
		}
		for _, character := range store.ExpectedBucketOwner {
			if character < '0' || character > '9' {
				return nil, errors.New("seed observation objects: expected bucket owner must be a 12-digit account id")
			}
		}
	}
	return store, nil
}

func (s *S3ObservationObjectStore) PutRawMIME(ctx context.Context, object RawMIMEObject) (ObjectReceipt, error) {
	if s == nil || s.Client == nil {
		return ObjectReceipt{}, errors.New("seed observation objects: store is not configured")
	}
	tenantID, err := uuid.Parse(strings.TrimSpace(object.TenantID))
	if err != nil {
		return ObjectReceipt{}, errors.New("seed observation objects: tenant id must be a UUID")
	}
	observationKey := strings.ToLower(strings.TrimSpace(object.ObservationKey))
	if !validLowerSHA256(observationKey) {
		return ObjectReceipt{}, errors.New("seed observation objects: invalid observation key")
	}
	declaredHash := strings.ToLower(strings.TrimSpace(object.SHA256))
	if !validLowerSHA256(declaredHash) {
		return ObjectReceipt{}, errors.New("seed observation objects: invalid MIME digest")
	}
	if len(object.Raw) == 0 || len(object.Raw) > maxObservationObjectBytes {
		return ObjectReceipt{}, fmt.Errorf("seed observation objects: raw MIME size must be between 1 and %d bytes", maxObservationObjectBytes)
	}
	actualSum := sha256.Sum256(object.Raw)
	if hex.EncodeToString(actualSum[:]) != declaredHash {
		return ObjectReceipt{}, errors.New("seed observation objects: MIME digest mismatch")
	}
	if object.ExpiresAt.IsZero() {
		return ObjectReceipt{}, errors.New("seed observation objects: expiry is required")
	}

	objectKey := path.Join(s.Prefix, "v1", tenantID.String(), observationKey, "received.eml")
	encryptionContext, err := tenantEncryptionContext(tenantID.String())
	if err != nil {
		return ObjectReceipt{}, err
	}
	checksum := base64.StdEncoding.EncodeToString(actualSum[:])
	input := &s3.PutObjectInput{
		Bucket:                  aws.String(s.Bucket),
		Key:                     aws.String(objectKey),
		Body:                    bytes.NewReader(object.Raw),
		ContentLength:           aws.Int64(int64(len(object.Raw))),
		ContentType:             aws.String("message/rfc822"),
		CacheControl:            aws.String("private, no-store"),
		ChecksumAlgorithm:       s3types.ChecksumAlgorithmSha256,
		ChecksumSHA256:          aws.String(checksum),
		ServerSideEncryption:    s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:             aws.String(s.KMSKeyID),
		SSEKMSEncryptionContext: aws.String(encryptionContext),
		BucketKeyEnabled:        aws.Bool(true),
		Tagging:                 aws.String("postwave-retention=seed-mime-30d"),
		Metadata: map[string]string{
			"postwave-schema":     seedMIMEObjectSchemaVersion,
			"postwave-sha256":     declaredHash,
			"postwave-expires-at": object.ExpiresAt.UTC().Format(time.RFC3339),
		},
	}
	if s.ExpectedBucketOwner != "" {
		input.ExpectedBucketOwner = aws.String(s.ExpectedBucketOwner)
	}
	output, err := s.Client.PutObject(ctx, input)
	if err != nil {
		return ObjectReceipt{}, fmt.Errorf("seed observation objects: put: %w", err)
	}
	if output == nil {
		return ObjectReceipt{}, errors.New("seed observation objects: S3 returned an empty receipt")
	}
	versionID := strings.TrimSpace(aws.ToString(output.VersionId))
	if versionID == "" {
		return ObjectReceipt{}, errors.New("seed observation objects: bucket versioning is required")
	}
	reference := "s3://" + s.Bucket + "/" + objectKey
	reference += "?versionId=" + url.QueryEscape(versionID)
	return ObjectReceipt{
		ObjectRef: reference,
		VersionID: versionID,
		ETag:      strings.Trim(strings.TrimSpace(aws.ToString(output.ETag)), `"`),
	}, nil
}

func (s *S3ObservationObjectStore) DeleteRawMIME(ctx context.Context, receipt ObjectReceipt) error {
	if s == nil || s.Client == nil {
		return errors.New("seed observation objects: store is not configured")
	}
	parsed, err := url.Parse(strings.TrimSpace(receipt.ObjectRef))
	if err != nil || parsed.Scheme != "s3" || parsed.Host != s.Bucket {
		return errors.New("seed observation objects: invalid cleanup reference")
	}
	objectKey := strings.TrimPrefix(parsed.EscapedPath(), "/")
	decodedKey, err := url.PathUnescape(objectKey)
	if err != nil || decodedKey == "" || !strings.HasPrefix(decodedKey, path.Join(s.Prefix, "v1")+"/") {
		return errors.New("seed observation objects: cleanup reference is outside the configured prefix")
	}
	versionID := strings.TrimSpace(receipt.VersionID)
	if versionID == "" {
		versionID = strings.TrimSpace(parsed.Query().Get("versionId"))
	}
	if versionID == "" {
		return errors.New("seed observation objects: refusing unversioned cleanup")
	}
	input := &s3.DeleteObjectInput{
		Bucket:    aws.String(s.Bucket),
		Key:       aws.String(decodedKey),
		VersionId: aws.String(versionID),
	}
	if s.ExpectedBucketOwner != "" {
		input.ExpectedBucketOwner = aws.String(s.ExpectedBucketOwner)
	}
	if _, err := s.Client.DeleteObject(ctx, input); err != nil {
		return fmt.Errorf("seed observation objects: delete orphan: %w", err)
	}
	return nil
}

func tenantEncryptionContext(tenantID string) (string, error) {
	payload, err := json.Marshal(struct {
		TenantID string `json:"tenant_id"`
		Purpose  string `json:"purpose"`
		Schema   string `json:"schema"`
	}{
		TenantID: tenantID,
		Purpose:  "controlled_seed_received_mime",
		Schema:   seedMIMEObjectSchemaVersion,
	})
	if err != nil {
		return "", fmt.Errorf("seed observation objects: encryption context: %w", err)
	}
	return base64.StdEncoding.EncodeToString(payload), nil
}

// VerifyObservationObjectStore proves the production data path, including
// SSE-KMS permission, bucket versioning, receipt construction, and exact-version
// cleanup, before a poller can ingest customer-derived bytes.
func VerifyObservationObjectStore(ctx context.Context, store ObservationObjectStore) error {
	if store == nil {
		return errors.New("seed observation objects: store is required")
	}
	probe := []byte("From: readiness@postwave.invalid\r\nTo: seed@postwave.invalid\r\nSubject: readiness\r\n\r\nprobe\r\n")
	probeHash := digestBytes(probe)
	receipt, err := store.PutRawMIME(ctx, RawMIMEObject{
		TenantID:       uuid.Nil.String(),
		ObservationKey: digestString(seedMIMEObjectSchemaVersion + ":readiness"),
		SHA256:         probeHash,
		Raw:            probe,
		ExpiresAt:      time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		return fmt.Errorf("seed observation objects readiness put: %w", err)
	}
	if err := store.DeleteRawMIME(ctx, receipt); err != nil {
		return fmt.Errorf("seed observation objects readiness cleanup: %w", err)
	}
	return nil
}

func validLowerSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validObjectPrefix(prefix string) bool {
	if prefix == "" {
		return true
	}
	if len(prefix) > 512 || strings.ContainsAny(prefix, "\\\x00\r\n") {
		return false
	}
	for _, segment := range strings.Split(prefix, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
