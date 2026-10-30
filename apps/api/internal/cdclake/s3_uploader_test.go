// SPDX-License-Identifier: AGPL-3.0-only
package cdclake

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

type putCall struct {
	bucket, key, ctype string
	body               []byte
	sseKMSKey          string
	sse                string
}

type fakeS3 struct {
	calls   []putCall
	failOn  string // key substring to fail on
	failErr error
}

func (f *fakeS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	body, _ := io.ReadAll(in.Body)
	key := deref(in.Key)
	if f.failOn != "" && contains(key, f.failOn) {
		return nil, f.failErr
	}
	c := putCall{bucket: deref(in.Bucket), key: key, ctype: deref(in.ContentType), body: body, sse: string(in.ServerSideEncryption)}
	if in.SSEKMSKeyId != nil {
		c.sseKMSKey = *in.SSEKMSKeyId
	}
	f.calls = append(f.calls, c)
	return &s3.PutObjectOutput{}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func contains(s, sub string) bool { return len(sub) > 0 && len(s) >= len(sub) && indexOf(s, sub) >= 0 }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func sampleTable(t *testing.T) *iceberg.TableFiles {
	t.Helper()
	rows := [][]pgcdc.NamedColumn{{col("id", "1"), col("email", "a@b.com"), col("total_cents", "5"), col("paid", "t")}}
	sync := [16]byte{1}
	tf, err := WriteChanges(ordersRel(), rows, iceberg.WriteTableOptions{
		TableUUID: "u", Location: "s3://lake/warehouse/orders", LastUpdatedMs: 1700,
		SnapshotID: 1, SequenceNumber: 1, ManifestSync: &sync, ManifestListSync: &sync,
	})
	if err != nil {
		t.Fatalf("WriteChanges: %v", err)
	}
	return tf
}

func TestS3TableUploader_PutsAllFourFiles(t *testing.T) {
	tf := sampleTable(t)
	fake := &fakeS3{}
	up := S3TableUploader{S3: fake, SSEKMSKeyID: "kms-key-1"}
	if err := up.Upload(context.Background(), "orders", tf); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if len(fake.calls) != 4 {
		t.Fatalf("got %d PUTs, want 4 (data/manifest/manifest-list/metadata)", len(fake.calls))
	}
	// Every object goes to the bucket + key parsed from its s3:// path, with
	// the KMS key applied, and non-empty bytes.
	wantKeys := map[string]bool{}
	for _, c := range fake.calls {
		if c.bucket != "lake" {
			t.Errorf("bucket = %q, want lake", c.bucket)
		}
		if c.sseKMSKey != "kms-key-1" {
			t.Errorf("PUT %s missing SSE-KMS key, got %q", c.key, c.sseKMSKey)
		}
		if len(c.body) == 0 {
			t.Errorf("PUT %s has empty body", c.key)
		}
		wantKeys[c.key] = true
	}
	// The metadata + data keys should be under warehouse/orders/{metadata,data}/.
	var sawData, sawMeta bool
	for k := range wantKeys {
		if indexOf(k, "warehouse/orders/data/") == 0 {
			sawData = true
		}
		if indexOf(k, "warehouse/orders/metadata/") == 0 {
			sawMeta = true
		}
	}
	if !sawData || !sawMeta {
		t.Errorf("expected data/ and metadata/ keys, got %v", wantKeys)
	}
}

// TestS3TableUploader_AlwaysEncrypts pins the fix for the at-rest downgrade:
// every PUT requests server-side encryption — SSE-KMS when a key is set, and
// SSE-S3 (AES256) when it isn't — never plaintext.
func TestS3TableUploader_AlwaysEncrypts(t *testing.T) {
	tf := sampleTable(t)

	withKey := &fakeS3{}
	if err := (S3TableUploader{S3: withKey, SSEKMSKeyID: "k"}).Upload(context.Background(), "orders", tf); err != nil {
		t.Fatal(err)
	}
	for _, c := range withKey.calls {
		if c.sse != "aws:kms" || c.sseKMSKey != "k" {
			t.Errorf("with a KMS key, PUT %s should use aws:kms+key, got sse=%q key=%q", c.key, c.sse, c.sseKMSKey)
		}
	}

	noKey := &fakeS3{}
	if err := (S3TableUploader{S3: noKey}).Upload(context.Background(), "orders", tf); err != nil {
		t.Fatal(err)
	}
	if len(noKey.calls) != 4 {
		t.Fatalf("got %d PUTs, want 4", len(noKey.calls))
	}
	for _, c := range noKey.calls {
		if c.sse != "AES256" {
			t.Errorf("with no KMS key, PUT %s must still encrypt (AES256), got sse=%q", c.key, c.sse)
		}
	}
}

func TestS3TableUploader_PartialFailurePropagates(t *testing.T) {
	tf := sampleTable(t)
	fake := &fakeS3{failOn: ".metadata.json", failErr: errors.New("boom")}
	up := S3TableUploader{S3: fake}
	if err := up.Upload(context.Background(), "orders", tf); err == nil {
		t.Fatal("a failed PUT must fail the whole Upload")
	}
}

func TestParseS3URI(t *testing.T) {
	b, k, err := parseS3URI("s3://bucket/a/b/c.parquet")
	if err != nil || b != "bucket" || k != "a/b/c.parquet" {
		t.Fatalf("parse = (%q,%q,%v), want bucket a/b/c.parquet nil", b, k, err)
	}
	for _, bad := range []string{"https://x/y", "s3://only-bucket", "s3://bucket/", "s3:///key"} {
		if _, _, err := parseS3URI(bad); err == nil {
			t.Errorf("parseS3URI(%q) should error", bad)
		}
	}
}

// TestRunConsumer_DrivesUntilChannelCloses feeds ticks deterministically and
// asserts the loop consumed each one, exiting when the channel closes.
func TestRunConsumer_DrivesUntilChannelCloses(t *testing.T) {
	fetch := &fakeFetcher{batches: [][][]byte{
		{mustHex(t, realRelationHex), mustHex(t, realInsertHex)}, // tick 1: one table
		{}, // tick 2: nothing
	}}
	up := &fakeUploader{}
	c := newTestConsumer(fetch, up)

	ticks := make(chan time.Time, 2)
	ticks <- time.Time{}
	ticks <- time.Time{}
	close(ticks)

	done := make(chan struct{})
	go func() { RunConsumer(context.Background(), c, ticks, 0, nil); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunConsumer did not return after ticks channel closed")
	}
	if len(up.uploads) != 1 {
		t.Errorf("expected 1 upload across the two ticks, got %d", len(up.uploads))
	}
}

// TestRunConsumer_StopsOnContextCancel confirms cancellation exits the loop.
func TestRunConsumer_StopsOnContextCancel(t *testing.T) {
	c := newTestConsumer(&fakeFetcher{}, &fakeUploader{})
	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time) // never ticks
	done := make(chan struct{})
	go func() { RunConsumer(ctx, c, ticks, 0, nil); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunConsumer did not return on context cancel")
	}
}
