// SPDX-License-Identifier: AGPL-3.0-only
//
// Live verification of the production ChangeFetcher (PgSlotFetcher) driving
// the consume loop end-to-end against a real logical slot. Skips unless
// PGCDC_LOGICAL_URL points at a throwaway wal_level=logical cluster (see
// live_db_test.go).
package cdclake

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/parquet-go/parquet-go"

	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

func TestLive_ConsumeBatchViaPgSlotFetcher(t *testing.T) {
	url := os.Getenv("PGCDC_LOGICAL_URL")
	if url == "" {
		t.Skip("PGCDC_LOGICAL_URL not set; skipping live consume test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	exec := func(sql string) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	}
	exec(`DROP TABLE IF EXISTS cdc_items CASCADE`)
	exec(`SELECT pg_drop_replication_slot(s.slot_name) FROM pg_replication_slots s WHERE s.slot_name='cdc_items_slot'`)
	exec(`DROP PUBLICATION IF EXISTS cdc_items_pub`)
	exec(`CREATE TABLE cdc_items (id bigint primary key, name text, qty int)`)
	exec(`CREATE PUBLICATION cdc_items_pub FOR TABLE cdc_items`)
	if _, err := conn.Exec(ctx, `SELECT pg_create_logical_replication_slot('cdc_items_slot','pgoutput')`); err != nil {
		t.Fatalf("create slot: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), url)
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `SELECT pg_drop_replication_slot('cdc_items_slot')`)
		_, _ = c.Exec(context.Background(), `DROP PUBLICATION IF EXISTS cdc_items_pub`)
		_, _ = c.Exec(context.Background(), `DROP TABLE IF EXISTS cdc_items CASCADE`)
	})

	exec(`INSERT INTO cdc_items VALUES (1, 'widget', 10)`)
	exec(`INSERT INTO cdc_items VALUES (2, 'gadget', 20)`)
	exec(`UPDATE cdc_items SET qty = 25 WHERE id = 2`)

	fetcher := PgSlotFetcher{Querier: conn, SlotName: "cdc_items_slot", Publication: "cdc_items_pub"}
	up := &fakeUploader{}
	var seq int64
	c := NewConsumer(ConsumerConfig{
		Fetcher: fetcher, Uploader: up,
		TableOf: func(rel pgcdc.RelationMessage) (string, string) {
			return "live-" + rel.RelationName, "s3://b/" + rel.RelationName
		},
		NextSnapshotID: func() int64 { seq++; return seq },
		Now:            func() time.Time { return time.Unix(1_700_000_000, 0) },
	})

	res, err := c.ConsumeBatch(ctx, 0)
	if err != nil {
		t.Fatalf("ConsumeBatch (live slot): %v", err)
	}
	// 2 inserts + 1 update = 3 appended rows, one uploaded table for cdc_items.
	if res.Appended != 3 {
		t.Errorf("appended = %d, want 3 (2 insert + 1 update)", res.Appended)
	}
	if res.TablesWritten != 1 || len(up.uploads) != 1 || up.uploads[0].relation != "cdc_items" {
		t.Fatalf("expected one uploaded table for cdc_items, got %+v", up.uploads)
	}

	// The landed Parquet holds all three appended rows. Columns sort to:
	// id, name, qty.
	type itemRow struct {
		ID   *int64  `parquet:"id"`
		Name *string `parquet:"name"`
		Qty  *int32  `parquet:"qty"`
	}
	r := parquet.NewGenericReader[itemRow](bytes.NewReader(up.uploads[0].tf.Data.Bytes))
	defer func() { _ = r.Close() }()
	got := make([]itemRow, 3)
	n, _ := r.Read(got)
	if n != 3 {
		t.Fatalf("read %d rows, want 3", n)
	}
	// The update's new-tuple (id=2, qty=25) must be among them.
	var sawUpdatedQty bool
	for _, row := range got[:n] {
		if row.ID != nil && *row.ID == 2 && row.Qty != nil && *row.Qty == 25 {
			sawUpdatedQty = true
		}
	}
	if !sawUpdatedQty {
		t.Errorf("expected the update's new tuple (id=2 qty=25) among landed rows: %+v", got[:n])
	}

	// A second consume with no new DML is a clean no-op (slot already drained).
	res2, err := c.ConsumeBatch(ctx, 0)
	if err != nil {
		t.Fatalf("second ConsumeBatch: %v", err)
	}
	if res2.TablesWritten != 0 {
		t.Errorf("drained slot should write nothing, got %+v", res2)
	}
}
