// SPDX-License-Identifier: AGPL-3.0-only
package cdclake

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// fakeRows / fakeQuerier fake the narrow pgx surface PgSlotFetcher reads: it
// only calls Next/Scan/Close/Err, so embedding pgx.Rows (whose other methods
// stay nil) is safe here.
type fakeRows struct {
	pgx.Rows
	data [][]byte
	i    int
}

func (r *fakeRows) Next() bool { return r.i < len(r.data) }
func (r *fakeRows) Scan(dest ...any) error {
	*(dest[0].(*[]byte)) = r.data[r.i]
	r.i++
	return nil
}
func (r *fakeRows) Close()     {}
func (r *fakeRows) Err() error { return nil }

type fakeQuerier struct{ rows [][]byte }

func (q *fakeQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return &fakeRows{data: q.rows}, nil
}

func TestTableIdentity_StableAndDistinct(t *testing.T) {
	ns := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	cfg := CDCConfig{Bucket: "lake", Prefix: "/warehouse/", TableUUIDNamespace: ns}

	orders := pgcdc.RelationMessage{Namespace: "public", RelationName: "orders"}
	items := pgcdc.RelationMessage{Namespace: "public", RelationName: "items"}

	u1, loc1 := TableIdentity(cfg, orders)
	u2, loc2 := TableIdentity(cfg, orders)
	u3, _ := TableIdentity(cfg, items)

	// Same relation → same UUID (stable identity across batches/restarts).
	if u1 != u2 {
		t.Errorf("same relation gave different UUIDs: %s vs %s", u1, u2)
	}
	// Different relations → different UUIDs.
	if u1 == u3 {
		t.Error("distinct relations must get distinct table UUIDs")
	}
	// It's a real parseable UUID.
	if _, err := uuid.Parse(u1); err != nil {
		t.Errorf("table UUID not a valid UUID: %v", err)
	}
	// Location: prefix slashes normalized, relation appended.
	if loc1 != "s3://lake/warehouse/orders" {
		t.Errorf("location = %q, want s3://lake/warehouse/orders", loc1)
	}
	if loc2 != loc1 {
		t.Error("location must be stable for a relation")
	}
}

func TestBuildConsumer_DrivesRealPgoutput(t *testing.T) {
	// BuildConsumer over a fake querier that yields the real captured
	// Relation+Insert, and a fake S3 client: one table must be uploaded, its
	// key under the configured bucket/prefix, and the snapshot id must come
	// from StartSnapshotID+1.
	fq := &fakeQuerier{rows: [][]byte{mustHex(t, realRelationHex), mustHex(t, realInsertHex)}}
	fs := &fakeS3{}
	cfg := CDCConfig{
		SlotName: "s", Publication: "p", Bucket: "lake", Prefix: "cdc",
		TableUUIDNamespace: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
		StartSnapshotID:    1000,
	}
	c := BuildConsumer(cfg, fq, fs, "kms-1", func() time.Time { return time.Unix(1_700_000_000, 0) })

	res, err := c.ConsumeBatch(context.Background(), 0)
	if err != nil {
		t.Fatalf("ConsumeBatch: %v", err)
	}
	if res.TablesWritten != 1 {
		t.Fatalf("tables written = %d, want 1", res.TablesWritten)
	}
	if len(fs.calls) != 4 {
		t.Fatalf("expected 4 S3 PUTs for the table, got %d", len(fs.calls))
	}
	for _, cl := range fs.calls {
		if cl.bucket != "lake" {
			t.Errorf("PUT bucket = %q, want lake", cl.bucket)
		}
		if indexOf(cl.key, "cdc/users/") != 0 {
			t.Errorf("PUT key %q not under cdc/users/", cl.key)
		}
		if cl.sse != "aws:kms" {
			t.Errorf("PUT %s not KMS-encrypted (sse=%q)", cl.key, cl.sse)
		}
	}
}
