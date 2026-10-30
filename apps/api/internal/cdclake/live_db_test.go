// SPDX-License-Identifier: AGPL-3.0-only
//
// Live end-to-end verification of the CDC source→schema chain against a REAL
// Postgres logical replication slot: DML → pgoutput bytes (read via
// pg_logical_slot_get_binary_changes, no streaming socket / pglogrepl needed)
// → pgcdc.Decode → cdclake.SchemaFor. This upgrades pgcdc/cdclake from
// spec-fixture-verified to reality-verified.
//
// Skips unless PGCDC_LOGICAL_URL points at a wal_level=logical database (e.g.
// a throwaway `initdb` cluster on another port — never a production DB, since
// it creates a publication + replication slot). See the package docs.
package cdclake

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/parquet-go/parquet-go"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

func TestLive_PgoutputToIcebergSchema(t *testing.T) {
	url := os.Getenv("PGCDC_LOGICAL_URL")
	if url == "" {
		t.Skip("PGCDC_LOGICAL_URL not set; skipping live logical-replication test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	// A wal_level=logical DB is required; fail loudly (not skip) if the URL
	// points somewhere that can't create a logical slot, so a misconfigured
	// run doesn't look like a pass.
	var walLevel string
	if err := conn.QueryRow(ctx, "SHOW wal_level").Scan(&walLevel); err != nil {
		t.Fatalf("show wal_level: %v", err)
	}
	if walLevel != "logical" {
		t.Fatalf("PGCDC_LOGICAL_URL points at a wal_level=%q database, need logical", walLevel)
	}

	// Fresh, uniquely-named objects so reruns don't collide; full teardown.
	exec := func(sql string) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	}
	exec(`DROP TABLE IF EXISTS cdc_orders CASCADE`)
	exec(`SELECT pg_drop_replication_slot(s.slot_name) FROM pg_replication_slots s WHERE s.slot_name = 'cdc_test_slot'`)
	exec(`DROP PUBLICATION IF EXISTS cdc_test_pub`)

	exec(`CREATE TABLE cdc_orders (id bigint primary key, email text, total_cents int, paid boolean)`)
	exec(`CREATE PUBLICATION cdc_test_pub FOR TABLE cdc_orders`)
	// Slot must exist before the DML so the changes are captured.
	if _, err := conn.Exec(ctx, `SELECT pg_create_logical_replication_slot('cdc_test_slot', 'pgoutput')`); err != nil {
		t.Fatalf("create slot: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), url)
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `SELECT pg_drop_replication_slot('cdc_test_slot')`)
		_, _ = c.Exec(context.Background(), `DROP PUBLICATION IF EXISTS cdc_test_pub`)
		_, _ = c.Exec(context.Background(), `DROP TABLE IF EXISTS cdc_orders CASCADE`)
	})

	exec(`INSERT INTO cdc_orders VALUES (100, 'a@b.com', 4200, true)`)
	exec(`UPDATE cdc_orders SET total_cents = 5000 WHERE id = 100`)
	exec(`DELETE FROM cdc_orders WHERE id = 100`)

	// Consume the raw pgoutput messages.
	rows, err := conn.Query(ctx,
		`SELECT data FROM pg_logical_slot_get_binary_changes('cdc_test_slot', NULL, NULL,
		   'proto_version', '1', 'publication_names', 'cdc_test_pub')`)
	if err != nil {
		t.Fatalf("get binary changes: %v", err)
	}
	var raw [][]byte
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			t.Fatalf("scan change: %v", err)
		}
		cp := make([]byte, len(b))
		copy(cp, b)
		raw = append(raw, cp)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("no pgoutput changes captured")
	}

	// Decode every message with the committed decoder, tracking what we saw.
	cache := pgcdc.NewRelationCache()
	var (
		gotRelation     *pgcdc.RelationMessage
		gotInsert       *pgcdc.InsertMessage
		gotUpdate       *pgcdc.UpdateMessage
		gotDelete       *pgcdc.DeleteMessage
		begins, commits int
	)
	for i, b := range raw {
		msg, err := pgcdc.Decode(b)
		if err != nil {
			t.Fatalf("decode message %d (% x): %v", i, b, err)
		}
		cache.Observe(msg)
		switch m := msg.(type) {
		case pgcdc.BeginMessage:
			begins++
		case pgcdc.CommitMessage:
			commits++
		case pgcdc.RelationMessage:
			rel := m
			gotRelation = &rel
		case pgcdc.InsertMessage:
			ins := m
			gotInsert = &ins
		case pgcdc.UpdateMessage:
			upd := m
			gotUpdate = &upd
		case pgcdc.DeleteMessage:
			del := m
			gotDelete = &del
		}
	}

	// --- Every DML must have produced its message against real Postgres. ---
	if begins == 0 || commits == 0 {
		t.Errorf("expected Begin/Commit framing, got %d begins %d commits", begins, commits)
	}
	if gotRelation == nil || gotInsert == nil || gotUpdate == nil || gotDelete == nil {
		t.Fatalf("missing a message type: rel=%v ins=%v upd=%v del=%v",
			gotRelation != nil, gotInsert != nil, gotUpdate != nil, gotDelete != nil)
	}

	// --- Relation shape matches the table we created. ---
	if gotRelation.RelationName != "cdc_orders" || gotRelation.Namespace != "public" {
		t.Errorf("relation name/namespace = %s.%s", gotRelation.Namespace, gotRelation.RelationName)
	}
	if len(gotRelation.Columns) != 4 {
		t.Fatalf("relation has %d columns, want 4", len(gotRelation.Columns))
	}

	// --- cdclake.SchemaFor maps the REAL relation to the right Iceberg types. ---
	schema, err := SchemaFor(*gotRelation)
	if err != nil {
		t.Fatalf("SchemaFor(real relation): %v", err)
	}
	wantTypes := map[string]iceberg.PrimitiveType{
		"id": iceberg.TypeLong, "email": iceberg.TypeString,
		"total_cents": iceberg.TypeInt, "paid": iceberg.TypeBoolean,
	}
	for _, f := range schema.Fields {
		if wantTypes[f.Name] != f.Type {
			t.Errorf("column %q -> %s, want %s", f.Name, f.Type, wantTypes[f.Name])
		}
	}

	// --- Insert values resolve, via the relation cache, to the row we wrote. ---
	cols, err := cache.NamedColumns(gotInsert.RelationID, gotInsert.New)
	if err != nil {
		t.Fatalf("named columns for insert: %v", err)
	}
	got := map[string]string{}
	for _, c := range cols {
		if c.Value != nil {
			got[c.Name] = *c.Value
		}
	}
	if got["id"] != "100" || got["email"] != "a@b.com" || got["total_cents"] != "4200" || got["paid"] != "t" {
		t.Errorf("insert values = %v, want id=100 email=a@b.com total_cents=4200 paid=t", got)
	}

	// --- FULL PIPELINE against real data: the real Insert → an Iceberg table,
	//     and the encoded Parquet round-trips back to the exact typed row.
	//     This exercises pgoutput text → typed Parquet (bigint/text/int/bool)
	//     end-to-end, not just the schema map. ---
	sync := [16]byte{3}
	tf, err := WriteChanges(*gotRelation, [][]pgcdc.NamedColumn{cols}, iceberg.WriteTableOptions{
		TableUUID: "live-uuid", Location: "s3://b/w", LastUpdatedMs: 1_700_000_000_000,
		SnapshotID: 1, SequenceNumber: 1, ManifestSync: &sync, ManifestListSync: &sync,
	})
	if err != nil {
		t.Fatalf("WriteChanges(real insert): %v", err)
	}
	if tf.DataFileStats.RecordCount != 1 {
		t.Errorf("iceberg record_count = %d, want 1", tf.DataFileStats.RecordCount)
	}
	type liveRow struct {
		ID         *int64  `parquet:"id"`
		Email      *string `parquet:"email"`
		TotalCents *int32  `parquet:"total_cents"`
		Paid       *bool   `parquet:"paid"`
	}
	rr := parquet.NewGenericReader[liveRow](bytes.NewReader(tf.Data.Bytes))
	defer func() { _ = rr.Close() }()
	back := make([]liveRow, 1)
	if n, err := rr.Read(back); (err != nil && !errors.Is(err, io.EOF)) || n != 1 {
		t.Fatalf("read encoded parquet back: n=%d err=%v", n, err)
	}
	if back[0].ID == nil || *back[0].ID != 100 || back[0].Email == nil || *back[0].Email != "a@b.com" ||
		back[0].TotalCents == nil || *back[0].TotalCents != 4200 || back[0].Paid == nil || *back[0].Paid != true {
		t.Errorf("round-tripped row = %+v, want id=100 email=a@b.com total_cents=4200 paid=true", back[0])
	}

	// --- Update's new tuple carries the changed value. ---
	upCols, err := cache.NamedColumns(gotUpdate.RelationID, gotUpdate.New)
	if err != nil {
		t.Fatalf("named columns for update: %v", err)
	}
	for _, c := range upCols {
		if c.Name == "total_cents" && (c.Value == nil || *c.Value != "5000") {
			t.Errorf("update total_cents = %v, want 5000", c.Value)
		}
	}

	// --- Delete carries the key (default replica identity: key cols only). ---
	delCols, err := cache.NamedColumns(gotDelete.RelationID, gotDelete.Old)
	if err != nil {
		t.Fatalf("named columns for delete: %v", err)
	}
	for _, c := range delCols {
		if c.Name == "id" && (c.Value == nil || *c.Value != "100") {
			t.Errorf("delete key id = %v, want 100", c.Value)
		}
	}
}
