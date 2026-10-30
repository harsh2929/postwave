// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const (
	testTenant  = "00000000-0000-4000-8000-000000000001"
	testIntent  = "00000000-0000-4000-8000-000000000099"
	testVersion = "s3-version-0001"
	testKMS     = "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-4000-8000-000000000002"
)

func testRest() string {
	return "campaign-assurance/raw-output/runs/00000000-0000-4000-8000-000000000010/" +
		"attempt-1/artifacts/00000000-0000-4000-8000-000000000011/configurations/" +
		strings.Repeat("a", 64) + "/writes/" + testIntent + ".json"
}

func testConfig() Configuration {
	return Configuration{
		Bucket: "postwave-raw-model-output", KMSKeyID: testKMS,
		WorkerID: "raw-output-test-worker", OperationTimeout: 2 * time.Second,
		CleanupLeaseTTL: 10 * time.Second, OrphanGrace: time.Minute,
		RetryBackoff: func(int64) time.Duration { return time.Minute },
	}
}

type fakeS3 struct {
	mu sync.Mutex

	versioned bool
	encrypted bool
	versionID string
	requestID string

	putInput     *s3.PutObjectInput
	headInputs   []*s3.HeadObjectInput
	getInput     *s3.GetObjectInput
	deleteInputs []*s3.DeleteObjectInput
	body         []byte
	putErr       error
	headErr      error
	getErr       error
	deleteErr    error
	tamperBody   bool
	events       *[]string
}

func (f *fakeS3) addEvent(value string) {
	if f.events != nil {
		*f.events = append(*f.events, value)
	}
}

func (f *fakeS3) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addEvent("s3.put")
	f.putInput = input
	f.body, _ = io.ReadAll(input.Body)
	if f.putErr != nil {
		return nil, f.putErr
	}
	return &s3.PutObjectOutput{VersionId: aws.String(f.version())}, nil
}

func (f *fakeS3) HeadObject(_ context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addEvent("s3.head")
	f.headInputs = append(f.headInputs, input)
	if f.headErr != nil {
		return nil, f.headErr
	}
	if f.putInput == nil {
		return nil, &smithy.GenericAPIError{Code: "NoSuchKey", Message: "missing"}
	}
	return &s3.HeadObjectOutput{
		VersionId: aws.String(f.version()), ChecksumSHA256: f.putInput.ChecksumSHA256,
		ContentLength: aws.Int64(int64(len(f.body))), ContentType: f.putInput.ContentType,
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(testKMS), Metadata: cloneMetadata(f.putInput.Metadata),
	}, nil
}

func (f *fakeS3) GetObject(_ context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.getInput = input
	if f.getErr != nil {
		return nil, f.getErr
	}
	body := append([]byte(nil), f.body...)
	if f.tamperBody {
		body = append(body, '!')
	}
	return &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(body)), VersionId: aws.String(f.version()),
		ChecksumSHA256: f.putInput.ChecksumSHA256, ContentLength: aws.Int64(int64(len(f.body))),
		ContentType: f.putInput.ContentType, ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId: aws.String(testKMS), Metadata: cloneMetadata(f.putInput.Metadata),
	}, nil
}

func (f *fakeS3) DeleteObject(_ context.Context, input *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addEvent("s3.delete")
	f.deleteInputs = append(f.deleteInputs, input)
	if f.deleteErr != nil {
		return nil, f.deleteErr
	}
	output := &s3.DeleteObjectOutput{VersionId: aws.String(f.version())}
	if f.requestID != "" {
		awsmiddleware.SetRequestIDMetadata(&output.ResultMetadata, f.requestID)
	}
	return output, nil
}

func (f *fakeS3) GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error) {
	status := s3types.BucketVersioningStatusSuspended
	if f.versioned {
		status = s3types.BucketVersioningStatusEnabled
	}
	return &s3.GetBucketVersioningOutput{Status: status}, nil
}

func (f *fakeS3) GetBucketEncryption(context.Context, *s3.GetBucketEncryptionInput, ...func(*s3.Options)) (*s3.GetBucketEncryptionOutput, error) {
	key := "wrong-key"
	if f.encrypted {
		key = testKMS
	}
	return &s3.GetBucketEncryptionOutput{ServerSideEncryptionConfiguration: &s3types.ServerSideEncryptionConfiguration{
		Rules: []s3types.ServerSideEncryptionRule{{ApplyServerSideEncryptionByDefault: &s3types.ServerSideEncryptionByDefault{
			SSEAlgorithm: s3types.ServerSideEncryptionAwsKms, KMSMasterKeyID: aws.String(key),
		}}},
	}}, nil
}

func (f *fakeS3) version() string {
	if f.versionID != "" {
		return f.versionID
	}
	return testVersion
}

func cloneMetadata(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

type fakeRepository struct {
	mu               sync.Mutex
	events           *[]string
	intent           WriteIntent
	receipt          VersionReceipt
	beginErr         error
	recordVersionErr error
	loadErr          error
	claimErr         error
	cleanupErr       error
	failureErr       error
	cleanup          CleanupResult
	failureCode      string
	orphans          []WriteIntent
}

func (r *fakeRepository) addEvent(value string) {
	if r.events != nil {
		*r.events = append(*r.events, value)
	}
}

func (*fakeRepository) Ready(context.Context) error { return nil }

func (r *fakeRepository) BeginWrite(_ context.Context, input WriteIntentInput) (WriteIntent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.addEvent("db.intent")
	if r.beginErr != nil {
		return WriteIntent{}, r.beginErr
	}
	r.intent = WriteIntent{WriteIntentInput: input, State: "pending", CreatedAt: time.Now().UTC()}
	return r.intent, nil
}

func (r *fakeRepository) RecordVersion(_ context.Context, intent WriteIntent, receipt VersionReceipt) (VersionReceipt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.addEvent("db.version")
	if r.recordVersionErr != nil {
		return VersionReceipt{}, r.recordVersionErr
	}
	receipt.ReceiptHash = strings.Repeat("e", 64)
	r.receipt = receipt
	r.intent = intent
	r.intent.State = "ready"
	r.intent.Version = &r.receipt
	return receipt, nil
}

func (r *fakeRepository) LoadVersion(_ context.Context, tenantID, rest, expectedHash string) (VersionReceipt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.loadErr != nil {
		return VersionReceipt{}, r.loadErr
	}
	if r.receipt.VersionID == "" || r.receipt.TenantID != tenantID || r.receipt.ObjectRest != rest ||
		expectedHash != "" && r.receipt.ContentSHA256 != expectedHash {
		return VersionReceipt{}, ErrReceiptUnavailable
	}
	return r.receipt, nil
}

func (r *fakeRepository) ClaimCleanup(_ context.Context, tenantID, rest, workerID string, ttl time.Duration) (WriteIntent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.addEvent("db.claim")
	if r.claimErr != nil {
		return WriteIntent{}, r.claimErr
	}
	if r.intent.TenantID != tenantID || r.intent.ObjectRest != rest || workerID == "" || ttl == 0 {
		return WriteIntent{}, ErrCleanupNotAuthorized
	}
	claim := r.intent
	claim.State, claim.Attempt = "cleanup_leased", claim.Attempt+1
	claim.LeaseToken, claim.LeaseOwner = "00000000-0000-4000-8000-000000000088", workerID
	claim.Version = nil
	if r.receipt.VersionID != "" {
		copy := r.receipt
		claim.Version = &copy
	}
	r.intent = claim
	return claim, nil
}

func (r *fakeRepository) ClaimOrphans(context.Context, string, int, time.Duration, time.Duration) ([]WriteIntent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]WriteIntent(nil), r.orphans...), nil
}

func (r *fakeRepository) RecordCleanup(_ context.Context, _ WriteIntent, _ VersionReceipt, result CleanupResult) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.addEvent("db.cleanup")
	r.cleanup = result
	return r.cleanupErr
}

func (r *fakeRepository) RecordCleanupFailure(_ context.Context, _ WriteIntent, _ *VersionReceipt, code string, _ error, _ time.Duration) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failureCode = code
	return r.failureErr
}

func newTestStore(t *testing.T, objects *fakeS3, repository *fakeRepository) *S3Store {
	t.Helper()
	store, err := NewS3Store(testConfig(), objects, repository)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestS3StoreReadyRequiresVersioningAndExactKMSKey(t *testing.T) {
	repository := &fakeRepository{}
	objects := &fakeS3{versioned: true, encrypted: true}
	store := newTestStore(t, objects, repository)
	if err := store.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	objects.encrypted = false
	if err := store.Ready(context.Background()); !errors.Is(err, ErrNotReady) {
		t.Fatalf("wrong KMS default passed readiness: %v", err)
	}
	objects.encrypted, objects.versioned = true, false
	if err := store.Ready(context.Background()); !errors.Is(err, ErrNotReady) {
		t.Fatalf("unversioned bucket passed readiness: %v", err)
	}
}

func TestPutOrdersDurableIntentBeforeImmutableVersionedS3Receipt(t *testing.T) {
	events := []string{}
	objects := &fakeS3{events: &events}
	repository := &fakeRepository{events: &events}
	store := newTestStore(t, objects, repository)
	body := []byte(`{"status":"ok"}`)
	key, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	wantKey := "tenants/" + testTenant + "/" + testRest()
	if key != wantKey || strings.Join(events, ",") != "db.intent,s3.put,s3.head,db.version" {
		t.Fatalf("key/events = %q / %v", key, events)
	}
	objects.mu.Lock()
	put := objects.putInput
	head := objects.headInputs[0]
	objects.mu.Unlock()
	if aws.ToString(put.IfNoneMatch) != "*" || put.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(put.SSEKMSKeyId) != testKMS || put.ChecksumAlgorithm != s3types.ChecksumAlgorithmSha256 ||
		aws.ToString(put.ChecksumSHA256) == "" || aws.ToString(head.VersionId) != testVersion ||
		head.ChecksumMode != s3types.ChecksumModeEnabled {
		t.Fatalf("unsafe S3 write/head: put=%+v head=%+v", put, head)
	}
	if put.Metadata["postwave-tenant-sha256"] == testTenant ||
		put.Metadata["postwave-raw-output-sha256"] != sha256Hex(body) ||
		put.Metadata["postwave-write-intent-id"] != testIntent {
		t.Fatalf("unsafe metadata: %+v", put.Metadata)
	}
	repository.mu.Lock()
	receipt := repository.receipt
	repository.mu.Unlock()
	if receipt.VersionID != testVersion || receipt.ContentSHA256 != sha256Hex(body) ||
		receipt.ByteSize != int64(len(body)) || receipt.ProviderProofHash != providerProof(receipt) ||
		receipt.ReceiptHash == "" {
		t.Fatalf("incomplete durable receipt: %+v", receipt)
	}
}

func TestPutReceiptFailureDeletesOnlyExactCapturedVersion(t *testing.T) {
	events := []string{}
	objects := &fakeS3{events: &events}
	repository := &fakeRepository{
		events: &events, recordVersionErr: errors.New("receipt insert failed"),
		loadErr: ErrReceiptUnavailable,
	}
	store := newTestStore(t, objects, repository)
	if _, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON,
		bytes.NewBufferString(`{"status":"ok"}`)); err == nil {
		t.Fatal("receipt failure unexpectedly succeeded")
	}
	objects.mu.Lock()
	deletes := append([]*s3.DeleteObjectInput(nil), objects.deleteInputs...)
	objects.mu.Unlock()
	if len(deletes) != 1 || aws.ToString(deletes[0].VersionId) != testVersion ||
		aws.ToString(deletes[0].Key) != "tenants/"+testTenant+"/"+testRest() {
		t.Fatalf("cleanup was not exact-version: %+v", deletes)
	}
	if strings.Join(events, ",") != "db.intent,s3.put,s3.head,db.version,db.claim,s3.delete,db.cleanup" {
		t.Fatalf("unsafe compensation ordering: %v", events)
	}
}

func TestGetVerifiesExactVersionAndBodyBeforeReturning(t *testing.T) {
	objects := &fakeS3{}
	repository := &fakeRepository{}
	store := newTestStore(t, objects, repository)
	body := []byte(`{"status":"ok"}`)
	if _, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	reader, contentType, err := store.Get(context.Background(), testTenant, testRest())
	if err != nil {
		t.Fatal(err)
	}
	read, _ := io.ReadAll(reader)
	_ = reader.Close()
	if !bytes.Equal(read, body) || contentType != ContentTypeJSON || aws.ToString(objects.getInput.VersionId) != testVersion {
		t.Fatalf("wrong exact read: body=%q contentType=%q input=%+v", read, contentType, objects.getInput)
	}
	objects.tamperBody = true
	if _, _, err := store.Get(context.Background(), testTenant, testRest()); !errors.Is(err, ErrObjectConflict) {
		t.Fatalf("tampered exact body passed: %v", err)
	}
}

func TestDeleteExactHashesProviderRequestIDAndAcceptsOnlyExplicitMissing(t *testing.T) {
	objects := &fakeS3{requestID: "provider-request-secret"}
	repository := &fakeRepository{}
	store := newTestStore(t, objects, repository)
	body := []byte(`{"status":"ok"}`)
	if _, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	identity, err := store.ResolveExactVersion(context.Background(), testTenant, testRest(), sha256Hex(body))
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.DeleteExactVersion(context.Background(), testTenant, identity)
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderRequestIDHash != sha256Hex([]byte("provider-request-secret")) ||
		strings.Contains(result.ProviderRequestIDHash, "provider-request-secret") {
		t.Fatalf("request identifier leaked or was not hashed: %+v", result)
	}
	objects.deleteErr = &smithy.GenericAPIError{Code: "AccessDenied", Message: "denied"}
	if _, err := store.DeleteExactVersion(context.Background(), testTenant, identity); err == nil {
		t.Fatal("non-missing delete error was accepted")
	}
	objects.deleteErr = &smithy.GenericAPIError{Code: "NoSuchVersion", Message: "gone"}
	result, err = store.DeleteExactVersion(context.Background(), testTenant, identity)
	if err != nil || result.Disposition != "already_missing" {
		t.Fatalf("explicit NoSuchVersion was not idempotent: result=%+v err=%v", result, err)
	}
}

func TestReconcileOrphanResolvesReceiptBeforeExactDelete(t *testing.T) {
	objects := &fakeS3{}
	repository := &fakeRepository{}
	store := newTestStore(t, objects, repository)
	body := []byte(`{"status":"orphan"}`)
	if _, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	repository.mu.Lock()
	claim := repository.intent
	claim.State, claim.Attempt = "cleanup_leased", 1
	claim.LeaseToken = "00000000-0000-4000-8000-000000000077"
	claim.LeaseOwner = testConfig().WorkerID
	claim.Version = nil // exercise crash-after-Put-before-version-receipt recovery
	repository.receipt = VersionReceipt{}
	repository.orphans = []WriteIntent{claim}
	repository.mu.Unlock()
	result, err := store.ReconcileOrphans(context.Background(), 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	if result.Claimed != 1 || result.VersionsFound != 1 || result.Deleted != 1 || result.Failed != 0 {
		t.Fatalf("reconcile result = %+v", result)
	}
	objects.mu.Lock()
	deleteInput := objects.deleteInputs[len(objects.deleteInputs)-1]
	objects.mu.Unlock()
	if aws.ToString(deleteInput.VersionId) != testVersion {
		t.Fatalf("orphan deletion omitted resolved exact version: %+v", deleteInput)
	}
	repository.mu.Lock()
	stored, cleanup := repository.receipt, repository.cleanup
	repository.mu.Unlock()
	if stored.VersionID != testVersion || stored.ReceiptHash == "" || cleanup.Disposition != CleanupDeleted {
		t.Fatalf("orphan proof was not durable before cleanup: receipt=%+v cleanup=%+v", stored, cleanup)
	}
}

func TestReconcileRequiresThreeExplicitMissingObservations(t *testing.T) {
	body := []byte(`{"status":"ambiguous-put"}`)
	input := makeIntentInput(t, body)
	for attempt := int64(1); attempt <= 3; attempt++ {
		objects := &fakeS3{headErr: &smithy.GenericAPIError{Code: "NoSuchKey", Message: "missing"}}
		repository := &fakeRepository{}
		claim := WriteIntent{WriteIntentInput: input, State: "cleanup_leased", Attempt: attempt,
			LeaseToken: "00000000-0000-4000-8000-000000000077", LeaseOwner: testConfig().WorkerID}
		repository.orphans = []WriteIntent{claim}
		store := newTestStore(t, objects, repository)
		result, err := store.ReconcileOrphans(context.Background(), 1, 1)
		if attempt < 3 {
			if err == nil || result.Failed != 1 || repository.failureCode != "exact_version_not_observed" ||
				repository.cleanup.Disposition != "" {
				t.Fatalf("attempt %d prematurely closed ambiguous write: result=%+v err=%v repo=%+v",
					attempt, result, err, repository)
			}
			continue
		}
		if err != nil || result.AlreadyMissing != 1 || repository.cleanup.Disposition != CleanupAlreadyMissing {
			t.Fatalf("third explicit missing did not close intent: result=%+v err=%v cleanup=%+v",
				result, err, repository.cleanup)
		}
	}
}

func TestPutRejectsOversizeAndNoncanonicalKeysBeforeS3(t *testing.T) {
	objects := &fakeS3{}
	repository := &fakeRepository{}
	store := newTestStore(t, objects, repository)
	oversized := bytes.Repeat([]byte{'x'}, 128<<10+1)
	if _, err := store.Put(context.Background(), testTenant, testRest(), ContentTypeJSON, bytes.NewReader(oversized)); err == nil {
		t.Fatal("oversized raw output passed")
	}
	if _, err := store.Put(context.Background(), testTenant, "campaign-assurance/raw-output/../escape/writes/"+testIntent+".json",
		ContentTypeJSON, bytes.NewBufferString(`{}`)); err == nil {
		t.Fatal("traversal key passed")
	}
	objects.mu.Lock()
	put := objects.putInput
	objects.mu.Unlock()
	if put != nil {
		t.Fatal("invalid input reached S3")
	}
}

func makeIntentInput(t *testing.T, body []byte) WriteIntentInput {
	t.Helper()
	key, ref, intentID, err := canonicalRest(testTenant, testRest())
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	return WriteIntentInput{
		TenantID: testTenant, IntentID: intentID, ObjectRest: testRest(), ObjectKey: key,
		ObjectRef: ref, ContentSHA256: sha256Hex(body),
		ChecksumBase64: base64.StdEncoding.EncodeToString(digest[:]), ContentType: ContentTypeJSON,
		ByteSize: int64(len(body)), Bucket: testConfig().Bucket,
		KMSKeyIDHash: sha256Hex([]byte(testKMS)),
	}
}
