// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	hashPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	identityPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
	failurePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
)

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func canonicalUUID(value string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil || parsed.String() != value {
		return "", false
	}
	return value, true
}

func parseObjectReference(reference string) (string, error) {
	if !strings.HasPrefix(reference, objectReferencePrefix) || strings.TrimSpace(reference) != reference {
		return "", ErrInvalidIdentity
	}
	rest := strings.TrimPrefix(reference, objectReferencePrefix)
	if !strings.HasPrefix(rest, "campaign-assurance/raw-output/") || len(rest) > 1800 ||
		path.IsAbs(rest) || path.Clean(rest) != rest || strings.Contains(rest, `\`) ||
		strings.ContainsAny(rest, "\x00\r\n") {
		return "", ErrInvalidIdentity
	}
	for _, segment := range strings.Split(rest, "/") {
		if segment == "" || segment == "." || segment == ".." || len(segment) > 128 {
			return "", ErrInvalidIdentity
		}
	}
	return rest, nil
}

func normalizeClaim(input Claim) (Claim, error) {
	if _, ok := canonicalUUID(input.TenantID); !ok {
		return Claim{}, ErrInvalidIdentity
	}
	if _, ok := canonicalUUID(input.TaskID); !ok {
		return Claim{}, ErrInvalidIdentity
	}
	if _, ok := canonicalUUID(input.LeaseToken); !ok || input.Attempt < 1 || input.ExpiresAt.IsZero() ||
		input.LeaseExpiresAt.IsZero() || !hashPattern.MatchString(input.ObjectReferenceHash) ||
		!hashPattern.MatchString(input.RawOutputHash) || !hashPattern.MatchString(input.SourceManifestHash) ||
		!hashPattern.MatchString(input.CampaignScopeHash) {
		return Claim{}, ErrInvalidIdentity
	}
	key, err := parseObjectReference(input.ObjectReference)
	if err != nil || key != input.ObjectKey || sha256Hex(input.ObjectReference) != input.ObjectReferenceHash {
		return Claim{}, ErrInvalidIdentity
	}
	input.ExpiresAt = input.ExpiresAt.UTC()
	input.LeaseExpiresAt = input.LeaseExpiresAt.UTC()
	return input, nil
}

func normalizeVersion(claim Claim, input VersionIdentity) (VersionIdentity, error) {
	if _, err := normalizeClaim(claim); err != nil || !identityPattern.MatchString(input.Backend) ||
		input.Bucket == "" || len(input.Bucket) > 255 || strings.TrimSpace(input.Bucket) != input.Bucket ||
		strings.ContainsAny(input.Bucket, "\x00\r\n") || input.ObjectKey != claim.ObjectKey ||
		input.VersionID == "" || len(input.VersionID) > 1024 || strings.ContainsAny(input.VersionID, "\x00\r\n") ||
		input.ContentSHA256 != claim.RawOutputHash || input.ByteSize < 1 || input.ByteSize > maxRawOutputBytes ||
		!hashPattern.MatchString(input.ProviderProofSHA256) ||
		input.ReceiptHash != "" && !hashPattern.MatchString(input.ReceiptHash) {
		return VersionIdentity{}, ErrInvalidIdentity
	}
	return input, nil
}

func normalizeConfiguration(input Configuration) (Configuration, error) {
	input.WorkerID = strings.TrimSpace(input.WorkerID)
	if input.WorkerID == "" || len(input.WorkerID) > 200 || strings.ContainsAny(input.WorkerID, "\x00\r\n") ||
		input.BatchSize < 1 || input.BatchSize > 500 || input.Concurrency < 1 || input.Concurrency > 32 ||
		input.Concurrency > input.BatchSize || input.ResolveTimeout < time.Second || input.ResolveTimeout > 2*time.Minute ||
		input.DeleteTimeout < time.Second || input.DeleteTimeout > 2*time.Minute ||
		input.LeaseTTL < input.ResolveTimeout+input.DeleteTimeout+5*time.Second || input.LeaseTTL > 30*time.Minute ||
		input.RetryBackoff == nil {
		return Configuration{}, ErrInvalidConfiguration
	}
	for _, attempt := range []int64{1, 2, 10, 100} {
		backoff := input.RetryBackoff(attempt)
		if backoff < time.Second || backoff > 24*time.Hour {
			return Configuration{}, ErrInvalidConfiguration
		}
	}
	return input, nil
}

func stableFailureCode(err error) string {
	switch {
	case errors.Is(err, ErrExactVersionUnavailable):
		return "exact_version_unavailable"
	case errors.Is(err, ErrIdentityConflict), errors.Is(err, ErrInvalidIdentity):
		return "version_identity_conflict"
	case errors.Is(err, context.DeadlineExceeded):
		return "storage_timeout"
	default:
		return "storage_operation_failed"
	}
}

func normalizeFailure(code string, cause error) (string, string, error) {
	code = strings.TrimSpace(code)
	if !failurePattern.MatchString(code) || cause == nil {
		return "", "", fmt.Errorf("%w: invalid failure receipt", ErrInvalidIdentity)
	}
	return code, sha256Hex(cause.Error()), nil
}
