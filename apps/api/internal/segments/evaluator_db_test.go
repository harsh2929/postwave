// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestCanonicalPopulationComposedScopesAndReferenceSafety_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	foreignTenantID, _ := seedPreviewAggregateFixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Add a disabled but otherwise email-consented profile. Definition
	// membership includes it; activation eligibility must not.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	disabledEmail := "disabled-" + marker + "@example.test"
	var disabledSubscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, 'disabled', 'api')
RETURNING id::text`, tenantID, disabledEmail).Scan(&disabledSubscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed disabled subscriber: %v", err)
	}
	seedCanonicalEmailFixture(t, ctx, tx, tenantID, disabledSubscriberID, disabledEmail, true)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	repo := &Repo{Pool: pool}
	base, err := repo.Create(ctx, tenantID, CreateInput{
		Name:     "population-base-" + uuid.NewString(),
		QueryAST: json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"` + marker + `"}`),
	})
	if err != nil {
		t.Fatalf("create base: %v", err)
	}
	composedAST := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"` + base.ID + `"}`)
	composed, err := repo.Create(ctx, tenantID, CreateInput{
		Name: "population-composed-" + uuid.NewString(), QueryAST: composedAST,
	})
	if err != nil {
		t.Fatalf("create composed: %v", err)
	}

	assertPopulationCount := func(scope PopulationScope, want int) {
		t.Helper()
		predicate, compileErr := CompilePopulation(ctx, composed.QueryAST, tenantID, repo, scope)
		if compileErr != nil {
			t.Fatalf("compile population: %v", compileErr)
		}
		got, countErr := repo.Count(ctx, tenantID, predicate.SQL, predicate.Args)
		if countErr != nil {
			t.Fatalf("count population: %v", countErr)
		}
		if got != want {
			t.Fatalf("scope %+v count=%d want=%d SQL=%s", scope, got, want, predicate.SQL)
		}
	}
	assertPopulationCount(DefinitionPopulation(false), 3) // enabled consented + enabled unconsented + disabled
	assertPopulationCount(DefinitionPopulation(true), 4)  // plus archived
	assertPopulationCount(ActivationPopulation(ActivationChannelEmail), 1)

	activationCount, err := repo.CountSegmentAudience(ctx, tenantID, composed.ID)
	if err != nil {
		t.Fatalf("CountSegmentAudience: %v", err)
	}
	if activationCount != 1 {
		t.Fatalf("CountSegmentAudience=%d want=1", activationCount)
	}

	foreignBase, err := repo.Create(ctx, foreignTenantID, CreateInput{
		Name: "population-foreign-" + uuid.NewString(), QueryAST: json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"foreign"}`),
	})
	if err != nil {
		t.Fatalf("create foreign base: %v", err)
	}
	foreignRef := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"` + foreignBase.ID + `"}`)
	if _, err := CompilePopulation(ctx, foreignRef, tenantID, repo, DefinitionPopulation(false)); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("cross-tenant reference should fail closed, got %v", err)
	}

	cycleA, err := repo.Create(ctx, tenantID, CreateInput{Name: "cycle-a-" + uuid.NewString(), QueryAST: json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"a"}`)})
	if err != nil {
		t.Fatal(err)
	}
	cycleB, err := repo.Create(ctx, tenantID, CreateInput{Name: "cycle-b-" + uuid.NewString(), QueryAST: segmentReferenceAST(cycleA.ID)})
	if err != nil {
		t.Fatal(err)
	}
	cycleARef := segmentReferenceAST(cycleB.ID)
	if _, err := repo.Update(ctx, tenantID, cycleA.ID, UpdateInput{QueryAST: &cycleARef}); err != nil {
		t.Fatal(err)
	}
	if _, err := CompilePopulation(ctx, segmentReferenceAST(cycleA.ID), tenantID, repo, DefinitionPopulation(false)); err == nil || !strings.Contains(err.Error(), "reference cycle") {
		t.Fatalf("stored cycle should fail explicitly, got %v", err)
	}

	depthC, err := repo.Create(ctx, tenantID, CreateInput{Name: "depth-c-" + uuid.NewString(), QueryAST: json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"c"}`)})
	if err != nil {
		t.Fatal(err)
	}
	depthB, err := repo.Create(ctx, tenantID, CreateInput{Name: "depth-b-" + uuid.NewString(), QueryAST: segmentReferenceAST(depthC.ID)})
	if err != nil {
		t.Fatal(err)
	}
	depthA, err := repo.Create(ctx, tenantID, CreateInput{Name: "depth-a-" + uuid.NewString(), QueryAST: segmentReferenceAST(depthB.ID)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CompilePopulation(ctx, segmentReferenceAST(depthA.ID), tenantID, repo, DefinitionPopulation(false)); err == nil || !strings.Contains(err.Error(), "max depth") {
		t.Fatalf("stored over-depth chain should fail explicitly, got %v", err)
	}
}

func segmentReferenceAST(segmentID string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"op": "condition", "field": "segment_id", "comparator": "in_segment", "value": segmentID,
	})
	return b
}
