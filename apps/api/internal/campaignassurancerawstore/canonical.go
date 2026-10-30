// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
)

const objectReferencePrefix = "postwave.tenant-object-ref.v1:"

var (
	hashPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	regexpFailure = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
)

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func normalizeConfiguration(input Configuration) (Configuration, error) {
	input.Bucket = strings.TrimSpace(input.Bucket)
	input.KMSKeyID = strings.TrimSpace(input.KMSKeyID)
	input.WorkerID = strings.TrimSpace(input.WorkerID)
	if input.Bucket == "" || len(input.Bucket) > 255 || strings.ContainsAny(input.Bucket, "\x00\r\n") ||
		input.KMSKeyID == "" || len(input.KMSKeyID) > 2048 || strings.ContainsAny(input.KMSKeyID, "\x00\r\n") ||
		input.WorkerID == "" || len(input.WorkerID) > 200 || strings.ContainsAny(input.WorkerID, "\x00\r\n") ||
		input.OperationTimeout < time.Second || input.OperationTimeout > 2*time.Minute ||
		input.CleanupLeaseTTL < 2*input.OperationTimeout+5*time.Second || input.CleanupLeaseTTL > 30*time.Minute ||
		input.OrphanGrace < 2*input.OperationTimeout+5*time.Second || input.OrphanGrace < time.Minute ||
		input.OrphanGrace > 24*time.Hour || input.RetryBackoff == nil {
		return Configuration{}, ErrInvalidConfiguration
	}
	for _, attempt := range []int64{1, 2, 10, 100} {
		if delay := input.RetryBackoff(attempt); delay < time.Second || delay > 24*time.Hour {
			return Configuration{}, ErrInvalidConfiguration
		}
	}
	return input, nil
}

func canonicalRest(tenantID, rest string) (string, string, string, error) {
	if !canonicalUUID(tenantID) || rest == "" || len(rest) > 1800 || strings.TrimSpace(rest) != rest ||
		!strings.HasPrefix(rest, "campaign-assurance/raw-output/") || path.IsAbs(rest) ||
		path.Clean(rest) != rest || strings.Contains(rest, `\`) || strings.ContainsAny(rest, "\x00\r\n") {
		return "", "", "", ErrInvalidIdentity
	}
	segments := strings.Split(rest, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || len(segment) > 128 {
			return "", "", "", ErrInvalidIdentity
		}
	}
	if len(segments) < 4 || segments[len(segments)-2] != "writes" {
		return "", "", "", ErrInvalidIdentity
	}
	name := strings.TrimSuffix(segments[len(segments)-1], ".json")
	if name == segments[len(segments)-1] || !canonicalUUID(name) {
		return "", "", "", ErrInvalidIdentity
	}
	return "tenants/" + tenantID + "/" + rest, objectReferencePrefix + rest, name, nil
}

func normalizeIntent(input WriteIntentInput) (WriteIntentInput, error) {
	objectKey, objectRef, intentID, err := canonicalRest(input.TenantID, input.ObjectRest)
	if err != nil || input.IntentID != intentID || input.ObjectKey != objectKey || input.ObjectRef != objectRef ||
		!hashPattern.MatchString(input.ContentSHA256) || input.ContentType != ContentTypeJSON ||
		input.ByteSize < 1 || input.ByteSize > int64(campaigncomprehension.MaxExtractionBytes) ||
		input.Bucket == "" || len(input.Bucket) > 255 || strings.ContainsAny(input.Bucket, "\x00\r\n") ||
		!hashPattern.MatchString(input.KMSKeyIDHash) {
		return WriteIntentInput{}, ErrInvalidIdentity
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(input.ChecksumBase64)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != input.ContentSHA256 {
		return WriteIntentInput{}, ErrInvalidIdentity
	}
	return input, nil
}

func normalizeReceipt(intent WriteIntent, input VersionReceipt) (VersionReceipt, error) {
	identity, err := normalizeIntent(intent.WriteIntentInput)
	if err != nil || input.TenantID != identity.TenantID || input.IntentID != identity.IntentID ||
		input.ObjectRest != identity.ObjectRest || input.ObjectKey != identity.ObjectKey || input.ObjectRef != identity.ObjectRef ||
		input.Bucket != identity.Bucket || input.ContentSHA256 != identity.ContentSHA256 ||
		input.ChecksumBase64 != identity.ChecksumBase64 || input.ContentType != identity.ContentType ||
		input.ByteSize != identity.ByteSize || input.KMSKeyIDHash != identity.KMSKeyIDHash ||
		input.VersionID == "" || len(input.VersionID) > 1024 || strings.ContainsAny(input.VersionID, "\x00\r\n") ||
		!hashPattern.MatchString(input.ProviderProofHash) || input.ReceiptHash != "" && !hashPattern.MatchString(input.ReceiptHash) {
		return VersionReceipt{}, ErrInvalidIdentity
	}
	return input, nil
}

func providerProof(receipt VersionReceipt) string {
	canonical, _ := json.Marshal(struct {
		Bucket         string `json:"bucket"`
		ObjectKey      string `json:"object_key"`
		VersionID      string `json:"version_id"`
		ContentSHA256  string `json:"content_sha256"`
		ChecksumBase64 string `json:"checksum_sha256_base64"`
		ContentType    string `json:"content_type"`
		ByteSize       int64  `json:"byte_size"`
		KMSKeyIDHash   string `json:"kms_key_id_sha256"`
	}{receipt.Bucket, receipt.ObjectKey, receipt.VersionID, receipt.ContentSHA256,
		receipt.ChecksumBase64, receipt.ContentType, receipt.ByteSize, receipt.KMSKeyIDHash})
	return sha256Hex(canonical)
}
