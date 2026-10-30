// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestSubscriberRequestAuditCommitsAtomically(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41166"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	rolledBackEmail := fmt.Sprintf("audit-rollback-%d@example.test", suffix)

	// An audit constraint failure must abort the subscriber write, proving the
	// request trail is not a post-commit best-effort side effect.
	if _, err := repo.UpsertWithAudit(ctx, tenantID, CreateInput{
		Email: rolledBackEmail, Status: StatusUnconfirmed, ConsentSource: ConsentUnknown,
	}, db.AuditMeta{ActorType: "not-a-valid-actor", ActorLabel: "rollback-canary"}); err == nil {
		t.Fatal("UpsertWithAudit with invalid actor unexpectedly succeeded")
	}
	exists, err := repo.ExistsByEmail(ctx, tenantID, rolledBackEmail)
	if err != nil {
		t.Fatalf("check rolled-back create: %v", err)
	}
	if exists {
		t.Fatal("subscriber committed even though its audit row failed")
	}

	email := fmt.Sprintf("audit-atomic-%d@example.test", suffix)
	created, err := repo.UpsertWithAudit(ctx, tenantID, CreateInput{
		Email: email, Status: StatusUnconfirmed, ConsentSource: ConsentUnknown,
	}, db.AuditMeta{
		ActorType: "human", ActorLabel: "subscriber-audit-test", IP: "192.0.2.55",
	})
	if err != nil {
		t.Fatalf("create with atomic audit: %v", err)
	}
	name := "Reviewed Person"
	modelVersion := "churn-v7"
	confidence := 0.87
	updated, err := repo.UpdateWithAudit(ctx, tenantID, created.ID, UpdateInput{
		FullName:               &name,
		GppSections:            map[string]string{"usca": "DBABLA~BUoAA"},
		PredictionModelVersion: &modelVersion,
		PredictionConfidence:   &confidence,
	}, db.AuditMeta{
		ActorType: "human", ActorLabel: "subscriber-audit-test", IP: "192.0.2.55",
	})
	if err != nil {
		t.Fatalf("update with atomic audit: %v", err)
	}
	if updated.FullName != name {
		t.Fatalf("updated full_name = %q, want %q", updated.FullName, name)
	}
	if updated.GppSections["usca"] != "DBABLA~BUoAA" {
		t.Fatalf("returned GPP projection = %v", updated.GppSections)
	}
	if updated.PredictionModelVersion == nil || *updated.PredictionModelVersion != modelVersion ||
		updated.PredictionConfidence == nil || *updated.PredictionConfidence != confidence {
		t.Fatalf("returned prediction projection = version %v confidence %v", updated.PredictionModelVersion, updated.PredictionConfidence)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant audit read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var createdAudits, updatedAudits, gppAudits, predictionRows int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND resource_id = $2
   AND action = 'subscriber.created'
   AND actor_type = 'human'
   AND actor_label = 'subscriber-audit-test'
   AND ip = '192.0.2.55'::inet`, tenantID, created.ID).Scan(&createdAudits); err != nil {
		t.Fatalf("read create audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND resource_id = $2
   AND action = 'subscriber.updated'
   AND metadata @> '{"pii_changed":true}'::jsonb
   AND metadata -> 'submitted_fields' ? 'full_name'`, tenantID, created.ID).Scan(&updatedAudits); err != nil {
		t.Fatalf("read update audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_gpp_audit
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND jurisdiction = 'usca' AND section_value = 'DBABLA~BUoAA'`, tenantID, created.ID).Scan(&gppAudits); err != nil {
		t.Fatalf("read GPP audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_prediction_metadata
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND score_type = 'churn' AND model_version = $3 AND confidence = $4`, tenantID, created.ID, modelVersion, confidence).Scan(&predictionRows); err != nil {
		t.Fatalf("read prediction metadata: %v", err)
	}
	if createdAudits != 1 || updatedAudits != 1 || gppAudits != 1 || predictionRows != 1 {
		t.Fatalf("atomic counts created=%d updated=%d gpp=%d prediction=%d, want 1/1/1/1",
			createdAudits, updatedAudits, gppAudits, predictionRows)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit read: %v", err)
	}

	badName := "Must Roll Back"
	badModel := "must-not-commit"
	if _, err := repo.UpdateWithAudit(ctx, tenantID, created.ID, UpdateInput{
		FullName:               &badName,
		GppSections:            map[string]string{"usva": "must-not-commit"},
		PredictionModelVersion: &badModel,
	}, db.AuditMeta{
		ActorType: "not-a-valid-actor", ActorLabel: "rollback-canary",
	}); err == nil {
		t.Fatal("UpdateWithAudit with invalid actor unexpectedly succeeded")
	}
	afterFailure, err := repo.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("read after failed audit: %v", err)
	}
	if afterFailure.FullName != name {
		t.Fatalf("failed audit leaked subscriber mutation: full_name=%q want %q", afterFailure.FullName, name)
	}
	gppAfter, err := repo.GetGppSections(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("read GPP after failed audit: %v", err)
	}
	if _, leaked := gppAfter.Sections["usva"]; leaked {
		t.Fatalf("failed audit leaked GPP mutation: %v", gppAfter.Sections)
	}
	predictionAfter, err := repo.GetPredictionMetadata(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("read prediction metadata after failed audit: %v", err)
	}
	if len(predictionAfter.Items) != 1 || predictionAfter.Items[0].ModelVersion != modelVersion {
		t.Fatalf("failed audit leaked prediction mutation: %#v", predictionAfter.Items)
	}
}
