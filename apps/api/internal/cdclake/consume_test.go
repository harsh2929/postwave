// SPDX-License-Identifier: AGPL-3.0-only
package cdclake

import (
	"bytes"
	"context"
	"encoding/hex"
	"testing"
	"time"

	"github.com/parquet-go/parquet-go"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// These are REAL pgoutput messages captured from a wal_level=logical Postgres
// for a table users(id int4, email text, active boolean): a Relation message
// and an Insert of (7, 'a@b.com', true). Using real bytes (not synthesized)
// means the consume loop is tested against exactly what Postgres emits.
const (
	realRelationHex = "52000040017075626c6963007573657273006400030169640000000017ffffffff" +
		"00656d61696c0000000019ffffffff006163746976650000000010ffffffff"
	realInsertHex = "49000040014e000374000000013774000000076140622e636f6d740000000174"
	// A real Delete (key id=7) for the same relation.
	realDeleteHex = "44000040014b00037400000001376e6e"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex fixture: %v", err)
	}
	return b
}

type fakeFetcher struct {
	batches [][][]byte
	i       int
}

func (f *fakeFetcher) FetchAndConsume(_ context.Context, _ int) ([][]byte, error) {
	if f.i >= len(f.batches) {
		return nil, nil
	}
	b := f.batches[f.i]
	f.i++
	return b, nil
}

type uploadRec struct {
	relation string
	tf       *iceberg.TableFiles
}

type fakeUploader struct{ uploads []uploadRec }

func (u *fakeUploader) Upload(_ context.Context, relation string, tf *iceberg.TableFiles) error {
	u.uploads = append(u.uploads, uploadRec{relation, tf})
	return nil
}

func newTestConsumer(f ChangeFetcher, u TableUploader) *Consumer {
	var seq int64
	return NewConsumer(ConsumerConfig{
		Fetcher: f, Uploader: u,
		TableOf: func(rel pgcdc.RelationMessage) (string, string) {
			return "uuid-" + rel.RelationName, "s3://bucket/" + rel.RelationName
		},
		NextSnapshotID: func() int64 { seq++; return seq },
		Now:            func() time.Time { return time.Unix(1_700_000_000, 0) },
	})
}

func TestConsumeBatch_AppendsRealInsertToIceberg(t *testing.T) {
	fetch := &fakeFetcher{batches: [][][]byte{
		{mustHex(t, realRelationHex), mustHex(t, realInsertHex)},
	}}
	up := &fakeUploader{}
	c := newTestConsumer(fetch, up)

	res, err := c.ConsumeBatch(context.Background(), 0)
	if err != nil {
		t.Fatalf("ConsumeBatch: %v", err)
	}
	if res.Messages != 2 || res.TablesWritten != 1 || res.Appended != 1 || res.DeletesSeen != 0 {
		t.Fatalf("batch result = %+v, want {msgs:2 tables:1 appended:1 deletes:0}", res)
	}
	if len(up.uploads) != 1 || up.uploads[0].relation != "users" {
		t.Fatalf("uploads = %+v, want one for relation users", up.uploads)
	}

	// The uploaded Iceberg table's Parquet must carry the real row. Columns
	// sort alphabetically: active, email, id.
	tf := up.uploads[0].tf
	if tf.DataFileStats.RecordCount != 1 {
		t.Errorf("record_count = %d, want 1", tf.DataFileStats.RecordCount)
	}
	type userRow struct {
		Active *bool   `parquet:"active"`
		Email  *string `parquet:"email"`
		ID     *int32  `parquet:"id"`
	}
	r := parquet.NewGenericReader[userRow](bytes.NewReader(tf.Data.Bytes))
	defer func() { _ = r.Close() }()
	got := make([]userRow, 1)
	if n, _ := r.Read(got); n != 1 {
		t.Fatalf("read %d rows back, want 1", n)
	}
	if got[0].ID == nil || *got[0].ID != 7 || got[0].Email == nil || *got[0].Email != "a@b.com" ||
		got[0].Active == nil || *got[0].Active != true {
		t.Errorf("landed row = %+v, want id=7 email=a@b.com active=true", got[0])
	}
}

func TestConsumeBatch_DeleteIsCountedNotWritten(t *testing.T) {
	fetch := &fakeFetcher{batches: [][][]byte{
		{mustHex(t, realRelationHex), mustHex(t, realDeleteHex)},
	}}
	up := &fakeUploader{}
	c := newTestConsumer(fetch, up)

	res, err := c.ConsumeBatch(context.Background(), 0)
	if err != nil {
		t.Fatalf("ConsumeBatch: %v", err)
	}
	if res.DeletesSeen != 1 || res.Appended != 0 || res.TablesWritten != 0 {
		t.Fatalf("delete batch = %+v, want {deletes:1 appended:0 tables:0}", res)
	}
	if len(up.uploads) != 0 {
		t.Errorf("a delete-only batch should upload nothing, got %d", len(up.uploads))
	}
}

func TestConsumeBatch_RelationCachePersistsAcrossBatches(t *testing.T) {
	// Batch 1 carries the Relation (and an insert); batch 2 carries only an
	// insert referencing the same relation — it must still resolve via the
	// persistent cache.
	fetch := &fakeFetcher{batches: [][][]byte{
		{mustHex(t, realRelationHex), mustHex(t, realInsertHex)},
		{mustHex(t, realInsertHex)},
	}}
	up := &fakeUploader{}
	c := newTestConsumer(fetch, up)

	if _, err := c.ConsumeBatch(context.Background(), 0); err != nil {
		t.Fatalf("batch 1: %v", err)
	}
	res2, err := c.ConsumeBatch(context.Background(), 0)
	if err != nil {
		t.Fatalf("batch 2 (relation only in batch 1): %v", err)
	}
	if res2.TablesWritten != 1 || res2.Appended != 1 {
		t.Fatalf("batch 2 = %+v, want a resolved append via the persistent cache", res2)
	}
	// The second batch appends to the SAME table, so its metadata carries
	// two snapshots (not a fresh single-snapshot table).
	if len(up.uploads[1].tf.TableMetadata.Snapshots) != 2 {
		t.Errorf("second batch should append a 2nd snapshot, got %d snapshots", len(up.uploads[1].tf.TableMetadata.Snapshots))
	}
}

func TestConsumeBatch_EmptyFetchNoOp(t *testing.T) {
	c := newTestConsumer(&fakeFetcher{}, &fakeUploader{})
	res, err := c.ConsumeBatch(context.Background(), 0)
	if err != nil || res.Messages != 0 || res.TablesWritten != 0 {
		t.Fatalf("empty fetch should be a clean no-op, got %+v err=%v", res, err)
	}
}
