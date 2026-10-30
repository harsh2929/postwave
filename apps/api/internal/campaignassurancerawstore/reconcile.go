// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

// ReconcileOrphans claims a bounded set of abandoned pre-extraction writes.
// Pending intents are first resolved by HeadObject; the resulting VersionID is
// made durable before the exact-version delete is issued.
func (s *S3Store) ReconcileOrphans(ctx context.Context, limit, concurrency int) (ReconcileResult, error) {
	if s == nil || limit < 1 || limit > 500 || concurrency < 1 || concurrency > 32 || concurrency > limit {
		return ReconcileResult{}, ErrInvalidConfiguration
	}
	claims, err := s.repository.ClaimOrphans(ctx, s.configuration.WorkerID, limit,
		s.configuration.OrphanGrace, s.configuration.CleanupLeaseTTL)
	if err != nil {
		return ReconcileResult{}, err
	}
	result := ReconcileResult{Claimed: len(claims)}
	if len(claims) == 0 {
		return result, nil
	}
	if concurrency > len(claims) {
		concurrency = len(claims)
	}
	jobs := make(chan WriteIntent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failures []error
	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for claim := range jobs {
				found, outcome, cleanupErr := s.cleanupClaimWithOutcome(ctx, claim)
				mu.Lock()
				if found {
					result.VersionsFound++
				}
				switch outcome {
				case CleanupDeleted:
					result.Deleted++
				case CleanupAlreadyMissing:
					result.AlreadyMissing++
				default:
					result.Failed++
				}
				if cleanupErr != nil {
					failures = append(failures, cleanupErr)
				}
				mu.Unlock()
			}
		}()
	}
	for _, claim := range claims {
		select {
		case jobs <- claim:
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return result, errors.Join(append(failures, ctx.Err())...)
		}
	}
	close(jobs)
	wg.Wait()
	return result, errors.Join(failures...)
}

func (s *S3Store) cleanupClaim(ctx context.Context, claim WriteIntent) error {
	_, _, err := s.cleanupClaimWithOutcome(ctx, claim)
	return err
}

func (s *S3Store) cleanupClaimWithOutcome(ctx context.Context, claim WriteIntent) (bool, string, error) {
	if _, err := normalizeIntent(claim.WriteIntentInput); err != nil || claim.State != "cleanup_leased" ||
		!canonicalUUID(claim.LeaseToken) || claim.Attempt < 1 {
		return false, "", ErrCleanupNotAuthorized
	}
	var receipt VersionReceipt
	found := false
	if claim.Version != nil {
		receipt = *claim.Version
		found = true
	} else {
		resolved, err := s.verifyHead(ctx, claim, "")
		if errors.Is(err, ErrExactVersionMissing) {
			// A timed-out PutObject can complete after its caller has stopped
			// waiting. Two leased, backoff-separated missing observations keep
			// such an ambiguous write discoverable; only the third explicit
			// missing response closes an intent as never written.
			if claim.Attempt < 3 {
				return false, "", s.recordCleanupFailure(ctx, claim, nil, "exact_version_not_observed", err)
			}
			result := CleanupResult{Disposition: CleanupAlreadyMissing}
			if recordErr := s.repository.RecordCleanup(ctx, claim, VersionReceipt{}, result); recordErr != nil {
				return false, "", recordErr
			}
			return false, CleanupAlreadyMissing, nil
		}
		if err != nil {
			return false, "", s.recordCleanupFailure(ctx, claim, nil, "exact_version_resolution_failed", err)
		}
		stored, err := s.repository.RecordVersion(ctx, claim, resolved)
		if err != nil {
			return false, "", s.recordCleanupFailure(ctx, claim, nil, "version_receipt_failed", err)
		}
		if !sameVersion(stored, resolved) {
			return false, "", s.recordCleanupFailure(ctx, claim, nil, "version_identity_conflict", ErrObjectConflict)
		}
		receipt = stored
		found = true
	}
	result, err := s.deleteExact(ctx, receipt)
	if err != nil {
		return found, "", s.recordCleanupFailure(ctx, claim, &receipt, "exact_cleanup_failed", err)
	}
	if err := s.repository.RecordCleanup(ctx, claim, receipt, result); err != nil {
		return found, "", err
	}
	return found, result.Disposition, nil
}

func (s *S3Store) recordCleanupFailure(
	ctx context.Context,
	claim WriteIntent,
	version *VersionReceipt,
	code string,
	cause error,
) error {
	recordErr := s.repository.RecordCleanupFailure(ctx, claim, version, code, cause,
		s.configuration.RetryBackoff(claim.Attempt))
	return errors.Join(cause, recordErr)
}

// deleteExact is the sole DeleteObject call in this package. VersionId is
// mandatory on the constructed input. Provider request identifiers are hashed
// immediately and never returned or persisted in plaintext.
func (s *S3Store) deleteExact(ctx context.Context, receipt VersionReceipt) (CleanupResult, error) {
	if receipt.VersionID == "" {
		return CleanupResult{}, ErrInvalidIdentity
	}
	if _, err := normalizeReceipt(intentFromReceipt(receipt), receipt); err != nil {
		return CleanupResult{}, ErrInvalidIdentity
	}
	if receipt.ReceiptHash != "" && !hashPattern.MatchString(receipt.ReceiptHash) ||
		receipt.Bucket != s.configuration.Bucket ||
		receipt.KMSKeyIDHash != sha256Hex([]byte(s.configuration.KMSKeyID)) ||
		providerProof(receipt) != receipt.ProviderProofHash {
		return CleanupResult{}, ErrInvalidIdentity
	}
	call, cancel := s.operationContext(ctx)
	output, err := s.objects.DeleteObject(call, &s3.DeleteObjectInput{
		Bucket: aws.String(receipt.Bucket), Key: aws.String(receipt.ObjectKey),
		VersionId: aws.String(receipt.VersionID),
	})
	cancel()
	if err != nil {
		if isDeleteExplicitlyMissing(err) {
			return CleanupResult{Disposition: CleanupAlreadyMissing}, nil
		}
		return CleanupResult{}, fmt.Errorf("delete exact raw-output version: %w", err)
	}
	if output == nil {
		return CleanupResult{}, ErrObjectConflict
	}
	responseVersion := aws.ToString(output.VersionId)
	if responseVersion != "" && responseVersion != receipt.VersionID {
		return CleanupResult{}, ErrObjectConflict
	}
	requestIDHash := ""
	if requestID, ok := awsmiddleware.GetRequestIDMetadata(output.ResultMetadata); ok && requestID != "" {
		requestIDHash = sha256Hex([]byte(requestID))
	}
	return CleanupResult{
		Disposition: CleanupDeleted, ResponseVersion: responseVersion,
		DeleteMarker: aws.ToBool(output.DeleteMarker), ProviderRequestIDHash: requestIDHash,
	}, nil
}

func isDeleteExplicitlyMissing(err error) bool {
	// Deliberately narrower than Head/Get handling. Delete retries count as
	// already missing only when S3 explicitly identifies the key or version.
	var apiError smithy.APIError
	return errors.As(err, &apiError) &&
		(apiError.ErrorCode() == "NoSuchVersion" || apiError.ErrorCode() == "NoSuchKey")
}
