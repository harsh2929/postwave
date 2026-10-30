// SPDX-License-Identifier: AGPL-3.0-only
package seqstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/services/voice/internal/generation"
)

func TestSequenceDraftLifecycleAndVersionIsolationDB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, _ := New(pool)
	tenant := uuid.NewString()
	other := uuid.NewString()
	for _, id := range []string{tenant, other} {
		tx, err := store.beginTenant(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO tenants(id,slug,name,tier) VALUES($1::uuid,$2,'Sequence QA fixture','studio')`, id, "seq-qa-"+id)
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, id := range []string{tenant, other} {
			tx, e := store.beginTenant(context.Background(), id)
			if e == nil {
				_, _ = tx.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, id)
				_ = tx.Commit(context.Background())
			}
		}
	}()
	var steps []generation.Step
	if err = json.Unmarshal([]byte(`[
  {"type":"email","position":1,"email":{"subject":"Welcome","body":"QA body","delay_seconds":600,"variants":[{"key":"a","subject":"A","body":"One","weight_bp":6000},{"key":"b","subject":"B","body":"Two","weight_bp":4000}]}},
  {"type":"delay","position":2,"delay":{"seconds":7200,"value":2,"unit":"hours"}},
  {"type":"condition","position":3,"condition":{"predicate":"tag_present","value":"qa","yes_branch":[{"type":"exit","position":1}],"no_branch":[]}},
  {"type":"tag_add","position":4,"tag":{"name":"onboarded"}},
  {"type":"tag_remove","position":5,"tag":{"name":"pending"}},
  {"type":"exit","position":6}]`), &steps); err != nil {
		t.Fatal(err)
	}
	seq := generation.Sequence{ID: uuid.NewString(), TenantID: tenant, Name: "QA lifecycle", Status: "draft", Steps: steps, CreatedAt: time.Now().UTC()}
	if err = store.Save(ctx, seq); err != nil {
		t.Fatal(err)
	}
	saved, err := store.Get(ctx, tenant, seq.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 1 || !reflect.DeepEqual(saved.Steps, steps) {
		t.Fatalf("initial draft lost structure: %+v", saved)
	}
	saved.Name = "QA edited"
	saved.Goal = &generation.SequenceGoal{Kind: "click", ExitOnGoal: true}
	saved.StuckAfterDays = 3
	version, err := store.SaveWithVersion(ctx, saved, 1)
	if err != nil || version != 2 {
		t.Fatalf("save version=%d err=%v", version, err)
	}
	if _, err = store.SaveWithVersion(ctx, saved, 1); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("stale write: %v", err)
	}
	saved.Status = "archived"
	version, err = store.SaveWithVersion(ctx, saved, 2)
	if err != nil || version != 3 {
		t.Fatalf("archive version=%d err=%v", version, err)
	}
	archived, err := store.Get(ctx, tenant, saved.ID)
	if err != nil || archived.Status != "archived" {
		t.Fatalf("archive read: %+v %v", archived, err)
	}
	archived.Status = "draft"
	version, err = store.SaveWithVersion(ctx, archived, 3)
	if err != nil || version != 4 {
		t.Fatalf("restore version=%d err=%v", version, err)
	}
	copy := archived
	copy.ID = uuid.NewString()
	copy.Name = "Copy of QA edited"
	if err = store.Save(ctx, copy); err != nil {
		t.Fatal(err)
	}
	copied, err := store.Get(ctx, tenant, copy.ID)
	if err != nil || copied.Version != 1 || !reflect.DeepEqual(copied.Steps, steps) || !reflect.DeepEqual(copied.Goal, saved.Goal) {
		t.Fatalf("copy lost source/goal: %+v %v", copied, err)
	}
	if _, err = store.Get(ctx, other, seq.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign read: %v", err)
	}
	foreign := archived
	foreign.TenantID = other
	if _, err = store.SaveWithVersion(ctx, foreign, 4); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign update: %v", err)
	}
	if err = store.DeleteWithVersion(ctx, tenant, seq.ID, 3); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("stale delete: %v", err)
	}
	if err = store.DeleteWithVersion(ctx, tenant, seq.ID, 4); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Get(ctx, tenant, seq.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted draft still visible: %v", err)
	}
}
