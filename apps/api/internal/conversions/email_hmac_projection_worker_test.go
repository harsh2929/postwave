// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

type projectionCipherStub struct{}

func (projectionCipherStub) Encrypt(context.Context, []byte) ([]byte, error) {
	return []byte("sealed"), nil
}
func (projectionCipherStub) Decrypt(context.Context, []byte, []byte) ([]byte, error) {
	return []byte("opened"), nil
}

type projectionStoreStub struct {
	claims      []EmailHMACProjectionClaim
	secret      []byte
	resolveErr  error
	apply       ProjectionApplyResult
	applyErr    error
	pageSize    int
	failureCode string
	retryAfter  time.Duration
	recordErr   error
	readyErr    error
	health      EmailHMACProjectionHealth
	healthErr   error
}

func (store *projectionStoreStub) Ready(context.Context) error { return store.readyErr }
func (store *projectionStoreStub) Health(context.Context) (EmailHMACProjectionHealth, error) {
	return store.health, store.healthErr
}
func (store *projectionStoreStub) Claim(
	context.Context, string, int, time.Duration,
) ([]EmailHMACProjectionClaim, error) {
	return append([]EmailHMACProjectionClaim(nil), store.claims...), nil
}
func (store *projectionStoreStub) ResolveSecret(
	context.Context, EmailHMACProjectionClaim, EnvelopeCipher,
) ([]byte, error) {
	return store.secret, store.resolveErr
}
func (store *projectionStoreStub) Apply(
	_ context.Context,
	_ EmailHMACProjectionClaim,
	_ []byte,
	pageSize int,
) (ProjectionApplyResult, error) {
	store.pageSize = pageSize
	return store.apply, store.applyErr
}
func (store *projectionStoreStub) RecordFailure(
	_ context.Context,
	_ EmailHMACProjectionClaim,
	code string,
	retryAfter time.Duration,
) error {
	store.failureCode, store.retryAfter = code, retryAfter
	return store.recordErr
}

func validProjectionClaim() EmailHMACProjectionClaim {
	return EmailHMACProjectionClaim{
		TenantID: "tenant", TaskID: "task", KeyID: "key",
		TaskKind: projectionTaskFull, TargetRevision: 4, Attempt: 1,
		LeaseToken: "lease", LeaseExpiresAt: time.Now().Add(time.Minute),
	}
}

func TestEmailHMACProjectionWorkerBoundsPageAndZerosSecret(t *testing.T) {
	secret := []byte("plaintext-signing-secret")
	store := &projectionStoreStub{
		claims: []EmailHMACProjectionClaim{validProjectionClaim()},
		secret: secret,
		apply:  ProjectionApplyResult{Processed: DefaultProjectionPageSize},
	}
	worker, err := NewEmailHMACProjectionWorker(
		store, projectionCipherStub{},
		DefaultEmailHMACProjectionWorkerConfiguration("test-worker"),
	)
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	result, err := worker.Sweep(context.Background())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if result.Claimed != 1 || result.Subscribers != DefaultProjectionPageSize ||
		store.pageSize != DefaultProjectionPageSize {
		t.Fatalf("bounded sweep = %+v page=%d", result, store.pageSize)
	}
	if !bytes.Equal(secret, make([]byte, len(secret))) {
		t.Fatal("worker retained plaintext signing secret after the page")
	}
}

func TestEmailHMACProjectionWorkerRetriesWithClosedFailureCode(t *testing.T) {
	claim := validProjectionClaim()
	claim.Attempt = DefaultProjectionMaxAttempts
	store := &projectionStoreStub{
		claims:     []EmailHMACProjectionClaim{claim},
		resolveErr: ErrProjectionSecretUnavailable,
	}
	worker, err := NewEmailHMACProjectionWorker(
		store, projectionCipherStub{},
		DefaultEmailHMACProjectionWorkerConfiguration("test-worker"),
	)
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	result, err := worker.Sweep(context.Background())
	if err == nil {
		t.Fatal("dependency failure was not surfaced")
	}
	if store.failureCode != ProjectionErrorSecretUnavailable ||
		store.retryAfter != time.Hour || result.Retried != 1 || result.FailedVisible != 1 {
		t.Fatalf("failure = code %q backoff %s result %+v",
			store.failureCode, store.retryAfter, result)
	}
}

func TestEmailHMACProjectionWorkerTreatsSupersededLeaseAsConvergence(t *testing.T) {
	store := &projectionStoreStub{
		claims:     []EmailHMACProjectionClaim{validProjectionClaim()},
		resolveErr: ErrProjectionLeaseLost,
	}
	worker, err := NewEmailHMACProjectionWorker(
		store, projectionCipherStub{},
		DefaultEmailHMACProjectionWorkerConfiguration("test-worker"),
	)
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	result, err := worker.Sweep(context.Background())
	if err != nil {
		t.Fatalf("superseded lease must be harmless: %v", err)
	}
	if result.LeaseLost != 1 || result.Retried != 0 || store.failureCode != "" {
		t.Fatalf("superseded lease result = %+v code=%q", result, store.failureCode)
	}
}

func TestProjectionMetadataIsClosedAndHonest(t *testing.T) {
	now := time.Now()
	for _, metadata := range []ProjectionMetadata{
		{Status: ProjectionStatusPending, UpdatedAt: now},
		{Status: ProjectionStatusReady, UpdatedAt: now},
		{Status: ProjectionStatusFailed, ErrorCode: ProjectionErrorSecretUnavailable, UpdatedAt: now},
		{Status: ProjectionStatusFailed, ErrorCode: ProjectionErrorFailed, UpdatedAt: now},
	} {
		if !validProjectionMetadata(metadata) {
			t.Fatalf("valid metadata rejected: %+v", metadata)
		}
	}
	for _, metadata := range []ProjectionMetadata{
		{},
		{Status: "complete", UpdatedAt: now},
		{Status: ProjectionStatusReady, ErrorCode: ProjectionErrorFailed, UpdatedAt: now},
		{Status: ProjectionStatusFailed, UpdatedAt: now},
		{Status: ProjectionStatusFailed, ErrorCode: "kms_error_detail", UpdatedAt: now},
	} {
		if validProjectionMetadata(metadata) {
			t.Fatalf("invalid metadata accepted: %+v", metadata)
		}
	}
}

func TestProjectionRetryBackoffIsBounded(t *testing.T) {
	if got := projectionRetryBackoff(1); got != time.Second {
		t.Fatalf("first retry = %s", got)
	}
	if got := projectionRetryBackoff(1_000); got != time.Hour {
		t.Fatalf("late retry = %s, want 1h", got)
	}
	if !errors.Is(errors.Join(ErrProjectionLeaseLost), ErrProjectionLeaseLost) {
		t.Fatal("lease-lost sentinel is not stable")
	}
}
