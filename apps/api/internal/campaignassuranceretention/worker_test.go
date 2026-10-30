// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type retentionRepositoryFake struct {
	claims        []Claim
	version       *VersionIdentity
	loadErr       error
	failures      []string
	recordVersion int
	deleteCalls   int
	deferDelete   bool
	mu            sync.Mutex
}

func (r *retentionRepositoryFake) ClaimExpired(context.Context, string, int, time.Duration) ([]Claim, error) {
	return append([]Claim(nil), r.claims...), nil
}

func (r *retentionRepositoryFake) LoadVersion(context.Context, Claim) (*VersionIdentity, error) {
	if r.loadErr != nil {
		return nil, r.loadErr
	}
	if r.version == nil {
		return nil, nil
	}
	copy := *r.version
	return &copy, nil
}

func (r *retentionRepositoryFake) RecordVersion(_ context.Context, _ Claim, input VersionIdentity) (VersionIdentity, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recordVersion++
	input.ReceiptHash = hashOf("version-receipt")
	return input, nil
}

func (r *retentionRepositoryFake) RecordFailure(
	_ context.Context, _ Claim, code string, _ error, _ string, _ time.Duration,
) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failures = append(r.failures, code)
	return nil
}

func (r *retentionRepositoryFake) DeleteUnderLegalHoldFence(
	ctx context.Context,
	_ Claim,
	_ VersionIdentity,
	_ string,
	_ time.Duration,
	deleteExact func(context.Context) (DeleteResult, error),
) (AttemptOutcome, error) {
	r.mu.Lock()
	r.deleteCalls++
	r.mu.Unlock()
	if r.deferDelete {
		return AttemptOutcome{Outcome: "deferred", FailureCode: "legal_hold_or_reference_conflict"}, nil
	}
	result, err := deleteExact(ctx)
	if err != nil {
		return AttemptOutcome{Outcome: "failure", FailureCode: "storage_operation_failed"}, err
	}
	if err := validateDeleteResult(VersionIdentity{VersionID: "version-1"}, result); err != nil {
		return AttemptOutcome{Outcome: "failure", FailureCode: "exact_delete_unproven"}, err
	}
	return AttemptOutcome{Outcome: "deleted", Disposition: result.Disposition}, nil
}

type exactStoreFake struct {
	resolveCalls atomic.Int64
	deleteCalls  atomic.Int64
	resolve      func(Claim) (VersionIdentity, error)
	delete       func(VersionIdentity) (DeleteResult, error)
}

func (s *exactStoreFake) ResolveExactVersion(
	_ context.Context, tenantID, key, expectedHash string,
) (VersionIdentity, error) {
	s.resolveCalls.Add(1)
	claim := validRetentionClaim(0)
	claim.TenantID, claim.ObjectKey, claim.RawOutputHash = tenantID, key, expectedHash
	if s.resolve != nil {
		return s.resolve(claim)
	}
	return VersionIdentity{
		Backend: "s3", Bucket: "assurance-private", ObjectKey: key,
		VersionID: "version-1", ContentSHA256: expectedHash, ByteSize: 512,
		ProviderProofSHA256: hashOf("provider-head-proof"),
	}, nil
}

func (s *exactStoreFake) DeleteExactVersion(
	_ context.Context, _ string, version VersionIdentity,
) (DeleteResult, error) {
	s.deleteCalls.Add(1)
	if s.delete != nil {
		return s.delete(version)
	}
	return DeleteResult{
		Disposition: DispositionDeleted, ResponseVersion: version.VersionID,
		ProviderRequestIDHash: sha256Hex("request-1"),
	}, nil
}

func hashOf(value string) string { return sha256Hex(value) }

func validRetentionClaim(index int) Claim {
	tenantID := "00000000-0000-4000-8000-000000000001"
	taskID := fmt.Sprintf("00000000-0000-4000-8000-%012d", index+10)
	leaseID := fmt.Sprintf("00000000-0000-4000-8000-%012d", index+100)
	reference := objectReferencePrefix + fmt.Sprintf(
		"campaign-assurance/raw-output/runs/00000000-0000-4000-8000-%012d/attempt-1/artifacts/00000000-0000-4000-8000-%012d/configurations/%s.json",
		index+1000, index+2000, hashOf(fmt.Sprintf("config-%d", index)),
	)
	key, err := parseObjectReference(reference)
	if err != nil {
		panic(err)
	}
	return Claim{
		TenantID: tenantID, TaskID: taskID, ObjectReference: reference, ObjectKey: key,
		ObjectReferenceHash: hashOf(reference), RawOutputHash: hashOf(fmt.Sprintf("raw-%d", index)),
		SourceManifestHash: hashOf(fmt.Sprintf("source-%d", index)),
		CampaignScopeHash:  hashOf(fmt.Sprintf("campaign-%d", index)),
		ExpiresAt:          time.Now().UTC().Add(-time.Hour), Attempt: 1, LeaseToken: leaseID,
		LeaseExpiresAt: time.Now().UTC().Add(5 * time.Minute),
	}
}

func testRetentionConfiguration() Configuration {
	config := DefaultConfiguration("raw-output-retention-test")
	config.BatchSize = 4
	config.Concurrency = 2
	return config
}

func TestKeyOnlyStorageFailsClosedAndNeverDeletes(t *testing.T) {
	repository := &retentionRepositoryFake{claims: []Claim{validRetentionClaim(0)}}
	worker, err := NewWorker(repository, FailClosedKeyOnlyStore{}, testRetentionConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.Sweep(context.Background())
	if !errors.Is(err, ErrExactVersionUnavailable) {
		t.Fatalf("error = %v, want exact-version-unavailable", err)
	}
	if result.Claimed != 1 || result.Failed != 1 || result.Deleted != 0 ||
		repository.deleteCalls != 0 || len(repository.failures) != 1 ||
		repository.failures[0] != "exact_version_unavailable" {
		t.Fatalf("fail-closed result=%+v repository=%+v", result, repository)
	}
}

func TestSweepPersistsResolutionBeforeExactVersionDelete(t *testing.T) {
	claim := validRetentionClaim(0)
	repository := &retentionRepositoryFake{claims: []Claim{claim}}
	objects := &exactStoreFake{}
	worker, err := NewWorker(repository, objects, testRetentionConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Claimed != 1 || result.VersionResolved != 1 || result.Deleted != 1 ||
		objects.resolveCalls.Load() != 1 || objects.deleteCalls.Load() != 1 ||
		repository.recordVersion != 1 || repository.deleteCalls != 1 {
		t.Fatalf("unexpected exact deletion result=%+v", result)
	}
}

func TestSweepReplaysRecordedVersionAsAlreadyMissing(t *testing.T) {
	claim := validRetentionClaim(0)
	version := &VersionIdentity{
		Backend: "s3", Bucket: "assurance-private", ObjectKey: claim.ObjectKey,
		VersionID: "version-1", ContentSHA256: claim.RawOutputHash, ByteSize: 12,
		ProviderProofSHA256: hashOf("proof"), ReceiptHash: hashOf("receipt"),
	}
	repository := &retentionRepositoryFake{claims: []Claim{claim}, version: version}
	objects := &exactStoreFake{delete: func(version VersionIdentity) (DeleteResult, error) {
		return DeleteResult{Disposition: DispositionAlreadyMissing}, nil
	}}
	worker, err := NewWorker(repository, objects, testRetentionConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.AlreadyMissing != 1 || result.VersionResolved != 0 ||
		objects.resolveCalls.Load() != 0 || objects.deleteCalls.Load() != 1 {
		t.Fatalf("unexpected replay result=%+v", result)
	}
}

func TestLegalHoldDeferralDoesNotCallObjectStore(t *testing.T) {
	claim := validRetentionClaim(0)
	version := &VersionIdentity{
		Backend: "s3", Bucket: "assurance-private", ObjectKey: claim.ObjectKey,
		VersionID: "version-1", ContentSHA256: claim.RawOutputHash, ByteSize: 12,
		ProviderProofSHA256: hashOf("proof"), ReceiptHash: hashOf("receipt"),
	}
	repository := &retentionRepositoryFake{
		claims: []Claim{claim}, version: version, deferDelete: true,
	}
	objects := &exactStoreFake{}
	worker, err := NewWorker(repository, objects, testRetentionConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Deferred != 1 || objects.deleteCalls.Load() != 0 {
		t.Fatalf("hold deferral result=%+v deletes=%d", result, objects.deleteCalls.Load())
	}
}

func TestMismatchedResolvedContentFailsClosed(t *testing.T) {
	claim := validRetentionClaim(0)
	repository := &retentionRepositoryFake{claims: []Claim{claim}}
	objects := &exactStoreFake{resolve: func(input Claim) (VersionIdentity, error) {
		return VersionIdentity{
			Backend: "s3", Bucket: "assurance-private", ObjectKey: input.ObjectKey,
			VersionID: "version-1", ContentSHA256: hashOf("different-content"),
			ByteSize: 10, ProviderProofSHA256: hashOf("proof"),
		}, nil
	}}
	worker, err := NewWorker(repository, objects, testRetentionConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.Sweep(context.Background())
	if !errors.Is(err, ErrInvalidIdentity) {
		t.Fatalf("error=%v, want invalid exact identity", err)
	}
	if result.Failed != 1 || objects.deleteCalls.Load() != 0 || repository.deleteCalls != 0 ||
		len(repository.failures) != 1 || repository.failures[0] != "version_identity_conflict" {
		t.Fatalf("mismatched-content result=%+v repository=%+v", result, repository)
	}
}

type boundedStore struct {
	started chan struct{}
	release chan struct{}
	active  atomic.Int64
	maximum atomic.Int64
}

func (s *boundedStore) ResolveExactVersion(
	_ context.Context, _ string, key, expectedHash string,
) (VersionIdentity, error) {
	active := s.active.Add(1)
	for {
		maximum := s.maximum.Load()
		if active <= maximum || s.maximum.CompareAndSwap(maximum, active) {
			break
		}
	}
	s.started <- struct{}{}
	<-s.release
	s.active.Add(-1)
	return VersionIdentity{
		Backend: "s3", Bucket: "assurance-private", ObjectKey: key,
		VersionID: "version-1", ContentSHA256: expectedHash, ByteSize: 10,
		ProviderProofSHA256: hashOf("proof-" + expectedHash),
	}, nil
}

func (*boundedStore) DeleteExactVersion(
	_ context.Context, _ string, version VersionIdentity,
) (DeleteResult, error) {
	return DeleteResult{Disposition: DispositionDeleted, ResponseVersion: version.VersionID}, nil
}

func TestSweepBoundsStorageConcurrency(t *testing.T) {
	claims := []Claim{
		validRetentionClaim(0), validRetentionClaim(1),
		validRetentionClaim(2), validRetentionClaim(3),
	}
	repository := &retentionRepositoryFake{claims: claims}
	objects := &boundedStore{started: make(chan struct{}, 4), release: make(chan struct{}, 4)}
	config := testRetentionConfiguration()
	config.Concurrency = 2
	worker, err := NewWorker(repository, objects, config)
	if err != nil {
		t.Fatal(err)
	}
	type sweepReturn struct {
		result SweepResult
		err    error
	}
	done := make(chan sweepReturn, 1)
	go func() {
		result, err := worker.Sweep(context.Background())
		done <- sweepReturn{result: result, err: err}
	}()
	waitStarted := func() {
		t.Helper()
		select {
		case <-objects.started:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for bounded storage call")
		}
	}
	waitStarted()
	waitStarted()
	select {
	case <-objects.started:
		t.Fatal("third storage call started before a concurrency slot was released")
	case <-time.After(30 * time.Millisecond):
	}
	objects.release <- struct{}{}
	objects.release <- struct{}{}
	waitStarted()
	waitStarted()
	objects.release <- struct{}{}
	objects.release <- struct{}{}
	select {
	case returned := <-done:
		if returned.err != nil {
			t.Fatal(returned.err)
		}
		if returned.result.Deleted != 4 || objects.maximum.Load() != 2 {
			t.Fatalf("bounded result=%+v maximum=%d", returned.result, objects.maximum.Load())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bounded sweep did not finish")
	}
}

func TestDeleteResponseMustProveTheRequestedVersion(t *testing.T) {
	version := VersionIdentity{VersionID: "version-1"}
	for name, result := range map[string]DeleteResult{
		"current-key-only": {},
		"different-version": {
			Disposition: DispositionDeleted, ResponseVersion: "version-2",
		},
		"unbounded-provider-id": {
			Disposition: DispositionDeleted, ProviderRequestIDHash: "not-a-sha256",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if !errors.Is(validateDeleteResult(version, result), ErrUnprovenDeletionResponse) {
				t.Fatalf("result %+v was not rejected", result)
			}
		})
	}
}
